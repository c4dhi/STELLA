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
# and short so the fallback is always safe (no evaluation, no questions).
BRIDGE_SYSTEM_PROMPT = """You just heard the user and you're about to answer. First you say the opening beat of your reply the way a real person would — spoken aloud on its own, while the rest of the answer is still being prepared.
{{#if conversationHistory}}

Recent context:
{{conversationHistory}}
{{/if}}

Always:
- End with . or ! — never ask a question. The question belongs to the reply that follows.
- Never answer, advise, or move to the next topic — that is the reply's job. You only receive what they just said.
- NEVER say the user's own words back to them. If they said "I don't know", you do not say "I don't know"; if they said "not really", you do not say "not really". Repeating someone verbatim is not acknowledgement — it lands as mockery, or as a machine with nothing of its own to add. React to what they MEANT.
- React to the specific thing they said rather than to the act of answering, but do it in YOUR words, not theirs. A short real reaction ("Fair enough.", "Ah, okay.") beats an echo every time.
- Speak the way THEY speak: their language, their register, contractions and all. Never translate an English phrase word for word into their language — say what someone actually says in that language.
- VARY HOW YOU OPEN. Check what you already said in the recent context above and start this one differently — different words AND a different construction. Opening several turns in a row with the same frame ("That sounds like...", "Das klingt nach...") is the single most robotic thing you can do, even when each sentence is individually fine.
- No "hmm", "uh" or "erm" — they render badly in our synth.
{{#if isBargeIn}}
- The user just interrupted you. Acknowledge it briefly and yield ("Oh, go ahead."). Do not continue your previous point.
{{/if}}
- Do NOT evaluate or praise what they said — no "that's interesting", "good point", "that's great", "perfect". You do not yet know whether they just told you something difficult. Naming what you hear in it ("that sounds draining") is welcome; judging it is not.
- Say only what follows from what they actually told you. Do not invent a mood, a motive or a situation they have not mentioned.
{{#if bridgeMode}}

{{bridgeMode}}
{{/if}}
Output ONLY the bridge. No quotes, no labels."""

# ── Bridge modes ─────────────────────────────────────────────────────────────
# Listener tokens are NOT interchangeable (Yngve 1970; Schegloff 1982), so the
# bridge varies what it DOES from turn to turn rather than only how it words it.
# It used to pick from hand-written phrase inventories, one list per sub-type per
# language. That could only ever cover the two languages someone had written
# lists for, repeated within a session because a six-item pool does, and never
# referred to anything the user had actually said. All of it is gone: there is
# one LLM bridge, and the mode below tells it what this particular turn needs.
#
#   • BRIEF    — a beat and no more. Either they gave you almost nothing, or you
#                received them in full last turn; a second full reception in a
#                row is the questionnaire lockstep (see select_bridge_mode).
#   • FULL     — they gave you something real: mirror it and name what you hear.
#   • THINKING — a question or a lot at once: take a visible moment, don't answer.
#
# THE BRIDGE NEVER APPRAISES. Evaluative openers ("that's great", "wow") are
# jarring before dispreferred content — a "no", a correction, a disclosure — which
# the bridge cannot rule out because it runs BEFORE the experts. It once had an
# opt-in appraisal tier guarded by a word-list risk screen; that screen was
# guessing at information which arrives ~200ms later in the same turn, and could
# only guess in English and German. Appraisal now lives in the Response
# Generator, which runs after arbitration and is handed the tone — so it knows
# rather than guesses.
BRIDGE_MODE_BRIEF = "brief"
BRIDGE_MODE_FULL = "full"
BRIDGE_MODE_THINKING = "thinking"

# The modes that perform a FULL reception. Two of these back to back is the
# "acknowledge + question" lockstep the conversation guidelines forbid, so
# select_bridge_mode never returns one twice running on an ordinary turn.
_FULL_RECEPTION_MODES = frozenset({BRIDGE_MODE_FULL, BRIDGE_MODE_THINKING})

