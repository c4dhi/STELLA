"""Bridge Generator — natural conversational bridge for early TTS synthesis.

Generates a human-sounding reaction (a couple of words for a greeting, up to
~35 / two-three short sentences to fully receive a personal turn) that buys
time while the main pipeline (experts → arbitration → response) completes. The
bridge carries the whole reaction so the reply only has to move forward — and a
fuller bridge speaks longer, covering more of the gap before the reply lands.
Runs in parallel with the Expert Pool via asyncio.gather() (#363: there is no
Input Gate to run beside).

On failure: returns a short fallback bridge. Every turn always gets a bridge.
"""

import asyncio
import random
import re
import time
from typing import Dict, Any, List, Optional

from stella_agent_sdk.env import env_bool as _env_bool, env_float as _env_float
from stella_agent_sdk.llm import (
    LLMService, LLMConfig, LLMMessage, LLMProvider, stream_completion,
)
from stella_agent_sdk.language import LANGUAGE_NAMES as _LANGUAGE_NAMES
from stella_v2_agent.prompts.template import render_prompt
from stella_agent_sdk.prompts import format_history
import logging

logger = logging.getLogger(__name__)


def _coerce_bool(value: Any) -> bool:
    """Coerce a config value to bool, accepting the select's "on"/"off" strings.

    The configurator has no boolean slot type, so a toggle arrives as the string
    "on"/"off" (or already a bool). ``bool("off")`` is True, so we must parse the
    string rather than cast it.
    """
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return bool(value)

# Minimal fallback only. The full, editable bridge prompt lives in agent.yaml
# (bridge_generator → system_prompt) and is what runs in production; this default
# is used solely when no configured prompt is provided. It stays reflection-only
# and short so the fallback is always safe (no appraisal, no questions).
BRIDGE_SYSTEM_PROMPT = """You just heard the user and you're about to answer, but first you briefly acknowledge them the way a real person would — a short, natural beat, spoken aloud on its own.
{{#if conversationHistory}}

Recent context:
{{conversationHistory}}
{{/if}}

- End with . or ! — never ask a question.
- 1-2 words for a short answer or greeting; up to ~35 words to fully receive a longer or more personal turn — mirror it back and name the feeling or effort you hear, in their own words.
- Never answer, advise, or evaluate what they said — just receive it and lead in. Naming what you hear ("that sounds draining") is reflection and welcome; advice or the next question is not.
- Mirror the specific thing they said, not a generic "okay". Match the user's language.
{{#if isBargeIn}}
The user just interrupted you — acknowledge it briefly and yield ("Oh, go ahead."). Don't continue your previous point.
{{/if}}
Output ONLY the bridge. No quotes, no labels."""

# ── Typed bridge inventories (#304 A2) ───────────────────────────────────────
# Listener tokens are NOT interchangeable (Yngve 1970; Schegloff 1982). We pick
# a sub-type by context rather than emitting one generic "acknowledgement":
#   • GREETING       — greet back when the user greets.
#   • MINIMAL        — a bare receipt token ("Mm.", "Right."). Signals "heard,
#                      keep going" WITHOUT performing a full reaction. This is
#                      the type that breaks the questionnaire lockstep: see
#                      select_bridge_type.
#   • ACKNOWLEDGEMENT — "received, go on" for an ordinary completed turn.
#   • PENSIVE        — "let me think", signalling effortful/longer compute; used
#                      when the turn looks hard (a question, a long input).
#   • NONE           — say nothing at all; the reply opens cold. Opt-in only,
#                      because a silent bridge means the user hears the expert
#                      pool's latency instead of a voice.
# DELIBERATELY NO ASSESSMENT SUB-TYPE: evaluative tokens ("that's great", "wow")
# are jarring before dispreferred content (a "no"/correction the agent can't yet
# rule out at bridge time, since this runs before the experts). Omitting the
# class entirely is the structural guarantee the A2 acceptance criterion asks for.
BRIDGE_TYPE_GREETING = "greeting"
BRIDGE_TYPE_MINIMAL = "minimal"
BRIDGE_TYPE_ACKNOWLEDGEMENT = "acknowledgement"
BRIDGE_TYPE_PENSIVE = "pensive"
BRIDGE_TYPE_NONE = "none"

