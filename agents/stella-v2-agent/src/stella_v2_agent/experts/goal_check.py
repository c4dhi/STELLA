"""A second opinion before a goal state is closed as reached (#706).

The extraction expert both collects what the user says and decides when a goal
is reached. It is told to be alert to answers given in passing, and it judges
"reached" in that same generous frame: in simulated conversations it closed a
goal on a remark about a picnic, and on "maybe a park could be nice".

So that one decision gets its own call. When the expert's tool calls would
complete the goal task, this asks a single yes/no question with nothing else to
do, and it has to quote the user's words that meet the success criteria. Unless
it says yes and the quote really is something the user said, the completion is
taken out of the tool calls; everything else in them still runs.

It leans to "not reached" on purpose. Closing a goal late costs a few turns and
the stuck-state net still catches it; closing it early skips the state and
loses its answers.

Skipping a goal gets the same treatment, with its own question: did the user
refuse this part of the conversation or ask to move on? A smaller model gave a
goal up because the user had not answered one question yet, in the same call
that recorded two of their answers.
"""

import json
import logging
import re
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Optional, Tuple

from stella_agent_sdk.llm import LLMConfig, LLMMessage, LLMProvider, LLMService

logger = logging.getLogger(__name__)

# Ids a goal state's one task goes by (the state machine accepts both).
GOAL_TASK_IDS = {"__goal__", "__goal_deliverables__"}
# How a goal used to be closed: a deliverable with this key set to "yes".
LEGACY_GOAL_MARKER = "__goal_achieved__"
_LEGACY_YES = {"true", "yes", "1", "done", "completed", "complete", "achieved", "met"}

HISTORY_TURNS = 12

PROMPT = """You check one thing about a conversation between an assistant and a user: has the goal below been reached?

Decide only from what the USER said. The assistant's own words never reach a goal.

Goal: {objective}
It is reached when: {success}
{deliverables}
Rules:
- Find the user's own words that meet the criteria and copy them exactly into "quote". If there are none, the goal is not reached.
- The quote must be the words behind the hardest part of the criteria: the reason, the decision or the plan itself. A name, a greeting or a pleasantry is never the quote. If any required part has no words of the user behind it, the goal is not reached.
- A hesitant or hypothetical answer ("maybe", "I suppose", "I could", "that could be nice", "I'll see how I feel") does not reach a goal that asks for a decision, a commitment or a plan.
- Something the user already does, or did in the past, is not a plan or a next step.
- A remark made in passing while talking about something else does not reach the goal. The user must be answering to the goal's subject.
- A clear "yes" to a specific proposal the assistant just made does count; quote the user's "yes".
- Where an answer is listed with what it must look like, hold the recorded value to that. A value taken from small talk does not meet it.
- Conditional talk ("if the weather behaves", "that would be the sort of day for it", "one could") and finding a suggestion pleasant ("sounds sensible", "that would be nice") are not taking it on. The quote itself must show the user deciding.
- If you are unsure, the goal is not reached.

Reply with JSON only: {{"quote": "<the user's exact words, or empty>", "reached": true or false, "reason": "<one short sentence>"}}

Conversation:
{conversation}"""

SKIP_PROMPT = """You check one thing about a conversation between an assistant and a user: has the user turned this part of the conversation down?

This part is about: {objective}

Rules:
- Find the user's own words that refuse it, or ask to move on, change the subject or stop, and copy them exactly into "quote". If there are none, the answer is no.
- Declining ONE question (not giving a name, "I'd rather not say") while staying in the conversation is not turning this part down.
- Being unsure, vague, brief or quiet, or talking about something else, is not turning it down. Neither is not having answered yet.
- The one exception: the assistant has brought the subject up three or more times and each time the user gave no answer to it. Then the answer is yes; quote the user's latest non-answer.
- If you are unsure, the answer is no.

Reply with JSON only: {{"quote": "<the user's exact words, or empty>", "refused": true or false, "reason": "<one short sentence>"}}

Conversation:
{conversation}"""


@dataclass
class GoalCheckResult:
    allowed: bool
    quote: str = ""
    reason: str = ""

    kind: str = "close"   # "close" (reached) or "skip" (given up)

    def as_dict(self) -> Dict[str, Any]:
        return {"attempted": True, "allowed": self.allowed, "quote": self.quote, "reason": self.reason}


def _norm(text: str) -> str:
    return re.sub(r"[^\w\s]", "", re.sub(r"\s+", " ", text or "")).strip().lower()


