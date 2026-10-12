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
loses its answers. Skipping a goal is not checked here.
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
- A hesitant or hypothetical answer ("maybe", "I suppose", "I could", "that could be nice", "I'll see how I feel") does not reach a goal that asks for a decision, a commitment or a plan.
- Something the user already does, or did in the past, is not a plan or a next step.
- A remark made in passing while talking about something else does not reach the goal. The user must be answering to the goal's subject.
- A clear "yes" to a specific proposal the assistant just made does count; quote the user's "yes".
- Where an answer is listed with what it must look like, hold the recorded value to that. A value taken from small talk does not meet it.
- If you are unsure, the goal is not reached.

Reply with JSON only: {{"quote": "<the user's exact words, or empty>", "reached": true or false, "reason": "<one short sentence>"}}

Conversation:
{conversation}"""


@dataclass
class GoalCheckResult:
    allowed: bool
    quote: str = ""
    reason: str = ""

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

    async def filter(
        self,
        tool_calls: List[Any],
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        model: str,
    ) -> Tuple[List[Any], Optional[GoalCheckResult]]:
        """``tool_calls`` as they may run, and the check's result if there was
        a close to check (None otherwise — the common case, with no model call)."""
        if sm_context.get("processing_mode") != "goal":
            return tool_calls, None
        without_close, closing = split_goal_close(tool_calls)
        if not closing:
            return tool_calls, None
        result = await self._check(tool_calls, user_input, conversation_history, sm_context, model)
        logger.info(
            "Goal close %s: %s", "allowed" if result.allowed else "held back", result.reason or result.quote
        )
        return (tool_calls if result.allowed else without_close), result

    async def _check(
        self,
        tool_calls: List[Any],
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        model: str,
    ) -> GoalCheckResult:
        state = sm_context.get("state") or {}
        turns = [*conversation_history[-HISTORY_TURNS:], {"role": "user", "content": user_input}]
        prompt = PROMPT.format(
            objective=state.get("goal_objective") or state.get("description") or state.get("title") or "",
            success=state.get("goal_success_description") or "the objective is met",
            deliverables=_deliverable_lines(sm_context, _proposed_values(tool_calls)),
            conversation="\n".join(
                f"{'USER' if m.get('role') == 'user' else 'ASSISTANT'}: {m.get('content', '')}" for m in turns
            ),
        )
        try:
            response = await self._llm_service.generate(
                messages=[LLMMessage(role="user", content=prompt)],
                config=LLMConfig(
                    model=model, temperature=0.0, max_tokens=200,
                    provider=LLMProvider.OPENAI_LANGCHAIN, json_mode=True,
                ),
                component_name="expert:goal_close_check",
            )
            answer = json.loads(response.content)
        except Exception as error:
            # Without an answer the goal stays open; the expert will try again.
            logger.warning("Goal close check failed, holding the goal open: %s", error)
            return GoalCheckResult(False, reason=f"check failed: {str(error)[:80]}")

        quote = str(answer.get("quote") or "").strip()
        reason = str(answer.get("reason") or "").strip()
        if answer.get("reached") is not True:
            return GoalCheckResult(False, quote, reason)
        said = _norm(" ".join(m.get("content", "") for m in turns if m.get("role") == "user"))
        if not quote or _norm(quote) not in said:
            return GoalCheckResult(False, quote, "the quoted words are not something the user said")
        return GoalCheckResult(True, quote, reason)
