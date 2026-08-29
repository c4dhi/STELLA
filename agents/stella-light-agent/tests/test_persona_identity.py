"""Identity comes from the persona, and from nowhere else (#467).

stella-light used to take identity from three places — the plan's own
system_prompt, the Configurator's `persona` slot, and a merged
`system_prompt` slot — with precedence rules between them. The persona is now
the single source, so what these tests guard is mostly ABSENCE: the old inputs
must no longer be able to speak, or the second source is quietly back and it
outranks the persona the operator actually chose.
"""

import pytest

from stella_light_agent.agent import StellaLightAgent
from stella_light_agent.prompts import LightPromptBuilder


def _ctx(**over):
    ctx = {
        "processing_mode": "loose",
        "state": {"title": "Goals", "description": "Discuss goals"},
        "deliverables": [],
        "available_tasks": [],
        "collected_deliverables": {},
    }
    ctx.update(over)
    return ctx


PERSONA = "You are Grace, a physiotherapist in Bern."


# --- the persona is the identity -------------------------------------------

def test_persona_replaces_the_default_identity():
    prompt = LightPromptBuilder().build_system_prompt(_ctx(persona=PERSONA))
    assert PERSONA in prompt
    assert "You are STELLA" not in prompt


def test_no_persona_falls_back_to_the_built_in_identity():
    # A deployment always resolves SOMETHING (the system default persona), but
    # the builder must not produce a blank identity if it ever resolves nothing.
    prompt = LightPromptBuilder().build_system_prompt(_ctx())
    assert "You are STELLA" in prompt


def test_a_persona_owns_the_language_rule_too():
    # The default identity carries "default to German". A persona replaces the
    # whole block, so that rule must not leak past a persona written for, say,
    # an English-only deployment.
    prompt = LightPromptBuilder().build_system_prompt(_ctx(persona=PERSONA))
    assert "default to German" not in prompt


# --- the removed sources must stay removed ---------------------------------

def test_a_plan_system_prompt_can_no_longer_reach_the_prompt():
    # Plans carry structure only. A plan authored before the cut still has this
    # key in the wild; it must be inert rather than a second identity.
    prompt = LightPromptBuilder().build_system_prompt(
        _ctx(persona=PERSONA, plan_system_prompt="You are a strict examiner.")
    )
    assert "strict examiner" not in prompt
    assert PERSONA in prompt


def test_the_old_configurator_identity_slots_are_inert():
    prompt = LightPromptBuilder().build_system_prompt(
        _ctx(
            persona=PERSONA,
            custom_persona="You are a pirate.",
            custom_system_prompt="You are a tax auditor.",
        )
    )
    assert "pirate" not in prompt and "tax auditor" not in prompt
    assert PERSONA in prompt


def test_saved_configs_cannot_reinstate_identity_through_the_response_node(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    # A configuration saved before 1.1.0 still carries response.system_prompt
    # and response.persona. Reading either would put identity back into the
    # Configurator and outrank the deployed persona.
    agent = StellaLightAgent()
    agent._persona_config = {"system_prompt": PERSONA}

    agent._apply_pipeline_config({
        "nodes": {"response": {
            "system_prompt": "You are a tax auditor.",
            "persona": "You are a pirate.",
        }},
        "thresholds": {},
    })

    assert agent._custom_guidelines is None


# --- style is not identity --------------------------------------------------

def test_conversation_style_shapes_delivery_without_touching_identity():
    prompt = LightPromptBuilder().build_system_prompt(
        _ctx(persona=PERSONA, custom_guidelines="Speak in haiku.")
    )
    assert "Speak in haiku." in prompt
    assert PERSONA in prompt  # the persona still says who is speaking
    assert "Conversational Style (CRITICAL" not in prompt  # default replaced


def test_conversation_style_slot_feeds_the_delivery_block(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    agent = StellaLightAgent()

    agent._apply_pipeline_config({
        "nodes": {"response": {"conversation_style": "Speak in haiku."}},
        "thresholds": {},
    })

    assert agent._custom_guidelines == "Speak in haiku."
