"""Language resolver — single source of truth for the conversation language.

Without this, language tends to be decided several times independently within a
turn (an early bridge/ack heuristic, response-prompt inference, a static TTS env
var) and they can drift apart. This module collapses that into ONE resolved
language per turn that every consumer — the prompt's {{language}} directive and
TTS routing — reads, so the whole turn speaks one language.

Design (see RFC §8):
- Resolve from a per-turn ``(language, confidence)`` signal. For voice the
  signal is STT's independent acoustic detection (passed into ``resolve`` by the
  agent); for typed text it is the bundled ``detect_language`` text classifier.
  Both shapes are interchangeable — same gating, same propagation (§8.3).
- Hold a session lock; switch only on a sustained, high-confidence change
  (§8 confidence-gated switch). Short/ambiguous utterances never flip it.
- Clamp to the supported set — never resolve to a language we cannot speak (§7).
- Fallback chain: confident signal → session lock → plan seed → default.

Scope: the committed v1 supported set is ``en``/``de`` (RFC §7), so the bundled
detector is a focused, dependency-free en/de classifier that returns a usable
confidence. Swapping in a broader detector only changes ``detect_language``.
"""

import logging
import os
import re
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Human-readable names for prompt injection.
LANGUAGE_NAMES = {"en": "English", "de": "German"}

# Deployment-level language PIN, chosen by the operator in the deploy UI.
# When set to a supported ISO 639-1 code the conversation language is FORCED to
# it for the whole deployment: detection is ignored, the lock never switches,
# and STT transcription is pinned to the same language (``audio/pipeline.py``).
# This is the deliberate opposite of the default auto-detect — it exists because
# auto-detect needs a long enough utterance to be confident, so a short first
# turn would otherwise fall back to the generic default (RFC §5 / §10 "force").
# Empty or ``auto`` = auto-detect, the default.
FORCE_LANGUAGE_ENV = "STELLA_LANGUAGE"


def forced_language() -> Optional[str]:
    """The deployment-pinned conversation language, or ``None`` for auto-detect.

    Read from the ``STELLA_LANGUAGE`` env var so every consumer (resolver, STT
    pin, TTS seed) derives the pin from one place rather than each holding its
    own copy.
    """
    value = (os.getenv(FORCE_LANGUAGE_ENV) or "").strip().lower()
    if not value or value == "auto":
        return None
    return value


# German function words / strong indicators.
_GERMAN_WORDS = {
    "ich", "du", "er", "sie", "wir", "ihr", "mein", "dein", "sein",
    "ist", "bin", "bist", "sind", "hat", "habe", "hatte", "war", "wird",
    "und", "oder", "aber", "weil", "dass", "nicht", "kein", "keine",
    "nein", "nee", "doch", "schon", "noch", "auch", "sehr", "mal",
    "das", "die", "der", "den", "dem", "des", "ein", "eine", "einen", "einem",
    "mit", "für", "von", "auf", "aus", "bei", "nach", "über", "unter",
    "hallo", "danke", "bitte", "tschüss", "genau", "wie", "was", "wer",
    "warum", "wann", "wo", "hier", "heute", "morgen", "gestern", "gut",
}

# English function words / strong indicators.
_ENGLISH_WORDS = {
    "i", "you", "he", "she", "we", "they", "my", "your", "his", "her",
    "is", "am", "are", "was", "were", "have", "has", "had", "will", "would",
    "and", "or", "but", "because", "that", "not", "no", "yes",
    "the", "a", "an", "this", "these", "those", "of", "to", "for", "from",
    "with", "on", "at", "in", "out", "about", "over", "under",
    "hello", "thanks", "please", "what", "who", "why", "when", "where",
    "here", "today", "tomorrow", "yesterday", "good", "how",
}

_WORD_RE = re.compile(r"[a-zà-ÿäöüß]+", re.IGNORECASE)
_UMLAUT_RE = re.compile(r"[äöüß]", re.IGNORECASE)


