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

def test_no_placeholders_includes_history_and_user_message_in_user_role():
    runner = _runner()
    config = _config(system_prompt="You are an expert.")
    messages = runner._build_messages(config, "What's wrong?", HISTORY, {})

    assert messages[0].role == "system"
    assert messages[1].role == "user"
    user_content = messages[1].content
    assert "CONVERSATION:" in user_content
    assert "CURRENT USER MESSAGE: What's wrong?" in user_content


def test_history_placeholder_in_prompt_skips_history_in_user_role():
    # {{history_5}} inlines history into the system prompt — must not duplicate in user role
    runner = _runner()
    config = _config(system_prompt="Context: {{history_5}}")
    messages = runner._build_messages(config, "hello", HISTORY, {})

    assert "CONVERSATION:" not in messages[1].content


def test_user_message_placeholder_in_prompt_skips_duplication_in_user_role():
    # {{user_message}} was already inlined — must not appear again as "CURRENT USER MESSAGE:"
    runner = _runner()
    config = _config(system_prompt="User said: {{user_message}}")
    messages = runner._build_messages(config, "hello", HISTORY, {})

    assert "CURRENT USER MESSAGE:" not in messages[1].content


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


def test_each_tools_guidance_is_injected_once():
    # An expert is taught exactly the tools it has, from the SDK — never from
    # its editable prompt, and each contract once however many tools share it.
    from stella_agent_sdk.tools.state_machine import create_state_machine_tools
    from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE

    runner = _runner()
    config = _config(system_prompt="Extract things.")
    messages = runner._build_messages(
        config, "hi", [], {}, append_output_format=False,
        tools=create_state_machine_tools(client=None),
    )
    assert messages[0].content.count(STATE_MACHINE_TOOL_GUIDANCE) == 1


def test_the_router_is_not_taught_the_state_machine_tools():
    # companion_router got the set_deliverable contract appended, for tools it
    # cannot call, contradicting its own prompt.
    from stella_v2_agent.companion_tools import COMPANION_TOOL_GUIDANCE, create_companion_tools
    from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE

    runner = _runner()
    messages = runner._build_messages(
        _config(system_prompt="Route."), "hi", [], {}, append_output_format=False,
        tools=create_companion_tools([]),
    )
    assert COMPANION_TOOL_GUIDANCE in messages[0].content
    assert STATE_MACHINE_TOOL_GUIDANCE not in messages[0].content


def test_tool_guidance_not_injected_by_default():
    # JSON-mode experts must not get the tool contract.
    from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE

    runner = _runner()
    messages = runner._build_messages(_config(system_prompt="Classify."), "hi", [], {})
    assert STATE_MACHINE_TOOL_GUIDANCE not in messages[0].content


def test_history_limit_truncates_older_messages():
    # history_limit=1 should keep only the last message
    long_history = [
        {"role": "user", "content": "msg1"},
        {"role": "assistant", "content": "msg2"},
        {"role": "user", "content": "msg3"},
    ]
    runner = _runner()
    config = _config(system_prompt="You are an expert.", history_limit=1)
    messages = runner._build_messages(config, "hi", long_history, {})

    user_content = messages[1].content
    assert "msg3" in user_content
    assert "msg1" not in user_content
