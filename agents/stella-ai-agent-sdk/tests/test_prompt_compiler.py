"""Tests for the shared SDK prompt-compiler library and the single compile entry point."""

import pytest

from stella_agent_sdk import prompts
from stella_agent_sdk.prompts import (
    PromptCompiler,
    PlaceholderPromptCompiler,
    validate_template,
    palette,
    PLACEHOLDER_SPECS,
    get_compiler,
    register_compiler,
    available_versions,
    latest_version,
    COMPILER_VERSION,
    KNOWN_PLACEHOLDERS,
)
from stella_agent_sdk.prompts.placeholder_compiler import (
    PLACEHOLDER_REGISTRY,
    _compile_prompt,
    _resolve_current_focus,
)


def _ctx():
    return {
        "state": {"id": "s1", "title": "Intake", "description": "Collect basics"},
        "processing_mode": "loose",
        "current_task": {"id": "t1", "description": "Ask for name"},
        "deliverables": [
            {"key": "user_name", "description": "the name", "type": "string", "required": True, "status": "pending"},
            {"key": "age", "value": 42, "status": "completed"},
        ],
        "progress": {"percentage": 50, "turns_without_deliverable": 2},
    }


# --- single compile() entry point -------------------------------------------------

def test_compile_resolves_against_runtime_context():
    out = prompts.compile(
        "State {{current_state}} / {{progress_percentage}} / "
        "{{collected_deliverables}} / {{history_1}} / {{user_message}}",
        version=COMPILER_VERSION,
        sm_context=_ctx(),
        conversation_history=[{"role": "user", "content": "hi"}],
        user_input="My name is Sam",
    )
    assert "Intake" in out
    assert "50%" in out
    assert "age" in out
    assert "[USER]: hi" in out
    assert "My name is Sam" in out


def test_compile_requires_an_explicit_version():
    # No implicit "latest": calling without a version is an error, so an SDK
    # upgrade can never silently change how an agent's prompts compile.
    with pytest.raises(TypeError):
        prompts.compile("{{current_state}}", sm_context=_ctx())  # type: ignore[call-arg]
    with pytest.raises(ValueError):
        prompts.compile("{{current_state}}", None, sm_context=_ctx())  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        prompts.compile("{{current_state}}", "", sm_context=_ctx())


def test_compile_leaves_unknown_tokens_and_is_noop_without_tokens():
    assert "{{nope}}" in prompts.compile("x {{nope}} y", COMPILER_VERSION, sm_context=_ctx())
    assert prompts.compile("plain", COMPILER_VERSION, sm_context=_ctx()) == "plain"
    assert prompts.compile("", COMPILER_VERSION, sm_context=_ctx()) == ""
    assert prompts.compile(None, COMPILER_VERSION, sm_context=_ctx()) is None


def test_compile_unknown_version_raises():
    with pytest.raises(KeyError):
        prompts.compile("{{current_state}}", "99.0.0", sm_context=_ctx())


# --- registry / versioning --------------------------------------------------------

def test_registry_has_builtin_version():
    assert COMPILER_VERSION in available_versions()
    assert get_compiler(COMPILER_VERSION) is PlaceholderPromptCompiler
    assert issubclass(PlaceholderPromptCompiler, PromptCompiler)


def test_persona_version_ships_alongside_the_base_version():
    # 1.1.0 added the {{persona.*}} namespace as a SEPARATE registered version.
    # get_compiler() raises on an unknown version, so replacing 1.0.0 in place
    # would have broken every prompt and saved configuration pinned to it.
    from stella_agent_sdk.prompts import PersonaAwarePlaceholderCompiler

    assert COMPILER_VERSION in available_versions()
    assert PersonaAwarePlaceholderCompiler.VERSION in available_versions()
    assert latest_version() == PersonaAwarePlaceholderCompiler.VERSION
    assert get_compiler(COMPILER_VERSION) is PlaceholderPromptCompiler
    assert not PlaceholderPromptCompiler.RESOLVES_PERSONA
    assert PersonaAwarePlaceholderCompiler.RESOLVES_PERSONA


