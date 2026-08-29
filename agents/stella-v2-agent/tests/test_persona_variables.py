"""Persona variables reach every place a prompt is written (#467).

A fact about the agent is stated once on the Persona and referenced as
{{persona.<key>}}. Three separate template paths have to agree about what that
means, and they use two different engines plus one path that historically did no
substitution at all — so each is pinned here.
"""

import pytest

from stella_agent_sdk import prompts
from stella_agent_sdk.prompts import resolve_persona_tokens
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.prompts.response_prompt import build_response_system_prompt

PERSONA = {
    "name": "Grace",
    "voice": "grace_de",
    "variables": {"role": "wellbeing companion", "tone": "warm but direct"},
}


# ---------------------------------------------------------------------------
# Path 1 — the placeholder compiler (expert prompts, verdict templates)
# ---------------------------------------------------------------------------

def test_compiler_resolves_persona_variables():
    out = prompts.compile(
        "You are {{persona.name}}, a {{persona.role}}.",
        version="1.1.0",
        sm_context={"persona": PERSONA},
    )
    assert out == "You are Grace, a wellbeing companion."


def test_author_defined_variable_beats_the_builtin_field():
    # Both engines must agree on this precedence, or {{persona.name}} means two
    # different things depending on which prompt it was written in.
    persona = {"name": "Row name", "variables": {"name": "Variable name"}}
    out = prompts.compile(
        "{{persona.name}}", version="1.1.0", sm_context={"persona": persona}
    )
    assert out == "Variable name"


def test_unknown_persona_key_resolves_empty_rather_than_literal():
    # A literal {{persona.nickname}} reaching the LLM — or being spoken — is worse
    # than the sentence simply not containing it.
    out = prompts.compile(
        "Hello[{{persona.nickname}}]", version="1.1.0", sm_context={"persona": PERSONA}
    )
    assert out == "Hello[]"


def test_persona_values_are_not_rescanned_for_placeholders():
    # Single-pass substitution: an author-supplied value must not be able to
    # smuggle in a placeholder of its own.
    persona = {"variables": {"evil": "{{collected_deliverables}}"}}
    out = prompts.compile(
        "{{persona.evil}}",
        version="1.1.0",
        sm_context={"persona": persona, "collected_deliverables": {"secret": "value"}},
    )
    assert out == "{{collected_deliverables}}"


def test_compiler_1_0_0_is_unchanged_by_the_new_namespace():
    # 1.0.0 stays registered and leaves persona tokens alone, so every prompt and
    # saved configuration pinned to it keeps compiling exactly as before.
    out = prompts.compile(
        "{{persona.name}}", version="1.0.0", sm_context={"persona": PERSONA}
    )
    assert out == "{{persona.name}}"


def test_both_compiler_versions_stay_available():
    assert "1.0.0" in prompts.available_versions()
    assert "1.1.0" in prompts.available_versions()


# ---------------------------------------------------------------------------
# Path 2 — render_prompt (the configured conversation guidelines)
# ---------------------------------------------------------------------------

def test_configured_guidelines_resolve_persona_variables():
    prompt = build_response_system_prompt(
        {"persona": PERSONA},
        ResponseDirective(),
        custom_guidelines="Speak as {{persona.name}}, {{persona.tone}}.",
    )
    assert "Speak as Grace, warm but direct." in prompt


def test_guidelines_and_compiler_agree_on_precedence():
    persona = {"name": "Row name", "variables": {"name": "Variable name"}}
    prompt = build_response_system_prompt(
        {"persona": persona}, ResponseDirective(), custom_guidelines="{{persona.name}}"
    )
    compiled = prompts.compile(
        "{{persona.name}}", version="1.1.0", sm_context={"persona": persona}
    )
    assert "Variable name" in prompt
    assert compiled == "Variable name"


# ---------------------------------------------------------------------------
# Path 3 — plan-authored text, which had no substitution at all
# ---------------------------------------------------------------------------

def test_plan_text_resolves_only_the_persona_namespace():
    # Plan text is rendered INTO {{plan}} / {{current_focus}}, so resolving the
    # wider palette here would be recursive. Everything else is left untouched.
    out = resolve_persona_tokens(
        "Introduce {{persona.name}} before {{current_focus}} and {{plan}}.", PERSONA
    )
    assert out == "Introduce Grace before {{current_focus}} and {{plan}}."


def test_plan_text_with_no_persona_empties_the_tokens():
    # Consistent with the unknown-key rule: with no persona, every key is unknown.
    # Reachable only if the seeded default row was deleted, or on an agent deployed
    # before personas existed — and in both cases a half-rendered sentence beats
    # literal braces reaching the LLM.
    assert resolve_persona_tokens("Ask about {{persona.name}}.", None) == "Ask about ."


@pytest.mark.parametrize("text", ["", None, "no tokens here"])
def test_plan_text_passthrough(text):
    assert resolve_persona_tokens(text, PERSONA) == text
