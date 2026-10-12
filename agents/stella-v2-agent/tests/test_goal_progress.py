"""What counts as progress for the no-progress turn counter (#706).

A goal state accepts keys the plan does not define ("discovered insights"). If
writing one counted as progress, an agent that notes something every turn would
never let the stuck-state net release the state.
"""

from stella_v2_agent.agent import StellaV2Agent

FULL_STATE = {
    "states": [
        {
            "id": "rapport",
            "tasks": [
                {
                    "id": "__goal_deliverables__",
                    "deliverables": [
                        {"key": "client_name", "status": "pending"},
                        {"key": "likes_gardening", "status": "completed", "discovered": True},
                    ],
                }
            ],
        },
        {"id": "closing", "tasks": [{"id": "t1", "deliverables": [{"key": "rating"}]}]},
    ]
}

wrote = StellaV2Agent._wrote_defined_deliverable


def test_a_defined_deliverable_is_progress():
    assert wrote(["client_name"], FULL_STATE)
    assert wrote(["likes_gardening", "rating"], FULL_STATE)


def test_an_insight_alone_is_not_progress():
    assert not wrote(["likes_gardening"], FULL_STATE)
    assert not wrote(["something_new"], FULL_STATE)


def test_nothing_written_is_not_progress():
    assert not wrote([], FULL_STATE)


def test_without_a_plan_view_any_write_counts():
    assert wrote(["anything"], None)
