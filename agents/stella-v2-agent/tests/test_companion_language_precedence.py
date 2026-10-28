"""#58: in companion mode, an activity's own plan must never pin the session's
language — only the deployment's pin, then the persona's, then detection.
The activity's own language becomes a turn-scoped hint to the model instead,
never a pin, and disappears again the moment the activity ends (nothing to
"restore", because nothing was ever overwritten).

Felix's decision (19 Oct 2026, ref 7f897946): deployment pin > persona >
detection, with no plan pinning in companion mode; the hint applies only
while the activity runs.
"""

from stella_agent_sdk.language import LanguageResolver
from stella_v2_agent.agent import StellaV2Agent


def _agent(*, companion: bool, resolver: LanguageResolver, persona_language=None, plan_config=None):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent._companion_mode = companion
    agent.language_resolver = resolver
    agent._persona_config = {"language": persona_language} if persona_language else None
    agent._plan_config = plan_config
    agent._audio_pipeline = None  # has_audio -> False, so set_stt_language is never touched
    return agent


# ─────────────────────── _apply_session_language_pin ───────────────────────

def test_deployment_pin_outranks_the_persona_and_the_activity():
    resolver = LanguageResolver(forced="de")  # the deployment's own pin
    agent = _agent(
        companion=True, resolver=resolver,
        persona_language="en",  # would win if there were no deployment pin
        plan_config={"language": "fr"},  # an activity -- must never be consulted at all
    )
    agent._apply_session_language_pin()
    assert resolver.forced == "de"
    assert resolver.deployment_pin == "de"


def test_persona_pins_when_there_is_no_deployment_pin():
    resolver = LanguageResolver()  # no deployment pin
    agent = _agent(
        companion=True, resolver=resolver,
        persona_language="de",
        plan_config={"language": "en"},  # still must not be consulted
    )
    agent._apply_session_language_pin()
    assert resolver.forced == "de"


def test_an_activitys_plan_never_pins_the_session_in_companion_mode():
    resolver = LanguageResolver()  # no deployment pin, no persona language either
    agent = _agent(
        companion=True, resolver=resolver,
        persona_language=None,
        plan_config={"language": "en"},
    )
    agent._apply_session_language_pin()
    assert resolver.forced is None  # detection is free to run, same as free conversation


def test_plan_following_deployments_are_unchanged():
    # Not companion mode at all: the old behavior, unchanged by #58.
    resolver = LanguageResolver()
    agent = _agent(companion=False, resolver=resolver, plan_config={"language": "de"})
    agent._apply_session_language_pin()
    assert resolver.forced == "de"


def test_deployment_pin_is_untouched_by_set_plan_language_calls():
    # The structural fix, proven directly: captured once at construction,
    # `deployment_pin` survives whatever `set_plan_language` does elsewhere.
    resolver = LanguageResolver(forced="de")
    resolver.set_plan_language("en")  # a plan-following deployment's own call, say
    assert resolver.forced == "en"
    assert resolver.deployment_pin == "de"  # unchanged


# ─────────────────────── _activity_content_language ───────────────────────

def test_hints_the_activitys_language_when_it_differs_from_the_session():
    agent = _agent(
        companion=True, resolver=LanguageResolver(),
        plan_config={"language": "en"},
    )
    assert agent._activity_content_language("de") == "en"


def test_no_hint_when_the_activitys_language_matches_the_session():
    agent = _agent(
        companion=True, resolver=LanguageResolver(),
        plan_config={"language": "de"},
    )
    assert agent._activity_content_language("de") is None


def test_no_hint_outside_an_activity():
    agent = _agent(companion=True, resolver=LanguageResolver(), plan_config=None)
    assert agent._activity_content_language("de") is None


def test_no_hint_in_plan_following_mode():
    # The hint is a companion-mode concept only -- a plan-following deployment's
    # plan already pins the session outright, there is no mismatch to flag.
    agent = _agent(companion=False, resolver=LanguageResolver(), plan_config={"language": "en"})
    assert agent._activity_content_language("de") is None


def test_the_hint_disappears_the_turn_after_leaving_the_activity():
    # Turn-scoped by construction: no explicit "clear" needed, since the value
    # is derived fresh from _plan_config every turn.
    agent = _agent(
        companion=True, resolver=LanguageResolver(),
        plan_config={"language": "en"},
    )
    assert agent._activity_content_language("de") == "en"
    agent._plan_config = None  # what _leave_activity does
    assert agent._activity_content_language("de") is None


def test_a_pause_and_resume_mid_activity_needs_nothing_restored():
    # #58's second "done when": the same behavior after a pause/resume in the
    # middle of an activity. _rehydrate_active_activity just sets
    # _plan_config back to the activity's plan -- there is no separate
    # language state to restore because the session's own pin was never
    # touched by the activity in the first place.
    resolver = LanguageResolver(forced="de")  # the session's own pin throughout
    agent = _agent(
        companion=True, resolver=resolver,
        plan_config={"language": "en"},
    )
    agent._apply_session_language_pin()
    assert resolver.forced == "de"
    assert agent._activity_content_language("de") == "en"

    # The pod restarts; the activity is still running; _rehydrate_active_activity
    # sets _plan_config back to the SAME plan.
    agent._plan_config = None  # simulate the gap before rehydration runs
    agent._apply_session_language_pin()
    assert resolver.forced == "de"  # untouched the whole time
    agent._plan_config = {"language": "en"}  # rehydration restores it
    agent._apply_session_language_pin()
    assert resolver.forced == "de"  # still untouched
    assert agent._activity_content_language("de") == "en"  # hint picks back up