# What this turn's bridge should do, handed to the LLM as {{bridgeMode}}. These
# live in code rather than in the editable prompt so that a deployment whose
# stored prompt predates modes still gets them (see _build_messages).
_MODE_DIRECTIVES = {
    BRIDGE_MODE_BRIEF: (
        "THIS TURN — keep it to a beat. One or two words, then stop. Either they "
        "gave you very little, or you already received them in full a moment ago; "
        "either way a fuller reception here would sound like a routine rather than "
        "a person. Just show you heard them and hand the floor back: \"Okay.\", "
        "\"Right.\", \"Fair enough.\", \"Got it.\" — in their language. Do not name "
        "a feeling, do not add warmth you have not been given a reason for, and "
        "above all do not hand their own words back to them."
    ),
    BRIDGE_MODE_FULL: (
        "THIS TURN — they gave you something real. React the way a person would: "
        "agree, recognise it, say what it makes you think, follow their point. In "
        "YOUR words — do not restate theirs; they know what they said, and hearing "
        "it read back is what makes this sound like a machine.\n"
        "Do NOT assume there is a hardship in it. Most turns are ordinary, and "
        "some are good news. Manufacturing a struggle ('that sounds demanding', "
        "'that must be exhausting') for a turn that contained none is worse than "
        "saying something small and true. Only name a difficulty if they actually "
        "described one.\n"
        "One or two short sentences, around 15-25 words. Stop once you have "
        "actually reacted."
    ),
    BRIDGE_MODE_THINKING: (
        "THIS TURN — they asked you something, or gave you a lot at once. Take the "
        "beat you would take in person before answering something that deserves a "
        "moment, and say so in your own words — freshly, not the same phrase you "
        "used last time. Do NOT begin answering: the answer belongs to the reply "
        "that follows. One or two short sentences."
    ),
}

# Per-mode ceiling on generated tokens. A BRIEF bridge is one or two words, so
# capping it hard is what keeps the LLM round trip inside the turn-taking gap
# now that there is no instant template to fall back on. FULL uses the
# configured max_tokens, since its whole job is to be substantial.
_MODE_MAX_TOKENS = {
    BRIDGE_MODE_BRIEF: 12,
    BRIDGE_MODE_THINKING: 40,
}

# Scripts that do not put spaces between words. Splitting on whitespace returns
# ~1 "word" for an entire Chinese or Japanese sentence, which made every turn in
# those languages look bare — so every turn got a two-word beat, and a personal
# disclosure was brushed off with one. That is the exact failure the substantial
# threshold exists to prevent, total for those languages.
#
# These are properties of writing systems rather than of any language's
# vocabulary, which is why this is a table and not a word list: it makes the
# thresholds work in MORE languages, not in a hand-picked few.
#
# Korean is deliberately absent: Hangul is written with spaces between words, so
# whitespace splitting already works there.
_DENSE_SCRIPT_RANGES = (
    (0x3040, 0x30FF),   # Hiragana + Katakana
    (0x3400, 0x4DBF),   # CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),   # CJK Unified Ideographs
    (0xF900, 0xFAFF),   # CJK Compatibility Ideographs
    (0x0E00, 0x0E7F),   # Thai
)

# Characters per word in a dense script. Chinese averages roughly 1.5 characters
# per word and Japanese is close enough that one constant serves both; this only
# has to be good enough to put a turn on the right side of a threshold.
_DENSE_CHARS_PER_WORD = 1.5


def _turn_length(text: str) -> int:
    """Roughly how much the user said, in word-equivalents.

    Whitespace splitting for space-delimited scripts, character count scaled by
    ``_DENSE_CHARS_PER_WORD`` for those without spaces. Takes the larger of the
    two so mixed input ("老实说我really不想") is not undercounted.
    """
    words = len(text.split())
    dense = sum(
        1 for ch in text
        if any(lo <= ord(ch) <= hi for lo, hi in _DENSE_SCRIPT_RANGES)
    )
    if not dense:
        return words
    return max(words, round(dense / _DENSE_CHARS_PER_WORD))


