"""Companion mode: free conversation that can run activities (#467, #36).

The contract: inside an activity, every turn is built exactly as a plan-mode
deployment of that plan would build it — same plan context, same history
(starting where the activity started), same experts. The only additions are a
way out (stop, confirmed by the user) and that the plan's end hands back to free
conversation instead of ending the session.

This module is the one place that knows what mode the session is in and how it
changes. Each mode has ONE judge, asking one question:

* free conversation — the ``companion_router`` expert: do they want to see the
  activities, start one, or are they done for now? Its tools only PROPOSE;
  they touch nothing.
* in an activity — ``exit_dialogue``, on every turn: do they want to leave?
  It answers leave, stay or ask, and when it asks it writes the question.

``Companion.decide`` turns the judge's answer into at most one transition,
judged against the mode the turn STARTED in, after every expert has finished.
That ordering is what makes the rest simple:

* nothing races: the plan loads or clears after the other experts' writes;
* a pending "shall we stop?" is part of the input state, so it is answered by
  the NEXT turn, never by the turn that asked it.

Leaving used to need two judges in a row — the router had to notice a stop
before the exit dialogue was asked what it was — so a stop the router missed
never reached the judge that would have understood it.
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from stella_agent_sdk import AgentOutput
from stella_agent_sdk.llm import LLMConfig, LLMMessage, LLMProvider

from stella_v2_agent.pipeline.history_scope import ActivitySegment

logger = logging.getLogger(__name__)

ROUTER = "companion_router"


class Change(Enum):
    NONE = "none"
    OFFERED = "offered"            # listed the activities
    STARTED = "started"            # an activity took over
    EXIT_ASKED = "exit_asked"      # asked "shall we stop X?"
    EXITED = "exited"              # the user confirmed; back to free conversation
    EXIT_DECLINED = "exit_declined"  # the user did not confirm; carry on
    FINISHED = "finished"          # the plan reached its end; back to free conversation
    DISMISSED = "dismissed"        # the user is done for now; say goodbye and go to sleep
    UNHEARD = "unheard"            # too doubtful a transcript to act on; ask them to repeat
    START_ASKED = "start_asked"    # asked "do you mean X?" before starting it
    START_DECLINED = "start_declined"  # they did not confirm X; it does not start


@dataclass(frozen=True)
class Transition:
    change: Change
    activity: Optional[Dict[str, Any]] = None
    offered: List[Dict[str, Any]] = field(default_factory=list)
    # A proposal that did not fit the mode, kept for the decision log.
    ignored: Optional[str] = None
    # EXIT_ASKED: the question to speak, as the exit dialogue wrote it.
    say: str = ""
    # What the exit dialogue understood the user to want, for the decision log.
    understood: str = ""

    @property
    def title(self) -> str:
        return (self.activity or {}).get("title") or "the activity"


NO_CHANGE = Transition(Change.NONE)

LEAVE, STAY, ASK = "leave", "stay", "ask"
# Asking again is for a genuinely unclear answer, not a loop: after this many
# questions without a clear yes, the activity carries on.
MAX_EXIT_ASKS = 2
MAX_START_ASKS = 2
# The exit dialogue has its own model, not the reply's. With the stop question
# open, gpt-4o-mini left on nearly anything — "Thank you.", a misheard "Nein",
# an answer to the activity — where this one stays or asks again (replay set,
# 5 Oct: confirmations 56% -> 96%). Overridable per deployment through the
# pipeline config node "exit_dialogue".
EXIT_MODEL = "gpt-5.4-mini"
# How long free conversation may stay silent before she goes to sleep unasked.
# Long enough to think about an offer; she only ever sleeps outside an activity.
IDLE_SLEEP_SECONDS = 45.0
# Below this transcript confidence a message may not change the mode: she asks
# instead of leaving, starting or going to sleep. 0.4 is roughly where Whisper's
# own conventions put "low confidence" (avg_logprob -1.0, or no_speech 0.6 on an
# otherwise perfect decode). Not yet calibrated on recorded sessions.
MIN_CONFIDENCE = 0.4


@dataclass(frozen=True)
class ExitStep:
    """What the exit dialogue concluded about one user message."""

    decision: str                # LEAVE, STAY or ASK
    say: str = ""                # the question, when it decided to ASK
    user_intent: str = ""        # what it understood, stated before deciding (for the log)


def _plain(text: str) -> str:
    """Lower-case words only, so "Check-in" and "check in" compare equal."""
    return " ".join("".join(c if c.isalnum() else " " for c in text.lower()).split())


def commands_from(verdicts: List[Any]) -> List[Dict[str, Any]]:
    """The router's proposals this turn, in call order."""
    commands: List[Dict[str, Any]] = []
    for verdict in verdicts or []:
        if getattr(verdict, "expert_name", "") != ROUTER:
            continue
        for result in (verdict.raw_output or {}).get("tool_results", []) or []:
            data = result.get("data") or {}
            if result.get("success") and data.get("command"):
                commands.append(data)
    return commands


