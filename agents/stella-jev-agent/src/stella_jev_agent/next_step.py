"""Where the plan goes next, worked out before anything is saved.

The reply no longer waits for task_extraction, so it cannot learn from the state
machine where this answer leads. It reads that from the plan instead, and Jev picks
when the way depends on the answer. The state machine still makes the real move once
extraction has saved the value, and the next turn reads the state it landed in.
Where the plan cannot tell (a goal, a compound condition), the reply stays on this
step with the answer marked as collected, and the next turn sees any move.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Set

from typesafe_sdk import Choice

END = "__end__"
NOTHING = "nothing"
OTHERWISE = "otherwise"

_OPERATORS = {
    "gt": "more than", "gte": "at least", "lt": "less than", "lte": "at most",
    "eq": "exactly", "neq": "anything but",
}
# Fires on a count or a goal rather than on what was said, so an answer cannot predict it.
_NOT_FROM_THE_ANSWER = {"turn_count_exceeded"}
_VALUE_CONDITIONS = {"deliverable_value", "deliverable_value_in", "deliverable_value_numeric", "deliverable_exists"}


@dataclass
class Branch:
    target: str
    when: str = ""
    keys: Set[str] = field(default_factory=set)


def _plan_state(plan: Optional[Dict[str, Any]], state_id: Any) -> Optional[Dict[str, Any]]:
    return next((s for s in (plan or {}).get("states", []) if s.get("id") == state_id), None)


def _label(plan: Dict[str, Any], key: str) -> str:
    for state in plan.get("states", []):
        for task in state.get("tasks", []):
            for deliverable in task.get("deliverables", []):
                if deliverable.get("key") == key:
                    return deliverable.get("description") or key
    return key


def _describe(plan: Dict[str, Any], kind: str, config: Dict[str, Any]) -> str:
    label = _label(plan, config["key"])
    if kind == "deliverable_value":
        return f"{label}: {config['value']}"
    if kind == "deliverable_value_in":
        return f"{label}: one of {', '.join(str(v) for v in config['values'])}"
    if kind == "deliverable_value_numeric":
        if config.get("operator") == "between":
            return f"{label}: between {config['min']} and {config['max']}"
        return f"{label}: {_OPERATORS.get(config.get('operator'), config.get('operator'))} {config['value']}"
    return ""


def route(plan: Optional[Dict[str, Any]], state_id: Any) -> Optional[List[Branch]]:
    """The ways out of a state, or None when only the state machine can tell."""
    state = _plan_state(plan, state_id)
    if state is None or state.get("type") == "goal":
        return None
    states = plan.get("states", [])
    transitions = sorted(state.get("transitions") or [], key=lambda t: t.get("priority", 100))
    if not transitions:
        # The backend fills these in the same way when a plan leaves them out.
        following = states[states.index(state) + 1:]
        transitions = [{
            "target_state_id": following[0]["id"] if following else END,
            "condition_type": "all_tasks_complete",
        }]

    branches: List[Branch] = []
    for transition in transitions:
        kind = transition.get("condition_type", "all_tasks_complete")
        target = transition.get("target_state_id")
        if kind in _NOT_FROM_THE_ANSWER:
            continue
        following = _plan_state(plan, target)
        if target != END and (following is None or following.get("type") == "goal"):
            return None
        if kind == "all_tasks_complete":
            branches.append(Branch(target))
        elif kind in _VALUE_CONDITIONS:
            config = transition.get("condition_config") or {}
            branches.append(Branch(target, _describe(plan, kind, config), {config["key"]}))
        else:
            return None
    return branches or None


def has_choice(branches: Optional[List[Branch]]) -> bool:
    return bool(branches) and any(b.when for b in branches)


def branch_question(branches: List[Branch]) -> Choice:
    """Asks which way the latest message leads."""
    criteria = {f"way_{i}": b.when for i, b in enumerate(branches) if b.when}
    criteria[OTHERWISE] = "The latest message says none of these, or does not say."
    return Choice(
        instructions="Going by what the person said in the latest message, which of these is true?",
        criteria=criteria,
    )


def pending_tasks(sm_context: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The tasks still open in the current state."""
    for state in sm_context.get("full_plan") or []:
        if state.get("is_current"):
            return [t for t in state.get("tasks", []) if t.get("status", "pending") == "pending"]
    return []