# A turn this long (in words) reads as effortful → THINKING: take a visible beat.
_THINKING_WORD_THRESHOLD = 25

# At or below this many words the turn carries too little to receive in full.
# Mirroring "yeah" back at the user is the empty acknowledgement the conversation
# guidelines explicitly forbid. Kept deliberately low: a short FACTUAL answer
# ("I run three times a week") is still worth reflecting.
_BRIEF_WORD_THRESHOLD = 3

# At or above this many words the user gave you something real, which exempts the
# turn from the anti-lockstep demotion below. Deliberately well UNDER the
# thinking threshold: a 20-word disclosure ("I've been forcing myself through
# every workout and it just feels like a chore") is emotionally substantial long
# before it is computationally heavy, and answering that with a beat would be the
# worst thing this selector could do.
_SUBSTANTIAL_WORD_THRESHOLD = 12


def select_bridge_mode(
    user_input: str,
    previous_mode: Optional[str] = None,
) -> str:
    """Pick what this turn's bridge should DO, from its shape and the last turn.

    The bridge used to run the same way on every turn: one LLM call told to
    "lean long", so every turn opened with a full reflective reception and the
    reply was then told to open on the forward move. That hardcodes the exact
    shape the conversation guidelines forbid — "Never run the same 'acknowledge
    + question' shape twice in a row, that lockstep is what makes you sound like
    a questionnaire" — on every single turn. Prompt and pipeline were fighting,
    and the pipeline won.

    The rules, in order:

    * a turn of ``_BRIEF_WORD_THRESHOLD`` words or fewer gets a beat, because
      there is nothing in "yeah" worth receiving in full;
    * **the anti-lockstep rule** — after a full reception, an ordinary turn gets
      a beat rather than a second full reception. A substantial turn (a question,
      or ``_SUBSTANTIAL_WORD_THRESHOLD`` words or more) is exempt: when someone
      actually opens up, receiving it properly matters more than varying shape;
    * a question or a genuinely long turn takes a visible moment instead.

    ``previous_mode`` is the mode chosen for the preceding turn (``None`` on the
    first turn of a session, which is therefore never demoted).
    """
    text = user_input.strip()
    word_count = _turn_length(text)
    # Substantial gates the anti-lockstep exemption; thinking needs a distinctly
    # heavier turn, so the two thresholds are deliberately separate.
    substantial = "?" in text or word_count >= _SUBSTANTIAL_WORD_THRESHOLD

    if word_count <= _BRIEF_WORD_THRESHOLD and not substantial:
        return BRIDGE_MODE_BRIEF

    # Anti-lockstep: never two full receptions back to back on ordinary turns.
    if not substantial and previous_mode in _FULL_RECEPTION_MODES:
        return BRIDGE_MODE_BRIEF

    if "?" in text or word_count >= _THINKING_WORD_THRESHOLD:
        return BRIDGE_MODE_THINKING
    return BRIDGE_MODE_FULL


# Shared bridge-validation invariants — referenced by BOTH the whole-string
# validator (there is no longer a whole-string one — see _gate_stream) and the
# sentence-gated streaming validator (_gate_stream), so the two can't drift.
_BRIDGE_MAX_WORDS = 35
# A sentence boundary for streaming gates: terminal . ! ? followed by whitespace
# or end-of-text. Used only to decide how much of the streamed bridge is safe to
# release to TTS yet — the SDK's own segmenter (with its abbreviation guard) does
# the actual TTS sentence splitting on the emitted text.
_BRIDGE_SENTENCE_END = re.compile(r"[.!?]+(?=\s|$)")


