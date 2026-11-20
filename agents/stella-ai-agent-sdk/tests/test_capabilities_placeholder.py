"""{{capabilities}}: what the agent can do, as prompt text (compiler 1.2.0, #992)."""

from stella_agent_sdk import prompts
from stella_agent_sdk.prompts import format_capabilities

CAPS = {
    "mode": "companion",
    "capabilities": [
        {"id": "activity.quiz", "kind": "activity", "title": "Memory quiz", "description": "Ten short questions"},
        {"id": "go_to_sleep", "kind": "action", "title": "Go to sleep", "description": ""},
    ],
}


def test_format_lists_the_mode_and_one_line_each():
    assert format_capabilities(CAPS) == (
        "Mode: open conversation, between activities\n"
        "- Memory quiz: Ten short questions\n"
        "- Go to sleep"
    )


def test_format_says_so_when_there_is_nothing_beyond_talking():
    assert format_capabilities({"mode": "plan", "capabilities": []}) == (
        "Mode: following a plan\n- Nothing beyond the conversation itself"
    )


def test_format_is_empty_without_a_list():
    assert format_capabilities(None) == ""
    assert format_capabilities({}) == ""


def test_only_1_2_0_resolves_it():
    ctx = {"capabilities": CAPS, "language": "de"}
    assert prompts.compile("Can do:\n{{capabilities}}", "1.2.0", sm_context=ctx).startswith(
        "Can do:\nMode: open conversation"
    )
    # Older versions keep their exact behaviour: the token stays as written.
    for version in ("1.0.0", "1.1.0"):
        assert prompts.compile("{{capabilities}}", version, sm_context=ctx) == "{{capabilities}}"


def test_1_2_0_still_resolves_persona_and_the_base_palette():
    ctx = {"capabilities": CAPS, "language": "de", "persona": {"name": "Grace"}}
    assert prompts.compile("{{persona.name}} / {{language}}", "1.2.0", sm_context=ctx) == "Grace / German"


def test_validate_knows_it_only_from_1_2_0():
    assert prompts.get_compiler("1.2.0").validate("{{capabilities}}") == []
    assert prompts.get_compiler("1.1.0").validate("{{capabilities}}") == ["capabilities"]


def test_a_title_cannot_smuggle_in_a_placeholder():
    caps = {"mode": "plan", "capabilities": [{"title": "{{collected_deliverables}}", "description": ""}]}
    out = prompts.compile("{{capabilities}}", "1.2.0", sm_context={"capabilities": caps, "collected_deliverables": {}})
    assert "{{collected_deliverables}}" in out
