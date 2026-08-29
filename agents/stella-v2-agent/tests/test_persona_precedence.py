"""Identity has exactly one source (#467).

This file used to pin a precedence table — plan prompt vs. Agent Configurator
slot vs. deployed Persona vs. built-in fallback — because identity could come
from three places and the order decided who won. Both rival sources are gone:
plans carry structure only, and the Configurator's persona slot was removed with
the pipeline schema so that many personas can share one configuration.

What is left to guard is that it stays that way.
"""

import inspect

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline.response_generator import ResponseGenerator
from stella_v2_agent.prompts import response_prompt
from stella_v2_agent.prompts.response_prompt import build_response_system_prompt


PERSONA = "You are Grace, a clinical companion."


def _build(**kwargs) -> str:
    return build_response_system_prompt({}, ResponseDirective(), **kwargs)


def test_the_deployed_persona_is_the_identity():
    prompt = _build(persona=PERSONA)
    assert PERSONA in prompt
    assert "You are STELLA" not in prompt


def test_falls_back_to_the_in_code_default_without_a_persona():
    # Reachable when an agent runs headless, or against a backend with no
    # Persona table. Never in a normal deployment: omitting a persona resolves
    # to the system default row server-side.
    assert "You are STELLA" in _build()


def test_persona_is_never_rendered_as_a_template():
    # Personas are inserted verbatim; a {{placeholder}} written in one is passed
    # through untouched. This is what frees a persona from any agent type's
    # variable palette — and therefore from its version pinning.
    persona = "You are Grace. Never resolve {{current_focus}}."
    assert "{{current_focus}}" in _build(persona=persona)


# ---------------------------------------------------------------------------
# The two removed sources must not come back
# ---------------------------------------------------------------------------

def test_the_prompt_builder_accepts_no_rival_identity_source():
    # A regression here would not fail loudly — it would just mean two blocks
    # describing who the agent is, concatenated, exactly as before #467.
    params = inspect.signature(build_response_system_prompt).parameters
    assert "plan_system_prompt" not in params, "a plan cannot supply identity"
    assert "custom_persona" not in params, "the Configurator slot cannot supply identity"


def test_pipeline_config_cannot_set_a_persona():
    """A configuration saved before the slot was removed still carries the key.

    It is deliberately ignored rather than pruned — no stored data is rewritten —
    so this asserts the key is inert rather than absent.
    """
    generator = ResponseGenerator.__new__(ResponseGenerator)
    generator.custom_guidelines = None
    generator.history_limit = 0
    generator.response_model = "m"
    generator.response_max_tokens = 1
    generator.response_temperature = 0.0
    generator.persona = None

    generator.apply_config({"persona": "You are somebody the config invented."})

    assert generator.persona is None
    assert not hasattr(generator, "custom_persona")


def test_a_plans_system_prompt_is_ignored():
    """Guardrail against a hand-authored plan JSON reintroducing a second source.

    The extraction migration strips system_prompt from stored plans, but a file
    dropped into config/plans/ could still contain one. Nothing reads it.
    """
    assert "plan_system_prompt" not in inspect.getsource(response_prompt)