def _is_legacy_close(key: Any, value: Any) -> bool:
    return key == LEGACY_GOAL_MARKER and (value is True or str(value).strip().lower() in _LEGACY_YES)


def split_goal_close(tool_calls: List[Any]) -> Tuple[List[Any], bool]:
    """The tool calls without any that would close a goal as reached, and
    whether there was one. Skips of the goal are left in."""
    kept: List[Any] = []
    closing = False
    for call in tool_calls:
        args = call.arguments or {}
        if call.name == "complete_task" and args.get("task_id") in GOAL_TASK_IDS:
            closing = True
            continue
        if call.name == "set_deliverable" and _is_legacy_close(args.get("key"), args.get("value")):
            closing = True
            continue
        if call.name == "batch_update":
            tasks = args.get("tasks") or []
            deliverables = args.get("deliverables") or []
            other_tasks = [t for t in tasks if t.get("task_id") not in GOAL_TASK_IDS]
            other_deliverables = [d for d in deliverables if not _is_legacy_close(d.get("key"), d.get("value"))]
            if len(other_tasks) != len(tasks) or len(other_deliverables) != len(deliverables):
                closing = True
                if not (other_tasks or other_deliverables or args.get("skip_tasks")):
                    continue
                call = replace(call, arguments={**args, "tasks": other_tasks, "deliverables": other_deliverables})
        kept.append(call)
    return kept, closing


def split_goal_skip(tool_calls: List[Any]) -> Tuple[List[Any], bool]:
    """The tool calls without any that would give the goal up (skip its task,
    or skip the whole state), and whether there was one."""
    kept: List[Any] = []
    skipping = False
    for call in tool_calls:
        args = call.arguments or {}
        if call.name == "skip_state" or (call.name == "skip_task" and args.get("task_id") in GOAL_TASK_IDS):
            skipping = True
            continue
        if call.name == "batch_update":
            skips = args.get("skip_tasks") or []
            other_skips = [t for t in skips if t.get("task_id") not in GOAL_TASK_IDS]
            if len(other_skips) != len(skips):
                skipping = True
                if not (other_skips or args.get("tasks") or args.get("deliverables")):
                    continue
                call = replace(call, arguments={**args, "skip_tasks": other_skips})
        kept.append(call)
    return kept, skipping


def _proposed_values(tool_calls: List[Any]) -> Dict[str, Any]:
    values: Dict[str, Any] = {}
    for call in tool_calls:
        args = call.arguments or {}
        if call.name == "set_deliverable" and args.get("key"):
            values[args["key"]] = args.get("value")
        if call.name == "batch_update":
            for d in args.get("deliverables") or []:
                if d.get("key"):
                    values[d["key"]] = d.get("value")
    return values


def _deliverable_lines(sm_context: Dict[str, Any], proposed: Dict[str, Any]) -> str:
    """The answers this goal collects, what each must look like, and what is
    recorded for it — including what this very turn is about to record."""
    state_id = (sm_context.get("state") or {}).get("id")
    state = next((s for s in sm_context.get("full_plan", []) if s.get("id") == state_id), None)
    lines = []
    for task in (state or {}).get("tasks", []):
        for d in task.get("deliverables", []):
            key = d.get("key")
            if not key or key == LEGACY_GOAL_MARKER:
                continue
            value = proposed.get(key, d.get("value"))
            line = f"- {key} ({'required' if d.get('required') else 'optional'}): {d.get('description') or ''}"
            if d.get("acceptance_criteria"):
                line += f" Must look like: {d['acceptance_criteria']}"
            line += f" Recorded: {json.dumps(value, ensure_ascii=False) if value not in (None, '') else 'nothing yet'}"
            lines.append(line)
    return ("Answers this goal collects:\n" + "\n".join(lines) + "\n") if lines else ""


