"""The session config STELLA hands an agent (``AGENT_CONFIG``), typed.

The backend writes one JSON object per deployment into the pod's
``AGENT_CONFIG`` env var. Some keys belong to the platform (the persona, the
plan, the mode, the Configurator's pipeline, the connectors); everything else
is the user's settings for this agent, as described by the agent's
``configSchema`` in ``agent.yaml``.

``SessionConfig`` is that object with the platform keys typed and the user's
settings under ``config``. It is lenient by design: a malformed platform key is
logged and dropped, never fatal, because an agent that cannot start cannot tell
the participant anything either.

The JSON Schema the backend types its builder against is generated from this
model: ``contracts/agent-session-config.schema.json`` (see
``python -m stella_agent_sdk.contracts``; ``tests/test_platform_contract.py``
keeps the committed file in step).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

#: Keys the platform owns. Everything else at the top level of AGENT_CONFIG is
#: a user setting and is collected into ``SessionConfig.config``.
PLATFORM_KEYS = frozenset({
    "persona",
    "mode",
    "plan",
    "plan_id",
    "available_plans",
    "pipeline_config",
    "connectors",
    "config",
})


class PersonaConfig(BaseModel):
    """Who the agent is: the Persona snapshot resolved at deploy time.

    By value, never by reference: editing a Persona reaches the next deployment,
    never a running session.
    """

    model_config = ConfigDict(extra="allow")

    id: Optional[str] = None
    name: Optional[str] = None
    icon: Optional[str] = None
    system_prompt: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = Field(default=None, description="ISO 639-1 code, e.g. 'de'")
    variables: Dict[str, str] = Field(
        default_factory=dict,
        description="Values for {{persona.<key>}} placeholders in prompts and plan text",
    )
    is_system_default: bool = Field(
        default=False,
        description="True when nobody chose a persona and the platform default was used",
    )


class ActivityConfig(BaseModel):
    """One plan a companion may offer (``mode == 'companion'``)."""

    model_config = ConfigDict(extra="allow")

    id: str
    title: str = ""
    description: str = ""
    plan: Dict[str, Any] = Field(description="The plan, in the same shape as SessionConfig.plan")


class ConnectorBinding(BaseModel):
    """A connector (outside MCP server) bound to this deployment."""

    model_config = ConfigDict(extra="allow")

    handle: str = Field(description="What the agent passes to connectors.call_tool()")
    slot: Optional[str] = Field(default=None, description="The agent.yaml slot it fills, if any")
    name: Optional[str] = None


class SessionConfig(BaseModel):
    """``AGENT_CONFIG``, typed. See the module docstring."""

    model_config = ConfigDict(extra="allow", title="AgentSessionConfig")

    persona: Optional[PersonaConfig] = Field(
        default=None, description="The deployed Persona; absent for deployments made before personas"
    )
    mode: Optional[Literal["plan", "companion"]] = Field(
        default=None,
        description="'companion' converses and offers available_plans; absent or 'plan' follows `plan`",
    )
    plan: Optional[Union[Dict[str, Any], str]] = Field(
        default=None,
        description="The plan to follow (plan mode). A string is a plan id the agent resolves itself",
    )
    available_plans: List[ActivityConfig] = Field(
        default_factory=list, description="Companion mode: the activities it may offer"
    )
    pipeline_config: Optional[Dict[str, Any]] = Field(
        default=None, description="The Agent Configurator's saved configuration, snapshotted"
    )
    config: Dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "The user's settings for this agent, as described by configSchema in agent.yaml. "
            "When the backend sends no `config` key, every non-platform top-level key is a setting"
        ),
    )
    connectors: List[ConnectorBinding] = Field(
        default_factory=list, description="Connectors bound to this deployment"
    )

    @model_validator(mode="before")
    @classmethod
    def _collect_user_settings(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if isinstance(data.get("config"), dict):
            return data
        data = dict(data)
        data["config"] = {k: v for k, v in data.items() if k not in PLATFORM_KEYS}
        return data

    # ── reading ──────────────────────────────────────────────────────────

    @classmethod
    def parse(cls, raw: Optional[Dict[str, Any]]) -> "SessionConfig":
        """Parse ``raw`` leniently: a platform key that does not fit is logged
        and dropped, so one bad value never stops the agent from starting."""
        data: Dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        for _ in range(len(PLATFORM_KEYS) + 1):
            try:
                return cls.model_validate(data)
            except ValidationError as e:
                bad = {err["loc"][0] for err in e.errors() if err.get("loc")}
                bad &= set(data) & PLATFORM_KEYS
                if not bad:
                    break
                for key in bad:
                    logger.warning("[SESSION CONFIG] ignoring malformed %r: %s", key, e)
                    data.pop(key, None)
        logger.warning("[SESSION CONFIG] could not parse AGENT_CONFIG; using an empty one")
        return cls()

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> "SessionConfig":
        """Read and parse ``AGENT_CONFIG``. Invalid JSON gives an empty config."""
        env = os.environ if env is None else env
        raw = env.get("AGENT_CONFIG") or "{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.warning(f"Invalid AGENT_CONFIG JSON: {e}, using empty config")
            data = {}
        return cls.parse(data if isinstance(data, dict) else {})

    # ── conveniences ─────────────────────────────────────────────────────

    @property
    def is_companion(self) -> bool:
        return self.mode == "companion"

    @property
    def plan_dict(self) -> Optional[Dict[str, Any]]:
        """The plan when it is inline (a dict); ``None`` for none or a plan id."""
        return self.plan if isinstance(self.plan, dict) else None

    @property
    def extras(self) -> Dict[str, Any]:
        """Top-level keys that are neither platform keys nor typed fields."""
        return dict(self.model_extra or {})

    @classmethod
    def json_schema(cls) -> Dict[str, Any]:
        """The JSON Schema the backend's AGENT_CONFIG builder is typed against."""
        schema = cls.model_json_schema()
        schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
        schema["$id"] = "https://stella.c4dhi.org/schemas/agent-session-config.schema.json"
        schema["description"] = (
            "AGENT_CONFIG as stella-ai-agent-sdk reads it. Generated from "
            "stella_agent_sdk.session_config.SessionConfig; do not edit by hand."
        )
        return schema
