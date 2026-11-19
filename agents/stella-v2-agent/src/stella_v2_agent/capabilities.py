"""What Grace can do this turn: STELLA's list plus the configuration's extras (#992).

STELLA works the list out from what the session really has (the plan, the
activities on offer, the connector tools this agent calls) and returns it with
the per-turn state. A configuration may add entries per mode: the
``capability_extras`` slot of the Expert Pool node, one entry per line, for
example "Answer general-knowledge questions" in companion mode. Nothing else
is ever added here, so general knowledge is on the list only when a
configuration puts it there.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional

MODES = ("plan", "activity", "companion")


def parse_extras(value: Any) -> Dict[str, List[str]]:
    """The ``capability_extras`` slot as ``{mode: [entry, ...]}``.

    Unknown modes and empty lines are dropped, so a typo adds nothing rather
    than something unexpected.
    """
    extras: Dict[str, List[str]] = {}
    if not isinstance(value, dict):
        return extras
    for mode, text in value.items():
        if mode not in MODES:
            continue
        lines = [line.strip().lstrip("-").strip() for line in str(text or "").splitlines()]
        entries = [line for line in lines if line]
        if entries:
            extras[mode] = entries
    return extras


def with_extras(
    capabilities: Optional[Dict[str, Any]], extras: Dict[str, List[str]]
) -> Optional[Dict[str, Any]]:
    """STELLA's list with this mode's extras appended, as a new dict.

    None stays None: without STELLA's list the mode is unknown, and the agent
    must not claim abilities it was never given.
    """
    if not isinstance(capabilities, dict):
        return None
    merged = copy.deepcopy(capabilities)
    entries = list(merged.get("capabilities") or [])
    for i, title in enumerate(extras.get(str(merged.get("mode")), [])):
        entries.append({"id": f"extra.{i + 1}", "kind": "extra", "title": title, "description": ""})
    merged["capabilities"] = entries
    return merged
