"""Verdict rules (#221): merging, checking, stepping down, the safety floor and gates."""

from stella_agent_sdk.experts.verdict_rules import (
    REACTIONS,
    RULE_FIELDS,
    Gate,
    VerdictRuleSupport,
    check_verdict_rules,
    expert_enabled,
    gated_experts,
    may_drop_for,
    merge_verdict_directives,
    never_step_down,
    settle_verdict,
)

MEDICAL = {
    "name": "medical",
    "safety": True,
    "verdict_directives": {
        "none": {"action": "inform"},
        "low": {"action": "inform", "min_confidence": 0.6, "below": "none"},
        "high": {"action": "prepend", "template": "careful", "flag": True, "min_confidence": 0.6, "below": "low"},
        "critical": {"action": "override", "template": "call help", "flag": True, "min_confidence": 0.9, "below": "high"},
    },
}
EVERY_FIELD = VerdictRuleSupport(REACTIONS, ("flag", "tone", "must_avoid", "reaction", "reaction_field", "min_confidence", "below", "overrides"))


# --- merge -----------------------------------------------------------------

def test_a_saved_verdict_replaces_only_the_fields_it_names():
    merged = merge_verdict_directives(MEDICAL["verdict_directives"], {"high": {"template": "mine"}})
    assert merged["high"] == {**MEDICAL["verdict_directives"]["high"], "template": "mine"}


def test_a_configuration_saved_before_the_new_fields_keeps_their_defaults():
    # What a configuration saved before #221 holds: the old three fields only.
    old = {"high": {"action": "prepend", "template": "x", "description": "d"}}
    merged = merge_verdict_directives(MEDICAL["verdict_directives"], old)
    assert merged["high"]["flag"] is True and merged["high"]["below"] == "low"


def test_a_verdict_only_the_configuration_has_is_kept_and_defaults_are_not_mutated():
    before = {k: dict(v) for k, v in MEDICAL["verdict_directives"].items()}
    merged = merge_verdict_directives(MEDICAL["verdict_directives"], {"extra": {"action": "inform"}, "low": "junk"})
    assert merged["extra"] == {"action": "inform"}
    assert merged["low"] == before["low"]
    assert MEDICAL["verdict_directives"] == before


# --- check -----------------------------------------------------------------

def test_an_unknown_reaction_is_refused():
    problems = check_verdict_rules("probing", {"unclear": {"reaction": "sing"}}, EVERY_FIELD)
    assert len(problems) == 1 and 'unknown reaction "sing"' in problems[0]


def test_a_reaction_the_agent_did_not_declare_is_refused():
    support = VerdictRuleSupport(("ask_followup",), ("reaction",))
    problems = check_verdict_rules("probing", {"unclear": {"reaction": "ask_back"}}, support)
    assert problems == ['expert "probing" verdict "unclear": this agent does not support the reaction "ask_back"']
    assert check_verdict_rules("probing", {"unclear": {"reaction": "ask_followup"}}, support) == []


def test_a_field_the_agent_did_not_declare_is_refused():
    support = VerdictRuleSupport((), ("flag",))
    problems = check_verdict_rules("medical", {"high": {"flag": True, "min_confidence": 0.5, "below": "none"}, "none": {}}, support)
    assert any('"min_confidence"' in p for p in problems) and any('"below"' in p for p in problems)


def test_bad_confidence_and_dangling_below_are_refused():
    problems = check_verdict_rules("x", {"a": {"min_confidence": 1.5, "below": "nowhere"}}, EVERY_FIELD)
    assert len(problems) == 2


def test_the_old_fields_alone_pass_on_an_agent_that_declares_nothing():
    assert check_verdict_rules("medical", {"high": {"action": "prepend", "template": "x"}}, VerdictRuleSupport()) == []


# --- settle ----------------------------------------------------------------

def test_a_verdict_holds_when_the_agent_is_sure_enough():
    assert settle_verdict("high", {"high": 0.7}, MEDICAL["verdict_directives"]) == "high"


