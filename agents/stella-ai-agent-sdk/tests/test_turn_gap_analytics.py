"""The end-of-speech gap and the endpointing signals on the turn timeline (#92).

Logging only: the turn is taken exactly as before, these tests only pin what
is recorded about it.

- ``stt_end`` carries the STT service's ``trailing_silence_ms``, ``decode_ms``
  and ``speech_ms``, so end of speech to first audio is a plain sum;
- each pause the STT service rescued inside the continuation window becomes a
  ``pause_rescued`` event on the turn whose final it rode in on;
- ``user_resumed_after_final`` fires when the user starts talking again within
  RESUMED_AFTER_FINAL_WINDOW_MS of a final: the early-cutoff signal. It goes on
  the turn that was cut, with whether the agent was already audible.
"""

import asyncio

import pytest

from stella_agent_sdk.audio import pipeline as pipeline_module
from stella_agent_sdk.audio.pipeline import RESUMED_AFTER_FINAL_WINDOW_MS, AudioPipeline
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = None
    queued_playout_ms = 0.0

    def __init__(self):
        self.published = []

    def on_data_received(self, cb):
        pass

    async def publish_audio(self, data):
        await asyncio.sleep(0)

    async def publish_data(self, data, *a, **k):
        self.published.append(data)
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        pass

    def clear_playout(self):
        pass

    def flush_audio_queue(self):
        pass

    def get_participant_name(self, identity):
        return identity


class ScriptedSTT:
    def __init__(self, items):
        self.items = items

    async def stream_transcribe(self, audio_iter, **kwargs):
        for item in self.items:
            if callable(item):
                item()
                await asyncio.sleep(0)
                continue
            yield item
            await asyncio.sleep(0)


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t

    def at(self, t):
        def _set():
            self.t = t
        return _set


def ev(text="", is_final=False, tid="t", started=False, ended=False, **extra):
    return TranscriptEvent(
        text=text, is_final=is_final, transcript_id=tid, participant_id="human",
        confidence=1.0, timestamp_ms=0, speech_started=started, speech_ended=ended,
        **extra,
    )


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(pipeline_module, "_now", c)
    return c


def idle_pipeline():
    pipe = AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    return pipe


async def drive(pipe, items):
    pipe._stt = ScriptedSTT(items)
    await pipe._run_stt_stream_inner()
    for _ in range(20):
        await asyncio.sleep(0)


def analytics(pipe, stage):
    return [
        m["data"] for m in pipe._room.published
        if m.get("type") == "analytics" and m["data"]["stage"] == stage
    ]


# -- stt_end carries the gap ------------------------------------------------


@pytest.mark.asyncio
async def test_stt_end_carries_the_silence_waited_the_decode_and_the_speech(clock):
    pipe = idle_pipeline()
    await drive(pipe, [
        ev(started=True, tid="A"),
        ev(ended=True, tid="A"),
        ev("Ich gehe heute spazieren", is_final=True, tid="A",
           trailing_silence_ms=1104, decode_ms=312, speech_ms=1830),
    ])
    [stt_end] = analytics(pipe, "stt_end")
    assert stt_end["turn_id"] == "A"
    assert stt_end["trailing_silence_ms"] == 1104
    assert stt_end["decode_ms"] == 312
    assert stt_end["speech_ms"] == 1830


@pytest.mark.asyncio
async def test_stt_end_from_an_older_stt_service_has_no_gap_fields(clock):
    pipe = idle_pipeline()
    await drive(pipe, [ev("Hallo zusammen", is_final=True, tid="A")])
    [stt_end] = analytics(pipe, "stt_end")
    assert "trailing_silence_ms" not in stt_end
    assert "decode_ms" not in stt_end


def test_the_gap_fields_are_read_off_the_proto_only_when_present():
    from stella_agent_sdk._grpc import stt_pb2

    with_gap = stt_pb2.TranscriptEvent(is_final=True, trailing_silence_ms=0, decode_ms=280)
    with_gap.rescued_pauses.add(pause_ms=700, into_window_ms=200,
                                silence_threshold_ms=500, continuation_window_ms=600)
    event = TranscriptEvent.from_proto(with_gap)
    assert event.trailing_silence_ms == 0, "a real zero must survive as zero"
    assert event.decode_ms == 280
    assert event.speech_ms is None
    assert event.rescued_pauses == [{
        "pause_ms": 700, "into_window_ms": 200,
        "silence_threshold_ms": 500, "continuation_window_ms": 600,
    }]

    bare = TranscriptEvent.from_proto(stt_pb2.TranscriptEvent(is_final=True))
    assert bare.trailing_silence_ms is None and bare.rescued_pauses == []


