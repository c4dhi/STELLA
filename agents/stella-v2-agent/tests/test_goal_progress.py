"""What counts as progress for the no-progress turn counter (#706).

A goal state accepts keys the plan does not define ("discovered insights"), and
an agent can re-record a hesitant answer as hesitant turn after turn. If either
counted as progress, the stuck-state net would never release the state.
"""

from stella_v2_agent.agent import StellaV2Agent


def full_state(**statuses):
    return {
        "states": [
            {
                "id": "rapport",
                "tasks": [
                    {
                        "id": "__goal_deliverables__",
                        "deliverables": [
                            *({"key": key, "status": status} for key, status in statuses.items()),
                            {"key": "likes_gardening", "status": "completed", "discovered": True},
                        ],
                    }
                ],
            },
            {"id": "closing", "tasks": [{"id": "t1", "deliverables": [{"key": "rating", "status": "pending"}]}]},
        ]
    }


statuses = StellaV2Agent._deliverable_statuses
moved = StellaV2Agent._deliverables_moved_forward

NOTHING = statuses(full_state(client_name="pending", trigger="pending"))


def test_insights_are_not_among_the_defined_deliverables():
    assert NOTHING == {"client_name": "pending", "trigger": "pending", "rating": "pending"}
    assert statuses(None) is None


def test_a_newly_recorded_answer_is_progress():
    after = statuses(full_state(client_name="completed", trigger="pending"))
    assert moved(["client_name"], NOTHING, after)


def test_a_hesitant_answer_recorded_for_the_first_time_is_progress():
    after = statuses(full_state(client_name="pending", trigger="partial"))
    assert moved(["trigger"], NOTHING, after)


def test_re_recording_a_hesitant_answer_as_hesitant_is_not_progress():
    hesitant = statuses(full_state(client_name="pending", trigger="partial"))
    assert not moved(["trigger"], hesitant, hesitant)


def test_confirming_a_hesitant_answer_is_progress():
    before = statuses(full_state(client_name="pending", trigger="partial"))
    after = statuses(full_state(client_name="pending", trigger="completed"))
    assert moved(["trigger"], before, after)


def test_an_insight_alone_is_not_progress():
    assert not moved(["likes_gardening"], NOTHING, NOTHING)
    assert not moved(["something_new"], NOTHING, NOTHING)


def test_nothing_written_is_not_progress():
    assert not moved([], NOTHING, NOTHING)


def test_on_the_first_turn_any_defined_key_counts():
    assert moved(["client_name"], None, NOTHING)
    assert not moved(["something_new"], None, NOTHING)


def test_without_a_plan_view_any_write_counts():
    assert moved(["anything"], None, None)
