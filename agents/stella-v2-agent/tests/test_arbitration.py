"""Tests for the Arbitration stage (Stage 3 of the stella-v2 pipeline).

Arbitration is deterministic pure-Python logic — no LLM calls, no I/O.
It receives a list of ExpertVerdict objects and resolves conflicts into a
single ResponseDirective that the Response Generator uses.

What we test here:
- Empty verdicts produce a neutral, no-action directive
- noise_detection "unclear" short-circuits everything else
- Priority ordering: higher-priority expert wins when two experts conflict
- medical/legal verdicts add must_avoid constraints
- probing verdict sets follow-up questions and deliverable signals
- timekeeper sets a follow-up only when probing hasn't already set one
- Conflict detection between safety experts and probing
- Custom tone map override via apply_config()
- Custom gate failure message via apply_config()
"""

from stella_v2_agent.pipeline.arbitration import Arbitration
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.experts.base import ExpertConfig, VerdictDirective


# ---------------------------------------------------------------------------
# Helpers: build ExpertVerdict objects with sensible defaults so each test
# only has to set the fields it actually cares about.
# ---------------------------------------------------------------------------

def _verdict(
    name: str,
    verdict: str,
    confidence: float = 0.9,
    recommendation: str = "",
    priority: int = 50,
    success: bool = True,
    raw_output: dict | None = None,
) -> ExpertVerdict:
    """Build a minimal ExpertVerdict for use in tests."""
    return ExpertVerdict(
        expert_name=name,
        verdict=verdict,
        confidence=confidence,
        recommendation=recommendation,
        priority=priority,
        success=success,
        raw_output=raw_output or {},
    )


# ---------------------------------------------------------------------------
# No verdicts
# ---------------------------------------------------------------------------

def test_empty_verdicts_returns_neutral_directive():
    # With no experts active, arbitration should produce a safe neutral default.
    arb = Arbitration()
    result = arb.resolve([])

    assert result.directive.tone == "neutral"
    assert result.directive.short_circuit is False
    assert result.directive.primary_action == ""
    assert result.directive.ask_followup is False
    assert result.favored_expert == ""


# ---------------------------------------------------------------------------
# noise_detection short-circuit
# ---------------------------------------------------------------------------

def test_noise_detection_unclear_short_circuits_all_other_experts():
    # noise_detection "unclear" is the highest-priority override in the system.
    # It must cancel all other expert processing and return a clarification message.
    arb = Arbitration()
    verdicts = [
        _verdict("noise_detection", "unclear", priority=100),
        # probing would normally set a follow-up — noise_detection must override it
        _verdict("probing", "needs_clarification", priority=60, recommendation="Tell me more"),
    ]

    result = arb.resolve(verdicts)

    assert result.directive.short_circuit is True
    # The redirect message should be set (either default or custom)
    assert result.directive.redirect_message != ""
    assert result.favored_expert == "noise_detection"


def test_noise_detection_clear_does_not_short_circuit():
    # "clear" verdict means the input was understandable — pipeline continues normally.
    arb = Arbitration()
    verdicts = [_verdict("noise_detection", "clear", priority=100)]

    result = arb.resolve(verdicts)

    assert result.directive.short_circuit is False


# ---------------------------------------------------------------------------
# Priority ordering
# ---------------------------------------------------------------------------

def test_higher_priority_expert_tone_wins():
    # When two experts flag something, the one with the higher priority number
    # should set the tone. medical (95) > probing (60).
    arb = Arbitration()
    verdicts = [
        _verdict("medical", "high", priority=95, recommendation="Refer to a doctor"),
        _verdict("probing", "needs_clarification", priority=60, recommendation="Ask more"),
    ]

    result = arb.resolve(verdicts)

    # medical has higher priority — it should be the favored expert
    assert result.favored_expert == "medical"
    # medical maps to "cautious" tone in the default tone map
    assert result.directive.tone == "cautious"