# -- pause_rescued -----------------------------------------------------------


@pytest.mark.asyncio
async def test_each_rescued_pause_goes_on_the_turn_it_belongs_to(clock):
    pipe = idle_pipeline()
    pauses = [
        {"pause_ms": 640, "into_window_ms": 140, "silence_threshold_ms": 500,
         "continuation_window_ms": 600},
        {"pause_ms": 1020, "into_window_ms": 520, "silence_threshold_ms": 500,
         "continuation_window_ms": 600},
    ]
    await drive(pipe, [
        ev(started=True, tid="A"),
        ev("Ich gehe heute ... spazieren", is_final=True, tid="A", rescued_pauses=pauses),
    ])
    rescued = analytics(pipe, "pause_rescued")
    assert [r["turn_id"] for r in rescued] == ["A", "A"]
    assert [r["pause_ms"] for r in rescued] == [640, 1020]
    assert [r["into_window_ms"] for r in rescued] == [140, 520]
    assert rescued[0]["continuation_window_ms"] == 600


@pytest.mark.asyncio
async def test_no_pause_rescued_without_one(clock):
    pipe = idle_pipeline()
    await drive(pipe, [ev("Hallo zusammen", is_final=True, tid="A")])
    assert analytics(pipe, "pause_rescued") == []


# -- user_resumed_after_final ------------------------------------------------


def _resume_script(clock, *, resume_at, between=()):
    """User speaks A (ends at 100.0, final at 101.1), then starts B at `resume_at`."""
    return [
        clock.at(99.0), ev(started=True, tid="A"),
        clock.at(100.0), ev(ended=True, tid="A"),
        clock.at(101.1), ev("Ich wollte noch", is_final=True, tid="A"),
        *between,
        clock.at(resume_at), ev(started=True, tid="B"),
    ]


@pytest.mark.asyncio
async def test_speech_right_after_a_final_is_the_early_cutoff_signal(clock):
    pipe = idle_pipeline()
    await drive(pipe, _resume_script(clock, resume_at=101.9))

    [resumed] = analytics(pipe, "user_resumed_after_final")
    assert resumed["turn_id"] == "A", "it belongs to the turn that was cut"
    assert resumed["since_final_ms"] == pytest.approx(800, abs=1)
    assert resumed["elapsed_ms"] == pytest.approx(800, abs=1)
    assert resumed["pause_ms"] == pytest.approx(1900, abs=1)
    assert resumed["agent_speaking"] is False


@pytest.mark.asyncio
async def test_it_says_whether_the_agent_was_already_audible(clock):
    pipe = idle_pipeline()

    def agent_starts():
        pipe._audio_active = True

    await drive(pipe, _resume_script(clock, resume_at=102.5, between=[agent_starts]))
    [resumed] = analytics(pipe, "user_resumed_after_final")
    assert resumed["agent_speaking"] is True


@pytest.mark.asyncio
async def test_speech_after_the_window_is_not_a_cutoff(clock):
    pipe = idle_pipeline()
    late = 101.1 + RESUMED_AFTER_FINAL_WINDOW_MS / 1000 + 0.05
    await drive(pipe, _resume_script(clock, resume_at=late))
    assert analytics(pipe, "user_resumed_after_final") == []


@pytest.mark.asyncio
async def test_it_fires_once_per_final(clock):
    pipe = idle_pipeline()
    await drive(pipe, _resume_script(clock, resume_at=101.5) + [
        clock.at(101.8), ev(ended=True, tid="B"),
        clock.at(102.0), ev(started=True, tid="B"),  # a pause inside B
        clock.at(102.2), ev(started=True, tid="C"),
    ])
    assert len(analytics(pipe, "user_resumed_after_final")) == 1


def test_the_window_is_three_seconds():
    assert RESUMED_AFTER_FINAL_WINDOW_MS == 3000
