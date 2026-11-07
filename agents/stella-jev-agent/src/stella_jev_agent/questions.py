"""The questions asked of Jev.

Jev classifies: it picks one of the options written here and gives a probability
for each, and it writes no text. So everything it decides is listed in this file,
and everything that needs words goes to a language model.
"""

from typing import Any, Dict, List, Optional

from typesafe_sdk import Choice

FITS = "fits"
SLIGHT_DOUBT = "slight_doubt"
DOESNT_FIT = "doesnt_fit"

COMMON_SENSE = Choice(
    instructions=(
        "The latest message comes from a speech recogniser that can mishear people or "
        "invent text during silence. The speaker is an older adult talking to a voice "
        "companion. Is it believable that the person really said this, here? Check it "
        "against everyday life, the question they were just asked and what they said "
        "earlier in the conversation."
    ),
    criteria={
        FITS: (
            "Believable. This includes unusual but possible facts, short or vague answers, "
            "\"I don't know\", thanks after praise or an offer, a question back, a change of "
            "topic, feelings, restarts and regional words. This is by far the most common answer."
        ),
        SLIGHT_DOUBT: "Probably what they meant, but one small detail is odd and could be a mishearing.",
        DOESNT_FIT: (
            "Not believable as what they meant: an amount or fact that is impossible or absurd for "
            "this everyday activity, an answer with no sensible link to the question, a clear "
            "contradiction of what they said earlier, a closing phrase or caption with no place in "
            "the conversation, or words with no meaning."
        ),
    },
)

# Asked separately because a tidy, grammatical caption looks fine to the question above.
RECOGNISER_ARTIFACT = Choice(
    instructions=(
        "Speech recognisers trained on video sometimes invent the sign-off or caption text of "
        "a broadcast during silence. Is the latest message such text, or something a person "
        "would say in this conversation?"
    ),
    criteria={
        "speech": "Something a person could say in this conversation, even if short or odd.",
        "artifact": "Subtitle credits, a broadcaster's name, thanks for watching, or a request to subscribe.",
    },
)

MEDICAL = Choice(
    instructions="Does the latest message raise a health or medical safety concern?",
    criteria={
        "none": "No health concern, or only general wellness talk such as exercise, sleep or diet.",
        "low": "A real but mild, non-acute health matter mentioned in passing.",
        "high": "A specific concern: concrete symptoms, medication, an injury, a mental-health concern, or a request for diagnosis or treatment.",
        "critical": "A possible emergency needing help now, such as chest pain, an overdose, a bad fall, stroke signs, or any suicidal thought or self-harm.",
    },
)

LEGAL = Choice(
    instructions="Does the latest message raise a legal concern affecting the person?",
    criteria={
        "none": "No legal matter, or only a passing or general mention.",
        "low": "A legal subject comes up, but it is mild and not urgent.",
        "high": "A specific concern: a dispute, a contract, a privacy or employment matter, or a request for legal advice.",
        "critical": "Illegal activity, or imminent danger or serious legal jeopardy.",
    },
)

PROBING = Choice(
    instructions="Should the assistant steer the conversation this turn, or simply respond to what was said?",
    criteria={
        "no_probe": (
            "Simply respond. They answered, or shared a remark, a story or a feeling worth responding "
            "to, even if it has nothing to do with the task. This is the default."
        ),
        "needs_clarification": "They tried to answer what the task needs, but left it open or too vague to record.",
        "gentle_redirect": "They have clearly been away from the task for several turns in a row. One remark is not enough.",
    },
)

TIMEKEEPER = Choice(
    instructions="Looking at the whole conversation, is it moving forward?",
    criteria={
        "on_track": "It is moving, or it is too early to tell. This is the default.",
        "slowing": "A couple of turns without progress, with answers getting shorter or vaguer.",
        "stuck": "No progress over several turns, or the same question keeps coming back.",
        "force_advance": "So stuck that the current step should be skipped.",
    },
)

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


# Jev writes no text, so the reply model gets these fixed sentences as guidance.
RECOMMENDATIONS: Dict[str, Dict[str, str]] = {
    "common_sense": {
        SLIGHT_DOUBT: "You may have misheard a small detail of this message. Do not build on that detail.",
    },
    "medical": {
        "low": "A mild health matter came up. Be lightly cautious.",
        "high": "A specific health concern came up. Give no diagnosis, treatment or tips.",
    },
    "legal": {
        "low": "A legal subject came up. Be careful.",
        "high": "A specific legal concern came up. Give no legal advice.",
    },
    "probing": {
        "needs_clarification": "Ask one short question about what the current task still needs.",
        "gentle_redirect": "Gently bring the conversation back to the current task.",
    },
    "timekeeper": {
        "slowing": "The conversation is slowing down. Give a light nudge towards the current task.",
        "stuck": "The conversation is stuck. Ask directly about what the current task still needs.",
        "force_advance": "The conversation is stuck. Ask directly about what the current task still needs.",
    },
}


def not_believable(common_sense: Dict[str, float], artifact: Dict[str, float]) -> float:
    """The probability that this should be asked back, from the two questions."""
    return max(common_sense[DOESNT_FIT], artifact["artifact"])


def _render(history: Optional[List[Dict[str, str]]], limit: int) -> List[str]:
    """The last turns as plain lines, oldest first."""
    turns = (history or [])[-limit:]
    return [f"{t.get('role', 'user')}: {t.get('content', '')}" for t in turns]


def turn_state(
    said: str,
    history: Optional[List[Dict[str, str]]],
    task: str = "",
    limit: int = 12,
) -> Dict[str, Any]:
    """What Jev reads on an ordinary turn."""
    state: Dict[str, Any] = {
        "conversation": _render(history, limit),
        "latest_message": said,
    }
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
