"""Turn an ELIAS interview guide into questions and a STELLA plan.

ELIAS ``get_interview_guide`` returns::

    {"id": ..., "project_id": ..., "questions": [
        {"question": "...", "category": "Diagnosis", "order": 1, "subquestions": null},
        ...
    ]}

The plan mirrors the interview so STELLA shows progress, keeps the answers in
the session's deliverables (exports, summaries), and can resume after an
auto-pause:

- one state per category, in the order categories first appear;
- one task per question (``q<order>``) with one required deliverable
  (``q<order>_answer``);
- states chain with ``all_tasks_complete``; the last goes to ``__end__``.

The agent asks the questions itself, word for word. The plan only records.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

END_STATE_ID = "__end__"
TRANSCRIPT_ID_KEY = "elias_transcript_id"


class GuideError(ValueError):
    """The guide is missing or unusable (no questions)."""


@dataclass(frozen=True)
class Question:
    order: int
    text: str
    category: str
    subquestions: List[str] = field(default_factory=list)

    @property
    def task_id(self) -> str:
        return f"q{self.order}"

    @property
    def deliverable_key(self) -> str:
        return f"q{self.order}_answer"


def parse_guide(guide: Dict[str, Any]) -> List[Question]:
    raw = guide.get("questions") if isinstance(guide, dict) else None
    if not raw:
        raise GuideError("The ELIAS project has no interview guide, or the guide has no questions")

    questions: List[Question] = []
    seen_orders = set()
    for i, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            continue
        text = str(item.get("question") or "").strip()
        if not text:
            continue
        order = item.get("order")
        order = int(order) if isinstance(order, (int, float)) or (isinstance(order, str) and order.isdigit()) else i
        while order in seen_orders:  # keep ids unique even if ELIAS repeats an order
            order += 1000
        seen_orders.add(order)
        subs = item.get("subquestions") or []
        if isinstance(subs, str):
            subs = [subs]
        questions.append(
            Question(
                order=order,
                text=text,
                category=str(item.get("category") or "Interview").strip() or "Interview",
                subquestions=[str(s).strip() for s in subs if str(s).strip()],
            )
        )

    if not questions:
        raise GuideError("The ELIAS interview guide has no usable questions")
    questions.sort(key=lambda q: q.order)
    return questions


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_") or "section"


def build_plan(questions: List[Question], *, project_id: str, title: str = "ELIAS interview") -> Dict[str, Any]:
    categories: List[str] = []
    for q in questions:
        if q.category not in categories:
            categories.append(q.category)

    state_ids: Dict[str, str] = {}
    for idx, cat in enumerate(categories, start=1):
        state_ids[cat] = f"s{idx}_{_slug(cat)}"

    states: List[Dict[str, Any]] = []
    for idx, cat in enumerate(categories):
        tasks = []
        for q in (q for q in questions if q.category == cat):
            deliverables = [
                {
                    "key": q.deliverable_key,
                    "type": "string",
                    "description": f"Answer to: {q.text}",
                    "required": True,
                }
            ]
            tasks.append(
                {
                    "id": q.task_id,
                    "description": q.text,
                    "instruction": "Asked verbatim by the agent.",
                    "required": True,
                    "deliverables": deliverables,
                }
            )
        next_id = state_ids[categories[idx + 1]] if idx + 1 < len(categories) else END_STATE_ID
        states.append(
            {
                "id": state_ids[cat],
                "title": cat,
                "type": "strict",
                "description": f"ELIAS questions: {cat}",
                "tasks": tasks,
                "transitions": [
                    {"target_state_id": next_id, "condition_type": "all_tasks_complete", "priority": 100}
                ],
            }
        )

    # Where the ELIAS transcript id lives, so a pod that wakes after an
    # auto-pause continues the same ELIAS interview instead of opening a new
    # one. Optional, so it never blocks the first task from completing.
    states[0]["tasks"][0]["deliverables"].append(
        {
            "key": TRANSCRIPT_ID_KEY,
            "type": "string",
            "description": "ELIAS transcript id (internal)",
            "required": False,
        }
    )

    return {
        "id": f"elias-{project_id}",
        "title": title,
        "description": f"Interview guide from ELIAS project {project_id}",
        "initial_state_id": states[0]["id"],
        "states": states,
        "metadata": {"source": "elias", "elias_project_id": project_id},
    }


def resume_point(questions: List[Question], full_state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """From a state-machine snapshot: which questions are already done, and the
    ELIAS transcript id if one was stored. Used on wake after auto-pause."""
    done: set = set()
    transcript_id: Optional[str] = None
    for state in (full_state or {}).get("states", []) or []:
        for task in state.get("tasks", []) or []:
            if task.get("status") in ("completed", "skipped"):
                done.add(task.get("id"))
            for d in task.get("deliverables", []) or []:
                if d.get("key") == TRANSCRIPT_ID_KEY and d.get("value"):
                    transcript_id = str(d["value"])
    next_index = next((i for i, q in enumerate(questions) if q.task_id not in done), len(questions))
    return {"next_index": next_index, "transcript_id": transcript_id}