def test_a_verdict_steps_down_until_the_weight_reaches_the_floor():
    # Jev's rule: high at 0.44 isn't enough, high+low at 0.7 is.
    assert settle_verdict("high", {"high": 0.44, "low": 0.26}, MEDICAL["verdict_directives"]) == "low"
    assert settle_verdict("high", {"high": 0.3, "low": 0.1}, MEDICAL["verdict_directives"]) == "none"


def test_a_safety_experts_critical_is_never_stepped_down_even_if_configured_to():
    assert never_step_down(MEDICAL) == ("critical",)
    assert settle_verdict("critical", {"critical": 0.2}, MEDICAL["verdict_directives"], never_step_down(MEDICAL)) == "critical"
    # Another expert's "critical" has no floor.
    assert never_step_down({"name": "x"}) == ()


def test_a_below_loop_stops():
    loop = {"a": {"min_confidence": 1, "below": "b"}, "b": {"min_confidence": 1, "below": "a"}}
    assert settle_verdict("a", {}, loop) == "b"


# --- safety floor ----------------------------------------------------------

def test_a_configuration_missing_the_setting_keeps_a_safety_expert_on():
    assert expert_enabled(MEDICAL, None) is True
    assert expert_enabled(MEDICAL, {}) is True


def test_enabled_false_alone_does_not_switch_a_safety_expert_off():
    assert expert_enabled(MEDICAL, {"enabled": False}) is True
    assert expert_enabled(MEDICAL, {"enabled": False, "safety_off": {"confirmed": False}}) is True


def test_only_a_recorded_confirmed_safety_off_switches_it_off():
    record = {"safety_off": {"confirmed": True, "by": "researcher@example.org", "at": "2026-11-27T15:00:00Z"}}
    assert expert_enabled(MEDICAL, record) is False


def test_other_experts_follow_enabled():
    assert expert_enabled({"name": "probing"}, {"enabled": False}) is False
    assert expert_enabled({"name": "probing", "enabled": False}, None) is False
    assert expert_enabled({"name": "probing"}, None) is True


def test_an_unfillable_placeholder_cannot_drop_a_safety_expert():
    # The path PR 1001 added: V2 drops an expert whose prompt the session's
    # compiler can't fill, e.g. {{persona.name}} under an old 1.0.0 pin.
    assert may_drop_for(MEDICAL, None) is False
    assert may_drop_for(MEDICAL, {"safety_off": {"confirmed": True}}) is True
    assert may_drop_for({"name": "probing"}, None) is True


# --- gates -----------------------------------------------------------------

def test_a_gate_skips_an_expert_when_another_says_so_sure_enough():
    gate = Gate.parse({"skip": "task_extraction", "when": "has_answer", "verdicts": ["no"], "min_confidence": 0.7})
    assert gated_experts([gate], {"has_answer": ("no", 0.8)}) == {"task_extraction"}
    assert gated_experts([gate], {"has_answer": ("no", 0.5)}) == set()
    assert gated_experts([gate], {"has_answer": ("yes", 0.9)}) == set()


def test_a_malformed_gate_is_not_parsed():
    assert Gate.parse({"skip": "x", "when": "y"}) is None
    assert Gate.parse({"skip": "x", "when": "y", "verdicts": ["a"], "min_confidence": True}) is None


def test_check_refuses_wrong_types_without_raising():
    support = VerdictRuleSupport(("ask_followup",), RULE_FIELDS)
    rules = {"a": {"below": ["b"], "flag": "yes", "must_avoid": "one line", "tone": 3, "reaction": {"x": 1}}}
    problems = check_verdict_rules("x", rules, support)
    assert len(problems) == 5


def test_declaring_reactions_implies_the_reaction_field():
    support = VerdictRuleSupport.from_declaration({"reactions": ["ask_followup"], "fields": []})
    assert check_verdict_rules("probing", {"unclear": {"reaction": "ask_followup"}}, support) == []