def test_lower_priority_expert_does_not_override_primary_action():
    # The primary_action comes from the highest-priority non-task expert.
    # A lower-priority expert's recommendation must not replace it.
    arb = Arbitration()
    verdicts = [
        _verdict("medical", "high", priority=95, recommendation="See a specialist"),
        _verdict("probing", "needs_clarification", priority=60, recommendation="Ask about symptoms"),
    ]

    result = arb.resolve(verdicts)

    # Primary action must come from medical (highest priority)
    assert result.directive.primary_action == "See a specialist"


# ---------------------------------------------------------------------------
# medical / legal must_avoid
# ---------------------------------------------------------------------------

def test_medical_high_verdict_adds_must_avoid():
    # When medical flags "high" risk, the response must avoid specific medical advice.
    arb = Arbitration()
    verdicts = [_verdict("medical", "high", priority=95)]

    result = arb.resolve(verdicts)

    assert any("medical" in item for item in result.directive.must_avoid)


def test_legal_critical_verdict_adds_must_avoid():
    # Same rule for legal at "critical" severity.
    arb = Arbitration()
    verdicts = [_verdict("legal", "critical", priority=90)]

    result = arb.resolve(verdicts)

    assert any("legal" in item for item in result.directive.must_avoid)


def test_medical_high_verdict_also_avoids_personal_tips():
    # #705: a flagged medical concern must also hold back home remedies and
    # personal tips, not just diagnoses/treatment plans — that's the gap that
    # let a plan step's "give a small personal suggestion" through unchecked.
    arb = Arbitration()
    result = arb.resolve([_verdict("medical", "high", priority=95)])

    assert any("tip" in item for item in result.directive.must_avoid)


def test_legal_critical_verdict_also_avoids_personal_tips():
    arb = Arbitration()
    result = arb.resolve([_verdict("legal", "critical", priority=90)])

    assert any("tip" in item for item in result.directive.must_avoid)


def test_medical_low_verdict_does_not_add_must_avoid():
    # "low" risk from medical does not add a must_avoid constraint —
    # only "high" and "critical" trigger it.
    arb = Arbitration()
    verdicts = [_verdict("medical", "low", priority=95)]

    result = arb.resolve(verdicts)

    assert result.directive.must_avoid == []


# ---------------------------------------------------------------------------
# probing expert
# ---------------------------------------------------------------------------

def test_probing_needs_clarification_sets_followup():
    # probing "needs_clarification" should tell the response generator to ask
    # a specific follow-up question.
    arb = Arbitration()
    verdicts = [
        _verdict(
            "probing",
            "needs_clarification",
            priority=60,
            recommendation="Can you describe the pain level?",
        )
    ]

    result = arb.resolve(verdicts)

    assert result.directive.ask_followup is True
    assert result.directive.followup_question == "Can you describe the pain level?"


def test_probing_gentle_redirect_sets_redirect():
    # probing "gentle_redirect" should force a redirect without a follow-up question.
    arb = Arbitration()
    verdicts = [
        _verdict(
            "probing",
            "gentle_redirect",
            priority=60,
            recommendation="Let's stay on topic.",
        )
    ]

    result = arb.resolve(verdicts)

    assert result.directive.force_redirect is True
    assert result.directive.redirect_message == "Let's stay on topic."


def test_probing_extracts_deliverable_signals_from_raw_output():
    # probing can signal which deliverables the user just provided.
    # These are used to acknowledge the user's input in the response.
    arb = Arbitration()
    verdicts = [
        _verdict(
            "probing",
            "needs_clarification",
            priority=60,
            raw_output={"deliverable_signals": ["user_name", "user_age"]},
        )
    ]

    result = arb.resolve(verdicts)

    assert "user_name" in result.directive.deliverable_signals
    assert "user_age" in result.directive.deliverable_signals


def test_probing_ignores_non_list_deliverable_signals():
    # Malformed raw_output (signals not a list) should not crash or produce bad state.
    arb = Arbitration()
    verdicts = [
        _verdict(
            "probing",
            "needs_clarification",
            priority=60,
            raw_output={"deliverable_signals": "not_a_list"},
        )
    ]

    result = arb.resolve(verdicts)

    # Should fall back to empty — no crash, no partial data
    assert result.directive.deliverable_signals == []


