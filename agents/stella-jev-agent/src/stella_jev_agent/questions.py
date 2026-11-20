"""Jev's own questions, the ones no expert configuration asks.

Jev classifies: it picks one of the options and gives a probability for each, and
it writes no text. The experts it answers (common_sense, medical, ...) are asked
exactly as their configuration says, see JevExpertPool.expert_questions. The
questions here decide what the pipeline does next and have no configuration of
their own: whether extraction or the companion router needs to run, and whether
an interruption should stop the assistant. Task and branch questions are built
from the plan in next_step.py.
"""

from typing import Any, Dict, List, Optional

from typesafe_sdk import Choice

FITS = "fits"
SLIGHT_DOUBT = "slight_doubt"
DOESNT_FIT = "doesnt_fit"

# Asked only to decide whether the slower language-model experts need to run.
HAS_ANSWER = Choice(
    instructions=(
        "Did the latest message give information the current task is collecting, correct an "
        "earlier answer, or complete a task that was just performed?"
    ),
    criteria={
        "no": "Nothing to record: a greeting, small talk, or a question to the assistant.",
        "yes": "There is something to record, even if it was only mentioned in passing or hedged.",
    },
)

ACTIVITY_INTENT = Choice(
    instructions="Does the person want to see the activities on offer, start one, or end the conversation?",
    criteria={
        "none": "None of these. Most messages are ordinary conversation. This includes mentioning an activity in passing.",
        "transition": "They ask what there is to do, say they have nothing to do or are bored, pick an activity, or are done for now.",
    },
)

COMMIT = "commit"
RESUME = "resume"

BARGE_IN = Choice(
    instructions=(
        "The person spoke while the assistant was talking. Judge the whole message, not its "
        "first words. Should the assistant stop and respond, or carry on?"
    ),
    criteria={
        COMMIT: "Something is left to respond to once any acknowledgement is removed: a fact, an answer, a correction, a question, a request to stop, or a feeling.",
        RESUME: "Nothing but acknowledgement or noise, such as a short yes, okay or mhm, with no information of its own.",
    },
)


SAFETY_LEVELS = ("high", "low")


def settle_safety(probabilities: Dict[str, float], choice: str, floor: float) -> str:
    """A medical or legal "high" or "low" only when Jev is sure enough of it.

    Jev's top choice can win with little weight, such as "high" at 0.44, and a high
    verdict prepends a fixed warning to the reply. Below the floor the verdict steps down
    to the next level whose weight, with the levels above it, reaches the floor, else to
    none. "critical" is never stepped down: a missed emergency costs more than a false one.
    """
    if choice not in SAFETY_LEVELS:
        return choice
    weight = 0.0
    for level in SAFETY_LEVELS[SAFETY_LEVELS.index(choice):]:
        weight += probabilities.get(level, 0.0)
        if weight >= floor:
            return level
    return "none"


def _render(history: Optional[List[Dict[str, str]]], limit: int) -> List[str]:
    """The last turns as plain lines, oldest first."""
    turns = (history or [])[-limit:]
    return [f"{t.get('role', 'user')}: {t.get('content', '')}" for t in turns]


def turn_state(
    said: str,
    history: Optional[List[Dict[str, str]]],
    task: str = "",
    limit: int = 12,
    setting: str = "",
) -> Dict[str, Any]:
    """What Jev reads on an ordinary turn. The setting says what kind of conversation this is."""
    state: Dict[str, Any] = {}
    if setting.strip():
        state["setting"] = setting.strip()
    state["conversation"] = _render(history, limit)
    state["latest_message"] = said
    if task:
        state["current_task"] = task
    return state


def barge_in_state(
    said: str,
    history: Optional[List[Dict[str, str]]],
    interrupted: str,
    limit: int = 6,
) -> Dict[str, Any]:
    """What Jev reads when someone speaks over the assistant."""
    return {
        "conversation": _render(history, limit),
        "assistant_was_saying": interrupted,
        "latest_message": said,
    }