@dataclass
class Companion:
    """The session's mode: free conversation, or one running activity."""

    activities: List[Dict[str, Any]] = field(default_factory=list)
    active: Optional[Dict[str, Any]] = None
    pending_exit: bool = False
    exit_asks: int = 0
    # "Do you mean X?" is open: the activity she asked about, and how often.
    pending_start: Optional[Dict[str, Any]] = None
    start_asks: int = 0
    exit_model: str = EXIT_MODEL
    min_confidence: float = MIN_CONFIDENCE
    # When the running activity started (None if unknown, e.g. resumed after a
    # restart), what it has collected so far, and the runs that already ended —
    # together they scope the history to the current mode.
    started_at: Optional[datetime] = None
    collected: Dict[str, Any] = field(default_factory=dict)
    segments: List[ActivitySegment] = field(default_factory=list)

    # ── reading ────────────────────────────────────────────────────────────

    @property
    def running_title(self) -> Optional[str]:
        return (self.active or {}).get("title") if self.active else None

    @property
    def plan(self) -> Optional[Dict[str, Any]]:
        return (self.active or {}).get("plan") if self.active else None

    def find(self, activity_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """The activity for an id — its own, or that of the plan it carries.

        The backend records the PLAN's id, which a plan's content can set
        independently of the activity's; matching either keeps a running
        activity recognisable whichever one comes back.
        """
        if not activity_id:
            return None
        for activity in self.activities:
            if activity_id in (activity.get("id"), (activity.get("plan") or {}).get("id")):
                return activity
        return None

    def doubtful(self, confidence: float) -> bool:
        """Whether a transcript heard with this confidence is too uncertain to
        change the mode on. 0 means the STT gave no signal, which is not doubt."""
        return 0.0 < confidence < self.min_confidence

    def progress_metadata(self) -> Dict[str, Any]:
        """What the progress panel needs: what is running, and what can be picked."""
        return {
            "active_activity": self.running_title,
            "activities": [
                {"id": a.get("id"), "title": a.get("title"), "description": a.get("description")}
                for a in self.activities
            ],
        }

    # ── deciding ───────────────────────────────────────────────────────────

    def decide(
        self,
        commands: List[Dict[str, Any]],
        exit_step: Optional[ExitStep] = None,
        doubtful: bool = False,
        *,
        start_confirmed: Optional[bool] = None,
        said: str = "",
    ) -> Transition:
        """The one transition this turn makes, from the mode it started in.

        Pure: nothing changes until the caller has applied the transition to the
        state machine and reports it with ``enter``/``leave``/``ask_exit``.
        In an activity only ``exit_step`` counts (None means the call failed);
        in free conversation only the router's ``commands`` do.

        ``doubtful`` says the transcript itself was heard with low confidence.
        Such a message never changes the mode — it may be a mumbled "yes" or
        filler the transcriber invented over silence — it can only make her ask.

        Starting takes over the conversation, so it is never a guess: an
        activity starts at once only when the user said its title (``said``).
        Anything less is asked about first, and ``start_confirmed`` is the
        judgment of their answer when that question is open.
        """
        if self.active:
            return self._decide_in_activity(exit_step, doubtful)

        asked = self.pending_start
        if asked and start_confirmed:
            if not doubtful:
                return Transition(Change.STARTED, activity=asked)
            if self.start_asks < MAX_START_ASKS:
                return Transition(Change.START_ASKED, activity=asked)
            return Transition(Change.START_DECLINED, activity=asked)

        # Not a yes. They may still name the one they meant ("no, the memory
        # game") or ask what there is; anything else just closes the question —
        # "no, never mind" is not a goodbye.
        command = commands[0] if commands else None
        kind = command.get("command") if command else None
        if asked and kind not in ("start", "list"):
            return Transition(Change.START_DECLINED, activity=asked)
        if not command:
            return NO_CHANGE
        if kind == "list":
            return Transition(Change.OFFERED, offered=list(command.get("activities") or []))
        if kind == "sleep":
            if doubtful:
                return Transition(Change.UNHEARD, ignored=kind)
            return Transition(Change.DISMISSED)
        if kind == "start":
            activity = self.find(command.get("activity_id"))
            if activity and activity.get("plan"):
                if not doubtful and self._named(activity, said):
                    return Transition(Change.STARTED, activity=activity)
                return Transition(Change.START_ASKED, activity=activity)
            logger.warning("start_activity for unknown or plan-less activity %r", command)
        return Transition(Change.NONE, ignored=kind)

    @staticmethod
    def _named(activity: Dict[str, Any], said: str) -> bool:
        """Whether the user's own words contain the activity's title."""
        title = _plain(activity.get("title") or "")
        return bool(title) and title in _plain(said)

    def _decide_in_activity(self, step: Optional[ExitStep], doubtful: bool) -> Transition:
        # A failed judgment changes nothing, whichever question was open: ending
        # on a guess costs the whole activity, and asking "shall we stop?" on
        # every failed call would interrupt it for no reason.
        step = step or ExitStep(STAY)
        unheard = step.decision == LEAVE and doubtful
        if unheard:
            # Heard as a stop, but not heard well: ask rather than leave.
            step = ExitStep(
                ASK, say=step.say,
                user_intent=f"{step.user_intent} (heard with low confidence, so asked)".strip(),
            )
        if step.decision == LEAVE:
            return Transition(Change.EXITED, activity=self.active, understood=step.user_intent)
        # Without a question to speak an ordinary ask is dropped; a stop that was
        # only heard poorly still has to be asked about, so the reply writes it.
        if step.decision == ASK and (step.say or unheard) and self.exit_asks < MAX_EXIT_ASKS:
            return Transition(Change.EXIT_ASKED, activity=self.active, say=step.say, understood=step.user_intent)
        if self.pending_exit:
            # The stop question was open and was not answered with a yes.
            return Transition(Change.EXIT_DECLINED, activity=self.active, understood=step.user_intent)
        return NO_CHANGE

    # ── recording what was applied ─────────────────────────────────────────

    def enter(self, activity: Dict[str, Any], not_before: Optional[datetime] = None) -> None:
        """An activity is running. Its history starts now — and never before the
        newest message already seen, so a clock that runs behind the message
        store cannot pull the choosing turn into the activity."""
        now = datetime.now(timezone.utc)
        if not_before is not None and not_before >= now:
            now = not_before + timedelta(microseconds=1)
        self.active = activity
        self.pending_exit = False
        self.exit_asks = 0
        self.drop_start()
        self.started_at = now
        self.collected = {}

    def resume(self, activity: Dict[str, Any]) -> None:
        """A restarted agent finds this activity already running. When it began
        is not known here, so its history is not scoped."""
        self.active = activity
        self.pending_exit = False
        self.exit_asks = 0
        self.started_at = None
        self.collected = {}

    def ask_start(self, activity: Dict[str, Any]) -> None:
        if self.pending_start is not activity:
            self.start_asks = 0
        self.pending_start = activity
        self.start_asks += 1

    def drop_start(self) -> None:
        self.pending_start = None
        self.start_asks = 0

    def ask_exit(self) -> None:
        self.pending_exit = True
        self.exit_asks += 1

    def stay(self) -> None:
        self.pending_exit = False
        self.exit_asks = 0

    def leave(self) -> None:
        """Back to free conversation; the finished run becomes one history line."""
        if self.active and self.started_at is not None:
            self.segments.append(ActivitySegment(
                title=self.running_title or "activity",
                started_at=self.started_at,
                ended_at=datetime.now(timezone.utc),
                collected=dict(self.collected),
            ))
        self.active = None
        self.pending_exit = False
        self.exit_asks = 0
        self.started_at = None
        self.collected = {}


# ── what the reply and the log are told ─────────────────────────────────────

def directive(transition: Transition) -> str:
    """The one instruction the reply gets about what just happened.

    Only for transitions the reply has to act on. Inside an activity the plan
    alone steers, exactly as in plan mode.
    """
    change = transition.change
    if change is Change.OFFERED:
        if not transition.offered:
            return (
                "The user asked what you can do together, but no activities are "
                "available. Say so plainly and keep the conversation going."
            )
        listed = "; ".join(
            f"{a.get('title')}" + (f" ({a.get('description')})" if a.get("description") else "")
            for a in transition.offered
        )
        # Naming them matters: left alone the model invents plausible activities
        # that do not exist, a broken promise the moment the user picks one.
        return (
            "The user asked what you can do together. Offer exactly these, in your "
            f"own words, and invite them to pick one: {listed}. Do not invent any others."
        )
    if change is Change.STARTED:
        return (
            f"The user just chose \"{transition.title}\" and it starts now. Acknowledge "
            "the choice in a few words, then open it exactly as the current step "
            "below says, as if this conversation had only just begun — do not "
            "re-ask which activity they want, and do not invent an opening of your own."
        )
    if change is Change.EXIT_ASKED:
        # Only reached when the exit dialogue failed to write the question.
        return (
            f"Ask clearly and briefly whether they want to stop \"{transition.title}\" — "
            "one direct yes/no question — and do nothing else this turn: do not "
            "continue the activity, and do not end it yet."
        )
    if change is Change.EXITED:
        return (
            f"\"{transition.title}\" has just been stopped, confirmed by the user. Close "
            "it warmly in a sentence, do not continue or resume it, and return to "
            "open conversation."
        )
    if change is Change.START_ASKED:
        description = (transition.activity or {}).get("description")
        return (
            f"The user seems to want \"{transition.title}\""
            + (f" ({description})" if description else "")
            + " but did not name it outright. Ask in ONE short question, naming "
            "it, whether that is the one they mean. Do nothing else this turn: "
            "do not start it and do not list the other activities."
        )
    if change is Change.START_DECLINED:
        return (
            f"The user did not confirm \"{transition.title}\", so it does not "
            "start. Carry on naturally; if they still want to do something, ask "
            "which activity they mean."
        )
    if change is Change.UNHEARD:
        return (
            "You did not hear the user clearly. Say so in a few words and ask "
            "them to say it again. Do not guess what they meant, and do not act "
            "on it."
        )
    if change is Change.DISMISSED:
        return (
            "The user is done for now and you are about to go to sleep. Say "
            "goodbye in one short, warm sentence and nothing more: no question, "
            "no offer, no summary."
        )
    if change is Change.EXIT_DECLINED:
        return (
            "The user did not confirm stopping. Stay in the activity and pick up "
            "naturally from where it left off — do not ask again unless they bring "
            "it up themselves."
        )
    return ""


_DECISIONS = {
    Change.STARTED: ("activity_started", "Started “{title}”", None),
    Change.EXIT_ASKED: ("activity_end_proposed", "Asked to confirm leaving “{title}”", None),
    Change.EXITED: ("activity_ended", "Left “{title}”", "Back to free conversation"),
    Change.EXIT_DECLINED: ("activity_end_declined", "Staying in “{title}”", None),
    Change.FINISHED: ("activity_completed", "Finished “{title}”", "Back to free conversation"),
    Change.DISMISSED: ("going_to_sleep", "Going to sleep", "The user is done for now"),
    Change.START_ASKED: ("activity_start_proposed", "Asked to confirm starting “{title}”", None),
    Change.START_DECLINED: ("activity_start_declined", "Not starting “{title}”", None),
}


def decision(session_id: str, transition: Transition) -> Optional[AgentOutput]:
    """The user-visible decision tag for a transition, if it is one."""
    if transition.change is Change.OFFERED:
        titles = [a.get("title", "") for a in transition.offered if a.get("title")]
        return AgentOutput.decision(
            session_id,
            "activities_offered",
            f"Offered {len(titles)} activit{'y' if len(titles) == 1 else 'ies'}"
            if titles else "No activities available",
            options=titles,
            component=ROUTER,
        )
    if transition.change is Change.UNHEARD:
        return AgentOutput.decision(
            session_id,
            "not_heard_clearly",
            "Asked to repeat",
            detail=f"Heard “{transition.ignored}” with low confidence; not acted on",
            component=ROUTER,
        )
    if transition.change is Change.NONE:
        if not transition.ignored:
            return None
        return AgentOutput.decision(
            session_id,
            "activity_command_ignored",
            f"Ignored “{transition.ignored}” — it does not fit the current mode",
            **({"detail": transition.understood} if transition.understood else {}),
            component=ROUTER,
        )
    kind, summary, detail = _DECISIONS[transition.change]
    detail = transition.understood or detail
    return AgentOutput.decision(
        session_id,
        kind,
        summary.format(title=transition.title),
        **({"detail": detail} if detail else {}),
        component=ROUTER,
    )


def _exit_prompt(
    title: str, awaiting_answer: bool, language: Optional[str], bridge: str,
    persona: Optional[str],
) -> str:
    situation = (
        f'In your last message you asked whether they want to stop "{title}". '
        "Their message below answers that."
        if awaiting_answer else
        f'They are in the middle of the activity "{title}". You see every '
        "message they send during it, and nearly all of them are simply taking "
        "part: answering its questions (a bare yes or no included), commenting, "
        "hesitating. Decide whether THIS message asks to stop the activity."
    )
    leave_rule = (
        "they said yes, or otherwise clearly want to stop now."
        if awaiting_answer else
        "they asked explicitly and unmistakably to stop it now."
    )
    ask_rule = (
        "it is genuinely unclear whether that was a yes or a no."
        if awaiting_answer else
        "they seem to want out of the activity itself but did not say so "
        'plainly. Hesitation, filler ("hm", "well...") or an unclear answer to '
        "the activity is not that: stay."
    )
    parts = [persona or ""]
    parts.append(
        "You handle ONE thing right now: whether the user wants to stop the "
        f'activity "{title}" and go back to open conversation. Not the '
        "activity's content, not anything else.\n\n"
        f"{situation}\n\n"
        'First write, in "user_intent", one plain sentence saying what they '
        "actually want. Then check that sentence against their exact words, and "
        'only then choose "decision":\n'
        f'- "leave": {leave_rule}\n'
        '- "stay": they want to carry on — including answering the activity, '
        "commenting on it, or complaining about how it is going.\n"
        f'- "ask": {ask_rule}\n\n'
        'Whenever your decision is "ask" or "leave", write in "say" ONE short, '
        f'warm yes/no question asking whether to stop "{title}", and nothing '
        "else — no content from the activity. It is spoken when you ask, and "
        "also when they were heard too poorly to leave on their word alone. "
        '"say" stays empty when they stay. Write it in the language with code '
        f"'{language or 'en'}'."
        + (
            f' It is spoken right after "{bridge}", which was already said — '
            "continue from it, do not repeat it."
            if bridge else ""
        )
        + '\n\nRespond with JSON only: {"user_intent": "...", "decision": '
        '"leave" | "stay" | "ask", "say": "..."}'
    )
    return "\n\n".join(p for p in parts if p)


async def exit_dialogue(
    llm_service,
    *,
    model: str,
    title: str,
    user_input: str,
    history: List[Dict[str, str]],
    awaiting_answer: bool,
    language: Optional[str] = None,
    bridge: str = "",
    persona: Optional[str] = None,
) -> Optional[ExitStep]:
    """Judge one user message during an activity: leave, stay, or ask.

    The one judge of an activity turn, separate from the reply model (which
    follows the plan). It states what the user wants before deciding, so the decision is
    checked against their words rather than made in one leap. Returns None when
    the call fails or its answer is unusable; the caller decides what that means.
    """
    recent = "\n".join(f"{m['role']}: {m['content']}" for m in history[-6:])
    try:
        response = await llm_service.generate(
            messages=[
                LLMMessage(
                    role="system",
                    content=_exit_prompt(title, awaiting_answer, language, bridge, persona),
                ),
                LLMMessage(
                    role="user",
                    content=(f"Recent conversation:\n{recent}\n\n" if recent else "")
                    + f"Their message: {user_input}",
                ),
            ],
            config=LLMConfig(
                model=model, temperature=0.2, max_tokens=200,
                provider=LLMProvider.OPENAI_LANGCHAIN, json_mode=True,
            ),
            component_name="exit_dialogue",
        )
        data = json.loads(response.content)
        decision = str(data.get("decision", "")).strip().lower()
        if decision not in (LEAVE, STAY, ASK):
            raise ValueError(f"unknown decision {decision!r}")
        say = str(data.get("say") or "").strip() if decision != STAY else ""
        step = ExitStep(decision, say=say, user_intent=str(data.get("user_intent") or ""))
        logger.info("Exit dialogue: %s (%s)", step.decision, step.user_intent)
        return step
    except Exception as e:
        logger.warning(f"Exit dialogue failed ({e})")
        return None


async def start_dialogue(
    llm_service,
    *,
    model: str,
    title: str,
    user_input: str,
    history: List[Dict[str, str]],
) -> Optional[bool]:
    """Judge the answer to "do you mean X?": True only for a yes to that.

    Anything else — a no, another activity, a change of subject — is False, and
    the turn is then handled as ordinary free conversation. None when the call
    fails, which the caller treats as not a yes: starting on a guess takes over
    the conversation.
    """
    recent = "\n".join(f"{m['role']}: {m['content']}" for m in history[-6:])
    try:
        response = await llm_service.generate(
            messages=[
                LLMMessage(
                    role="system",
                    content=(
                        "You handle ONE thing: in your last message you asked the "
                        f'user whether they want to start the activity "{title}". '
                        'First write, in "user_intent", one plain sentence saying '
                        "what their message below means. Then check that sentence "
                        'against their exact words and choose "decision":\n'
                        f'- "yes": they confirm they want "{title}".\n'
                        '- "no": anything else — they decline, name a different '
                        "activity, ask something, change the subject, or it is "
                        "unclear.\n\n"
                        'Respond with JSON only: {"user_intent": "...", '
                        '"decision": "yes" | "no"}'
                    ),
                ),
                LLMMessage(
                    role="user",
                    content=(f"Recent conversation:\n{recent}\n\n" if recent else "")
                    + f"Their message: {user_input}",
                ),
            ],
            config=LLMConfig(
                model=model, temperature=0.0, max_tokens=120,
                provider=LLMProvider.OPENAI_LANGCHAIN, json_mode=True,
            ),
            component_name="start_dialogue",
        )
        data = json.loads(response.content)
        decision = str(data.get("decision", "")).strip().lower()
        if decision not in ("yes", "no"):
            raise ValueError(f"unknown decision {decision!r}")
        logger.info("Start dialogue: %s (%s)", decision, data.get("user_intent"))
        return decision == "yes"
    except Exception as e:
        logger.warning(f"Start dialogue failed ({e})")
        return None
