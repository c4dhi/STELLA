"""Everything about companion mode an operator can change, in one place.

The defaults are the ``companion`` node of ``agent.yaml``: the same file the
Agent Configurator shows and edits, read here at run time. A deployment's saved
configuration overrides them slot by slot (``nodes.companion``). The code in
``companion.py`` decides WHEN something happens; what is said, to whom it is
left and how long she waits is all here.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field, fields
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict

import yaml

NODE = "companion"


@dataclass
class CompanionSettings:
    free_conversation_guidelines: str = ""
    # One instruction per situation, keyed by what just happened. An empty
    # entry switches that instruction off — and for "greeting" and
    # "offered_unasked" the step itself.
    reply_instructions: Dict[str, str] = field(default_factory=dict)
    exit_instructions: str = ""
    start_instructions: str = ""
    judge_model: str = ""
    max_exit_asks: int = 2
    max_start_asks: int = 2
    idle_sleep_seconds: float = 0.0
    min_confidence: float = 0.0

    def instruction(self, key: str) -> str:
        return (self.reply_instructions.get(key) or "").strip()

    def apply(self, overrides: Dict[str, Any]) -> None:
        """Take a saved configuration's values for this node. Unknown keys are
        ignored; reply instructions are merged, so a configuration saved
        before an entry existed still gets that entry's default."""
        for f in fields(self):
            if f.name not in overrides:
                continue
            value = overrides[f.name]
            current = getattr(self, f.name)
            if isinstance(current, dict):
                if isinstance(value, dict):
                    current.update({k: str(v or "") for k, v in value.items()})
            elif isinstance(current, str):
                if value:
                    setattr(self, f.name, str(value))
            elif isinstance(current, int):
                setattr(self, f.name, int(value or 0))
            else:
                setattr(self, f.name, float(value or 0.0))


def _manifest_path() -> Path:
    candidates = [
        Path("/app/stella-v2-agent/agent.yaml"),
        Path(__file__).resolve().parent.parent.parent / "agent.yaml",
        Path("agent.yaml"),
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(
        "agent.yaml not found; companion mode reads its defaults from it "
        f"(looked in {', '.join(str(c) for c in candidates)})"
    )


@lru_cache(maxsize=1)
def _defaults() -> CompanionSettings:
    manifest = yaml.safe_load(_manifest_path().read_text(encoding="utf-8"))
    nodes = (manifest.get("pipelineSchema") or {}).get("nodes") or []
    node = next((n for n in nodes if n.get("id") == NODE), None)
    if node is None:
        raise ValueError(f"agent.yaml has no '{NODE}' node")
    slots = {s["id"]: s.get("default") for s in node.get("slots") or []}
    known = {f.name for f in fields(CompanionSettings)}
    missing = known - set(slots)
    if missing:
        raise ValueError(f"agent.yaml '{NODE}' node lacks slots: {sorted(missing)}")
    settings = CompanionSettings()
    for name in known:
        value = slots[name]
        shipped = getattr(settings, name)
        if isinstance(shipped, dict):
            value = dict(value or {})
        elif isinstance(shipped, str):
            value = str(value or "").rstrip("\n")
        else:
            value = type(shipped)(value or 0)
        setattr(settings, name, value)
    return settings


def load_settings() -> CompanionSettings:
    """A fresh copy of the shipped defaults, safe for one agent to change."""
    return copy.deepcopy(_defaults())