# The types that perform a FULL reaction — mirror the user's words back and name
# what was heard. Two of these in a row is the "acknowledge + question" lockstep
# the conversation guidelines forbid, so select_bridge_type never emits two
# consecutively (see the anti-lockstep rule there).
_FULL_REACTION_TYPES = frozenset({BRIDGE_TYPE_ACKNOWLEDGEMENT, BRIDGE_TYPE_PENSIVE})

# Types served straight from the inventory with no LLM call. A greeting carries
# no context worth generating, and a receipt token must NOT be contextual — the
# whole point is that it does not perform a reaction.
_TEMPLATED_TYPES = frozenset({BRIDGE_TYPE_GREETING, BRIDGE_TYPE_MINIMAL})

ACKNOWLEDGEMENT_BRIDGES_EN = [
    "Okay, yeah.",
    "Right, okay.",
    "Got it.",
    "Sure, okay.",
    "Yeah, I hear you.",
    "Alright.",
    "Yeah, gotcha.",
    "Okay, I follow.",
]

ACKNOWLEDGEMENT_BRIDGES_DE = [
    "Ja, okay.",
    "Okay, verstehe.",
    "Ja, alles klar.",
    "Ja, ich verstehe.",
    "Alles klar.",
    "Ja, genau.",
    "Okay, ich versteh.",
    "Ja, ich hör dich.",
]

# Minimal bridges are receipt tokens, not reactions: they say "heard you, go on"
# in one beat and hand the floor straight back. They exist so an ordinary turn
# does not have to be received in full — see the anti-lockstep rule in
# select_bridge_type. Kept strictly non-evaluative, like every other inventory.
MINIMAL_BRIDGES_EN = [
    "Mm.",
    "Right.",
    "Okay.",
    "Yeah.",
    "Mhm.",
    "Sure.",
]

MINIMAL_BRIDGES_DE = [
    "Mhm.",
    "Ja.",
    "Okay.",
    "Genau.",
    "Aha.",
    "Klar.",
]

# Pensive bridges signal "I'm working on something effortful" — they buy more
# floor for a harder turn and soften a longer wait. No TTS-poor sounds
# ("hmm"/"uh") — those render badly in our synth (see system prompt).
PENSIVE_BRIDGES_EN = [
    "Okay, let me think.",
    "Right, let me think for a sec.",
    "Okay, give me a moment.",
    "Let me think about that.",
]

PENSIVE_BRIDGES_DE = [
    "Okay, lass mich kurz überlegen.",
    "Moment, ich überlege kurz.",
    "Okay, einen Moment.",
    "Lass mich kurz nachdenken.",
]

GREETING_BRIDGES_EN = [
    "Hey.",
    "Hi there.",
    "Hello.",
    "Hey, hi.",
]

GREETING_BRIDGES_DE = [
    "Hey.",
    "Hallo.",
    "Hi.",
    "Hey, hallo.",
]

# Inventory lookup: (type, is_german) → list. BRIDGE_TYPE_NONE has no entry on
# purpose — it means "say nothing", so it never reaches the inventory.
_BRIDGE_INVENTORY = {
    (BRIDGE_TYPE_GREETING, True): GREETING_BRIDGES_DE,
    (BRIDGE_TYPE_GREETING, False): GREETING_BRIDGES_EN,
    (BRIDGE_TYPE_MINIMAL, True): MINIMAL_BRIDGES_DE,
    (BRIDGE_TYPE_MINIMAL, False): MINIMAL_BRIDGES_EN,
    (BRIDGE_TYPE_PENSIVE, True): PENSIVE_BRIDGES_DE,
    (BRIDGE_TYPE_PENSIVE, False): PENSIVE_BRIDGES_EN,
    (BRIDGE_TYPE_ACKNOWLEDGEMENT, True): ACKNOWLEDGEMENT_BRIDGES_DE,
    (BRIDGE_TYPE_ACKNOWLEDGEMENT, False): ACKNOWLEDGEMENT_BRIDGES_EN,
}

