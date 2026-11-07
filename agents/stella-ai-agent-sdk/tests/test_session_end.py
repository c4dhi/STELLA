"""Tests for the session-end wrap-up wiring (issue #198)."""

import asyncio
import json

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.agent.base import BaseAgent
from stella_agent_sdk.run import (
    _resolve_farewell_message,
    _resolve_session_end_mode,
)


class TestFarewellResolver:
    """_resolve_farewell_message reads the plan's EndNodeConfig.farewell_message."""

    def test_resolves_nested_farewell_and_strips(self):
        cfg = {
            "plan": {
                "metadata": {
                    "plan_builder": {
                        "canvas": {"end_node_config": {"farewell_message": "  Bye now  "}}
                    }
                }
            }
        }
        assert _resolve_farewell_message(cfg) == "Bye now"

    @pytest.mark.parametrize(
        "cfg",
        [
            {},
            {"plan": None},
            {"plan": {"metadata": {}}},
            {"plan": {"metadata": {"plan_builder": {"canvas": {"end_node_config": {}}}}}},
            {"plan": {"metadata": {"plan_builder": {"canvas": {"end_node_config": {"farewell_message": 5}}}}}},
        ],
    )
    def test_missing_or_malformed_returns_empty(self, cfg):
        assert _resolve_farewell_message(cfg) == ""


class _Agent(BaseAgent):
    async def process(self, input):  # pragma: no cover - not used here
        if False:
            yield None

    async def on_interrupt(self, session_id):  # pragma: no cover - not used here
        return None


class TestSessionEndMode:
    """The mode comes from the agent (BaseAgent.session_end_mode), not from any
    agent's Configurator node: by default the SESSION_END_MODE env var."""

    @pytest.mark.parametrize("mode", ["farewell", "wrap_up", "silent", "WRAP_UP"])
    def test_env_var_picks_the_mode(self, monkeypatch, mode):
        monkeypatch.setenv("SESSION_END_MODE", mode)
        assert _resolve_session_end_mode(_Agent()) == mode.lower()

    @pytest.mark.parametrize("value", [None, "", "bogus"])
    def test_defaults_to_farewell(self, monkeypatch, value):
        if value is None:
            monkeypatch.delenv("SESSION_END_MODE", raising=False)
        else:
            monkeypatch.setenv("SESSION_END_MODE", value)
        assert _resolve_session_end_mode(_Agent()) == "farewell"

    def test_pipeline_config_is_not_read_by_the_sdk(self, monkeypatch):
        monkeypatch.delenv("SESSION_END_MODE", raising=False)
        agent = _Agent()
        agent._session_config = agent.session.__class__.model_validate(
            {"pipeline_config": {"nodes": {"interrupt_handler": {"mode": "silent"}}}}
        )
        assert _resolve_session_end_mode(agent) == "farewell"

    def test_an_override_wins_and_a_bad_one_falls_back(self):
        class Silent(_Agent):
            def session_end_mode(self):
                return "silent"

        class Broken(_Agent):
            def session_end_mode(self):
                raise RuntimeError("boom")

        assert _resolve_session_end_mode(Silent()) == "silent"
        assert _resolve_session_end_mode(Broken()) == "farewell"


class TestSessionEndDispatch:
    """The data-channel handler routes a session_end message to the registered hook."""

    @pytest.mark.asyncio
    async def test_session_end_message_invokes_handler(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)  # bypass heavy __init__
        received = {}

        async def handler(reason, deadline_ms):
            received["reason"] = reason
            received["deadline_ms"] = deadline_ms

        pipeline._session_end_handler = handler

        msg = json.dumps(
            {"type": "session_end", "reason": "session_end", "deadline_ms": 12000}
        ).encode("utf-8")
        pipeline._handle_data_message("server", msg)
        await asyncio.sleep(0)  # let the scheduled task run

        assert received == {"reason": "session_end", "deadline_ms": 12000}

    @pytest.mark.asyncio
    async def test_session_end_without_handler_is_noop(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)
        pipeline._session_end_handler = None

        msg = json.dumps({"type": "session_end"}).encode("utf-8")
        # Must not raise even with no handler registered.
        pipeline._handle_data_message("server", msg)
        await asyncio.sleep(0)


