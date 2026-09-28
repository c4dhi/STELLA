"""A session resumed from a config saved before personas keeps its identity (#550).

`lastAgentConfig` is replayed verbatim on restart and on an auto-pause wake. A
config saved before 1.3.0 has no `persona`, but its plan still carries the
`system_prompt` it always spoke with. Without a fallback that session would come
back as the default STELLA persona.

TEMPORARY: remove this fallback, and this file, one release after 1.3.0.
"""

from stella_v2_agent.agent import StellaV2Agent


def _load(config):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    return agent._load_persona_config(config)


def test_a_snapshot_persona_wins_over_the_plan_prompt():
    persona = {"name": "Grace", "system_prompt": "You are Grace."}
    loaded = _load({"persona": persona, "plan": {"system_prompt": "You are old."}})
    assert loaded["system_prompt"] == "You are Grace."


def test_a_config_without_persona_uses_the_plan_system_prompt():
    loaded = _load({"plan": {"system_prompt": "You are Grace, a coach.", "voice": "grace"}})
    assert loaded is not None
    assert loaded["system_prompt"] == "You are Grace, a coach."
    assert loaded["voice"] == "grace"
    assert not loaded.get("is_system_default")


def test_neither_persona_nor_plan_prompt_means_no_persona():
    assert _load({"plan": {"states": []}}) is None
    assert _load({}) is None


def test_a_blank_plan_prompt_is_not_an_identity():
    assert _load({"plan": {"system_prompt": "   "}}) is None