# An echo — the user's own words handed straight back — is the single worst
# thing the bridge can produce. "I don't know." answered with "I don't know."
# reads as mockery; "not really" answered with "not really" reads as a machine
# with nothing of its own. Both were observed in production on 2026-08-25.
#
# The prompt is the real fix (it no longer asks for a "mirror"); this is the
# backstop for when the model does it anyway. It is structural rather than a
# word list — it compares the two strings' own tokens, so it works in any
# language.
#
# Only SHORT bridges are checked. A longer reception legitimately reuses some of
# the user's words while adding something of its own, and its overlap ratio is
# naturally well below the threshold.
_ECHO_MAX_WORDS = 6
_ECHO_OVERLAP_RATIO = 0.8
# Below this length a shared prefix collides too easily to mean anything.
_STEM_MIN_LEN = 4


def _is_echo(bridge: str, user_input: str) -> bool:
    """True when a short bridge says almost nothing the user did not just say."""
    if not bridge or not user_input:
        return False
    b_words = re.findall(r"\w+", bridge.lower(), flags=re.UNICODE)
    if not b_words or len(b_words) > _ECHO_MAX_WORDS:
        return False
    u_words = set(re.findall(r"\w+", user_input.lower(), flags=re.UNICODE))
    if not u_words:
        return False
    shared = sum(1 for w in b_words if _same_word(w, u_words))
    return shared / len(b_words) >= _ECHO_OVERLAP_RATIO


def _same_word(word: str, others: set) -> bool:
    """Does ``word`` appear in ``others``, allowing for endings?

    Exact match alone is too brittle here: the user's turn arrives from STT, so
    it carries transcription noise and inflection the bridge will not reproduce.
    The real failure "not really." against "no, not reallyy" slipped through an
    exact check on one duplicated letter.

    Words of _STEM_MIN_LEN or more match on a shared prefix, which covers both
    that and ordinary inflection ("laufe"/"laufen") without needing to know any
    language's morphology. Shorter words must match exactly, since a 2-3 letter
    prefix collides far too easily.
    """
    if word in others:
        return True
    if len(word) < _STEM_MIN_LEN:
        return False
    return any(
        o.startswith(word) or word.startswith(o)
        for o in others
        if len(o) >= _STEM_MIN_LEN
    )


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


