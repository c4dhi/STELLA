"""Extraction saves only what Jev picked.

The reply is steered by Jev's pick before anything is saved. When extraction then saves
a different task, the reply and the plan drift apart: the reply asks again for what is
already saved, and the next answer lands in the next free slot. So on a turn where Jev
picked a task, extraction gets state machine tools that write that task and nothing
else. A correction Jev picked is saved as a correction, so it overwrites the old value,
and a task only mentioned in passing is saved as unconfirmed, for the reply to check lightly.

The value itself still comes from extraction, which can also save nothing. That is
recorded, and the task is simply open again on the next turn.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Set, Union

from stella_agent_sdk.tools.base import BaseTool, ToolResult

WRITES_TASKS = {"complete_task", "skip_task"}
ANSWERED, MENTIONED, CORRECTED = "answered", "mentioned", "corrected"


@dataclass
class Scope:
    task: str
    task_ids: Set[str]
    # Each key it may write, and how: answered, mentioned in passing, or corrected.
    keys: Dict[str, str]
    written: List[str] = field(default_factory=list)
    refused: List[str] = field(default_factory=list)
    # Each picked task by name, with every key and id that would count as saving it.
    tasks: Dict[str, Set[str]] = field(default_factory=dict)

    @classmethod
    def of(cls, picks: Union[Dict[str, Any], List[Dict[str, Any]]]) -> "Scope":
        picks = [picks] if isinstance(picks, dict) else picks
        names, ids, keys, tasks = [], set(), {}, {}
        for pick in picks:
            task = pick["task"]
            how = CORRECTED if pick.get("correction") else MENTIONED if pick.get("also") else ANSWERED
            names.append(str(task.get("description") or task.get("id")))
            tasks[names[-1]] = {d["key"] for d in task.get("deliverables", []) if d.get("key")}
            if how != CORRECTED:
                # A corrected task is already complete, so only its values can change.
                refs = {i for i in (task.get("id"), task.get("description")) if i}
                tasks[names[-1]] |= refs
                ids |= refs
            for d in task.get("deliverables", []):
                if d.get("key"):
                    keys[d["key"]] = how
        return cls(" and ".join(names), ids, keys, tasks=tasks)

    def unsaved(self) -> List[str]:
        """The picked tasks extraction wrote nothing for."""
        written = set(self.written)
        return [name for name, refs in self.tasks.items() if not refs & written]

    @property
    def correction(self) -> bool:
        return CORRECTED in self.keys.values()

    def refusal(self) -> str:
        return f"Not this turn: the latest message was about {self.task}. Only save that."

    def deliverable(self, item: Dict[str, Any]) -> bool:
        how = self.keys.get(item.get("key"))
        if how is None:
            self.refused.append(str(item.get("key")))
            return False
        if how == CORRECTED:
            item["correction"] = True
        elif how == MENTIONED:
            item["unconfirmed"] = True
        self.written.append(str(item["key"]))
        return True

    def task_ok(self, task_id: Any) -> bool:
        if task_id not in self.task_ids:
            self.refused.append(str(task_id))
            return False
        self.written.append(str(task_id))
        return True


class ScopedTool(BaseTool):
    """The same tool, refusing any write outside the scope."""

    def __init__(self, tool: BaseTool, scope: Scope):
        self._tool = tool
        self._scope = scope
        self.guidance = tool.guidance

    @property
    def name(self) -> str:
        return self._tool.name

    @property
    def description(self) -> str:
        return self._tool.description

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return self._tool.parameters_schema

    async def execute(self, **kwargs: Any) -> ToolResult:
        scope, name = self._scope, self._tool.name
        if name == "batch_update":
            refused_before = len(scope.refused)
            kwargs["deliverables"] = [d for d in kwargs.get("deliverables") or [] if scope.deliverable(d)]
            kwargs["tasks"] = [t for t in kwargs.get("tasks") or [] if scope.task_ok(t.get("task_id"))]
            kwargs["skip_tasks"] = [t for t in kwargs.get("skip_tasks") or [] if scope.task_ok(t.get("task_id"))]
            result = await self._tool.execute(**kwargs)
            refused = scope.refused[refused_before:]
            if refused and isinstance(result.data, dict):
                result.data["refused"] = {"items": refused, "reason": scope.refusal()}
            return result
        if name == "set_deliverable":
            if not scope.deliverable(kwargs):
                return ToolResult(success=False, error=scope.refusal())
        elif name in WRITES_TASKS:
            if not scope.task_ok(kwargs.get("task_id")):
                return ToolResult(success=False, error=scope.refusal())
        elif name == "skip_state":
            scope.refused.append("skip_state")
            return ToolResult(success=False, error=scope.refusal())
        return await self._tool.execute(**kwargs)


def scoped(tools: List[BaseTool], scope: Scope) -> List[BaseTool]:
    return [ScopedTool(t, scope) for t in tools]
