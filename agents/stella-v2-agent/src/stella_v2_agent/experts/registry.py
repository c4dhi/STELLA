"""Central expert registry with external config loading and env var overrides.

Loading priority:
1. STELLA_EXPERTS_DIR env var (first priority — external override, like plans)
2. /app/stella-v2-agent/config/experts/ (Docker default)
3. Relative to package source (development fallback)

Individual expert params are also overridable via env vars:
- EXPERT_{NAME}_ENABLED (bool)
- EXPERT_{NAME}_MODEL (string)
- EXPERT_{NAME}_MAX_TOKENS (int)
- EXPERT_{NAME}_TEMPERATURE (float)
- EXPERT_{NAME}_PRIORITY (int)
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Any

from stella_v2_agent.experts.base import ExpertConfig, VerdictDirective
import logging

logger = logging.getLogger(__name__)


def _coerce_override_value(key: str, value: Any) -> Any:
    """Coerce a raw override value before setattr, so structured fields
    (e.g. verdict_directives) become their typed form instead of plain dicts."""
    if key == "verdict_directives":
        return VerdictDirective.coerce_map(value)
    return value


class ExpertRegistry:
    """Central registry of all available experts.

    Discovers and loads expert configs from JSON files,
    applies environment variable overrides, and provides
    lookup for the pipeline stages.
    """

    def __init__(self, experts_dir: Optional[str] = None, overrides: Optional[Dict[str, Any]] = None):
        """Initialize the registry and load expert configs.

        Args:
            experts_dir: Explicit path to experts config directory.
            overrides: Per-expert runtime overrides from AGENT_CONFIG
                       (e.g. {"medical": {"enabled": false}}).
        """
        self._experts: Dict[str, ExpertConfig] = {}
        self._overrides = overrides or {}

        config_dir = self._resolve_experts_dir(experts_dir)
        if config_dir:
            self._load_from_directory(config_dir)

        self._apply_env_overrides()
        self._apply_runtime_overrides()

        enabled_count = sum(1 for e in self._experts.values() if e.enabled)
        logger.info(f"Loaded {len(self._experts)} experts ({enabled_count} enabled)")

    def _resolve_experts_dir(self, explicit_dir: Optional[str]) -> Optional[Path]:
        """Resolve the experts config directory from multiple sources."""
        candidates: List[Path] = []

        # 1. Explicit argument
        if explicit_dir:
            candidates.append(Path(explicit_dir))

        # 2. Environment variable
        env_dir = os.environ.get("STELLA_EXPERTS_DIR")
        if env_dir:
            candidates.append(Path(env_dir))

        # 3. Docker default
        candidates.append(Path("/app/stella-v2-agent/config/experts"))

        # 4. Development fallback (relative to this file)
        package_dir = Path(__file__).parent
        candidates.append(package_dir.parent.parent.parent / "config" / "experts")

        for path in candidates:
            if path.exists() and path.is_dir():
                logger.info(f"Loading experts from: {path}")
                return path

        logger.warning(f"No experts directory found. Searched: {candidates}")
        return None

    def _load_from_directory(self, config_dir: Path) -> None:
        """Load all expert JSON files from a directory."""
        for json_file in sorted(config_dir.glob("*.json")):
            try:
                with open(json_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                config = ExpertConfig.from_dict(data)
                self._experts[config.name] = config
                logger.info(f"Loaded expert: {config.name} (priority={config.priority})")
            except (json.JSONDecodeError, KeyError) as e:
                logger.error(f"Failed to load {json_file.name}: {e}")

    def _apply_env_overrides(self) -> None:
        """Apply per-expert environment variable overrides."""
        for name, config in self._experts.items():
            env_prefix = f"EXPERT_{name.upper()}_"

            enabled = os.environ.get(f"{env_prefix}ENABLED")
            if enabled is not None:
                config.enabled = enabled.lower() in ("true", "1", "yes")

            model = os.environ.get(f"{env_prefix}MODEL")
            if model is not None:
                config.model = model

            max_tokens = os.environ.get(f"{env_prefix}MAX_TOKENS")
            if max_tokens is not None:
                try:
                    config.max_tokens = int(max_tokens)
                except ValueError:
                    pass

            temperature = os.environ.get(f"{env_prefix}TEMPERATURE")
            if temperature is not None:
                try:
                    config.temperature = float(temperature)
                except ValueError:
                    pass

            priority = os.environ.get(f"{env_prefix}PRIORITY")
            if priority is not None:
                try:
                    config.priority = int(priority)
                except ValueError:
                    pass

    def _apply_runtime_overrides(self) -> None:
        """Apply per-expert runtime overrides from AGENT_CONFIG."""
        for name, overrides in self._overrides.items():
            if name not in self._experts:
                continue
            config = self._experts[name]
            if not isinstance(overrides, dict):
                continue
            for key, value in overrides.items():
                if hasattr(config, key):
                    setattr(config, key, _coerce_override_value(key, value))

    def apply_config(self, config: dict) -> None:
        """Apply configuration overrides from Agent Configurator.

        Supports:
        - experts: dict of {expert_name: {enabled, priority, model, ...}} for built-in experts
        - custom_experts: dict of {name: {description, priority, model, ...}} for new user-defined experts
        """
        # Apply overrides to built-in experts
        experts_config = config.get("experts", {})
        if isinstance(experts_config, dict):
            for name, overrides in experts_config.items():
                if name not in self._experts:
                    continue
                expert = self._experts[name]
                if not isinstance(overrides, dict):
                    continue
                for key, value in overrides.items():
                    if hasattr(expert, key):
                        setattr(expert, key, _coerce_override_value(key, value))

        # Register custom experts
        custom_experts = config.get("custom_experts", {})
        if isinstance(custom_experts, dict):
            for name, expert_def in custom_experts.items():
                if not isinstance(expert_def, dict):
                    continue
                # Prevent collision with built-in names
                if name in self._experts:
                    logger.warning(f"Custom expert '{name}' collides with built-in, skipping")
                    continue
                # Validate priority range
                priority = expert_def.get("priority", 50)
                if not (1 <= priority <= 100):
                    logger.warning(f"Custom expert '{name}' priority {priority} out of range, clamping")
                    priority = max(1, min(100, priority))
                try:
                    custom_config = ExpertConfig(
                        name=name,
                        description=expert_def.get("description", ""),
                        system_prompt=expert_def.get("system_prompt", ""),
                        model=expert_def.get("model", "gpt-5.4-mini"),
                        max_tokens=int(expert_def.get("max_tokens", 200)),
                        temperature=float(expert_def.get("temperature", 0.3)),
                        priority=priority,
                        enabled=True,
                        output_schema=expert_def.get("output_schema"),
                        output_format=expert_def.get("output_format", ""),
                        trigger_criteria=expert_def.get("trigger_criteria", ""),
                        verdict_directives=expert_def.get("verdict_directives", {}),
                    )
                    self._experts[name] = custom_config
                    logger.info(f"Registered custom expert: {name} (priority={priority})")
                except Exception as e:
                    logger.error(f"Failed to register custom expert '{name}': {e}")

        updated_count = sum(1 for e in self._experts.values() if e.enabled)
        logger.info(f"After config: {len(self._experts)} experts ({updated_count} enabled)")

    def get(self, name: str) -> Optional[ExpertConfig]:
        """Get an expert config by name. Returns None if not found."""
        return self._experts.get(name)

    def as_map(self) -> Dict[str, ExpertConfig]:
        """Return the name → ExpertConfig map (used by Arbitration to read
        per-expert verdict_directives without importing the registry).

        Returns a shallow copy so callers can't mutate the registry's internal
        dict (add/remove experts); the ExpertConfig values are shared and are
        only read by callers."""
        return dict(self._experts)

    def get_enabled(self) -> List[ExpertConfig]:
        """Get all enabled expert configs, sorted by priority (descending)."""
        return sorted(
            [e for e in self._experts.values() if e.enabled],
            key=lambda e: e.priority,
            reverse=True,
        )

    def get_enabled_names(self) -> List[str]:
        """Get names of all enabled experts."""
        return [e.name for e in self.get_enabled()]

    def get_summaries(self) -> List[Dict[str, str]]:
        """Get name + description + trigger_criteria for all enabled experts.

        Retained for the agent-configurator expert-summary surface. (The Input
        Gate that originally consumed this was removed in #363 — each expert now
        self-gates via its own engage/tap-out prompt contract.)"""
        return [
            {
                "name": e.name,
                "description": e.description,
                "trigger_criteria": e.trigger_criteria,
            }
            for e in self.get_enabled()
        ]

    def filter_valid_names(self, names: List[str]) -> List[str]:
        """Filter a list of expert names to only those that exist and are enabled."""
        enabled_names = set(self.get_enabled_names())
        return [n for n in names if n in enabled_names]

    @property
    def count(self) -> int:
        return len(self._experts)

    @property
    def enabled_count(self) -> int:
        return sum(1 for e in self._experts.values() if e.enabled)