def _gate_stream(raw: str, final: bool, user_input: str = "") -> tuple:
    """Decide how much of the streamed bridge is safe to release to TTS yet.

    The whole-string validator can't run mid-stream (TTS speaks sentence 1 before
    the bridge finishes), so we validate per completed sentence and return the
    longest validated prefix. Returns ``(accepted_text, stop)`` where ``stop``
    means a rule tripped (a question, the word cap, or an evaluative opener) and
    no further sentences should be released this turn.

    Every rule here is structural and language-agnostic — a word cap and "no
    question mark" are properties of text, not of a vocabulary.

    It used to also reject a hardcoded list of evaluative openers. That list
    existed to stop the bridge appraising ahead of a sensitive answer, a job
    that has moved to the Response Generator — which, unlike the bridge, runs
    after the experts and is handed the tone. With the bridge never permitted to
    appraise at all, the list was an English/German guess defending a case that
    no longer exists, and it failed silently in every other language.

    Call with ``final=True`` for whole-string validation. Incomplete trailing
    text is held back unless ``final``.
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
        if idx == 0 and _is_echo(s, user_input):
            # Better to say nothing than to read their own words back at them.
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
        # 0 = default (6). Was 2, which is one prior assistant turn — far too
        # little for the "vary how you open" rule to work with. Production
        # showed six consecutive bridges opening "Das klingt nach einer...",
        # each individually fine and collectively a template, because the model
        # could not see its own pattern.
        self.history_limit: int = 0
        # The bridge only buys ~1s while the main pipeline runs; it must never
        # stall the turn. If the LLM is slow (API latency spike), fall back to a
        # canned bridge instead of hanging. Tunable via BRIDGE_TIMEOUT_MS.
        self.bridge_timeout_s: float = _env_float("BRIDGE_TIMEOUT_MS", 2000.0) / 1000

        # Anti-lockstep state (#1 naturalness). The mode chosen for the previous
        # turn of THIS session, so select_bridge_mode can refuse two full
        # receptions back to back. One BridgeGenerator lives for the life of the
        # agent, so this is per-session by construction.
        self._previous_mode: Optional[str] = None
        # The mode chosen for the most recent turn, read by the agent to pick a
        # speaking rate for the whole turn (see agent.py / set_tts_speed).
        self.last_bridge_mode: Optional[str] = None

    def apply_config(self, config: dict) -> None:
        """Apply configuration overrides from the Agent Configurator.

        The configurator is the primary control surface for the bridge: every
        knob below maps to a slot on the ``bridge_generator`` node in agent.yaml
        (prompt, model, temperature, max_tokens, timeout_ms). The env var
        BRIDGE_TIMEOUT_MS is only a deploy-time default — a value set here wins.
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
        if config.get("timeout_ms") not in (None, ""):
            self.bridge_timeout_s = float(config["timeout_ms"]) / 1000

    def _build_messages(
        self,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        language: Optional[str],
        variables: Optional[Dict[str, Any]],
        mode: str = BRIDGE_MODE_FULL,
    ) -> List[LLMMessage]:
        """Render the bridge system prompt + user message. Shared by the
        streaming and non-streaming paths so they prompt the LLM identically."""
        raw_prompt = self.custom_system_prompt or BRIDGE_SYSTEM_PROMPT
        # Render template variables into the prompt so the bridge can adapt:
        # the recent context ({{conversationHistory}}), whether the turn is a
        # barge-in ({{isBargeIn}}), and what this turn's beat should do
        # ({{bridgeMode}}).
        directive = _MODE_DIRECTIVES.get(mode, "")
        ctx = {
            **(variables or {}),
            "userInput": user_input,
            "conversationHistory": format_history(conversation_history, self.history_limit or 6),
            "bridgeMode": directive,
        }
        system_prompt = render_prompt(raw_prompt, ctx)
        # A deployment whose stored prompt predates modes has no {{bridgeMode}}
        # placeholder, and prompts are stored per-deployment rather than read
        # from agent.yaml at run time — so without this the per-turn directive
        # would silently never reach production. Appended for exactly the same
        # reason RESOLVED LANGUAGE is below.
        if directive and "{{bridgeMode}}" not in raw_prompt:
            system_prompt += "\n\n" + directive
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

        # Decide what this turn's beat should DO before producing it. This is
        # what makes the bridge conditional: it used to prompt the LLM the same
        # way every turn, so every turn opened with a full reception.
        mode = select_bridge_mode(user_input, previous_mode=self._previous_mode)
        self._previous_mode = mode
        self.last_bridge_mode = mode

        released = ""  # accumulated, validated bridge text yielded so far
        try:
            messages = self._build_messages(
                user_input, conversation_history, language, variables, mode,
            )
            config = LLMConfig(
                model=self.bridge_model,
                temperature=self.bridge_temperature,
                # A beat is one or two words; capping it hard is what keeps the
                # round trip inside the turn-taking gap now that there is no
                # instant template to fall back on.
                max_tokens=min(
                    self.bridge_max_tokens,
                    _MODE_MAX_TOKENS.get(mode, self.bridge_max_tokens),
                ),
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
                    candidate, stop = _gate_stream(raw, final=final, user_input=user_input)
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
        # before first byte, or empty output) → say nothing at all.
        #
        # This used to emit a canned phrase from a hand-written inventory. Those
        # are gone, and a silent bridge is the better failure anyway: the reply
        # still carries the reaction (its prompt drops the {{#if bridge}}
        # continuation block when no bridge was spoken), so the turn degrades to
        # "no opener, normal reply" rather than to a stock phrase that fits any
        # answer. The cost is that the pipeline's latency is heard as silence on
        # this turn, which is the honest signal that something went wrong.
        if not released.strip():
            logger.warning(f"Bridge produced nothing usable (mode={mode}) — staying silent")