class GoalCloseCheck:
    """Decides whether a goal the extraction expert wants to close is reached."""

    def __init__(self, llm_service: LLMService):
        self._llm_service = llm_service
        # What was held back last, per goal state. The expert makes one call a
        # turn and never sees what became of its tool calls; told nothing, it
        # tries the same close again every turn.
        self._held: Dict[str, GoalCheckResult] = {}

    def note_for(self, sm_context: Dict[str, Any]) -> str:
        """A line for the expert's prompt about its last held-back attempt in
        the current goal state, or "" when there was none."""
        if sm_context.get("processing_mode") != "goal":
            return ""
        held = self._held.get((sm_context.get("state") or {}).get("id") or "")
        if not held:
            return ""
        action = "complete" if held.kind == "close" else "skip"
        return (
            f"YOUR LAST ATTEMPT: you tried to {action} `__goal__` and it was held back: {held.reason} "
            f"Do not try to {action} it again unless the user's NEW message changes that."
        )

    async def filter(
        self,
        tool_calls: List[Any],
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        model: str,
    ) -> Tuple[List[Any], List[GoalCheckResult]]:
        """``tool_calls`` as they may run, and the result of each check made:
        one for a close, one for a skip. Empty in the common case, with no
        model call."""
        if sm_context.get("processing_mode") != "goal":
            return tool_calls, []
        results: List[GoalCheckResult] = []

        without_close, closing = split_goal_close(tool_calls)
        if closing:
            result = await self._check(tool_calls, user_input, conversation_history, sm_context, model)
            results.append(result)
            if not result.allowed:
                tool_calls = without_close

        without_skip, skipping = split_goal_skip(tool_calls)
        if skipping:
            result = await self._check_skip(user_input, conversation_history, sm_context, model)
            results.append(result)
            if not result.allowed:
                tool_calls = without_skip

        state_id = (sm_context.get("state") or {}).get("id") or ""
        held = next((r for r in results if not r.allowed), None)
        if held:
            self._held = {state_id: held}
        elif results:
            self._held = {}

        for result in results:
            logger.info(
                "Goal %s %s: %s", result.kind, "allowed" if result.allowed else "held back",
                result.reason or result.quote,
            )
        return tool_calls, results

    @staticmethod
    def _conversation(conversation_history: List[Dict[str, str]], user_input: str) -> List[Dict[str, str]]:
        return [*conversation_history[-HISTORY_TURNS:], {"role": "user", "content": user_input}]

    async def _ask(self, prompt: str, turns: List[Dict[str, str]], yes_field: str, model: str, kind: str) -> GoalCheckResult:
        """One yes/no answer with a quote. Yes only counts when the quote is
        something the user said; no answer at all leaves the goal as it is."""
        try:
            response = await self._llm_service.generate(
                messages=[LLMMessage(role="user", content=prompt)],
                config=LLMConfig(
                    model=model, temperature=0.0, max_tokens=200,
                    provider=LLMProvider.OPENAI_LANGCHAIN, json_mode=True,
                ),
                component_name=f"expert:goal_{kind}_check",
            )
            answer = json.loads(response.content)
        except Exception as error:
            # Without an answer the goal stays open; the expert will try again.
            logger.warning("Goal %s check failed, holding the goal open: %s", kind, error)
            return GoalCheckResult(False, reason=f"check failed: {str(error)[:80]}", kind=kind)

        quote = str(answer.get("quote") or "").strip()
        reason = str(answer.get("reason") or "").strip()
        if answer.get(yes_field) is not True:
            return GoalCheckResult(False, quote, reason, kind)
        said = _norm(" ".join(m.get("content", "") for m in turns if m.get("role") == "user"))
        if not quote or _norm(quote) not in said:
            return GoalCheckResult(False, quote, "the quoted words are not something the user said", kind)
        return GoalCheckResult(True, quote, reason, kind)

    @staticmethod
    def _render(turns: List[Dict[str, str]]) -> str:
        return "\n".join(
            f"{'USER' if m.get('role') == 'user' else 'ASSISTANT'}: {m.get('content', '')}" for m in turns
        )

    async def _check_skip(
        self,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        model: str,
    ) -> GoalCheckResult:
        state = sm_context.get("state") or {}
        turns = self._conversation(conversation_history, user_input)
        prompt = SKIP_PROMPT.format(
            objective=state.get("goal_objective") or state.get("description") or state.get("title") or "",
            conversation=self._render(turns),
        )
        return await self._ask(prompt, turns, "refused", model, "skip")

    async def _check(
        self,
        tool_calls: List[Any],
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        model: str,
    ) -> GoalCheckResult:
        state = sm_context.get("state") or {}
        turns = self._conversation(conversation_history, user_input)
        prompt = PROMPT.format(
            objective=state.get("goal_objective") or state.get("description") or state.get("title") or "",
            success=state.get("goal_success_description") or "the objective is met",
            deliverables=_deliverable_lines(sm_context, _proposed_values(tool_calls)),
            conversation=self._render(turns),
        )
        return await self._ask(prompt, turns, "reached", model, "close")