class TestClosingInterrupt:
    """interrupt_for_closing() — the one terminal-interrupt operation (issue #198)."""

    def _bare_pipeline(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)  # bypass heavy __init__
        pipeline._closing = False
        pipeline._barge_in_enabled = True
        pipeline._is_speaking = False  # so stop_speaking() is a no-op
        pipeline._turn_abort = asyncio.Event()
        pipeline._turn_suspended = False
        pipeline._turn_release = asyncio.Event()
        pipeline._speech_worker_task = None
        pipeline._stop_speaking_event = asyncio.Event()
        return pipeline

    @pytest.mark.asyncio
    async def test_gates_turns_locks_barge_in_and_clears_stop_flag(self):
        pipeline = self._bare_pipeline()
        pipeline._stop_speaking_event.set()  # left set by the interrupt's stop_speaking

        await pipeline.interrupt_for_closing()

        assert pipeline.is_closing is True            # no new user turns
        assert pipeline._barge_in_enabled is False    # user can't interrupt the goodbye
        assert pipeline._turn_abort.is_set() is True  # agent's own turn aborted
        assert pipeline._stop_speaking_event.is_set() is False  # ready to speak farewell

    @pytest.mark.asyncio
    async def test_waits_out_a_winding_down_worker_then_clears_the_ref(self):
        pipeline = self._bare_pipeline()
        pipeline._stop_speaking_event.set()

        async def _winding_down():
            await asyncio.sleep(0.05)

        worker = asyncio.create_task(_winding_down())
        pipeline._speech_worker_task = worker

        await pipeline.interrupt_for_closing()

        assert worker.done()  # settled, not left dangling
        # Ref cleared so the farewell's enqueue_sentence spawns a FRESH worker.
        assert pipeline._speech_worker_task is None
        assert pipeline._stop_speaking_event.is_set() is False

    @pytest.mark.asyncio
    async def test_cancels_a_worker_that_never_settles(self):
        # A worker blocked in a slow TTS call won't honor the stop flag within the
        # settle timeout; it must be cancelled so the farewell isn't appended to its
        # draining queue (with the stop flag now cleared) and silently swallowed.
        pipeline = self._bare_pipeline()

        async def _stuck():
            await asyncio.sleep(100)

        worker = asyncio.create_task(_stuck())
        pipeline._speech_worker_task = worker

        await pipeline.interrupt_for_closing()

        assert worker.cancelled() or worker.done()
        assert pipeline._speech_worker_task is None
        assert pipeline._stop_speaking_event.is_set() is False


class TestPlayoutDrain:
    """wait_for_playout_drain() — hold the terminal signal until audio is heard."""

    @pytest.mark.asyncio
    async def test_waits_until_buffer_drains_then_returns(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)

        class _Room:
            def __init__(self):
                self._values = [120.0, 0.0]  # buffered → drained

            @property
            def queued_playout_ms(self):
                return self._values.pop(0) if self._values else 0.0

        pipeline._room = _Room()
        # Returns once the buffer reports ~empty — must not raise or hang.
        await pipeline.wait_for_playout_drain(max_wait_ms=5_000)

    @pytest.mark.asyncio
    async def test_bounded_when_buffer_never_drains(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)

        class _Room:
            @property
            def queued_playout_ms(self):
                return 10_000.0  # never drains

        pipeline._room = _Room()
        # A stuck buffer can't stall shutdown: bounded by max_wait_ms.
        await pipeline.wait_for_playout_drain(max_wait_ms=300)

    @pytest.mark.asyncio
    async def test_swallows_errors(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)

        class _Room:
            @property
            def queued_playout_ms(self):
                raise RuntimeError("source gone")

        pipeline._room = _Room()
        # A failed readout can't block shutdown.
        await pipeline.wait_for_playout_drain(max_wait_ms=300)


class TestSessionEndedSignal:
    """publish_session_ended() — terminal overlay signal to the frontend."""

    @pytest.mark.asyncio
    async def test_publish_session_ended_emits_terminal_envelope(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)
        published = []

        class _Room:
            async def publish_data(self, payload):
                published.append(payload)

        pipeline._room = _Room()

        await pipeline.publish_session_ended("session_end")

        assert published == [
            {"type": "session_ended", "data": {"reason": "session_end"}}
        ]

    @pytest.mark.asyncio
    async def test_publish_session_ended_swallows_errors(self):
        pipeline = AudioPipeline.__new__(AudioPipeline)

        class _Room:
            async def publish_data(self, payload):
                raise RuntimeError("room gone")

        pipeline._room = _Room()
        # Must not raise — a failed notify can't block shutdown.
        await pipeline.publish_session_ended("session_end")
