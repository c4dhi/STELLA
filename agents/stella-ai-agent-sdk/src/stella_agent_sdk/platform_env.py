"""Environment variables the SDK itself reads.

These tune the voice pipeline every agent runs on (barge-in, TTS, language,
teleprompter). They belong to the SDK, not to any one agent, so an agent's
``agent.yaml`` should not have to re-declare them. This module is the one list;
``contracts/sdk-platform-env.json`` is it exported for the backend and the UI,
which merge it with what the manifest declares.

Regenerate the JSON after editing this list::

    python -m stella_agent_sdk.contracts

``tests/test_platform_contract.py`` fails when the two differ, and when the
SDK reads one of these names without it being listed here.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class PlatformEnvVar:
    name: str
    description: str
    #: What the SDK uses when the variable is unset. ``None``: no fixed default
    #: (the behaviour is described in ``description``).
    default: Optional[str] = None
    #: UI grouping only.
    group: str = "general"


PLATFORM_ENV: List[PlatformEnvVar] = [
    # ── turn-taking ──────────────────────────────────────────────────────
    PlatformEnvVar(
        "INTERRUPT_MODE",
        "Transcript interrupt behaviour: 'none' (turn-based gating) or 'smart' (barge-in with re-prompting).",
        "none",
        "turn-taking",
    ),
    PlatformEnvVar(
        "TRANSCRIPT_DEBOUNCE_MS",
        "Window (ms) for joining rapid successive final transcripts into one turn. 0 disables it.",
        "0",
        "turn-taking",
    ),
    # ── barge-in ─────────────────────────────────────────────────────────
    PlatformEnvVar(
        "BARGE_IN_ENABLED",
        "Operator override for barge-in: 'false' forces it off, 'true' on. Unset follows the agent's supports_barge_in.",
        None,
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_EVAL_TIMEOUT_MS",
        "How long (ms) the barge-in evaluator may take to decide commit or resume before the agent resumes.",
        "2000",
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_DUCK_GAIN",
        "Volume (0-1) the agent's voice drops to while the user may be interrupting.",
        "0.25",
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_DUCK_TIMEOUT_MS",
        "How long (ms) the voice stays ducked without the user's speech becoming an interruption.",
        "1200",
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_SUSPEND_TIMEOUT_MS",
        "How long (ms) playback stays suspended waiting for the interrupting transcript before it resumes.",
        "8000",
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_STORM_COUNT",
        "Barge-ins within BARGE_IN_STORM_WINDOW_MS that switch barge-in off for a cool-down (echo protection).",
        "3",
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_STORM_WINDOW_MS",
        "Window (ms) in which BARGE_IN_STORM_COUNT barge-ins count as a storm.",
        "60000",
        "barge-in",
    ),
    PlatformEnvVar(
        "BARGE_IN_STORM_COOLDOWN_MS",
        "How long (ms) barge-in stays off after a storm.",
        "120000",
        "barge-in",
    ),
    # ── language ─────────────────────────────────────────────────────────
    PlatformEnvVar(
        "STELLA_LANGUAGE",
        "Pin the conversation to one language (ISO 639-1, e.g. 'de'): STT, the reply and the voice follow it. Empty or 'auto' detects per turn.",
        None,
        "language",
    ),
    # ── text-to-speech ───────────────────────────────────────────────────
    PlatformEnvVar(
        "TTS_ENABLED",
        "Speak replies. 'false' runs the agent text-only.",
        "true",
        "tts",
    ),
    PlatformEnvVar(
        "TTS_LANGUAGE",
        "Seed language for TTS (ISO 639-1). Empty follows the language resolved per turn.",
        None,
        "tts",
    ),
    PlatformEnvVar(
        "TTS_VOICE",
        "Seed TTS voice, for providers that select voices (e.g. Kokoro). Empty is the provider default.",
        None,
        "tts",
    ),
    PlatformEnvVar(
        "TTS_SPEED",
        "Baseline speaking rate (0.5-2.0). Rate is implemented by resampling, so it shifts pitch too.",
        "1.0",
        "tts",
    ),
    PlatformEnvVar(
        "TTS_PROGRESS_TICK_MS",
        "How often (ms) a teleprompter progress envelope is sent during playback.",
        "200",
        "tts",
    ),
    PlatformEnvVar(
        "TTS_PLAYOUT_BUFFER_MS",
        "Audio (ms) the room may queue ahead of playout.",
        "1000",
        "tts",
    ),
    PlatformEnvVar(
        "STELLA_TTS_PLAYBACK",
        "'auto' starts streaming and switches once to 'sentence' if synthesis cannot keep up; 'stream' or 'sentence' pins it. 'auto' follows the platform default.",
        "auto",
        "tts",
    ),
    PlatformEnvVar(
        "STELLA_TTS_PREROLL_MS",
        "Fix the audio head start (ms) before each sentence plays. Unset (recommended) lets the SDK measure and adapt it; 0 also disables the underrun guard.",
        None,
        "tts",
    ),
    PlatformEnvVar(
        "STELLA_TTS_RATE_VARIATION",
        "Vary the speaking rate slightly by turn character. 'false' speaks every utterance at one rate.",
        "true",
        "tts",
    ),
    # ── display ──────────────────────────────────────────────────────────
    PlatformEnvVar(
        "STELLA_TELEPROMPTER_ENABLED",
        "Light the reply up word by word as it is spoken. 'false' turns it off.",
        "true",
        "display",
    ),
    PlatformEnvVar(
        "STELLA_EMOTION_TAGS_ENABLED",
        "Turn [emotion] tags in replies into face cues. 'false' turns it off.",
        "true",
        "display",
    ),
]

PLATFORM_ENV_NAMES = frozenset(v.name for v in PLATFORM_ENV)


def platform_env_document() -> Dict[str, Any]:
    """The list as the JSON document in ``contracts/sdk-platform-env.json``.
    Version-free on purpose, so it only changes when the list does."""
    return {
        "description": (
            "Environment variables stella-ai-agent-sdk reads for every agent. "
            "Generated from stella_agent_sdk.platform_env; do not edit by hand."
        ),
        "env": [{k: v for k, v in asdict(var).items() if v is not None} for var in PLATFORM_ENV],
    }


def platform_env_json() -> str:
    return json.dumps(platform_env_document(), indent=2, ensure_ascii=False) + "\n"