# ---------------------------------------------------------------------------
# timekeeper expert
# ---------------------------------------------------------------------------

def test_timekeeper_stuck_sets_followup_when_probing_did_not():
    # If probing didn't set a follow-up and timekeeper says the user is stuck,
    # timekeeper's recommendation should be used as the follow-up question.
    arb = Arbitration()
    verdicts = [
        _verdict(
            "timekeeper",
            "stuck",
            priority=50,
            recommendation="You seem stuck — want to move on?",
        )
    ]

    result = arb.resolve(verdicts)

    assert result.directive.ask_followup is True
    assert result.directive.followup_question == "You seem stuck — want to move on?"


def test_timekeeper_does_not_override_probing_followup():
    # probing takes priority: if it already set a follow-up question,
    # timekeeper must not replace it.
    arb = Arbitration()
    verdicts = [
        _verdict("probing", "needs_clarification", priority=60, recommendation="Probing question"),
        _verdict("timekeeper", "stuck", priority=50, recommendation="Timekeeper question"),
    ]

    result = arb.resolve(verdicts)

    # Probing's question must survive
    assert result.directive.followup_question == "Probing question"


# ---------------------------------------------------------------------------
# Conflict detection
# ---------------------------------------------------------------------------

def test_conflict_detected_between_medical_high_and_probing():
    # medical "high" + probing "needs_clarification" is a conflict:
    # safety takes priority but probing wants to dig deeper.
    arb = Arbitration()
    verdicts = [
        _verdict("medical", "high", priority=95),
        _verdict("probing", "needs_clarification", priority=60),
    ]

    result = arb.resolve(verdicts)

    # At least one conflict should be recorded
    assert len(result.conflicts) > 0
    assert any("medical" in c for c in result.conflicts)


def test_no_conflict_when_only_one_expert_active():
    # A single active expert cannot conflict with itself.
    arb = Arbitration()
    verdicts = [_verdict("probing", "needs_clarification", priority=60)]

    result = arb.resolve(verdicts)

    assert result.conflicts == []


# ---------------------------------------------------------------------------
# apply_config overrides
# ---------------------------------------------------------------------------

def test_apply_config_custom_tone_map():
    # apply_config() allows overriding the tone for a specific expert.
    arb = Arbitration()
    arb.apply_config({"tone_map": {"probing": "empathetic"}})

    verdicts = [_verdict("probing", "needs_clarification", priority=60)]
    result = arb.resolve(verdicts)

    # Custom tone must be used instead of the default "curious"
    assert result.directive.tone == "empathetic"


def test_apply_config_custom_gate_failure_message():
    # The gate failure message (used on short-circuit) can be overridden.
    arb = Arbitration()
    arb.apply_config({"gate_failure_message": "Please rephrase your question."})

    verdicts = [_verdict("noise_detection", "unclear", priority=100)]
    result = arb.resolve(verdicts)

    assert result.directive.redirect_message == "Please rephrase your question."


# ---------------------------------------------------------------------------
# task_extraction expert
# ---------------------------------------------------------------------------

def test_task_extraction_verdict_does_not_set_primary_action():
    # task_extraction is an internal expert — its recommendations are metadata,
    # never surfaced as response directions. Tone should remain neutral.
    arb = Arbitration()
    verdicts = [
        _verdict(
            "task_extraction",
            "tool_calls_executed",
            priority=70,
            recommendation="Collected user_name",
        )
    ]

    result = arb.resolve(verdicts)

    # task_extraction must never set primary_action or change tone
    assert result.directive.primary_action == ""
    assert result.directive.tone == "neutral"


# ---------------------------------------------------------------------------
# Deterministic verdict directives (literature-informed responses)
# ---------------------------------------------------------------------------

def _expert(name: str, priority: int, directives: dict | None = None) -> ExpertConfig:
    """Build a minimal ExpertConfig with verdict_directives for arbitration tests."""
    return ExpertConfig(name=name, priority=priority, verdict_directives=directives or {})