_GREETING_WORDS = {"hello", "hi", "hey", "hallo", "hei", "greetings", "good morning", "good evening", "good afternoon",
                   "guten morgen", "guten tag", "guten abend", "moin", "servus", "grüß gott"}

# German words/patterns for quick language detection on user input
_GERMAN_INDICATORS = {
    "ich", "du", "er", "sie", "wir", "ihr", "mein", "dein", "sein",
    "ist", "bin", "bist", "sind", "hat", "habe", "hatte", "war",
    "und", "oder", "aber", "weil", "dass", "nicht", "kein", "keine",
    "ja", "nein", "nee", "doch", "schon", "noch", "auch", "sehr",
    "das", "die", "der", "den", "dem", "des", "ein", "eine", "einem",
    "mit", "für", "von", "auf", "aus", "bei", "nach", "über", "unter",
    "hallo", "danke", "bitte", "tschüss", "genau", "okay",
}


def _detect_german(text: str) -> bool:
    """Quick heuristic: is this text likely German?"""
    words = set(text.lower().split())
    german_count = len(words & _GERMAN_INDICATORS)
    # If at least 2 German indicator words, or the text is short and has 1
    return german_count >= 2 or (len(words) <= 3 and german_count >= 1)


def _is_greeting(user_input: str) -> bool:
    """Is the user's whole turn just a greeting (hi/hello/hallo)?"""
    return user_input.strip().lower().rstrip("!.,?") in _GREETING_WORDS


# A turn longer than this (in words) reads as effortful → favour a pensive bridge
# that buys more floor while the heavier turn computes.
_PENSIVE_WORD_THRESHOLD = 25

# At or below this many words the turn carries too little to receive in full.
# Mirroring "yeah" or "twice" back at the user is the empty acknowledgement the
# conversation guidelines explicitly forbid, so these get a receipt token instead.
# Kept deliberately low: a short FACTUAL answer ("I run three times a week") is
# still worth reflecting, and the guidelines' own worked examples depend on that.
_MINIMAL_WORD_THRESHOLD = 3

# A turn at or above this many words is "substantial" — the user gave something
# real, so receiving it properly matters more than varying the shape, and it is
# exempt from the anti-lockstep rule below. Deliberately well BELOW the pensive
# threshold: a 20-word disclosure ("I've been forcing myself through every
# workout and it just feels like a chore") is emotionally substantial long
# before it is computationally heavy, and answering that with a receipt token
# is the worst thing this selector could do.
_SUBSTANTIAL_WORD_THRESHOLD = 12


def select_bridge_type(
    user_input: str,
    previous_type: Optional[str] = None,
    allow_silence: bool = False,
) -> str:
    """Pick the bridge sub-type for a turn from its shape and the previous turn.

    The bridge used to be unconditional: every turn got a full reflective
    reaction, and the response prompt then told the reply to open on the forward
    move. That hardcodes the exact shape the conversation guidelines forbid —
    "Never run the same 'acknowledge + question' shape twice in a row, that
    lockstep is what makes you sound like a questionnaire" — on every single
    turn. Prompt and pipeline were fighting, and the pipeline won.

    So selection now varies the bridge's FUNCTION, not just its wording:

    * a bare greeting gets greeted back;
    * a turn of ``_MINIMAL_WORD_THRESHOLD`` words or fewer gets a receipt token,
      because there is nothing in "yeah" worth receiving in full;
    * **the anti-lockstep rule** — after a full reaction, an ordinary turn gets a
      receipt token rather than a second full reaction. A substantial turn (a
      question, or ``_SUBSTANTIAL_WORD_THRESHOLD`` words or more) is exempt: when
      someone actually opens up, receiving it properly matters more than varying
      the shape;
    * with ``allow_silence``, a second minimal turn in a row says nothing at all,
      so the agent does not tick "Mm." "Right." "Okay." down the conversation.

    ``previous_type`` is the type chosen for the preceding turn (``None`` on the
    first turn of a session). ``allow_silence`` is off by default because
    BRIDGE_TYPE_NONE trades latency for naturalness: with no bridge the user
    hears the expert pool's latency as silence instead of as speech.
    """
    if _is_greeting(user_input):
        return BRIDGE_TYPE_GREETING

    text = user_input.strip()
    word_count = len(text.split())
    # Substantial gates the anti-lockstep exemption; pensive (a slower, more
    # effortful beat) needs a distinctly heavier turn, so they are separate.
    substantial = "?" in text or word_count >= _SUBSTANTIAL_WORD_THRESHOLD

    if word_count <= _MINIMAL_WORD_THRESHOLD and not substantial:
        # Two bare turns running — even a receipt token starts to tick.
        if allow_silence and previous_type == BRIDGE_TYPE_MINIMAL:
            return BRIDGE_TYPE_NONE
        return BRIDGE_TYPE_MINIMAL

    # Anti-lockstep: never two full reactions back to back on ordinary turns.
    if not substantial and previous_type in _FULL_REACTION_TYPES:
        return BRIDGE_TYPE_MINIMAL

    if "?" in text or word_count >= _PENSIVE_WORD_THRESHOLD:
        return BRIDGE_TYPE_PENSIVE
    return BRIDGE_TYPE_ACKNOWLEDGEMENT