def detect_language(text: str) -> Tuple[Optional[str], float]:
    """Classify ``text`` as ``en`` or ``de`` with a confidence in ``[0, 1]``.

    Returns ``(None, 0.0)`` when there is no usable signal (empty, numeric, or
    no indicator words) so the caller can fall back. Confidence scales with the
    amount of evidence, so short/ambiguous input yields LOW confidence — that is
    what keeps a stray word from flipping the locked language.
    """
    if not text:
        return None, 0.0

    lowered = text.lower()
    words = _WORD_RE.findall(lowered)
    if not words:
        return None, 0.0

    de_hits = sum(1 for w in words if w in _GERMAN_WORDS)
    en_hits = sum(1 for w in words if w in _ENGLISH_WORDS)
    # Umlauts/ß are a strong, almost-exclusive German signal.
    umlauts = len(_UMLAUT_RE.findall(lowered))

    de_score = de_hits + 2 * umlauts
    en_score = en_hits
    total = de_score + en_score
    if total == 0:
        return None, 0.0

    if de_score >= en_score:
        lang, dominant = "de", de_score
    else:
        lang, dominant = "en", en_score

    # margin: how lopsided the evidence is (1.0 == fully one-sided).
    margin = (dominant - (total - dominant)) / total
    # evidence: more indicator hits → more trustworthy. Caps at 3 hits.
    evidence = min(1.0, total / 3.0)
    confidence = round(margin * evidence, 3)
    return lang, confidence


# Below this many word-equivalents a turn carries too little signal to move a
# confirmed language lock. Structural rather than a word list: it measures how
# much was said, so it holds in any language. Scripts without spaces are counted
# by character, since whitespace splitting returns ~1 for a whole sentence.
_MIN_SWITCH_WORDS = 4
_DENSE_SCRIPT_RANGES = (
    (0x3040, 0x30FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF), (0x0E00, 0x0E7F),
)


def _too_short_to_switch(text: Optional[str]) -> bool:
    """True when this turn is too slight to be evidence of a language change."""
    if not text:
        return True
    words = len(text.split())
    dense = sum(
        1 for ch in text
        if any(lo <= ord(ch) <= hi for lo, hi in _DENSE_SCRIPT_RANGES)
    )
    if dense:
        words = max(words, round(dense / 1.5))
    return words < _MIN_SWITCH_WORDS


