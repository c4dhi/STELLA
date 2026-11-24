"""Regression tests for #205 (fix A): a text-only deployment tells the SDK
so at spawn, via AGENT_CONFIG's `interaction_mode`, instead of leaving
AudioPipeline on its "voice" default until the frontend's post-join
`stella.interaction_mode` announcement lands. That announcement can be sent
before the pipeline exists to receive it and is then lost outright, not just
late (see the live-logged repro on the #205 card) -- so the regression this
guards is specifically: the announce never arrives (or arrives too late), and
the pipeline's mode must already be correct regardless.

Mirrors tests/test_text_barge_in.py's own FakeRoom/make_pipeline() harness;
test_205_reply_to_barge_in_committed_turn_reaches_tts_before_mode_flip below
is the same sequence as the original (pre-fix) bug repro from that card,
kept here as the "without the fix" control.
"""
import asyncio
import logging

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.livekit.room import RoomManager
from stella_agent_sdk.messages.types import BargeInDecision
from stella_agent_sdk.services.stt_client import TranscriptEvent
from stella_agent_sdk.session_config import PLATFORM_KEYS, SessionConfig

logging.basicConfig(level=logging.INFO)


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.data_handler = None
        self.captured = []

    def on_data_received(self, cb):
        self.data_handler = cb

    async def publish_audio(self, data: bytes):
        await asyncio.sleep(0)

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
    room = FakeRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    pipe._barge_in_enabled = True
    return pipe, room


def _text_event(text, participant_id="alice"):
    return TranscriptEvent(
        text=text, is_final=True, transcript_id="text1",
        participant_id=participant_id, confidence=1.0, timestamp_ms=0,
        speech_started=False,
    )


def _async(value):
    async def _coro():
        return value
    return _coro()


async def _commit_barge_in_and_stream_reply(pipe):
    """The exact sequence #205 reproduces: a turn already active, the
    participant's message committed as a text barge-in, then the real
    reply's first sentence dispatched -- all with no `stella.interaction_mode`
    client event ever delivered to this pipeline."""
    pipe.begin_turn()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    await pipe._handle_text_barge_in(_text_event("what's the weather tomorrow?"))
    assert pipe.is_turn_aborted is True
    pipe.begin_turn()
    pipe.enqueue_sentence("Let me check that for you.")


@pytest.mark.asyncio
async def test_205_reply_to_barge_in_committed_turn_reaches_tts_before_mode_flip():
    """Without the fix: interaction_mode is still the SDK's "voice" default at
    enqueue time, since nothing (neither a spawn-time flag nor an announcement)
    has told the pipeline otherwise -- the bug this card was filed for."""
    pipe, room = make_pipeline()
    assert pipe.interaction_mode == "voice"

    await _commit_barge_in_and_stream_reply(pipe)

    assert pipe._speech_worker_task is not None, (
        "the reply to a barge-in-committed turn reached the TTS speech "
        "worker during the pre-announce window of a text-only session"
    )
    pipe._speech_worker_task.cancel()
    try:
        await pipe._speech_worker_task
    except (asyncio.CancelledError, Exception):
        pass


@pytest.mark.asyncio
async def test_205_initial_text_mode_from_spawn_survives_a_lost_announce():
    """With the fix: run.py reads AGENT_CONFIG's `interaction_mode` and calls
    set_interaction_mode() on the pipeline right after constructing it (see
    run.py, step "5a"), before anything else can run. Reproduced here by doing
    exactly that -- no client event, no announce, ever reaches this pipeline."""
    session_config = SessionConfig.parse({"interaction_mode": "text"})
    initial_interaction_mode = session_config.config.get("interaction_mode")
    assert initial_interaction_mode == "text"

    # Mirrors run.py: AudioPipeline() is constructed first (which registers the
    # real data handler, pipeline.py:977) and only then does the new step 5a
    # call set_interaction_mode() -- no stella.interaction_mode client event is
    # ever delivered through that handler in this test.
    pipe, room = make_pipeline()
    pipe.set_interaction_mode(initial_interaction_mode)  # run.py's new step 5a

    await _commit_barge_in_and_stream_reply(pipe)

    assert pipe._speech_worker_task is None, (
        "REGRESSION: with interaction_mode set at spawn time, the reply must "
        "never reach the TTS speech worker, with or without a "
        "stella.interaction_mode announcement ever arriving"
    )


def test_205_interaction_mode_is_a_plain_setting_not_a_platform_key():
    """interaction_mode is computed by the backend from the session's own
    invitations (agents.service.ts#resolveInitialInteractionMode), not
    something a deployer chooses -- it is deliberately NOT one of
    SessionConfig.PLATFORM_KEYS (that list mirrors deploy-request.ts's
    PLATFORM_CONFIG_KEYS and is contract-tested against it in
    test_platform_contract.py). It travels as an ordinary AGENT_CONFIG key,
    read back via `.config`, same as any agent-declared setting."""
    session_config = SessionConfig.parse({"interaction_mode": "text", "mode": "companion"})
    assert session_config.config.get("interaction_mode") == "text"
    assert "interaction_mode" not in PLATFORM_KEYS


def test_205_data_message_before_any_handler_is_registered_is_logged_not_silent(caplog):
    """RoomManager's data callback is a single-slot assignment (on_data_received
    overwrites, never chains, #205): a message arriving before AudioPipeline
    constructs and registers its own handler was previously dropped with no
    trace. Confirms it now logs instead, so a future lost announcement (or
    anything else sent this early) is visible rather than silently gone."""
    rm = RoomManager(livekit_url="ws://localhost:7880", api_key="k", api_secret="s")

    class FakeParticipant:
        identity = "agent-test"

    class FakePacket:
        participant = FakeParticipant()
        data = b"some-bytes"

    with caplog.at_level(logging.WARNING):
        rm._on_data_received_handler(FakePacket())

    assert any(
        "dropped" in record.message and "no handler registered" in record.message
        for record in caplog.records
    ), "expected a warning when a data message arrives with nothing registered yet"