def pick_bridge_from_inventory(
    bridge_type: str,
    is_german: bool,
) -> str:
    """Return a random templated bridge of ``bridge_type`` in the right language.

    Falls back to the acknowledgement inventory for any type without its own
    list, so this never raises on an unexpected type. BRIDGE_TYPE_NONE is the
    caller's business — it means "say nothing" and must be handled before here,
    or it would fall back to speaking an acknowledgement.
    """
    inventory = _BRIDGE_INVENTORY.get(
        (bridge_type, is_german),
        ACKNOWLEDGEMENT_BRIDGES_DE if is_german else ACKNOWLEDGEMENT_BRIDGES_EN,
    )
    return random.choice(inventory)


# ── Appraisal risk screen (bridge naturalness, #343 follow-up) ───────────────
# The bridge runs BEFORE the experts, so it cannot know whether the agent's real
# answer will be dispreferred (a "no", a caution, a correction). A light appraisal
# ("that's a solid routine") is jarring — or unsafe — ahead of such an answer.
# Before allowing any appraisal we run this cheap, deterministic, LLM-free screen
# on the user input; if it trips, the bridge clamps back to pure reflection.
#
# The screen is intentionally trigger-happy: suppressing appraisal is the SAFE
# direction (you just fall back to a reflective bridge), so over-triggering costs
# nothing, while a miss is the exact failure mode we're guarding against. It does
# NOT replace the experts — they still govern the real response — it only decides
# whether the pre-expert bridge may affirm.
_APPRAISAL_RISK_WORDS = {
    # health / medical (EN)
    "hurt", "injured", "injury", "pain", "painful", "sick", "ill", "illness",
    "disease", "diagnosis", "diagnosed", "symptom", "symptoms", "surgery",
    "hospital", "doctor", "medication", "meds", "chronic", "disabled", "disability",
    # health / medical (DE)
    "verletzt", "verletzung", "schmerz", "schmerzen", "krank", "krankheit",
    "diagnose", "operation", "krankenhaus", "arzt", "ärztin", "medikament",
    # mental health / distress (EN)
    "depressed", "depression", "anxious", "anxiety", "stressed", "overwhelmed",
    "burnout", "burnt", "exhausted", "suicidal", "hopeless", "lonely", "grief",
    "grieving", "died", "death", "struggling", "panic",
    # mental health / distress (DE)
    "depressiv", "angst", "gestresst", "überfordert", "erschöpft", "einsam",
    "trauer", "gestorben", "panik", "hoffnungslos",
    # legal (EN/DE)
    "lawyer", "lawsuit", "court", "sue", "sued", "legal", "anwalt", "gericht",
    "klage", "rechtlich",
    # dispreferred / negation markers (EN/DE) — a "no"/"didn't"/"never" turn
    "no", "not", "didn't", "haven't", "won't", "can't", "cannot", "never",
    "nothing", "lazy", "failed", "fail", "nein", "nicht", "nee", "nie",
    "nichts", "faul",
}

