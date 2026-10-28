"""#87: the bridge must never agree to or name a specific activity as settled
before companion.decide() has judged whether the title was said precisely
enough to start it outright, because a bridge that already committed cannot
be un-said once the system goes on to ask "did you mean X?" instead.

``_activities_on_offer()`` is the gate: true only in companion free
conversation (not already in an activity) with activities actually on offer
-- exactly the turns where that premature commitment could happen, and the
only input the bridge needs, since it is set before the companion router has
even run.
"""

from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.companion import Companion


def _agent(*, companion_mode: bool, active=None, activities=None):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent._companion_mode = companion_mode
    agent.companion = Companion(activities=activities or [], active=active)
    return agent


def test_true_in_companion_free_conversation_with_activities_on_offer():
    agent = _agent(companion_mode=True, activities=[{"id": "a1", "title": "English Check-in"}])
    assert agent._activities_on_offer() is True


def test_false_outside_companion_mode():
    agent = _agent(companion_mode=False, activities=[{"id": "a1", "title": "English Check-in"}])
    assert agent._activities_on_offer() is False


def test_false_with_no_activities_offered():
    agent = _agent(companion_mode=True, activities=[])
    assert agent._activities_on_offer() is False


def test_false_once_an_activity_is_already_running():
    # Inside the activity there is nothing left to pick -- decide() routes on
    # the exit dialogue instead, not activity selection.
    agent = _agent(
        companion_mode=True,
        active={"id": "a1", "title": "English Check-in"},
        activities=[{"id": "a1", "title": "English Check-in"}],
    )
    assert agent._activities_on_offer() is False
