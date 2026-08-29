"""Persona precedence in the response system prompt (#467).

The identity a deployment speaks with can arrive from three places, and getting
their order wrong is silent: the agent still talks, just as somebody else. These
tests pin the table.

Phase 1 keeps `plan_system_prompt` alive (the clean cut is phase 2), so the cases
below also guard the pre-existing behaviour against regressions — in particular
that a plan prompt REPLACES the built-in fallback rather than stacking with it.
"""

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.prompts.response_prompt import build_response_system_prompt


CHOSEN = "You are Grace, a clinical companion."
CONFIGURATOR = "You are the Agent Configurator's persona."
DEFAULT_FROM_DB = "You are the system default persona row."


def _build(**kwargs) -> str:
    return build_response_system_prompt({}, ResponseDirective(), **kwargs)


def test_operator_selected_persona_outranks_configurator_slot():
    # The whole point of the entity: choosing a Persona at deploy time beats the
    # persona slot buried in the agent's pipeline config.
    prompt = _build(persona=CHOSEN, custom_persona=CONFIGURATOR)
    assert CHOSEN in prompt
    assert CONFIGURATOR not in prompt


def test_system_default_does_not_override_a_configured_persona():
    # Every deployment now resolves a persona — omitting one means "the default".
    # If the default outranked the Configurator slot, merely shipping this feature
    # would restyle every agent already configured the old way.
    prompt = _build(
        persona=DEFAULT_FROM_DB,
        persona_is_system_default=True,
        custom_persona=CONFIGURATOR,
    )
    assert CONFIGURATOR in prompt
    assert DEFAULT_FROM_DB not in prompt


def test_system_default_fills_the_fallback_slot():
    # With nothing else configured, the DB-backed default is the identity.
    prompt = _build(persona=DEFAULT_FROM_DB, persona_is_system_default=True)
    assert DEFAULT_FROM_DB in prompt


def test_falls_back_to_in_code_default_without_a_persona():
    # Agent running headless, or against a backend predating the Persona table.
    prompt = _build()
    assert "You are STELLA" in prompt


def test_persona_is_never_rendered_as_a_template():
    # Personas are inserted verbatim; a {{placeholder}} written in one is passed
    # through untouched. This is what frees a persona from any agent type's
    # variable palette — and therefore from its version pinning.
    persona = "You are Grace. Never resolve {{current_focus}}."
    assert "{{current_focus}}" in _build(persona=persona)


def test_a_plans_system_prompt_is_ignored():
    """A plan cannot supply identity, even by carrying the old field.

    Guardrail for the phase-2 cut (#467): the extraction migration strips
    system_prompt from stored plans, but a hand-authored plan JSON dropped into
    config/plans/ could still contain one. The agent simply never reads it, so
    there is no path back to two sources.
    """
    plan = {"id": "p1", "system_prompt": "You are somebody else entirely.", "states": []}
    # _load_plan_config returns the plan as-is; nothing consumes system_prompt.
    from stella_v2_agent.prompts import response_prompt

    import inspect
    signature = inspect.signature(response_prompt.build_response_system_prompt)
    assert "plan_system_prompt" not in signature.parameters

    prompt = _build(persona=CHOSEN)
    assert plan["system_prompt"] not in prompt
    assert CHOSEN in prompt
