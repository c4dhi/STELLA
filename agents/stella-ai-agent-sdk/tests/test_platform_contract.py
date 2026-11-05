"""SDK 0.10 platform contract: identity, SessionConfig, plan_runtime, the
public room APIs, SDK-owned env vars and SDK version reporting."""

import asyncio
import pathlib
import re
from importlib.metadata import version
from typing import Any, AsyncIterator, Dict, List

import pytest

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent, SessionConfig
from stella_agent_sdk.participants import is_human_participant
from stella_agent_sdk.plan.runtime import DEFAULT_STATE_MACHINE_ADDRESS, PlanRuntime
from stella_agent_sdk.contracts import render
from stella_agent_sdk.platform_env import PLATFORM_ENV_NAMES
from stella_agent_sdk.progress import ProgressGroup, ProgressItem, ProgressState
from stella_agent_sdk.services.agent_server_client import AgentServerClient

SDK_ROOT = pathlib.Path(__file__).resolve().parents[1]
CONTRACTS = SDK_ROOT / "contracts"
STALE = "contracts/ is stale: run `python -m stella_agent_sdk.contracts` in agents/stella-ai-agent-sdk"


class MyAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_final(input.session_id, "hi")

    async def on_interrupt(self, session_id: str) -> None:
        return None


# ── identity ────────────────────────────────────────────────────────────


def test_identity_comes_from_the_platform_env(monkeypatch):
    monkeypatch.setenv("AGENT_TYPE", "elias-interviewer")
    monkeypatch.setenv("AGENT_VERSION", "0.3.1")
    agent = MyAgent()
    assert agent.agent_type == "elias-interviewer"
    assert agent.agent_version == "0.3.1"


def test_identity_falls_back_to_the_class_name_outside_stella(monkeypatch):
    monkeypatch.delenv("AGENT_TYPE", raising=False)
    monkeypatch.delenv("AGENT_VERSION", raising=False)
    agent = MyAgent()
    assert agent.agent_type == "MyAgent"
    assert agent.agent_version == "1.0.0"


def test_empty_agent_type_does_not_register_as_empty(monkeypatch):
    monkeypatch.setenv("AGENT_TYPE", "")
    assert MyAgent().agent_type == "MyAgent"


# ── SessionConfig ───────────────────────────────────────────────────────

PERSONA = {
    "id": "p1",
    "name": "Grace",
    "system_prompt": "You are Grace.",
    "language": "de",
    "variables": {"town": "Bern"},
    "is_system_default": False,
}
PLAN = {"id": "plan-1", "title": "Intake", "states": []}


def test_session_config_types_platform_keys_and_collects_user_settings():
    raw = {
        "persona": PERSONA,
        "plan": PLAN,
        "pipeline_config": {"nodes": {}},
        "elias": {"project_id": "x"},
        "model": "gpt-5.4-mini",
    }
    cfg = SessionConfig.parse(raw)
    assert cfg.persona.name == "Grace" and cfg.persona.variables == {"town": "Bern"}
    assert cfg.plan_dict == PLAN and cfg.mode is None and not cfg.is_companion
    assert cfg.pipeline_config == {"nodes": {}}
    assert cfg.config == {"elias": {"project_id": "x"}, "model": "gpt-5.4-mini"}
    # unknown top-level keys stay reachable as extras, for older agents
    assert cfg.extras["model"] == "gpt-5.4-mini"


def test_session_config_takes_an_explicit_config_block_as_is():
    cfg = SessionConfig.parse({"config": {"a": 1}, "legacy": True})
    assert cfg.config == {"a": 1}
    assert cfg.extras == {"legacy": True}


def test_session_config_companion_mode_and_activities():
    cfg = SessionConfig.parse({
        "mode": "companion",
        "available_plans": [{"id": "a1", "title": "Walk", "plan": PLAN}],
        "connectors": [{"handle": "elias", "slot": "elias"}],
    })
    assert cfg.is_companion
    assert cfg.available_plans[0].plan == PLAN
    assert cfg.connectors[0].handle == "elias"
    assert cfg.plan_dict is None


def test_session_config_drops_a_malformed_platform_key_instead_of_failing(caplog):
    cfg = SessionConfig.parse({"persona": "not-a-dict", "mode": "weird", "plan": PLAN, "x": 1})
    assert cfg.persona is None and cfg.mode is None
    assert cfg.plan_dict == PLAN and cfg.config == {"x": 1}
    assert "ignoring malformed" in caplog.text


def test_session_config_from_env_tolerates_bad_json():
    assert SessionConfig.from_env({"AGENT_CONFIG": "{nope"}).config == {}
    assert SessionConfig.from_env({}).persona is None