def collected_tasks(sm_context: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The tasks of the current state that already hold an answer, which a message can correct."""
    collected = sm_context.get("collected_deliverables") or {}
    for state in sm_context.get("full_plan") or []:
        if state.get("is_current"):
            return [
                t for t in state.get("tasks", [])
                if t.get("status") == "completed" and any(
                    d.get("status") == "completed" and (d.get("value") is not None or d.get("key") in collected)
                    for d in t.get("deliverables", [])
                )
            ]
    return []


def _wanted(deliverable: Dict[str, Any]) -> str:
    """What one value is, with what the plan accepts for it."""
    label = deliverable.get("description") or deliverable.get("key")
    criteria = (deliverable.get("acceptance_criteria") or "").strip()
    return f"{label} ({criteria})" if criteria else str(label)


def _recorded(task: Dict[str, Any], collected: Dict[str, Any]) -> str:
    values = [
        str(d.get("value") if d.get("value") is not None else collected.get(d.get("key")))
        for d in task.get("deliverables", []) if d.get("status") == "completed"
    ]
    return "; ".join(v.strip('"') for v in values)


def task_question(
    tasks: List[Dict[str, Any]],
    corrections: Sequence[Dict[str, Any]] = (),
    collected: Optional[Dict[str, Any]] = None,
) -> Choice:
    """Asks which open task the latest message took care of, or which earlier answer it corrected.

    Extraction saves only what Jev picks here, so the deliverables are described with
    what the plan accepts for them, the same detail extraction reads.
    """
    criteria = {}
    for i, task in enumerate(tasks):
        # A plan's labels can be as thin as "deliverable_name", and the instruction says what was asked.
        about = ". ".join(filter(None, [task.get("description"), task.get("instruction")]))
        wanted = "; ".join(_wanted(d) for d in task.get("deliverables", []))
        criteria[f"task_{i}"] = (
            f"{about}. They gave: {wanted}" if wanted else f"{about}. The assistant has done this and they responded"
        )
    for i, task in enumerate(corrections):
        criteria[f"fix_{i}"] = (
            f"They change their earlier answer about {task.get('description')}, which was recorded as: "
            f"{_recorded(task, collected or {})}. Only a clear correction or contradiction, not a repeat."
        )
    criteria[NOTHING] = "None of these: small talk, a question to the assistant, or too vague to record."
    return Choice(
        instructions="Which of these did the latest message take care of?",
        criteria=criteria,
    )


YES = "yes"
ALSO_TASK = "also_task_"
ALSO_FIX = "also_fix_"


def also_questions(
    tasks: List[Dict[str, Any]], corrections: Sequence[Dict[str, Any]], collected: Optional[Dict[str, Any]] = None,
) -> Dict[str, Choice]:
    """Whatever else the message settled in this state, besides what it mainly answered.

    People mention the weather while talking about their week, or fix an earlier answer
    along the way. Each of these is its own yes or no, so one message can do several.
    """
    questions = {}
    for i, task in enumerate(tasks):
        about = ". ".join(filter(None, [task.get("description"), task.get("instruction")]))
        wanted = "; ".join(_wanted(d) for d in task.get("deliverables", []))
        questions[f"{ALSO_TASK}{i}"] = Choice(
            instructions=(
                "Whatever else it was about, does the latest message also give this, clearly enough "
                f"to record? {about}." + (f" Wanted: {wanted}" if wanted else "")
            ),
            criteria={
                YES: "Yes, it says this, even in passing.",
                "no": "No, or only so vaguely that it would still have to be asked.",
            },
        )
    for i, task in enumerate(corrections):
        questions[f"{ALSO_FIX}{i}"] = Choice(
            instructions=(
                f"Earlier the person answered about {task.get('description')}, recorded as: "
                f"{_recorded(task, collected or {})}. Does the latest message change or contradict that answer?"
            ),
            criteria={
                YES: "Yes, a clear correction or contradiction of what was recorded.",
                "no": "No: it does not mention it, repeats it, adds to it, or is too vague to tell.",
            },
        )
    return questions


def read_also(
    answers: Dict[str, Any], tasks: List[Dict[str, Any]], corrections: Sequence[Dict[str, Any]],
    threshold: float, main: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """The other tasks Jev is sure the message settled, apart from the main pick."""
    picks = []
    for prefix, pool, correction in ((ALSO_TASK, tasks, False), (ALSO_FIX, corrections, True)):
        for i, task in enumerate(pool):
            answer = answers.get(f"{prefix}{i}")
            if answer is None or float(answer.probabilities.get(YES, 0.0)) < threshold:
                continue
            if main is not None and main["task_id"] == task.get("id"):
                continue
            p = round(float(answer.probabilities[YES]), 2)
            picks.append({"task": task, "task_id": task.get("id"), "p": p, "correction": correction, "also": True})
    return picks


def read_pick(
    answer: Any, tasks: List[Dict[str, Any]], corrections: Sequence[Dict[str, Any]], threshold: float,
    answers: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """The task Jev picked, sure enough to act on, or None. Extraction may save only this.

    One choice has to share its probability out when a message answers two tasks at once,
    so an unsure pick counts when Jev's own yes or no on that task is sure of it.
    """
    if answer is None or answer.choice == NOTHING:
        return None
    p = float(answer.probabilities[answer.choice])
    kind, index = answer.choice.split("_")
    if p < threshold:
        also = (answers or {}).get(f"{ALSO_FIX if kind == 'fix' else ALSO_TASK}{index}")
        p = float(also.probabilities.get(YES, 0.0)) if also is not None else 0.0
        if p < threshold:
            return None
    task = (corrections if kind == "fix" else tasks)[int(index)]
    return {"task": task, "task_id": task.get("id"), "p": round(p, 2), "correction": kind == "fix"}


def open_required_keys(task: Dict[str, Any]) -> List[str]:
    return [
        d["key"] for d in task.get("deliverables", [])
        if d.get("required", True) and d.get("status", "pending") == "pending"
    ]


def finishes(task: Dict[str, Any]) -> bool:
    """One answer closes a task only when at most one value is still open on it."""
    return len(open_required_keys(task)) <= 1


def predict(
    branches: Optional[List[Branch]],
    tasks: List[Dict[str, Any]],
    picked: Dict[str, Any],
    way: str = OTHERWISE,
    required_task_ids: Optional[Set[str]] = None,
    also_done: Sequence[Any] = (),
) -> Optional[str]:
    """Where this answer takes the plan, or None if it stays or only the state machine can tell."""
    if branches is None:
        return None
    keys = set(open_required_keys(picked))
    if has_choice(branches) and way != OTHERWISE:
        branch = branches[int(way.split("_")[1])]
        return branch.target if branch.keys & keys else None

    others = [
        t for t in tasks
        if t.get("id") != picked.get("id") and t.get("id") not in also_done
        and (required_task_ids is None or t.get("id") in required_task_ids)
    ]
    if others or not finishes(picked):
        return None
    # Conditional ways come first. Reaching this line means none of them was picked,
    # so the plain way out decides, or a way that opens as soon as this value exists.
    for branch in branches:
        if not branch.when and (not branch.keys or branch.keys & keys):
            return branch.target
    return None


def required_tasks(plan: Optional[Dict[str, Any]], state_id: Any) -> Set[str]:
    state = _plan_state(plan, state_id) or {}
    return {t.get("id") for t in state.get("tasks", []) if t.get("required", True)}


def _open_for_reply(entry: Dict[str, Any], state: Dict[str, Any], without: Sequence[Any] = ()) -> List[Dict[str, Any]]:
    """The open tasks in the shape the state machine hands them to the reply."""
    required = {t.get("id"): t.get("required", True) for t in state.get("tasks", [])}
    return [
        {
            "id": t.get("id"),
            "description": t.get("description"),
            "instruction": t.get("instruction") or None,
            "required": required.get(t.get("id"), True),
            "has_deliverables": bool(t.get("deliverables")),
            "deliverable_keys": [d.get("key") for d in t.get("deliverables", [])],
            "is_preview": False,
        }
        for t in entry.get("tasks", [])
        if t.get("status", "pending") == "pending" and t.get("id") not in without
    ]


def _with_confirmed(sm_context: Dict[str, Any], keys: List[str]) -> List[Dict[str, Any]]:
    """Answered but not saved yet, so the reply reads the value from the transcript. Extraction
    fills it in for the next turn, and if it refuses the value is simply open again there."""
    return [
        {**d, "status": "confirmed"} if d.get("key") in keys and d.get("status") == "pending" else d
        for d in sm_context.get("deliverables", [])
    ]


def context_within(
    sm_context: Dict[str, Any], plan: Dict[str, Any], task_ids: Any, keys: List[str]
) -> Optional[Dict[str, Any]]:
    """The context once these tasks are done and the plan stays, so the reply heads for the next task."""
    done = [task_ids] if isinstance(task_ids, str) else list(task_ids)
    state_id = (sm_context.get("state") or {}).get("id")
    state = _plan_state(plan, state_id)
    entry = next((s for s in sm_context.get("full_plan") or [] if s.get("id") == state_id), None)
    if state is None or entry is None:
        return None
    tasks = _open_for_reply(entry, state, without=done)
    if not tasks:
        return None
    mode = sm_context.get("processing_mode")
    return {
        **sm_context,
        "available_tasks": tasks[:1] if mode == "strict" else tasks,
        "current_task": tasks[0],
        "deliverables": _with_confirmed(sm_context, keys),
    }


def context_after(
    sm_context: Dict[str, Any], plan: Dict[str, Any], target: str, keys: Sequence[str] = ()
) -> Optional[Dict[str, Any]]:
    """The context the state machine would hand back once it has moved to `target`."""
    state = _plan_state(plan, target)
    entry = next((s for s in sm_context.get("full_plan") or [] if s.get("id") == target), None)
    if state is None or entry is None:
        return None
    tasks = _open_for_reply(entry, state)
    mode = state.get("type", "loose")
    pending = [d for t in entry.get("tasks", []) for d in t.get("deliverables", []) if d.get("status") == "pending"]
    done = [d for d in _with_confirmed(sm_context, list(keys)) if d.get("status") in {"completed", "confirmed"}]
    return {
        **sm_context,
        "full_plan": [{**s, "is_current": s.get("id") == target} for s in sm_context.get("full_plan") or []],
        "state": {
            "id": target,
            "title": entry.get("title"),
            "type": mode,
            "description": state.get("description", ""),
        },
        "processing_mode": mode,
        "available_tasks": tasks[:1] if mode == "strict" else tasks,
        "current_task": tasks[0] if tasks else None,
        "deliverables": pending + done,
        "progress": {"percentage": 0, "turns_without_deliverable": 0},
        "state_just_changed": True,
    }
