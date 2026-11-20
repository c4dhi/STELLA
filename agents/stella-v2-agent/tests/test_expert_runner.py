"""Tests for ExpertRunner._parse_verdict() and _build_messages().

These are the pure-Python methods in the runner — no LLM calls, no I/O.
_parse_verdict() converts raw LLM JSON into an ExpertVerdict.
_build_messages() assembles the LLM message list from config + context.
"""

from stella_v2_agent.experts.runner import ExpertRunner
from stella_v2_agent.experts.base import ExpertConfig


def _runner() -> ExpertRunner:
    runner = ExpertRunner.__new__(ExpertRunner)
    runner._llm_service = None  # not used by _parse_verdict or _build_messages
    runner._compiler_version = "1.0.0"  # used by _build_messages to compile prompts
    return runner


def _config(**kwargs) -> ExpertConfig:
    return ExpertConfig(name="test_expert", **kwargs)


HISTORY = [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there"},
]


# ---------------------------------------------------------------------------
# _parse_verdict — happy path
# ---------------------------------------------------------------------------

def test_valid_json_all_fields_returns_correct_verdict():
    runner = _runner()
    config = _config(priority=80)

    result = runner._parse_verdict(
        config,
        '{"verdict": "high", "confidence": 0.9, "recommendation": "Act now"}',
        latency_ms=50.0,
    )

    assert result.verdict == "high"
    assert result.confidence == 0.9
    assert result.recommendation == "Act now"
    assert result.expert_name == "test_expert"
    assert result.priority == 80
    assert result.latency_ms == 50.0
    assert result.success is True


def test_missing_verdict_defaults_to_empty_string():
    runner = _runner()
    result = runner._parse_verdict(_config(), '{"confidence": 0.5}', latency_ms=10.0)
    assert result.verdict == ""
    assert result.success is True


def test_missing_confidence_defaults_to_zero():
    runner = _runner()
    result = runner._parse_verdict(_config(), '{"verdict": "clear"}', latency_ms=10.0)
    assert result.confidence == 0.0


def test_missing_recommendation_defaults_to_empty_string():
    runner = _runner()
    result = runner._parse_verdict(_config(), '{"verdict": "clear"}', latency_ms=10.0)
    assert result.recommendation == ""


def test_extra_fields_are_captured_in_flags():
    # Fields beyond verdict/confidence/recommendation go into flags for arbitration use
    runner = _runner()
    result = runner._parse_verdict(
        _config(),
        '{"verdict": "high", "confidence": 0.8, "recommendation": "", "severity": "critical", "topic": "medical"}',
        latency_ms=10.0,
    )
    assert result.flags == {"severity": "critical", "topic": "medical"}


def test_no_extra_fields_produces_empty_flags():
    runner = _runner()
    result = runner._parse_verdict(
        _config(),
        '{"verdict": "clear", "confidence": 0.9, "recommendation": "ok"}',
        latency_ms=10.0,
    )
    assert result.flags == {}


def test_confidence_as_string_is_coerced_to_float():
    # Some LLMs return numbers as strings despite JSON mode
    runner = _runner()
    result = runner._parse_verdict(_config(), '{"verdict": "low", "confidence": "0.75"}', latency_ms=10.0)
    assert result.confidence == 0.75
    assert isinstance(result.confidence, float)


# ---------------------------------------------------------------------------
# _parse_verdict — malformed LLM responses
# ---------------------------------------------------------------------------

def test_invalid_json_returns_parse_error_verdict():
    runner = _runner()
    result = runner._parse_verdict(_config(), "not valid json", latency_ms=10.0)
    assert result.verdict == "parse_error"
    assert result.success is False
    assert result.error_message is not None


def test_empty_string_returns_parse_error_verdict():
    runner = _runner()
    result = runner._parse_verdict(_config(), "", latency_ms=10.0)
    assert result.verdict == "parse_error"
    assert result.success is False


# ---------------------------------------------------------------------------
# _build_messages — message assembly
# ---------------------------------------------------------------------------

def test_the_prompt_alone_decides_what_conversation_the_expert_sees():
    # No placeholder, no conversation: nothing is added behind the prompt.
    runner = _runner()
    messages = runner._build_messages(_config(system_prompt="You are an expert."), "What's wrong?", HISTORY, {})

    assert messages[0].content == "You are an expert."
    assert [m.role for m in messages] == ["system", "user"]
    assert messages[1].content == "What's wrong?"


def test_history_and_user_message_placeholders_are_resolved_in_the_prompt():
    runner = _runner()
    config = _config(system_prompt="Context: {{history_1}}\n{{user_message}}")
    messages = runner._build_messages(config, "hello", HISTORY, {})

    assert "Hi there" in messages[0].content
    assert "Hello" not in messages[0].content  # history_1 keeps only the last message
    assert "hello" in messages[0].content
    assert messages[1].content == "hello"


def test_output_format_appended_to_system_prompt_when_set():
    runner = _runner()
    config = _config(system_prompt="Be an expert.", output_format='{"verdict": "..."}')
    messages = runner._build_messages(config, "hi", [], {})

    assert '{"verdict": "..."}' in messages[0].content


def test_append_output_format_false_skips_output_format():
    # Tool-calling mode passes append_output_format=False
    runner = _runner()
    config = _config(system_prompt="Be an expert.", output_format='{"verdict": "..."}')
    messages = runner._build_messages(config, "hi", [], {}, append_output_format=False)

    assert '{"verdict": "..."}' not in messages[0].content


def test_tool_mode_adds_nothing_but_the_last_goal_attempt_where_the_prompt_asks():
    runner = _runner()
    plain = runner._build_messages(_config(system_prompt="Extract things."), "hi", [], {}, append_output_format=False)
    assert plain[0].content == "Extract things."

    asked = runner._build_messages(
        _config(system_prompt="Extract things.\n{{last_goal_attempt}}"), "hi", [],
        {"last_goal_attempt": "YOUR LAST ATTEMPT: held back."}, append_output_format=False,
    )
    assert asked[0].content == "Extract things.\nYOUR LAST ATTEMPT: held back."


def test_the_default_prompts_carry_the_tool_contracts_themselves():
    # The contracts used to be appended from code, out of sight of the
    # Configurator and of anything optimizing the prompt.
    import json, pathlib
    from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE
    from stella_v2_agent.companion_tools import COMPANION_TOOL_GUIDANCE

    experts = pathlib.Path(__file__).resolve().parents[1] / "config" / "experts"
    prompt = lambda name: json.loads((experts / f"{name}.json").read_text())["system_prompt"]
    assert STATE_MACHINE_TOOL_GUIDANCE in prompt("task_extraction")
    assert "{{last_goal_attempt}}" in prompt("task_extraction")
    assert COMPANION_TOOL_GUIDANCE.strip() in prompt("companion_router")
    assert STATE_MACHINE_TOOL_GUIDANCE not in prompt("companion_router")


def test_every_default_expert_prompt_reads_the_conversation_through_placeholders():
    import json, pathlib
    experts = pathlib.Path(__file__).resolve().parents[1] / "config" / "experts"
    for path in experts.glob("*.json"):
        data = json.loads(path.read_text())
        assert "{{user_message}}" in data["system_prompt"], path.name
        assert "history_limit" not in data, path.name