# Multi-word markers a single-token scan would miss.
_APPRAISAL_RISK_PHRASES = (
    "not really", "haven't been", "have not been", "gave up", "give up",
    "kann nicht", "keine lust", "keine motivation", "aufgegeben", "war faul",
)


# Shared bridge-validation invariants — referenced by BOTH the whole-string
# validator (there is no longer a whole-string one — see _gate_stream) and the
# sentence-gated streaming validator (_gate_stream), so the two can't drift.
_BRIDGE_MAX_WORDS = 35
# Evaluative openers rejected unless the risk-screened appraisal tier is active.
_EVALUATIVE_OPENERS = ("that's a", "that's an", "what a", "what an")

# A sentence boundary for streaming gates: terminal . ! ? followed by whitespace
# or end-of-text. Used only to decide how much of the streamed bridge is safe to
# release to TTS yet — the SDK's own segmenter (with its abbreviation guard) does
# the actual TTS sentence splitting on the emitted text.
_BRIDGE_SENTENCE_END = re.compile(r"[.!?]+(?=\s|$)")


def _split_complete_sentences(text: str) -> tuple:
    """Split ``text`` into (complete_sentences, trailing_remainder).

    A complete sentence ends at a ``.!?`` boundary; the trailing remainder is the
    still-incomplete tail (held back while streaming so a half sentence is never
    spoken). Decimals like "3.5" don't match (no whitespace after the dot).
    """
    sentences: List[str] = []
    last = 0
    for m in _BRIDGE_SENTENCE_END.finditer(text):
        seg = text[last:m.end()].strip()
        if seg:
            sentences.append(seg)
        last = m.end()
    return sentences, text[last:].strip()


def _clean_stream_text(raw: str) -> str:
    """Normalize streamed bridge text: drop surrounding quotes the model may add."""
    t = (raw or "").strip()
    if t[:1] in ('"', "'"):
        t = t[1:].lstrip()
    if t[-1:] in ('"', "'"):
        t = t[:-1].rstrip()
    return t


def _gate_stream(raw: str, allow_appraisal: bool, final: bool) -> tuple:
    """Decide how much of the streamed bridge is safe to release to TTS yet.

    The whole-string validator can't run mid-stream (TTS speaks sentence 1 before
    the bridge finishes), so we validate per completed sentence and return the
    longest validated prefix. Returns ``(accepted_text, stop)`` where ``stop``
    means a rule tripped (a question, the word cap, or an evaluative opener) and
    no further sentences should be released this turn.

    This is the ONLY bridge validator. A whole-string ``_validate_bridge`` used
    to sit alongside it, serving a non-streaming path that no longer exists — so
    its invariants (``_BRIDGE_MAX_WORDS``, ``_EVALUATIVE_OPENERS``, no question
    marks) had to be hand-kept in sync with these for no benefit. Call with
    ``final=True`` for whole-string validation. Incomplete trailing text is held
    back unless ``final``.
    """
    text = _clean_stream_text(raw)
    if not text:
        return "", False

    sentences, remainder = _split_complete_sentences(text)
    candidates = list(sentences)
    if final and remainder:
        candidates.append(remainder)  # closing fragment; terminal punct added below

    accepted: List[str] = []
    words = 0
    for idx, s in enumerate(candidates):
        if "?" in s:  # a bridge never asks — drop this sentence and stop
            return " ".join(accepted), True
        if idx == 0 and not allow_appraisal and s.lower().startswith(_EVALUATIVE_OPENERS):
            return " ".join(accepted), True
        n = len(s.split())
        if words + n > _BRIDGE_MAX_WORDS:  # would overrun the cap — stop before it
            return " ".join(accepted), True
        accepted.append(s)
        words += n

    out = " ".join(accepted)
    if final and out and out[-1] not in ".!":
        out += "."
    return out, False