def test_get_compiler_requires_explicit_version():
    with pytest.raises(ValueError):
        get_compiler(None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        get_compiler("")


def test_register_compiler_adds_a_selectable_version():
    class V2(PlaceholderPromptCompiler):
        VERSION = "2.0.0-test"

    try:
        register_compiler(V2)
        assert "2.0.0-test" in available_versions()
        assert get_compiler("2.0.0-test") is V2
        assert latest_version() == "2.0.0-test"  # sorts above 1.0.0
        # The single entry point can target the new version explicitly.
        assert prompts.compile("{{current_state}}", version="2.0.0-test", sm_context=_ctx())
    finally:
        # Keep the registry clean for other tests.
        from stella_agent_sdk.prompts import registry
        registry._REGISTRY.pop("2.0.0-test", None)


def test_register_compiler_rejects_placeholder_version():
    class Bad(PromptCompiler):
        VERSION = "0.0.0"

        def compile(self, template):
            return template

    with pytest.raises(ValueError):
        register_compiler(Bad)


# --- versioning primitives --------------------------------------------------------

def test_validate_template_reports_only_unknown():
    assert validate_template("{{plan}} {{history_8}} {{user_message}}") == []
    assert validate_template("{{plan}} {{bogus}} {{nope}}") == ["bogus", "nope"]
    assert validate_template(None) == []


def test_known_placeholders_and_version():
    assert COMPILER_VERSION == PlaceholderPromptCompiler.VERSION
    assert "plan" in KNOWN_PLACEHOLDERS
    assert "history_N" in KNOWN_PLACEHOLDERS
    assert PlaceholderPromptCompiler.known_placeholders() == KNOWN_PLACEHOLDERS


def test_palette_specs_match_the_resolver_registry():
    # The palette metadata (the UI menu) must stay in sync with what the compiler
    # actually resolves, minus the parametric history_N (which has no plain resolver).
    spec_names = {s["name"] for s in palette()}
    non_parametric = {s["name"] for s in palette() if not s["parametric"]}
    assert non_parametric == set(PLACEHOLDER_REGISTRY)
    assert "history" in spec_names  # parametric {{history_N}}
    # palette() returns copies (callers can't mutate the source specs)
    palette()[0]["label"] = "mutated"
    assert PLACEHOLDER_SPECS[0]["label"] != "mutated"


def test_versioned_compile_matches_internal_resolver():
    # The public versioned entry point must produce exactly what the internal
    # resolver does — the version gate adds enforcement, not different output.
    ctx = _ctx()
    expected = _compile_prompt("{{current_state}}", {**ctx, "_conversation_history": [], "_user_input": ""})
    assert prompts.compile("{{current_state}}", COMPILER_VERSION, sm_context=ctx) == expected


def _running_basketball_ctx():
    """The transcript scenario: 'preferred_exercise' was collected as 'running'
    (its task complete) and the active task has advanced to the frequency
    question — when the user corrects themselves with 'oh no, I like basketball'."""
    return {
        "state": {"id": "exercise", "title": "Ask about preferred exercise"},
        "processing_mode": "strict",
        "current_task": {"id": "freq", "description": "Ask how often"},
        "full_plan": [
            {
                "id": "exercise",
                "title": "Ask about preferred exercise",
                "is_current": True,
                "tasks": [
                    {
                        "id": "type",
                        "description": "Type of exercise they prefer",
                        "status": "completed",
                        "has_deliverables": True,
                        "deliverables": [
                            {"key": "preferred_exercise", "status": "completed", "value": "running"},
                        ],
                    },
                    {
                        "id": "freq",
                        "description": "How often",
                        "status": "pending",
                        "has_deliverables": True,
                        "deliverables": [
                            {"key": "weekly_frequency", "status": "pending",
                             "type": "string", "required": True, "description": "times per week"},
                        ],
                    },
                ],
            }
        ],
    }


def test_current_focus_surfaces_collected_deliverables_as_correction_targets():
    # Regression for #278: once 'preferred_exercise' is collected it drops out of
    # the pending list, so the extraction expert used to see it only as "done"
    # and never overwrote a correction. CURRENT FOCUS must now surface it with its
    # stored value as an explicit, overwrite-on-correction target.
    focus = _resolve_current_focus(_running_basketball_ctx())

    assert "ALREADY COLLECTED" in focus
    assert "preferred_exercise = running" in focus
    assert "overwrite" in focus.lower()
    # The still-pending deliverable is unchanged — collected items don't replace it.
    assert "weekly_frequency" in focus
    # And the collected one is NOT mislabelled as still-pending ("○" marker).
    assert "○ preferred_exercise" not in focus


def test_current_focus_omits_collected_section_when_nothing_collected():
    ctx = _running_basketball_ctx()
    # Mark the type deliverable pending → nothing collected yet.
    ctx["full_plan"][0]["tasks"][0]["deliverables"][0]["status"] = "pending"
    ctx["full_plan"][0]["tasks"][0]["status"] = "pending"
    focus = _resolve_current_focus(ctx)
    assert "ALREADY COLLECTED" not in focus


# --- single-pass / speech-safe / history bounds (PR review hardening) ------------

def test_history_injected_content_is_not_re_expanded():
    """A {{placeholder}} literal inside a past user message must NOT be expanded.

    Regression for the old two-pass design that re-ran the simple-placeholder
    regex over already-resolved {{history_N}} output (input-driven injection)."""
    ctx = _ctx()
    ctx["_conversation_history"] = [
        {"role": "user", "content": "my secret is {{collected_deliverables}}"},
    ]
    out = _compile_prompt("{{history_1}}", ctx)
    assert "{{collected_deliverables}}" in out  # left verbatim, not expanded
    assert "age" not in out  # the deliverable value never leaked in


def test_history_zero_returns_no_messages():
    """{{history_0}} means 'last 0 messages', not the whole history (history[-0:])."""
    ctx = _ctx()
    ctx["_conversation_history"] = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "second"},
    ]
    out = _compile_prompt("{{history_0}}", ctx)
    assert "first" not in out and "second" not in out


