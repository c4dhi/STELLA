"""#222: a saved configuration lays verdict rules over the expert files field
by field, and a safety expert only goes off with a recorded safety_off."""

from stella_v2_agent.experts.registry import ExpertRegistry


def _registry(overrides):
    registry = ExpertRegistry()
    registry.apply_config({"experts": overrides})
    return registry


def test_a_configuration_saved_before_the_rules_keeps_their_defaults():
    saved = {"medical": {"verdict_directives": {"high": {"action": "prepend", "template": "Saved text."}}}}
    high = _registry(saved).get("medical").verdict_directives["high"]
    assert high.template == "Saved text."
    assert high.flag is True and high.tone == "cautious"
    assert "specific medical diagnoses or treatment plans" in high.must_avoid
    assert high.overrides == ["probing"]


def test_a_saved_rule_field_wins():
    saved = {"probing": {"verdict_directives": {"needs_clarification": {"tone": "warm", "reaction": "redirect"}}}}
    rule = _registry(saved).get("probing").verdict_directives["needs_clarification"]
    assert (rule.tone, rule.reaction, rule.flag) == ("warm", "redirect", True)


def test_enabled_false_does_not_switch_off_a_safety_expert():
    registry = _registry({"medical": {"enabled": False}, "probing": {"enabled": False}})
    assert registry.get("medical").enabled is True
    assert registry.get("probing").enabled is False


def test_a_recorded_safety_off_does():
    record = {"confirmed": True, "by": "a researcher", "at": "2026-11-27T15:00:00Z"}
    assert _registry({"legal": {"enabled": False, "safety_off": record}}).get("legal").enabled is False
    assert _registry({"legal": {"enabled": False, "safety_off": {"confirmed": False}}}).get("legal").enabled is True


def test_medical_and_legal_are_the_safety_experts():
    safety = {name for name, cfg in ExpertRegistry().as_map().items() if cfg.safety}
    assert safety == {"medical", "legal"}


def test_a_saved_entry_cannot_change_what_belongs_to_the_file():
    registry = _registry({"medical": {"safety": False, "enabled": False}, "task_extraction": {"surfaces_recommendation": True}})
    assert registry.get("medical").safety is True
    assert registry.get("medical").enabled is True
    assert registry.get("task_extraction").surfaces_recommendation is False