def test_plan_id_strings_are_kept_for_agents_that_resolve_them():
    cfg = SessionConfig.parse({"plan": "intake-v2"})
    assert cfg.plan == "intake-v2" and cfg.plan_dict is None


@pytest.mark.asyncio
async def test_base_agent_exposes_session_persona_and_plan():
    agent = MyAgent()
    raw = {"persona": PERSONA, "plan": PLAN, "lang": "de"}
    await agent.on_session_start("s1", raw)
    assert agent.session.config == {"lang": "de"}
    assert agent.persona.system_prompt == "You are Grace."
    assert agent.plan == PLAN


def test_committed_session_config_schema_is_current():
    committed = (CONTRACTS / "agent-session-config.schema.json").read_text()
    assert committed == render()["agent-session-config.schema.json"], STALE


# ── plan_runtime ────────────────────────────────────────────────────────


class FakeSM:
    def __init__(self, ok: bool = True, raises: bool = False) -> None:
        self.ok, self.raises = ok, raises
        self.connected = 0
        self.disconnected = 0
        self.plans: List[Dict[str, Any]] = []

    async def connect(self) -> None:
        self.connected += 1

    async def disconnect(self) -> None:
        self.disconnected += 1

    async def initialize(self, plan):
        if self.raises:
            raise RuntimeError("boom")
        self.plans.append(plan)
        return {"success": self.ok, "error": None if self.ok else "bad plan"}


@pytest.mark.asyncio
async def test_plan_runtime_connects_loads_the_plan_and_builds_sm_tools():
    sm = FakeSM()
    rt = PlanRuntime("s1", client=sm)
    result = await rt.start(PLAN)
    assert result["success"] and sm.plans == [PLAN] and rt.plan == PLAN
    names = rt.tools.list_names()
    assert {"complete_task", "set_deliverable", "get_current_state"} <= set(names)
    # every state machine tool talks to this session's client
    assert all(getattr(t, "client", sm) is sm for t in rt.tools.list_tools())
    await rt.start(None)
    assert sm.connected == 1  # idempotent
    await rt.close()
    await rt.close()
    assert sm.disconnected == 1


@pytest.mark.asyncio
async def test_plan_runtime_without_a_plan_connects_for_a_companion():
    sm = FakeSM()
    rt = PlanRuntime("s1", client=sm)
    assert await rt.start(None) is None
    assert sm.connected == 1 and sm.plans == [] and len(rt.tools) > 0


@pytest.mark.asyncio
async def test_plan_runtime_load_failure_is_reported_not_raised():
    assert (await PlanRuntime("s1", client=FakeSM(raises=True)).load(PLAN)) == {"success": False, "error": "boom"}
    rt = PlanRuntime("s1", client=FakeSM(ok=False))
    assert (await rt.load(PLAN))["success"] is False and rt.plan is None


def test_plan_runtime_address(monkeypatch):
    monkeypatch.delenv("STATE_MACHINE_ADDRESS", raising=False)
    rt = PlanRuntime("s1")
    assert rt.address == DEFAULT_STATE_MACHINE_ADDRESS and not rt.configured
    monkeypatch.setenv("STATE_MACHINE_ADDRESS", "sm:1")
    assert PlanRuntime("s1").address == "sm:1" and PlanRuntime("s1").configured
    assert PlanRuntime("s1", address="other:2").address == "other:2"
    assert PlanRuntime("s1").client.session_id == "s1"


@pytest.mark.asyncio
async def test_base_agent_plan_runtime_is_per_session_and_honours_the_address(monkeypatch):
    monkeypatch.delenv("STATE_MACHINE_ADDRESS", raising=False)
    agent = MyAgent()
    agent.state_machine_address = "sm-test:9"
    await agent.on_session_start("s1", {})
    first = agent.plan_runtime
    assert first is agent.plan_runtime and first.address == "sm-test:9" and first.session_id == "s1"
    await agent.on_session_start("s2", {})
    assert agent.plan_runtime is not first and agent.plan_runtime.session_id == "s2"


# ── public room APIs ────────────────────────────────────────────────────


class FakePipeline:
    def __init__(self, identities: List[str]) -> None:
        self.identities = identities
        self.published: List[Dict[str, Any]] = []
        self.drained = 0

    def participant_identities(self) -> List[str]:
        return list(self.identities)

    async def publish_data(self, payload):
        self.published.append(payload)

    async def wait_for_playout_drain(self, max_wait_ms: int = 15_000) -> None:
        self.drained += 1


def test_is_human_participant():
    assert is_human_participant("participant-1") and is_human_participant("human")
    for other in ("agent-abc", "message-recorder", "system-x", ""):
        assert not is_human_participant(other)


