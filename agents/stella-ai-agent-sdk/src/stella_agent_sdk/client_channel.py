"""The channel between the user's screen and the agent.

Besides speech and chat text, the screen and the agent can send each other
named messages:

- **Events**, screen → agent: ``{"type": "client_event", "data": {"event":
  name, "request_id"?: id, ...data}}``. The agent handles them in
  ``BaseAgent.on_client_event``. When the event carries a ``request_id``, the
  agent answers with ``{"type": "client_event_reply", "data": {"request_id",
  "event", "ok", "data" | "error", "agent_id"}}``.
- **Commands**, agent → screen: ``{"type": "agent_command", "data":
  {"command": name, ...data}}``, sent with ``BaseAgent.send_client_command`` or
  yielded as ``AgentOutput.client_command``.

An agent declares its events and commands in ``agent.yaml`` (the ``client``
block). STELLA passes the declaration to the pod as ``STELLA_CLIENT_CHANNEL``,
and the SDK refuses what is not declared or whose data does not fit the
declared JSON Schema. Outside STELLA the variable is unset and every message
is allowed.

Dotted names (``stella.…``) are the platform's own: every agent gets them, the
SDK handles them, and no manifest declares them.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

from stella_agent_sdk.messages.output import AgentOutput

logger = logging.getLogger(__name__)

CLIENT_CHANNEL_ENV = "STELLA_CLIENT_CHANNEL"
PLATFORM_PREFIX = "stella."

# The screen says which interface the participant uses. "voice": the agent
# speaks and listens. "text": it answers in text only, speaks nothing and
# ignores the microphone. Data: {"mode": "voice" | "text"}.
INTERACTION_MODE_EVENT = "stella.interaction_mode"
INTERACTION_MODES = ("voice", "text")

# The agent tells the screen whether it speaks (#180). With TTS off nothing
# is spoken, so no audio progress arrives and the screen has to fire a reply's
# cues (a [sleep] after a goodbye) once its text is in. Sent on ready and to
# every participant who joins later. Data: {"enabled": bool}.
SPEECH_COMMAND = "stella.speech"
TTS_ENABLED_ENV = "TTS_ENABLED"


def tts_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """Whether this agent speaks its replies: anything but ``TTS_ENABLED=false``."""
    env = os.environ if env is None else env
    return (env.get(TTS_ENABLED_ENV) or "true").strip().lower() != "false"


def speech_command(session_id: str, enabled: bool):
    """The ``stella.speech`` command for the screen."""
    return AgentOutput.client_command(session_id, SPEECH_COMMAND, enabled=bool(enabled))


# Keys of a client_event's data that belong to the envelope, not the message.
ENVELOPE_KEYS = ("event", "request_id", "timestamp")


def message_data(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """An event's own data: the payload without its envelope keys."""
    return {k: v for k, v in payload.items() if k not in ENVELOPE_KEYS}


@dataclass
class ClientChannel:
    """What the manifest declares. ``None`` maps: nothing declared (outside
    STELLA), so everything is allowed."""

    events: Optional[Dict[str, Optional[dict]]] = None
    commands: Optional[Dict[str, Optional[dict]]] = None
    _validators: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "ClientChannel":
        raw = env.get(CLIENT_CHANNEL_ENV)
        if raw is None:
            return cls()
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except ValueError:
            logger.error(f"[CLIENT CHANNEL] {CLIENT_CHANNEL_ENV} is not JSON; refusing every agent event and command")
            parsed = {}

        def table(key: str) -> Dict[str, Optional[dict]]:
            out: Dict[str, Optional[dict]] = {}
            for item in parsed.get(key) or []:
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    out[item["name"]] = item.get("data") if isinstance(item.get("data"), dict) else None
            return out

        return cls(events=table("events"), commands=table("commands"))

    @property
    def declared(self) -> bool:
        return self.events is not None

    def event_problem(self, name: str, data: Mapping[str, Any]) -> Optional[str]:
        """Why the screen may not send this event, or None."""
        return self._problem("event", self.events, name, data)

    def command_problem(self, name: str, data: Mapping[str, Any]) -> Optional[str]:
        """Why the agent may not send this command, or None. Platform commands
        (``stella.…``) are the SDK's own and need no declaration."""
        if name.startswith(PLATFORM_PREFIX):
            return None
        return self._problem("command", self.commands, name, data)

    def _problem(self, kind: str, table: Optional[Dict[str, Optional[dict]]], name: str, data: Mapping[str, Any]) -> Optional[str]:
        if table is None:
            return None
        if name not in table:
            return f"{kind} {name!r} is not declared in agent.yaml (client.{kind}s)"
        schema = table[name]
        if schema is None:
            return None
        errors = self._validator(f"{kind}:{name}", schema).iter_errors(dict(data))
        first = next(iter(sorted(errors, key=lambda e: list(e.path))), None)
        if first is None:
            return None
        where = "/".join(str(p) for p in first.path) or "data"
        return f"{kind} {name!r}: {where}: {first.message}"

    def _validator(self, key: str, schema: dict) -> Any:
        if key not in self._validators:
            from jsonschema.validators import Draft7Validator, validator_for

            self._validators[key] = validator_for(schema, default=Draft7Validator)(schema)
        return self._validators[key]


def reply_payload(
    request_id: str,
    event: str,
    *,
    ok: bool,
    data: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """The ``client_event_reply`` envelope for one event that carried a request_id."""
    body: Dict[str, Any] = {"request_id": request_id, "event": event, "ok": ok, "agent_id": agent_id}
    if ok:
        body["data"] = data or {}
    else:
        body["error"] = error or "failed"
    return {"type": "client_event_reply", "data": body}
