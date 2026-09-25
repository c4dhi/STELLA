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