def test_speech_safe_strips_scaffolding_labels():
    compiler = PlaceholderPromptCompiler(
        _ctx(),
        conversation_history=[{"role": "user", "content": "hello there"}],
        user_input="I feel dizzy",
        speech_safe=True,
    )
    user_msg = compiler.compile("{{user_message}}")
    history = compiler.compile("{{history_1}}")
    assert user_msg == "I feel dizzy"  # no "CURRENT USER MESSAGE:" label
    assert "CONVERSATION:" not in history and "[USER]" not in history
    assert "hello there" in history


def test_default_rendering_keeps_scaffolding_labels():
    """Non-speech-safe (LLM system-prompt) rendering is unchanged."""
    compiler = PlaceholderPromptCompiler(_ctx(), user_input="hi")
    assert compiler.compile("{{user_message}}") == "CURRENT USER MESSAGE: hi"


def test_compile_survives_malformed_progress_and_messages():
    """A bad progress value / role-less message must not raise."""
    ctx = _ctx()
    ctx["progress"] = {"percentage": None}
    ctx["_conversation_history"] = [{"content": "no role key"}]
    # Should not raise:
    out = _compile_prompt("{{progress_percentage}} {{history_1}}", ctx)
    assert "Overall progress: 0%" in out
    assert "no role key" in out


def test_speech_safe_forwarded_through_compile_entry_point():
    out = prompts.compile(
        "{{user_message}}",
        version=COMPILER_VERSION,
        sm_context=_ctx(),
        user_input="raw text",
        speech_safe=True,
    )
    assert out == "raw text"