@pytest.mark.asyncio
async def test_wait_for_participant_returns_the_first_person():
    agent = MyAgent()
    audio = FakePipeline(["agent-me", "message-recorder"])
    agent._audio_pipeline = audio

    async def someone_joins():
        await asyncio.sleep(0.05)
        audio.identities.append("participant-42")

    asyncio.ensure_future(someone_joins())
    assert await agent.wait_for_participant(timeout=2, poll_interval=0.01) == "participant-42"
    assert agent.human_participants() == ["participant-42"]


@pytest.mark.asyncio
async def test_wait_for_participant_times_out():
    agent = MyAgent()
    agent._audio_pipeline = FakePipeline(["agent-me"])
    with pytest.raises(asyncio.TimeoutError):
        await agent.wait_for_participant(timeout=0.05, poll_interval=0.01)


def _progress() -> ProgressState:
    return ProgressState(groups=[ProgressGroup(id="g", label="G", items=[ProgressItem(id="i", label="I")])])


@pytest.mark.asyncio
async def test_publish_progress_sends_and_remembers_it_for_late_joiners():
    agent = MyAgent()
    audio = FakePipeline([])
    agent._audio_pipeline = audio
    agent._agent_id = "a1"
    await agent.on_session_start("s1", {})
    await agent.publish_progress(_progress(), update_trigger="state_change")
    assert len(audio.published) == 1
    payload = audio.published[0]
    assert payload["type"] == "progress_update" and payload["data"]["metadata"]["agent_id"] == "a1"
    assert agent._last_progress_payload is payload  # what run_agent re-sends on join

    ready = AgentOutput.progress_update("s1", _progress())
    await agent.publish_progress(ready)
    assert len(audio.published) == 2

    with pytest.raises(ValueError):
        await agent.publish_progress(AgentOutput.text_final("s1", "no"))


@pytest.mark.asyncio
async def test_complete_session_announces_once_and_stops_the_loop():
    agent = MyAgent()
    audio = FakePipeline([])
    agent._audio_pipeline = audio
    await agent.complete_session("interview_complete", delay_s=0)
    await agent.complete_session("again", delay_s=0)
    assert audio.drained == 1
    assert audio.published == [{"type": "session_completed", "data": {"reason": "interview_complete"}}]
    assert agent.session_completed


def test_record_message_processed():
    agent = MyAgent()
    agent.record_message_processed()
    agent.record_message_processed(2)
    assert agent.messages_processed == 3


# ── SDK-owned env vars ──────────────────────────────────────────────────


def test_committed_platform_env_is_current():
    assert (CONTRACTS / "sdk-platform-env.json").read_text() == render()["sdk-platform-env.json"], STALE


TUNING = re.compile(
    r"^(INTERRUPT_MODE|BARGE_IN_\w+|TTS_\w+|STELLA_TTS_\w+|STELLA_LANGUAGE|"
    r"TRANSCRIPT_DEBOUNCE_MS|STELLA_TELEPROMPTER_ENABLED|STELLA_EMOTION_TAGS_ENABLED)$"
)
# Set by the platform on every pod, not tuned by operators.
PLATFORM_SET = {"TTS_SERVICE_ADDRESS", "STELLA_TTS_PLAYBACK_SOURCE"}


def test_every_tuning_env_var_the_sdk_reads_is_declared():
    src = SDK_ROOT / "src" / "stella_agent_sdk"
    read = set()
    for path in src.rglob("*.py"):
        if "_grpc" in path.parts:
            continue
        read |= set(re.findall(r"[\"']([A-Z][A-Z0-9_]{3,})[\"']", path.read_text()))
    tuning = {n for n in read if TUNING.match(n)} - PLATFORM_SET
    assert tuning - PLATFORM_ENV_NAMES == set()


# ── SDK version reporting ───────────────────────────────────────────────


def test_agent_reports_the_installed_sdk_version():
    assert MyAgent().sdk_version == version("stella-ai-agent-sdk")
    assert MyAgent().get_health_status()["sdk_version"] == version("stella-ai-agent-sdk")


@pytest.mark.asyncio
async def test_register_agent_sends_sdk_version():
    sent = {}

    class Stub:
        async def RegisterAgent(self, request):
            sent["req"] = request
            return type("R", (), {"success": True, "session_id": "s", "message": "", "config": {}})()

    client = AgentServerClient("x:1")
    client._stub = Stub()
    await client.register_agent(agent_type="t", agent_version="1")
    assert sent["req"].sdk_version == version("stella-ai-agent-sdk")
    await client.register_agent(agent_type="t", agent_version="1", sdk_version="9.9.9")
    assert sent["req"].sdk_version == "9.9.9"
