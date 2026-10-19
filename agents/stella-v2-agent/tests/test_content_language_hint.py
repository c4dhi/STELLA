"""#58: the activity's own declared language reaches the response prompt as
an informational hint ({{contentLanguage}}), never as an instruction to
switch — the session's own {{language}} directive always wins.
"""

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.prompts.response_prompt import build_response_system_prompt

GUIDELINES = "{{#if language}}\n{{language}}\n{{/if}}\n{{#if contentLanguage}}\n{{contentLanguage}}\n{{/if}}"


def _build(sm_context: dict) -> str:
    return build_response_system_prompt(
        sm_context, ResponseDirective(), custom_guidelines=GUIDELINES,
    )


def test_the_hint_appears_when_set():
    prompt = _build({"language": "de", "content_language": "en"})
    assert "originally written in English" in prompt
    assert "Keep speaking the conversation's language above" in prompt


def test_the_hint_names_the_right_languages():
    prompt = _build({"language": "en", "content_language": "de"})
    assert "originally written in German" in prompt


def test_no_hint_when_absent():
    prompt = _build({"language": "de", "content_language": None})
    assert "originally written in" not in prompt


def test_the_session_language_directive_still_renders_alongside_the_hint():
    # The hint is additive -- it must never replace or weaken the actual
    # instruction to speak the session's own language.
    prompt = _build({"language": "de", "content_language": "en"})
    assert "Respond ENTIRELY in German" in prompt
    assert "originally written in English" in prompt