class LanguageResolver:
    """Holds the resolved session language and applies confidence-gated switching.

    One instance per agent. ``resolve(text)`` is called once per turn, before the
    bridge fires, and returns the language the whole turn (bridge, response, TTS)
    must use. The value is stable across turns unless a sustained, confident
    change is detected.
    """

    def __init__(
        self,
        supported: Tuple[str, ...] = ("de", "en"),
        default: str = "en",
        seed: Optional[str] = None,
        detect_threshold: float = 0.4,
        switch_threshold: float = 0.6,
        debounce: int = 3,
        forced: Optional[str] = None,
    ) -> None:
        self.supported = set(supported)
        self.default = default if default in self.supported else next(iter(self.supported))
        self.detect_threshold = detect_threshold
        self.switch_threshold = switch_threshold
        # Consecutive confident detections required to move a CONFIRMED lock.
        # Was 1, i.e. a single turn flipped the conversation's language
        # mid-sentence. STT is least reliable on exactly the turns that carry
        # the least language signal — short acknowledgements — so one vote was
        # far too cheap. Observed in production: German sessions where "Nicht
        # so." and "Y'all." came back from Whisper as English.
        self.debounce = max(1, debounce)

        self.seed = seed if seed in self.supported else None
        # Deployment pin. ``_forced_request`` keeps the raw operator choice so a
        # later ``apply_config`` that widens ``supported`` can honor a pin the
        # default set had rejected. Falls back to the env var so both agents get
        # the pin from the shared SDK with no per-agent wiring.
        self._forced_request = (forced if forced is not None else forced_language())
        self.forced = self._validate_forced()
        self.locked: Optional[str] = self.forced
        # True once the lock came from a real detection (not the default/seed).
        # A provisional lock yields to the first genuine detection at
        # detect_threshold; a confirmed lock only changes via switch_threshold.
        # A pin counts as confirmed: it is a decision, not a placeholder.
        self._confirmed = bool(self.forced)
        self._pending: Optional[str] = None
        self._pending_count = 0

    def _validate_forced(self) -> Optional[str]:
        """Clamp the requested pin to the supported set (unsupported → no pin)."""
        want = self._forced_request
        if not want:
            return None
        if want not in self.supported:
            logger.warning(
                f"[Language] Ignoring pin '{want}': not in supported set "
                f"{sorted(self.supported)}. Falling back to auto-detect."
            )
            return None
        return want

    def reset(self) -> None:
        """Clear per-session state (lock, confirmation, pending switch).

        Call on session start so a resolved language never leaks between
        conversations. Configuration (supported set, default, thresholds, seed)
        is preserved.
        """
        self.locked = self.forced
        self._confirmed = bool(self.forced)
        self._reset_pending()

    def apply_config(self, config: dict) -> None:
        """Apply resolver configuration overrides from the pipeline config.

        Recognized keys (all optional): ``supported`` (list of ISO codes),
        ``default`` (fallback language), ``detect_threshold``, ``switch_threshold``,
        ``debounce``. Unknown keys are ignored.
        """
        if "supported" in config and config["supported"]:
            self.supported = set(config["supported"])
        if "default" in config and config["default"] in self.supported:
            self.default = config["default"]
        elif self.default not in self.supported:
            self.default = next(iter(self.supported))
        if "detect_threshold" in config:
            self.detect_threshold = float(config["detect_threshold"])
        if "switch_threshold" in config:
            self.switch_threshold = float(config["switch_threshold"])
        if "debounce" in config:
            self.debounce = max(1, int(config["debounce"]))
        if "force" in config:
            want = (str(config["force"] or "")).strip().lower()
            self._forced_request = want if want and want != "auto" else None
        # Re-validate seed and pin against the (possibly new) supported set.
        self.seed = self.seed if self.seed in self.supported else None
        self.forced = self._validate_forced()
        if self.forced:
            self.locked, self._confirmed = self.forced, True

    def set_seed(self, seed: Optional[str]) -> None:
        """Set the plan-declared language seed (``auto``/unsupported → no seed).

        No effect while a deployment pin is active — the pin outranks the plan
        seed, which only ever biases an otherwise-undecided turn.
        """
        self.seed = seed if seed in self.supported else None

    def _reset_pending(self) -> None:
        self._pending = None
        self._pending_count = 0

    def resolve(
        self,
        text: str,
        signal: Optional[Tuple[Optional[str], float]] = None,
    ) -> str:
        """Resolve the language for this turn (single source of truth).

        Args:
            text: the user's utterance/typed text — used to detect the language
                when no external ``signal`` is given.
            signal: an externally-provided ``(language, confidence)`` detection,
                e.g. the STT acoustic probe (RFC §8 #1–#4). When supplied it is
                used as-is and ``text`` is not inspected; when ``None`` the
                language is detected from ``text`` (typed input / no acoustic
                signal, RFC §8.3). Both signal shapes flow through the same
                gating below, so the source is interchangeable.

        Fallback chain (RFC §8.3): deployment pin → confident supported signal →
        session lock → plan seed → default.
        """
        # Deployment pin outranks everything: the operator asked for a
        # fixed-language deployment, so detection is not consulted at all and no
        # short/ambiguous turn can fall back to the default.
        if self.forced:
            self.locked = self.forced
            self._confirmed = True
            self._reset_pending()
            return self.locked

        if signal is not None:
            lang, confidence = signal
        else:
            lang, confidence = detect_language(text)
        if lang not in self.supported:  # clamp; unsupported never wins (§7)
            lang, confidence = None, 0.0

        # Until a real detection confirms the language, the lock is provisional
        # (default/seed). Adopt the first confident detection at detect_threshold,
        # exactly like the first turn — so the last *detected* language is
        # preferred over the static default/seed (RFC §8.3 fallback chain).
        if not self._confirmed:
            if lang and confidence >= self.detect_threshold:
                self.locked = lang
                self._confirmed = True
            elif self.locked is None:
                self.locked = self.seed or self.default
            self._reset_pending()
            return self.locked

        # Confirmed lock: hold it (the last detected language) unless a
        # sustained, high-confidence change is seen — and only from turns long
        # enough to actually carry the evidence. A one- or two-word
        # acknowledgement is where STT guesses, so it must not get a vote; it
        # neither advances a pending switch nor cancels one, it is simply not
        # evidence either way.
        if _too_short_to_switch(text):
            return self.locked

        if lang and lang != self.locked and confidence >= self.switch_threshold:
            if self._pending == lang:
                self._pending_count += 1
            else:
                self._pending, self._pending_count = lang, 1
            if self._pending_count >= self.debounce:
                self.locked = lang
                self._reset_pending()
        else:
            # Anything that is NOT a confident switch toward `lang` cancels an
            # in-flight switch: same language, no signal, OR a weak/ambiguous
            # opposite signal (different supported language below switch_threshold).
            # This keeps "sustained" meaning CONSECUTIVE confident detections —
            # a weak turn in between resets the debounce count (RFC §8 #3).
            self._reset_pending()

        return self.locked


def language_name(code: Optional[str]) -> str:
    """Human-readable language name for prompt injection.

    ``auto``/unknown → a generic phrase so prompts stay grammatical.
    """
    if not code or code == "auto":
        return "the user's language"
    return LANGUAGE_NAMES.get(code, code)
