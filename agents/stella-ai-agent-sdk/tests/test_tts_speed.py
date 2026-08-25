"""Per-turn speaking rate on the audio pipeline (#3 prosody).

The TTS provider synthesises at one fixed rate with one fixed affect, so without
a per-turn rate every utterance in a conversation is acoustically identical.
``speed`` follows exactly the contract ``voice`` and ``language`` already use:
an env seed the agent overrides per turn, forwarded to the provider as a hint.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline


class FakeRoom:
    """Minimal RoomManager stand-in (mirrors test_analytics_anchor.py)."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.published = bytearray()
        self.data_handler = None
        self.captured = []

    def on_data_received(self, cb):
        self.data_handler = cb

    async def publish_audio(self, data: bytes):
        await asyncio.sleep(0)
        self.published.extend(data)

    async def publish_data(self, data, *a, **k):
        self.captured.append(data)
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        self.captured.append(data)

    def flush_audio_queue(self):
        pass

    @property
    def queued_playout_ms(self):
        return 0.0

    def clear_playout(self):
        pass

    def get_participant_name(self, identity):
        return identity


def make_pipeline():
    return AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")


def test_default_rate_is_unchanged():
    # Nothing set anywhere → exactly the behaviour before rate variation existed.
    assert make_pipeline()._tts_speed == 1.0


def test_env_seeds_the_rate(monkeypatch):
    monkeypatch.setenv("TTS_SPEED", "0.95")
    assert make_pipeline()._tts_speed == 0.95


def test_agent_override_wins_over_the_seed(monkeypatch):
    monkeypatch.setenv("TTS_SPEED", "0.95")
    pipe = make_pipeline()
    pipe.set_tts_speed(1.05)
    assert pipe._tts_speed == 1.05


def test_string_rate_is_accepted():
    # Metadata arrives over the wire as JSON and may carry a string.
    pipe = make_pipeline()
    pipe.set_tts_speed("1.03")
    assert pipe._tts_speed == pytest.approx(1.03)


@pytest.mark.parametrize("bad", [None, "fast", "", [], {}])
def test_non_numeric_rate_is_ignored(bad):
    pipe = make_pipeline()
    pipe.set_tts_speed(bad)
    assert pipe._tts_speed == 1.0


@pytest.mark.parametrize("bad", [0.1, 4.0, -1.0, 0.0])
def test_out_of_range_rate_is_ignored_not_clamped(bad):
    # The provider owns the valid range; clamping here would hide a caller bug
    # by quietly speaking at a rate nobody asked for.
    pipe = make_pipeline()
    pipe.set_tts_speed(bad)
    assert pipe._tts_speed == 1.0


def test_rate_persists_across_sentences():
    # One turn is many enqueued sentences; the rate is set once per turn and
    # must still be in force for the last of them.
    pipe = make_pipeline()
    pipe.set_tts_speed(0.97)
    assert pipe._tts_speed == 0.97
    pipe.set_tts_speed(0.97)
    assert pipe._tts_speed == 0.97