def _screen_risk(user_input: str) -> bool:
    """Return True when the turn is too sensitive/dispreferred for an appraisal.

    Cheap and deterministic — no LLM, no dependency on the (being-removed) input
    gate. Biased toward suppression: a hit means "clamp the bridge to reflection".
    """
    text = user_input.lower()
    words = set(re.findall(r"[a-zäöüß']+", text))
    if words & _APPRAISAL_RISK_WORDS:
        return True
    return any(phrase in text for phrase in _APPRAISAL_RISK_PHRASES)


class BridgeGenerator:
    """Generates a short conversational bridge for early TTS synthesis.

    Uses a dedicated LLM call with higher temperature for natural variety.
    Emitted up front (before the experts run) so the user hears a natural beat
    while the rest of the pipeline computes.
    """

    def __init__(self, llm_service: LLMService):
        self._llm_service = llm_service

        # LLM config (overridable via apply_config)
        self.bridge_model = "gpt-4o-mini"
        # Headroom for a fuller reflective bridge (up to ~35 words / 2-3 short
        # sentences). agent.yaml's bridge_generator.max_tokens overrides this when
        # a config is loaded; this is the no-config default.
        self.bridge_max_tokens = 80
        self.bridge_temperature = 0.7
        self.custom_system_prompt: Optional[str] = None
        self.history_limit: int = 0  # 0 = default (2)
        # The bridge only buys ~1s while the main pipeline runs; it must never
        # stall the turn. If the LLM is slow (API latency spike), fall back to a
        # canned bridge instead of hanging. Tunable via BRIDGE_TIMEOUT_MS.
        self.bridge_timeout_s: float = _env_float("BRIDGE_TIMEOUT_MS", 2000.0) / 1000

        # Fast-path bridge (#304 A3). The LLM bridge can itself take up to
        # ``bridge_timeout_s`` to return — i.e. the latency-masking mechanism can
        # add latency and miss the gap window it exists to fill. When enabled,
        # the bridge is served INSTANTLY from the typed templated inventory (no
        # LLM call), guaranteeing first-byte inside the gap window. Trades the
        # LLM bridge's contextual richness for guaranteed timing, so it's opt-in
        # via BRIDGE_FAST_PATH and easy to A/B against the A1 baseline.
        self.fast_path_enabled: bool = _env_bool("BRIDGE_FAST_PATH", False)

        # Appraisal tier (#343 follow-up). When OFF (default), the bridge is
        # strictly reflective — it never evaluates what the user said (the #304 A2
        # guarantee). When ON, the LLM bridge MAY add a brief, understated
        # appraisal of the user's situation, but ONLY when the risk screen
        # (_screen_risk) clears — so it never affirms ahead of a sensitive or
        # dispreferred answer. The templated fast-path/fallback never appraises
        # regardless, so the deterministic route stays veto-proof. Opt-in and
        # A/B-able via BRIDGE_APPRAISAL, mirroring BRIDGE_FAST_PATH.
        self.appraisal_enabled: bool = _env_bool("BRIDGE_APPRAISAL", False)

        # Anti-lockstep state (#1 naturalness). The sub-type chosen for the
        # previous turn of THIS session, so select_bridge_type can refuse to
        # perform two full reactions back to back. One BridgeGenerator lives for
        # the life of the agent, so this is per-session by construction.
        self._previous_type: Optional[str] = None
        # The type chosen for the most recent turn, read by the agent to pick a
        # speaking rate for the whole turn (see agent.py / set_tts_speed).
        self.last_bridge_type: Optional[str] = None

        # Opt-in silent bridge. OFF by default: BRIDGE_TYPE_NONE trades latency
        # for naturalness, because with no bridge the user hears the expert
        # pool's latency as silence rather than as speech.
        self.allow_silence: bool = _env_bool("BRIDGE_ALLOW_SILENCE", False)

    def apply_config(self, config: dict) -> None:
        """Apply configuration overrides from the Agent Configurator.

        The configurator is the primary control surface for the bridge: every
        knob below maps to a slot on the ``bridge_generator`` node in agent.yaml
        (prompt, model, temperature, max_tokens, fast_path, timeout_ms). The env
        vars (BRIDGE_FAST_PATH / BRIDGE_TIMEOUT_MS) are only deploy-time defaults
        — any value set here overrides them.
        """
        if "model" in config:
            self.bridge_model = config["model"]
        if "max_tokens" in config:
            self.bridge_max_tokens = int(config["max_tokens"])
        if "temperature" in config:
            self.bridge_temperature = float(config["temperature"])
        if "system_prompt" in config:
            self.custom_system_prompt = config["system_prompt"]
        if "history_limit" in config:
            self.history_limit = int(config["history_limit"])
        if "fast_path" in config:
            self.fast_path_enabled = _coerce_bool(config["fast_path"])
        if "appraisal" in config:
            self.appraisal_enabled = _coerce_bool(config["appraisal"])
        if "allow_silence" in config:
            self.allow_silence = _coerce_bool(config["allow_silence"])
        if config.get("timeout_ms") not in (None, ""):
            self.bridge_timeout_s = float(config["timeout_ms"]) / 1000

    def fast_bridge(
        self,
        user_input: str,
        language: Optional[str] = None,
        bridge_type: Optional[str] = None,
    ) -> str:
        """Return a typed templated bridge INSTANTLY — no LLM call (#304 A3).

        Used for the templated sub-types (greeting, minimal), for the fast-path,
        and as the failure fallback, so all three are guaranteed to land inside
        the gap window.

        ``bridge_type`` lets the caller pass a type it has already selected (so
        the anti-lockstep state is applied once per turn, not recomputed here).
        When omitted, the type is selected from the input alone.
        """
        is_german = (language == "de") if language else _detect_german(user_input)
        if bridge_type is None:
            bridge_type = select_bridge_type(user_input)
        return pick_bridge_from_inventory(bridge_type, is_german)

    def _build_messages(
        self,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        language: Optional[str],
        variables: Optional[Dict[str, Any]],
        allow_appraisal: bool,
    ) -> List[LLMMessage]:
        """Render the bridge system prompt + user message. Shared by the
        streaming and non-streaming paths so they prompt the LLM identically."""
        raw_prompt = self.custom_system_prompt or BRIDGE_SYSTEM_PROMPT
        # Render template variables into the prompt so the bridge can adapt:
        # the recent context ({{conversationHistory}}), whether the turn is a
        # barge-in ({{isBargeIn}}), and whether a brief appraisal is permitted
        # ({{allowAppraisal}}).
        ctx = {
            **(variables or {}),
            "userInput": user_input,
            "conversationHistory": format_history(conversation_history, self.history_limit or 2),
            "allowAppraisal": allow_appraisal,
        }
        system_prompt = render_prompt(raw_prompt, ctx)
        if language:
            system_prompt += (
                f"\n\nRESOLVED LANGUAGE (overrides the rule above): "
                f"Produce the bridge in {_LANGUAGE_NAMES.get(language, language)} only."
            )
        return [
            LLMMessage(role="system", content=system_prompt),
            # The interruption/answer being reacted to is the bare user message;
            # all context is placed by the prompt via template variables.
            LLMMessage(role="user", content=user_input),
        ]

    async def generate(
        self,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        language: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Generate the complete bridge phrase (non-streaming convenience).

        Thin wrapper over :meth:`generate_stream` that drains the stream and
        returns the final accumulated bridge — for callers that want the whole
        phrase at once. The live pipeline uses ``generate_stream`` directly so
        each sentence reaches TTS as soon as it's ready.

        Returns:
            A validated bridge phrase (a couple of words up to ~35, scaled to the
            user's turn). Always returns a bridge (fallback on failure).
        """
        bridge = ""
        async for accumulated in self.generate_stream(
            user_input, conversation_history, language=language, variables=variables
        ):
            bridge = accumulated
        return bridge

    async def generate_stream(
        self,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        language: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
    ):
        """Stream the bridge as accumulated text, one validated sentence at a time.

        Yields the FULL accumulated bridge text each time another complete
        sentence has been validated and released, so the consumer can hand each
        sentence to TTS the instant it's ready — the same shape the Response
        Generator streams in, sharing the response transcript_id so bridge +
        reply are one seamless utterance. The key win for the "lean long" bridge:
        the first sentence starts speaking after a few hundred ms instead of
        waiting for the whole (now richer) bridge to generate.

        Because TTS starts before the bridge finishes, a whole-string validator
        cannot gate it — so each sentence is validated as it
        completes (``_gate_stream``: never release a question, an over-length run,
        or an evaluative opener). If the very first sentence is rejected or the
        LLM times out/fails before anything is released, a canned templated bridge
        is yielded instead (safe — nothing has been spoken yet).

        Args mirror :meth:`generate`. Yields ``str`` (accumulated bridge text);
        always yields at least one non-empty value (fallback on failure).
        """
        start_time = time.time()

        # Decide what KIND of beat this turn gets BEFORE deciding how to produce
        # it. This is what makes the bridge conditional: it used to run the LLM
        # unconditionally on every turn, so every turn opened with a full
        # reflective reaction (see select_bridge_type).
        bridge_type = select_bridge_type(
            user_input,
            previous_type=self._previous_type,
            allow_silence=self.allow_silence,
        )
        self._previous_type = bridge_type
        self.last_bridge_type = bridge_type

        # Say nothing at all. The reply then opens cold — its prompt drops the
        # {{#if bridge}} continuation block — and carries the reaction itself.
        if bridge_type == BRIDGE_TYPE_NONE:
            logger.info("Bridge: silent turn (type=none)")
            return

        # Templated types skip the LLM entirely. A greeting has no context worth
        # generating and a receipt token must not perform a reaction, so routing
        # them here is BOTH more natural and strictly faster than a round trip:
        # these turns now reach TTS in microseconds instead of a few hundred ms.
        # Fast-path forces every type down this route (#304 A3).
        if bridge_type in _TEMPLATED_TYPES or self.fast_path_enabled:
            bridge = self.fast_bridge(user_input, language, bridge_type=bridge_type)
            logger.info(
                f"Templated bridge '{bridge}' (type={bridge_type}) in "
                f"{(time.time() - start_time) * 1000:.0f}ms"
            )
            yield bridge
            return

        # Appraisal is allowed only when enabled AND the turn clears the risk
        # screen — so the bridge never affirms ahead of a sensitive/dispreferred
        # answer it can't yet see. Off → strictly reflective (the #304 A2 default).
        allow_appraisal = self.appraisal_enabled and not _screen_risk(user_input)

        released = ""  # accumulated, validated bridge text yielded so far
        try:
            messages = self._build_messages(
                user_input, conversation_history, language, variables, allow_appraisal
            )
            config = LLMConfig(
                model=self.bridge_model,
                temperature=self.bridge_temperature,
                max_tokens=self.bridge_max_tokens,
                provider=LLMProvider.OPENAI_LANGCHAIN,
                streaming=True,
                json_mode=False,
            )

            # Consume the LLM stream through the shared SDK adapter (single source
            # of truth for callback→async-iterator), bounded on wall-clock so a
            # slow LLM never stalls the turn. The timeout covers first-byte AND the
            # tail; on timeout we keep whatever validated sentences already
            # streamed (or fall back below if none did).
            async with asyncio.timeout(self.bridge_timeout_s):
                async for raw, final in stream_completion(
                    self._llm_service, messages, config, component_name="bridge_generator",
                ):
                    candidate, stop = _gate_stream(raw, allow_appraisal, final=final)
                    if candidate and candidate != released and candidate.startswith(released):
                        released = candidate
                        yield released
                    if stop:
                        break

            latency_ms = (time.time() - start_time) * 1000
            if released:
                logger.info(f"'{released}' streamed in {latency_ms:.0f}ms")
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            if released:
                # Already spoke valid sentence(s); just stop cleanly.
                logger.warning(f"Bridge stream ended early after {latency_ms:.0f}ms: {e}")
            else:
                logger.error(f"Bridge stream failed in {latency_ms:.0f}ms: {e}")

        # Nothing valid was released (rejected first sentence, timeout/error
        # before first byte, or empty output) → safe canned fallback.
        if not released.strip():
            fallback = self.fast_bridge(user_input, language, bridge_type=bridge_type)
            logger.info(f"Fallback bridge '{fallback}'")
            yield fallback
