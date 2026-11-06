"""ELIAS-Interviewer: asks an ELIAS interview guide word for word.

Lifecycle:

- ``on_session_start``: read the guide from ELIAS through the connector, mirror
  it into the STELLA state machine (progress, deliverables, resume), and work
  out where to continue after an auto-pause. Nothing here raises. A failure
  becomes ``_startup_error``, so the agent still registers and can tell the
  participant, instead of sitting at STARTING forever.
- ``run_audio_loop``: wait for a participant. Then either say the error line
  and end, or run the interview (see interview.py) and write every turn to
  ELIAS as it happens.

Everything a deployment sets arrives as an env var (see agent.yaml). Only
public SDK APIs (stella-ai-agent-sdk 0.10): ``self.plan_runtime`` for the state machine, ``wait_for_participant``,
``publish_progress`` and ``complete_session``. The agent registers under the
``AGENT_TYPE``/``AGENT_VERSION`` the platform injects.
- ``on_session_ending`` (the session is really ending, e.g. time cap):
  finalise the ELIAS transcript.
- ``on_session_end`` (teardown, also on auto-pause): flush pending writes only.
  It must NOT end the ELIAS interview, or a wake would continue a closed
  transcript.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Mapping, Optional

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent
from stella_agent_sdk.progress import progress_from_full_state

from elias_interviewer.checker import AnswerChecker
from elias_interviewer.elias import Elias, EliasUnavailable, Recorder
from elias_interviewer.guide import (
    TRANSCRIPT_ID_KEY,
    GuideError,
    Question,
    build_plan,
    parse_guide,
    resume_point,
)
from elias_interviewer.interview import ANSWER, REASK, SKIP, Interview

logger = logging.getLogger(__name__)

AGENT_NAME = "elias-interviewer"
AGENT_ICON = "🎙️"

ELIAS_SLOT = "elias"  # the connector slot in agent.yaml; the SDK calls it by this name

# Env var for each fixed line the agent says.
MESSAGE_ENV = {
    "opening": "ELIAS_OPENING",
    "reask_prefix": "ELIAS_REASK_PREFIX",
    "closing": "ELIAS_CLOSING",
    "error": "ELIAS_ERROR",
}

DEFAULT_MESSAGES = {
    "opening": "Hello, and thank you for taking part. I will ask you a few questions. Take all the time you need.",
    "reask_prefix": "Let me ask that again.",
    "closing": "Those were all my questions. Thank you very much for your time.",
    "error": "I'm sorry, I can't start the interview right now. Please try again later.",
}

def _int_between(raw: Optional[str], *, default: int, low: int, high: int) -> int:
    """An int env var, clamped to [low, high]; empty or unreadable gives ``default``."""
    try:
        value = int(str(raw).strip()) if raw is not None and str(raw).strip() else default
    except ValueError:
        logger.warning("ignoring %r, not a whole number; using %d", raw, default)
        value = default
    return max(low, min(high, value))


def _float_between(raw: Optional[str], *, default: float, low: float, high: float) -> float:
    """A number env var, clamped to [low, high]; empty or unreadable gives ``default``."""
    try:
        value = float(str(raw).strip()) if raw is not None and str(raw).strip() else default
    except ValueError:
        logger.warning("ignoring %r, not a number; using %s", raw, default)
        value = default
    return max(low, min(high, value))


class StartupError(Exception):
    """Why the interview cannot run. ``spoken`` is what the participant hears."""


class EliasInterviewerAgent(BaseAgent):
    supports_barge_in = False  # questions are read in full, never cut off
    supports_emotion_tags = False  # never strip [brackets] out of a question

    def __init__(
        self,
        *,
        checker: Optional[AnswerChecker] = None,
        state_machine_address: Optional[str] = None,
        sm_client: Any = None,
    ) -> None:
        super().__init__()
        self._checker = checker
        self.state_machine_address = state_machine_address  # None: STATE_MACHINE_ADDRESS
        self._sm = sm_client
        self._messages = dict(DEFAULT_MESSAGES)
        self._startup_error: Optional[str] = None
        self._questions: List[Question] = []
        self._plan: Optional[Dict[str, Any]] = None
        self._interview: Optional[Interview] = None
        self._elias: Optional[Elias] = None
        self._recorder: Optional[Recorder] = None
        self._transcript_id: Optional[str] = None
        self._resumed = False
        self._finished = False
        self._session_started_at: Optional[str] = None
        self._participant_poll_s = 0.3
        self._completion_delay_s = 1.0  # lets the session_completed frame reach the client before teardown

    # ── startup ──────────────────────────────────────────────────────────

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)
        self._session_started_at = datetime.now(timezone.utc).isoformat()
        try:
            await self._prepare(session_id, os.environ)
        except Exception as e:  # never raise out of startup, see module docstring
            self._startup_error = str(e) or e.__class__.__name__
            self.record_error(self._startup_error)
            logger.error("[STARTUP] interview cannot run: %s", self._startup_error)

    async def _prepare(self, session_id: str, env: Mapping[str, str]) -> None:
        """``env`` is the pod's environment; agent.yaml declares what it may hold."""
        for key, name in MESSAGE_ENV.items():
            if (env.get(name) or "").strip():
                self._messages[key] = env[name].strip()
        project_id = (env.get("ELIAS_PROJECT_ID") or "").strip()
        if not project_id:
            raise StartupError("No ELIAS project id configured (ELIAS_PROJECT_ID)")
        max_attempts = _int_between(env.get("ELIAS_MAX_ATTEMPTS"), default=3, low=1, high=5)

        connectors = getattr(self, "connectors", None)
        if connectors is None:
            raise StartupError(
                "This STELLA or SDK version has no connectors; ELIAS-Interviewer needs stella-ai-agent-sdk with connector support"
            )

        if self._checker is None:
            self._checker = AnswerChecker(
                model=(env.get("ANSWER_CHECK_MODEL") or "").strip() or "gpt-4o-mini",
                timeout_s=_float_between(env.get("ANSWER_CHECK_TIMEOUT_S"), default=8.0, low=1.0, high=60.0),
            )

        self._elias = Elias(connectors, ELIAS_SLOT, project_id)
        try:
            guide = await self._elias.get_guide()
            self._questions = parse_guide(guide)
        except (EliasUnavailable, GuideError) as e:
            raise StartupError(f"Could not load the ELIAS interview guide: {e}") from e
        logger.info("[STARTUP] %d questions from ELIAS project %s", len(self._questions), project_id)

        self._plan = build_plan(self._questions, project_id=project_id)
        start_index = 0
        if await self._connect_state_machine(session_id):
            await self._sm.initialize(self._plan)
            point = resume_point(self._questions, await self._sm.get_full_state())
            start_index = point["next_index"]
            self._transcript_id = point["transcript_id"]
            self._resumed = start_index > 0 or bool(self._transcript_id)
        self._interview = Interview(self._questions, max_attempts=max_attempts, index=start_index)
        if self._resumed:
            logger.info("[STARTUP] resuming at question %d of %d", start_index + 1, len(self._questions))

    async def _connect_state_machine(self, session_id: str) -> bool:
        """Progress and stored answers are a mirror, not the source of truth for
        ELIAS; without a state machine the interview still runs."""
        if self._sm is None:
            runtime = self.plan_runtime
            if not runtime.configured:
                logger.warning("[STARTUP] no STATE_MACHINE_ADDRESS, running without progress tracking")
                return False
            try:
                self._sm = await runtime.connect()
            except Exception as e:
                logger.warning("[STARTUP] state machine unavailable (%s), running without it", e)
                return False
        return True

    async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
        if self._startup_error:
            yield AgentOutput.error(session_id, self._startup_error, error_type="startup_error", recoverable=False)
            return
        progress = await self._progress_output("session_start")
        if progress is not None:
            yield progress

    # ── conversation ─────────────────────────────────────────────────────

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        # Not used: run_audio_loop drives the interview so the agent can speak first.
        return
        yield

    async def on_interrupt(self, session_id: str) -> None:
        # Barge-in is off; a question is never cut off mid-sentence.
        return None

    async def run_audio_loop(self) -> None:
        participant = await self.wait_for_participant(poll_interval=self._participant_poll_s)

        if self._startup_error or self._interview is None:
            await self._say(self._messages["error"], record=False)
            await self._finish_session("startup_error")
            return

        if not self._transcript_id:
            try:
                self._transcript_id = await self._elias.start_interview(participant, self.session_id or "")
            except EliasUnavailable as e:
                self._startup_error = f"Could not start the ELIAS interview: {e}"
                self.record_error(self._startup_error)
                await self._say(self._messages["error"], record=False)
                await self._finish_session("startup_error")
                return
            await self._set_deliverable(TRANSCRIPT_ID_KEY, self._transcript_id, "ELIAS start_interview")
        self._recorder = Recorder(self._elias, self._transcript_id)

        if not self._resumed and self._messages.get("opening"):
            await self._say(self._messages["opening"])
        await self._ask_current()

        async for event in self.audio.audio_in():
            if not (getattr(event, "is_final", False) and (event.text or "").strip()):
                continue
            if self.audio.is_closing or self._finished:
                continue
            await self._handle_reply(event.text.strip())
            if self._finished:
                break

    async def _handle_reply(self, text: str) -> None:
        iv = self._interview
        self.record_message_processed()
        self._recorder.record("participant", text)
        iv.add_reply(text)
        q = iv.current
        verdict = await self._checker.check(q.text, iv.replies, q.subquestions)
        step = iv.resolve(verdict)
        logger.info("[INTERVIEW] %s: %s (%s)", q.task_id, step.kind, step.reason)

        if step.kind == REASK:
            await self._ask_current(reask=True)
            return
        if step.kind == ANSWER:
            await self._set_deliverable(q.deliverable_key, step.answer, step.reason or "answered")
            await self._sm_call("complete_task", q.task_id, step.reason or "answered")
        elif step.kind == SKIP:
            await self._sm_call("skip_task", q.task_id, step.reason)
        await self._publish_progress("turn_completion")

        if iv.done:
            await self._close_interview()
        else:
            await self._ask_current()

    async def _ask_current(self, *, reask: bool = False) -> None:
        q = self._interview.current
        if q is None:
            return
        if reask and self._messages.get("reask_prefix"):
            await self._say(self._messages["reask_prefix"])
        self._interview.mark_asked()
        await self._say(q.text)  # verbatim

    async def _close_interview(self) -> None:
        if self._messages.get("closing"):
            await self._say(self._messages["closing"])
        await self._end_elias_interview()
        await self._finish_session("interview_complete")

    # ── session end ──────────────────────────────────────────────────────

    def session_end_mode(self) -> str:
        # 'wrap_up', so on_session_ending runs when the time cap or the organiser
        # ends the session, and the ELIAS interview is closed then too. It yields
        # nothing, so the SDK still speaks its farewell.
        return "wrap_up"

    async def on_session_ending(self, session_id: str, reason: str, deadline_ms: int) -> AsyncIterator[AgentOutput]:
        # The session really ends (time cap, organiser ended it): finalise what we have.
        await self._end_elias_interview()
        return
        yield

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        # Teardown also happens on auto-pause: flush, but leave the ELIAS interview open.
        if self._recorder is not None:
            await self._recorder.close()
        if self._sm is not None and hasattr(self._sm, "disconnect"):
            try:
                await self._sm.disconnect()
            except Exception:
                pass
        summary = {
            "elias_transcript_id": self._transcript_id,
            "questions": len(self._questions),
            "finished": self._finished,
            "turns_written": self._recorder.written if self._recorder else 0,
            "turns_failed": len(self._recorder.failed) if self._recorder else 0,
        }
        await super().on_session_end(session_id)
        return summary

    async def _end_elias_interview(self) -> None:
        if self._finished or not self._transcript_id or self._elias is None:
            return
        self._finished = True
        if self._recorder is not None:
            await self._recorder.flush()
        try:
            await self._elias.end_interview(self._transcript_id)
            logger.info("[ELIAS] interview %s ended", self._transcript_id)
        except EliasUnavailable as e:
            logger.error("[ELIAS] could not end interview %s: %s", self._transcript_id, e)

    async def _finish_session(self, reason: str) -> None:
        self._finished = True
        await self.complete_session(reason, delay_s=self._completion_delay_s)

    # ── helpers ──────────────────────────────────────────────────────────

    async def _say(self, text: str, *, record: bool = True) -> None:
        if not text.strip():
            return
        await self.audio.speak_line(text)
        if record and self._recorder is not None:
            self._recorder.record("interviewer", text)

    async def _set_deliverable(self, key: str, value: str, reasoning: str) -> None:
        if self._sm is None:
            return
        try:
            res = await self._sm.set_deliverable(key, value, reasoning=reasoning)
            if not res.get("success", True):
                logger.warning("[STATE] set_deliverable %s: %s", key, res.get("error"))
        except Exception as e:
            logger.warning("[STATE] set_deliverable %s failed: %s", key, e)

    async def _sm_call(self, method: str, task_id: str, reasoning: str) -> None:
        if self._sm is None:
            return
        try:
            res = await getattr(self._sm, method)(task_id, reasoning=reasoning)
            if not res.get("success", True):
                logger.info("[STATE] %s %s: %s", method, task_id, res.get("error"))
        except Exception as e:
            logger.warning("[STATE] %s %s failed: %s", method, task_id, e)

    async def _progress_output(self, trigger: str) -> Optional[AgentOutput]:
        if self._sm is None:
            return None
        try:
            full_state = await self._sm.get_full_state()
            if not full_state:
                return None
            progress = progress_from_full_state(full_state, plan=self._plan, session_started_at=self._session_started_at)
            return AgentOutput.progress_update(
                self.session_id or "", progress, update_trigger=trigger, agent_name=AGENT_NAME, agent_icon=AGENT_ICON
            )
        except Exception as e:
            logger.warning("[STATE] progress unavailable: %s", e)
            return None

    async def _publish_progress(self, trigger: str) -> None:
        output = await self._progress_output(trigger)
        if output is None:
            return
        try:
            await self.publish_progress(output)
        except Exception as e:
            logger.warning("[STATE] could not publish progress: %s", e)
