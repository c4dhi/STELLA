"""Guards for the task_extraction expert prompt (#278).

The deliverable-overwrite-on-correction behaviour is driven entirely by this
prompt plus the {{current_focus}} ALREADY COLLECTED section. These assertions
lock in the correction carve-outs so a future prompt edit can't silently drop
them (which is what let "running" survive a "oh no, I like basketball"
correction).
"""

import json
from pathlib import Path

import pytest

CONFIG = Path(__file__).resolve().parents[1] / "config" / "experts" / "task_extraction.json"


@pytest.fixture(scope="module")
def system_prompt() -> str:
    return json.loads(CONFIG.read_text())["system_prompt"]


def test_prompt_reads_the_already_collected_focus_section(system_prompt: str):
    # The expert must be pointed at the CURRENT FOCUS hook that lists collected
    # deliverables as correction targets.
    assert "ALREADY COLLECTED" in system_prompt
    assert "{{current_focus}}" in system_prompt


def test_prompt_requires_overwriting_corrections(system_prompt: str):
    # A correction must be a MUST-overwrite, not a soft "you can".
    assert "MUST overwrite" in system_prompt
    # The exact transcript case is called out as an example.
    assert "basketball" in system_prompt


def test_context_match_rule_exempts_corrections(system_prompt: str):
    # The CONTEXT MATCH check must not block a correction just because it doesn't
    # answer the question that was literally just asked.
    assert "EXCEPTION — corrections" in system_prompt


def test_strict_mode_exempts_corrections(system_prompt: str):
    # Strict/sequential task-scoping must not block correcting an earlier,
    # already-completed task's deliverable.
    strict_section = system_prompt.split("STRICT/SEQUENTIAL MODE RULE:")[1]
    assert "EXCEPTION" in strict_section
    assert "ALREADY COLLECTED" in strict_section


def test_prompt_marks_corrections_with_the_correction_flag(system_prompt: str):
    # The state machine rejects a change to a collected required deliverable
    # unless the write carries correction=true (#406). Without this in the
    # prompt every correction would silently fail.
    assert system_prompt.count("`correction: true`") >= 3
    assert "REJECTED without `correction: true`" in system_prompt


# --- Goal states (#706) ------------------------------------------------------
# A goal state is closed by completing or skipping its one task, `__goal__`.
# The prompt used to say nothing about how a goal ends, and the model wrote the
# user's answer into a "goal reached" deliverable instead.

def test_prompt_closes_a_goal_through_its_task(system_prompt: str):
    goal_section = system_prompt.split("GOAL-ORIENTED STATE HANDLING:")[1].split("DISCOVERED INSIGHTS")[0]
    assert "put `__goal__` in the `tasks` list" in goal_section
    assert "put `__goal__` in `skip_tasks`" in goal_section
    # Giving a goal up is for a refusal of the whole subject, not for one open question.
    assert "is NOT giving it up" in goal_section
    assert "Never skip `__goal__` in a call that also records a deliverable" in goal_section


def test_prompt_forbids_goal_reached_as_a_deliverable(system_prompt: str):
    assert "Never set a deliverable named `__goal__` or `__goal_achieved__`" in system_prompt
    # Nothing may still tell the model to close a goal by writing a value.
    assert "setDeliverable(" not in system_prompt


def test_prompt_does_not_take_a_maybe_for_a_reached_goal(system_prompt: str):
    assert "is not a commitment" in system_prompt
    assert "a remark made in passing" in system_prompt
    assert "the goal is not reached — leave it open" in system_prompt