def test_override_directive_replaces_response():
    # A medical "critical" verdict configured as "override" must deterministically
    # replace the generated response, set the action, and keep the back-compat
    # short_circuit flag so existing interception consumers keep working.
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"critical": VerdictDirective("override", "Please call emergency services.")})}

    result = arb.resolve([_verdict("medical", "critical", priority=95)], expert_configs=configs)

    assert result.directive.action == "override"
    assert result.directive.resolved_response == "Please call emergency services."
    assert result.directive.short_circuit is True
    assert result.directive.directive_source == "medical"
    assert result.favored_expert == "medical"


def test_short_circuit_directive_replaces_and_returns_early():
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"critical": VerdictDirective("short_circuit", "I can't help with that here.")})}

    result = arb.resolve([_verdict("medical", "critical", priority=95)], expert_configs=configs)

    assert result.directive.action == "short_circuit"
    assert result.directive.resolved_response == "I can't help with that here."
    # Early return — none of the normal probing/timekeeper passes ran.
    assert result.directive.ask_followup is False


def test_prepend_directive_keeps_normal_passes():
    # "prepend" speaks the template first but still lets the LLM write the reply,
    # so the normal must_avoid pass must still run for medical "high".
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"high": VerdictDirective("prepend", "I can't give medical advice.")})}

    result = arb.resolve([_verdict("medical", "high", priority=95)], expert_configs=configs)

    assert result.directive.action == "prepend"
    assert result.directive.resolved_response == "I can't give medical advice."
    assert any("medical" in item for item in result.directive.must_avoid)
    assert result.directive.short_circuit is False


def test_empty_prepend_template_does_not_inject_gate_failure_message():
    # An empty prepend template must mean "add nothing before the reply" — NOT
    # speak the "didn't catch that" gate-failure line ahead of a normal answer.
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"high": VerdictDirective("prepend", "")})}

    result = arb.resolve([_verdict("medical", "high", priority=95)], expert_configs=configs)

    assert result.directive.action == "prepend"
    assert result.directive.resolved_response == ""
    assert result.directive.resolved_response != arb.gate_failure_message


def test_empty_override_template_falls_back_to_safe_default():
    # A replace action (override/short_circuit) with an empty/failed template must
    # fall back to the safe locale-aware line so we never speak an empty turn.
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"critical": VerdictDirective("override", "")})}

    result = arb.resolve([_verdict("medical", "critical", priority=95)], expert_configs=configs)

    assert result.directive.action == "override"
    assert result.directive.resolved_response == arb.gate_failure_message


def test_failed_template_compile_fails_closed_not_raw_template():
    # An unresolvable compiler version must NOT speak the raw template (literal
    # {{placeholders}}); it fails closed to the safe default for a replace action.
    arb = Arbitration()
    arb.set_compiler_version("999.0.0")  # unregistered → compile raises internally
    configs = {
        "medical": _expert(
            "medical", 95, {"critical": VerdictDirective("override", "Call {{user_name}} now")}
        )
    }

    result = arb.resolve([_verdict("medical", "critical", priority=95)], expert_configs=configs)

    assert "{{" not in result.directive.resolved_response
    assert result.directive.resolved_response == arb.gate_failure_message


def test_directive_winner_resolves_by_priority():
    # Two experts both carry an "override" directive — the higher-priority one wins.
    arb = Arbitration()
    configs = {
        "medical": _expert("medical", 95, {"high": VerdictDirective("override", "MED")}),
        "legal": _expert("legal", 90, {"high": VerdictDirective("override", "LEG")}),
    }
    verdicts = [
        _verdict("legal", "high", priority=90),
        _verdict("medical", "high", priority=95),
    ]

    result = arb.resolve(verdicts, expert_configs=configs)

    assert result.directive.directive_source == "medical"
    assert result.directive.resolved_response == "MED"


def test_template_placeholders_compile():
    # Verdict templates support {{placeholders}} resolved against the live turn.
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"critical": VerdictDirective("override", "Re: {{user_message}}")})}

    result = arb.resolve(
        [_verdict("medical", "critical", priority=95)],
        expert_configs=configs,
        user_input="my chest hurts",
    )

    assert result.directive.resolved_response == "Re: my chest hurts"


