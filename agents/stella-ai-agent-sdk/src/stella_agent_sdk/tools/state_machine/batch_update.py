"""Tool for batch-updating deliverables and completing tasks in a single call."""

from typing import Any, Dict, List

from stella_agent_sdk.tools.base import BaseTool, ToolResult
from stella_agent_sdk.tools.state_machine.guidance import STATE_MACHINE_TOOL_GUIDANCE
from stella_agent_sdk.services.state_machine_client import StateMachineClient


class BatchUpdateTool(BaseTool):
    """
    Set multiple deliverables and complete multiple tasks in one call.

    Use this instead of calling set_deliverable/complete_task repeatedly.
    Include every deliverable and task you found — current message and history.
    """

    guidance = STATE_MACHINE_TOOL_GUIDANCE

    def __init__(self, client: StateMachineClient):
        self._client = client

    @property
    def name(self) -> str:
        return "batch_update"

    @property
    def description(self) -> str:
        return (
            "Set multiple deliverables, complete multiple tasks, and/or skip multiple "
            "tasks in a single call. Use this to submit ALL state changes at once — from "
            "the current message and conversation history. Each deliverable needs a key, "
            "value, and reasoning. Each completed/skipped task needs a task_id and reasoning. "
            "Tasks never complete on their own: explicitly complete a task once you have "
            "what it needs, or skip it when it does not apply."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "deliverables": {
                    "type": "array",
                    "description": "Deliverables to set (can be empty array)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "The deliverable key"
                            },
                            "value": {
                                "type": "string",
                                "description": "The extracted value"
                            },
                            "reasoning": {
                                "type": "string",
                                "description": "Why this value matches"
                            },
                            "unconfirmed": {
                                "type": "boolean",
                                "description": (
                                    "Set true when the user mentioned this in passing "
                                    "rather than answering a question about it — a "
                                    "detail volunteered while talking about something "
                                    "else, or one you inferred rather than were told. "
                                    "It is recorded either way, but an unconfirmed "
                                    "value gets checked back with the user in "
                                    "conversation instead of being treated as settled. "
                                    "Use false when they answered directly."
                                ),
                            },
                            "correction": {
                                "type": "boolean",
                                "description": (
                                    "Set true ONLY when the participant deliberately "
                                    "changes an answer that is already recorded "
                                    "(\"actually, it is Sarah, not Tom\"). A required "
                                    "answer that is already collected is rejected "
                                    "without this. Put what they said in reasoning. "
                                    "Leave false for a first answer."
                                ),
                            }
                        },
                        "required": ["key", "value", "reasoning"]
                    }
                },
                "tasks": {
                    "type": "array",
                    "description": "Tasks to mark as completed (can be empty array)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "task_id": {
                                "type": "string",
                                "description": "The task ID to complete"
                            },
                            "reasoning": {
                                "type": "string",
                                "description": "Why this task is complete"
                            }
                        },
                        "required": ["task_id", "reasoning"]
                    }
                },
                "skip_tasks": {
                    "type": "array",
                    "description": "Tasks to mark as skipped — not relevant or not worth pursuing (can be empty array)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "task_id": {
                                "type": "string",
                                "description": "The task ID to skip"
                            },
                            "reasoning": {
                                "type": "string",
                                "description": "Why this task is being skipped"
                            }
                        },
                        "required": ["task_id", "reasoning"]
                    }
                }
            },
            "required": ["deliverables", "tasks"]
        }

    async def execute(
        self,
        deliverables: List[Dict[str, str]] = None,
        tasks: List[Dict[str, str]] = None,
        skip_tasks: List[Dict[str, str]] = None,
    ) -> ToolResult:
        """Execute batch update — set deliverables, complete tasks, skip tasks."""
        deliverables = deliverables or []
        tasks = tasks or []
        skip_tasks = skip_tasks or []

        results = {
            "deliverables_set": [],
            "deliverables_failed": [],
            "tasks_completed": [],
            "tasks_failed": [],
            "tasks_skipped": [],
            "skips_failed": [],
            # Tasks this batch's own deliverables already satisfied. The backend
            # counts a task whose deliverables are all in as addressed (#291), so
            # completing it afterwards finds nothing pending — that is not a failure.
            "tasks_addressed": [],
            # Forward end-node completion metadata so the expert runner can emit
            # farewell and stop the session cleanly.
            "session_completed": False,
            "farewell_message": None,
            "summary_behavior": None,
        }

        # Which tasks were open before this batch wrote anything, so a task its
        # own deliverables satisfied can be told apart from a wrong task_id.
        pending_before = (
            {t.get("id") for t in await self._client.get_pending_tasks() if t.get("id")}
            if deliverables and tasks else set()
        )

        # Process deliverables — stop if a state transition occurs
        transitioned = False
        for i, d in enumerate(deliverables):
            try:
                result = await self._client.set_deliverable(
                    d["key"], d["value"], d.get("reasoning", ""),
                    bool(d.get("unconfirmed", False)),
                    bool(d.get("correction", False)),
                )
                if result.get("success"):
                    results["deliverables_set"].append({
                        "key": d["key"],
                        "value": d["value"],
                        "task_completed": result.get("task_completed"),
                        "transitioned": result.get("transitioned", False),
                        "new_state_id": result.get("new_state_id"),
                    })
                    if result.get("session_completed"):
                        results["session_completed"] = True
                        results["farewell_message"] = result.get("farewell_message")
                        results["summary_behavior"] = result.get("summary_behavior")
                    if result.get("transitioned", False):
                        transitioned = True
                        for skipped in deliverables[i + 1:]:
                            results["deliverables_failed"].append({
                                "key": skipped["key"],
                                "error": "skipped: state transitioned",
                            })
                        break
                else:
                    results["deliverables_failed"].append({
                        "key": d["key"],
                        "error": result.get("error") or "unknown",
                    })
            except Exception as e:
                results["deliverables_failed"].append({
                    "key": d["key"],
                    "error": str(e),
                })

        # Build pending-task lookup once so task_id inputs can be validated/corrected.
        pending_tasks = await self._client.get_pending_tasks()
        pending_ids = {t.get("id") for t in pending_tasks if t.get("id")}
        pending_by_description: Dict[str, str] = {}
        duplicate_descriptions = set()
        for task in pending_tasks:
            description = task.get("description")
            task_id = task.get("id")
            if not description or not task_id:
                continue
            if description in pending_by_description:
                duplicate_descriptions.add(description)
            else:
                pending_by_description[description] = task_id
        for description in duplicate_descriptions:
            pending_by_description.pop(description, None)

        def _drop_pending(task_id: str) -> None:
            # Keep the local pending snapshot in sync as tasks are addressed within
            # this same batch. Without this, a task completed in the completes loop
            # still looks "pending" to the skips loop (validated against the same
            # stale set), so a later skip is dispatched and bounced into
            # skips_failed — a spurious failure in combined batches.
            pending_ids.discard(task_id)
            for desc, tid in list(pending_by_description.items()):
                if tid == task_id:
                    pending_by_description.pop(desc, None)

        # Process tasks — skip if already transitioned
        if not transitioned:
            for i, t in enumerate(tasks):
                try:
                    raw_task_id = t["task_id"]
                    resolved_task_id = raw_task_id
                    if raw_task_id not in pending_ids and raw_task_id in pending_before:
                        results["tasks_addressed"].append({"task_id": raw_task_id})
                        continue
                    if resolved_task_id not in pending_ids:
                        resolved_task_id = pending_by_description.get(raw_task_id, "")
                        if not resolved_task_id:
                            results["tasks_failed"].append({
                                "task_id": raw_task_id,
                                "error": (
                                    f"invalid task_id '{raw_task_id}': use an exact pending task ID"
                                ),
                            })
                            continue

                    result = await self._client.complete_task(
                        resolved_task_id, t.get("reasoning", "")
                    )
                    if result.get("success"):
                        _drop_pending(resolved_task_id)
                        results["tasks_completed"].append({
                            "task_id": resolved_task_id,
                            "transitioned": result.get("transitioned", False),
                            "new_state_id": result.get("new_state_id"),
                        })
                        if result.get("session_completed"):
                            results["session_completed"] = True
                            results["farewell_message"] = result.get("farewell_message")
                            results["summary_behavior"] = result.get("summary_behavior")
                        if result.get("transitioned", False):
                            transitioned = True
                            for skipped in tasks[i + 1:]:
                                results["tasks_failed"].append({
                                    "task_id": skipped["task_id"],
                                    "error": "skipped: state transitioned",
                                })
                            break
                    else:
                        results["tasks_failed"].append({
                            "task_id": t["task_id"],
                            "error": result.get("error") or "unknown",
                        })
                except Exception as e:
                    results["tasks_failed"].append({
                        "task_id": t["task_id"],
                        "error": str(e),
                    })
        else:
            for t in tasks:
                if t["task_id"] in pending_before:
                    # Its phase completed on this batch's deliverables.
                    results["tasks_addressed"].append({"task_id": t["task_id"]})
                    continue
                results["tasks_failed"].append({
                    "task_id": t["task_id"],
                    "error": "skipped: state transitioned during deliverable processing",
                })

        # Process skips — also short-circuit once a transition has occurred.
        for s in skip_tasks:
            if transitioned:
                results["skips_failed"].append({
                    "task_id": s["task_id"],
                    "error": "skipped: state already transitioned",
                })
                continue
            try:
                raw_task_id = s["task_id"]
                resolved_task_id = raw_task_id
                if resolved_task_id not in pending_ids:
                    resolved_task_id = pending_by_description.get(raw_task_id, "")
                    if not resolved_task_id:
                        results["skips_failed"].append({
                            "task_id": raw_task_id,
                            "error": (
                                f"invalid task_id '{raw_task_id}': use an exact pending task ID"
                            ),
                        })
                        continue

                result = await self._client.skip_task(
                    resolved_task_id, s.get("reasoning", "")
                )
                if result.get("success"):
                    _drop_pending(resolved_task_id)
                    results["tasks_skipped"].append({
                        "task_id": resolved_task_id,
                        "transitioned": result.get("transitioned", False),
                        "new_state_id": result.get("new_state_id"),
                    })
                    if result.get("session_completed"):
                        results["session_completed"] = True
                        results["farewell_message"] = result.get("farewell_message")
                        results["summary_behavior"] = result.get("summary_behavior")
                    if result.get("transitioned", False):
                        transitioned = True
                else:
                    results["skips_failed"].append({
                        "task_id": s["task_id"],
                        "error": result.get("error") or "unknown",
                    })
            except Exception as e:
                results["skips_failed"].append({
                    "task_id": s["task_id"],
                    "error": str(e),
                })

        failures = [
            f"{item.get('key') or item.get('task_id')}: {item.get('error')}"
            for bucket in ("deliverables_failed", "tasks_failed", "skips_failed")
            for item in results[bucket]
        ]
        # The per-item reasons stay in `data`; `error` is the one line that
        # debug output shows, and without it a failure read "failed: None".
        return ToolResult(
            success=not failures,
            data=results,
            error="; ".join(failures) if failures else None,
        )
