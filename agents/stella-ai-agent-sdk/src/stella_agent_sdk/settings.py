"""The settings an agent declares in ``agent.yaml``, with their values (#996).

An agent declares each setting a saved configuration may change, once, with a
key, a type and a default: in the manifest's ``settings:`` section, or as a slot
on a ``pipelineSchema`` node (slot ``x`` on node ``n`` is the setting ``n.x``).
STELLA refuses a configuration that sets anything else, and the agent reads its
values here::

    settings = AgentSettings.from_manifest()
    settings.apply(session_config.pipeline_config)
    threshold = settings.get("expert_pool.safety_threshold")

``get`` returns the configuration's value, or the default from ``agent.yaml``
when the configuration leaves the setting unset, so a default lives in the
manifest and nowhere else. A key the manifest does not declare raises
``KeyError``: a typo fails where it is made, not by quietly reading nothing.

The rule for turning slots into settings mirrors ``declareConfigSettings`` in
the backend's ``src/agent-package/config-settings.ts``; change both together.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Union

import yaml

logger = logging.getLogger(__name__)

#: Points the SDK at the agent's manifest when it is not ``./agent.yaml``.
MANIFEST_PATH_ENV = "STELLA_AGENT_MANIFEST"

_SLOT_TYPES = {"select": "enum"}


@dataclass(frozen=True)
class SettingDeclaration:
    key: str
    type: str
    default: Any = None


def _coerce(declaration: SettingDeclaration, value: Any) -> Any:
    """A value as its type reads it. STELLA already checked it on save; this
    only turns a JSON number into the float or int the agent compares with."""
    if value is None:
        return None
    if declaration.type == "number":
        return float(value)
    if declaration.type == "integer":
        return int(value)
    return value


def declarations_of(manifest: Mapping[str, Any]) -> Dict[str, SettingDeclaration]:
    """Every setting a parsed manifest declares: pipeline slots, then ``settings:``."""
    declared: Dict[str, SettingDeclaration] = {}
    for node in (manifest.get("pipelineSchema") or {}).get("nodes") or []:
        for slot in node.get("slots") or []:
            key = f"{node['id']}.{slot['id']}"
            declared[key] = SettingDeclaration(key, _SLOT_TYPES.get(slot["type"], slot["type"]), slot.get("default"))
    for entry in manifest.get("settings") or []:
        declared[entry["key"]] = SettingDeclaration(entry["key"], entry["type"], entry.get("default"))
    return declared


def find_manifest(candidates: Iterable[Union[str, Path]] = ()) -> Path:
    """The first of ``candidates`` that exists, then ``$STELLA_AGENT_MANIFEST``,
    then ``./agent.yaml`` (an agent image's working directory holds it)."""
    paths: List[Path] = [Path(c) for c in candidates]
    if os.environ.get(MANIFEST_PATH_ENV):
        paths.append(Path(os.environ[MANIFEST_PATH_ENV]))
    paths.append(Path("agent.yaml"))
    for path in paths:
        if path.is_file():
            return path
    raise FileNotFoundError(
        "agent.yaml not found; the agent's settings and their defaults are read from it "
        f"(looked in {', '.join(str(p) for p in paths)})"
    )


class AgentSettings:
    """Declared settings with their defaults, and a configuration's values over them."""

    def __init__(self, declarations: Mapping[str, SettingDeclaration]):
        self._declared = dict(declarations)
        self._values: Dict[str, Any] = {}

    @classmethod
    def from_manifest(cls, *candidates: Union[str, Path]) -> "AgentSettings":
        path = find_manifest(candidates)
        manifest = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return cls(declarations_of(manifest))

    def apply(self, pipeline_config: Optional[Mapping[str, Any]]) -> List[str]:
        """Take a configuration's values (``pipeline_config.nodes.<stage>.<name>``).

        Replaces what an earlier call applied. Returns the keys the manifest
        does not declare, which STELLA would have refused; they are logged and
        left out, so an agent run outside STELLA behaves the same way.
        """
        self._values = {}
        undeclared: List[str] = []
        nodes = (pipeline_config or {}).get("nodes") or {}
        for stage, values in nodes.items():
            if not isinstance(values, Mapping):
                continue
            for name, value in values.items():
                key = f"{stage}.{name}"
                declaration = self._declared.get(key)
                if declaration is None:
                    undeclared.append(key)
                elif value is not None:
                    self._values[key] = _coerce(declaration, value)
        if undeclared:
            logger.warning("[SETTINGS] Ignoring settings agent.yaml does not declare: %s", ", ".join(sorted(undeclared)))
        return undeclared

    def get(self, key: str) -> Any:
        """The configured value, else the manifest's default. KeyError when undeclared."""
        declaration = self._declared.get(key)
        if declaration is None:
            raise KeyError(f"{key} is not a setting agent.yaml declares")
        if key in self._values:
            return self._values[key]
        return _coerce(declaration, declaration.default)

    def is_set(self, key: str) -> bool:
        """Whether the configuration sets ``key`` (rather than leaving the default)."""
        self.get(key)  # KeyError when undeclared
        return key in self._values

    def keys(self, stage: Optional[str] = None) -> List[str]:
        """Declared keys, optionally only one stage's."""
        return [k for k in self._declared if stage is None or k.startswith(f"{stage}.")]
