"""What conversation history the model sees when activities come and go.

A companion session alternates between free conversation and activities (plans).
Feeding the whole transcript to every turn made the model carry one mode into the
other: it kept asking a finished activity's questions in free conversation, and
opened a restarted activity with the previous run's topic instead of its first
step. So the history is scoped to where the conversation is now:

* Inside an activity, only turns since it started.
* In free conversation, an activity that ran and ended is one system line
  (title plus what it collected) in place of its turns.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


@dataclass
class ActivitySegment:
    """One finished activity run."""

    title: str
    started_at: datetime
    ended_at: datetime
    collected: Dict[str, Any] = field(default_factory=dict)


def parse_timestamp(value: Any) -> Optional[datetime]:
    """ISO 8601 (with or without a trailing Z) to an aware datetime, else None."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def ended_note(segment: ActivitySegment) -> str:
    """The single line that stands in for a finished activity's turns."""
    note = f'Activity "{segment.title}" ended.'
    if segment.collected:
        collected = ", ".join(f"{k} = {v}" for k, v in segment.collected.items())
        note += f" Collected: {collected}."
    return note


def scope_history(
    entries: List[Dict[str, Any]],
    segments: List[ActivitySegment],
    active_since: Optional[datetime],
) -> List[Dict[str, str]]:
    """Return role/content history scoped to the current mode.

    ``entries`` are chronological ``{"role", "content", "at"}`` dicts, ``at``
    being a datetime or None. An entry without a usable timestamp is kept, since
    dropping what cannot be placed would lose more than it saves.
    """
    if active_since is not None:
        return [
            {"role": e["role"], "content": e["content"]}
            for e in entries
            if e.get("at") is None or e["at"] >= active_since
        ]

    scoped: List[Dict[str, str]] = []
    noted = set()
    for entry in entries:
        at = entry.get("at")
        inside = None
        if at is not None:
            for i, seg in enumerate(segments):
                if seg.started_at <= at <= seg.ended_at:
                    inside = i
                    break
        if inside is None:
            scoped.append({"role": entry["role"], "content": entry["content"]})
        elif inside not in noted:
            noted.add(inside)
            scoped.append({"role": "system", "content": ended_note(segments[inside])})
    return scoped
