"""Test doubles: connectors (ELIAS), audio pipeline, state machine, checker."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from elias_interviewer.checker import Verdict

GUIDE = {
    "id": "g1",
    "project_id": "p1",
    "questions": [
        {"question": "What went through your mind when you were told?", "category": "Diagnosis", "order": 1},
        {"question": "What has changed in your daily routine?", "category": "Everyday life", "order": 2},
        {"question": "Who has helped you most?", "category": "Support", "order": 3},
    ],
}


class ConnectorError(Exception):
    def __init__(self, msg: str, retryable: bool = False) -> None:
        super().__init__(msg)
        self.retryable = retryable


class FakeConnectors:
    def __init__(self, guide: Optional[Dict[str, Any]] = GUIDE, fail: Optional[Dict[str, Exception]] = None) -> None:
        self.guide = guide
        self.fail = fail or {}
        self.calls: List[tuple] = []

    async def call_tool(self, handle: str, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        self.calls.append((handle, tool, dict(arguments)))
        if tool in self.fail:
            raise self.fail[tool]
        if tool == "get_interview_guide":
            return self.guide
        if tool == "start_interview":
            return {"transcript_id": "t-new", "status": "in_progress"}
        if tool == "record_interview_message":
            return {"ok": True, "message_id": arguments["message_id"]}
        if tool == "end_interview":
            return {"transcript_id": arguments["transcript_id"], "status": "completed"}
        raise AssertionError(f"unexpected tool {tool}")

    def tools(self, name: str) -> List[Dict[str, Any]]:
        return [args for (_, tool, args) in self.calls if tool == name]


@dataclass
class Event:
    text: str
    is_final: bool = True


class FakeAudio:
    """Feeds scripted replies; each reply is released only after the agent has
    spoken since the previous one, like a participant who waits for the question."""

    def __init__(self, replies: List[str], identities: Optional[List[str]] = None) -> None:
        self.replies = list(replies)
        self.spoken: List[str] = []
        self.identities = identities if identities is not None else ["agent-x", "participant-42"]
        self.published: List[Dict[str, Any]] = []
        self.is_closing = False
        self._spoke = asyncio.Event()

    def participant_identities(self) -> List[str]:
        return list(self.identities)

    async def publish_data(self, payload: Dict[str, Any]) -> None:
        self.published.append(payload)

    async def speak_line(self, text: str) -> None:
        self.spoken.append(text)
        self._spoke.set()

    async def wait_for_playout_drain(self, max_wait_ms: int = 15_000) -> None:
        return None

    async def audio_in(self):
        for reply in self.replies:
            await asyncio.wait_for(self._spoke.wait(), timeout=2)
            self._spoke.clear()
            yield Event(reply)


class FakeStateMachine:
    def __init__(self, existing: Optional[Dict[str, Any]] = None) -> None:
        self.plan: Optional[Dict[str, Any]] = None
        self.existing = existing
        self.deliverables: Dict[str, Any] = {}
        self.completed: List[str] = []
        self.skipped: List[str] = []

    async def initialize(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        self.plan = plan
        return {"success": True}

    async def get_full_state(self) -> Optional[Dict[str, Any]]:
        if self.existing is not None and not self.completed and not self.skipped and not self.deliverables:
            return self.existing
        if self.plan is None:
            return None
        states = []
        for s in self.plan["states"]:
            tasks = []
            for t in s["tasks"]:
                status = "completed" if t["id"] in self.completed else "skipped" if t["id"] in self.skipped else "pending"
                dels = [
                    {**d, "status": "completed" if d["key"] in self.deliverables else "pending",
                     **({"value": self.deliverables[d["key"]]} if d["key"] in self.deliverables else {})}
                    for d in t["deliverables"]
                ]
                tasks.append({"id": t["id"], "description": t["description"], "required": True, "status": status, "deliverables": dels})
            states.append({"id": s["id"], "title": s["title"], "type": s["type"], "status": "active", "tasks": tasks})
        return {"plan_id": self.plan["id"], "plan_title": self.plan["title"], "current_state_id": states[0]["id"],
                "progress": 0, "total_turns": 0, "turns_without_progress": 0, "states": states,
                "collected_deliverables": dict(self.deliverables)}

    async def set_deliverable(self, key: str, value: Any, reasoning: str = "", unconfirmed: bool = False) -> Dict[str, Any]:
        self.deliverables[key] = value
        return {"success": True}

    async def complete_task(self, task_id: str, reasoning: str = "") -> Dict[str, Any]:
        self.completed.append(task_id)
        return {"success": True}

    async def skip_task(self, task_id: str, reasoning: str = "") -> Dict[str, Any]:
        self.skipped.append(task_id)
        return {"success": True}

    async def disconnect(self) -> None:
        return None


class ScriptedChecker:
    """Verdict by reply text: 'hm'/'what?' -> unclear, 'pass' -> declined, else answered."""

    def __init__(self) -> None:
        self.calls: List[tuple] = []

    async def check(self, question: str, replies: List[str], subquestions=None) -> Verdict:
        self.calls.append((question, list(replies)))
        last = replies[-1].lower()
        if last in ("hm", "what?", "banana"):
            return Verdict("unclear", "not an answer")
        if last == "pass":
            return Verdict("declined", "does not want to say")
        return Verdict("answered", "responds")