def _multilingual_medical_config() -> dict:
    directive = VerdictDirective(
        action="override", template="Call for help.", template_i18n={"de": "Hol Hilfe."},
    )
    return {"medical": _expert("medical", 95, {"critical": directive})}


def test_a_language_keyed_template_resolves_to_the_turns_language():
    # #705: a verdict directive may carry template_i18n overrides of its plain
    # template, resolved from sm_context["language"] — same pattern as
    # _GATE_FAILURE_MESSAGES_BY_LANG. Kept as a separate field (not a dict
    # template) because the Agent Configurator's TypeScript contract assumes
    # template is always a plain string.
    arb = Arbitration()

    result = arb.resolve(
        [_verdict("medical", "critical", priority=95)],
        sm_context={"language": "de"},
        expert_configs=_multilingual_medical_config(),
    )

    assert result.directive.resolved_response == "Hol Hilfe."


def test_a_language_keyed_template_falls_back_to_english_for_an_unknown_language():
    arb = Arbitration()

    result = arb.resolve(
        [_verdict("medical", "critical", priority=95)],
        sm_context={"language": "fr"},
        expert_configs=_multilingual_medical_config(),
    )

    assert result.directive.resolved_response == "Call for help."


def test_a_language_keyed_template_falls_back_to_english_with_no_language_at_all():
    arb = Arbitration()

    result = arb.resolve(
        [_verdict("medical", "critical", priority=95)],
        expert_configs=_multilingual_medical_config(),
    )

    assert result.directive.resolved_response == "Call for help."


def test_a_plain_string_template_is_unaffected_by_language_resolution():
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {"critical": VerdictDirective("override", "Call for help.")})}

    result = arb.resolve(
        [_verdict("medical", "critical", priority=95)],
        sm_context={"language": "de"},
        expert_configs=configs,
    )

    assert result.directive.resolved_response == "Call for help."


def test_explicit_inform_directive_suppresses_noise_fallback():
    # An explicit "inform" entry on noise_detection means the operator opted out
    # of the legacy short-circuit — the pipeline must continue normally.
    arb = Arbitration()
    configs = {"noise_detection": _expert("noise_detection", 100, {"unclear": VerdictDirective("inform", "")})}

    result = arb.resolve([_verdict("noise_detection", "unclear", priority=100)], expert_configs=configs)

    assert result.directive.action == "inform"
    assert result.directive.short_circuit is False


def test_empty_directives_preserve_legacy_behavior():
    # With an expert config that carries no directives, arbitration behaves exactly
    # as before: tone + primary_action, action stays "inform".
    arb = Arbitration()
    configs = {"medical": _expert("medical", 95, {})}

    result = arb.resolve(
        [_verdict("medical", "high", priority=95, recommendation="see a doctor")],
        expert_configs=configs,
    )

    assert result.directive.action == "inform"
    assert result.directive.tone == "cautious"
    assert result.directive.primary_action == "see a doctor"


def test_seeded_noise_short_circuit_uses_gate_failure_message():
    # The seeded noise_detection directive ships an empty template, which resolves
    # to the locale-aware gate failure message.
    arb = Arbitration()
    arb.apply_config({"gate_failure_message": "Please repeat."})
    configs = {"noise_detection": _expert("noise_detection", 100, {"unclear": VerdictDirective("short_circuit", "")})}

    result = arb.resolve([_verdict("noise_detection", "unclear", priority=100)], expert_configs=configs)

    assert result.directive.resolved_response == "Please repeat."
    assert result.directive.redirect_message == "Please repeat."


def test_noise_fallback_without_configs_still_short_circuits():
    # Back-compat: an un-migrated deployment (no expert_configs passed) keeps the
    # hardcoded noise short-circuit behavior.
    arb = Arbitration()

    result = arb.resolve([_verdict("noise_detection", "unclear", priority=100)])

    assert result.directive.action == "short_circuit"
    assert result.directive.short_circuit is True
    assert result.favored_expert == "noise_detection"
