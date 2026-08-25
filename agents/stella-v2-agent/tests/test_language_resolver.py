"""Tests for the language resolver — the single source of truth for the
conversation language (RFC: docs/rfcs/2026-06-01_language-handling.md).

These cover the reliability promise: lock on confident detection, hold through
ambiguous/short input, switch only on a sustained confident change, clamp to the
supported set, and the plan-seed / default fallback chain (RFC §8).
"""

import pytest

from stella_agent_sdk.language import (
    detect_language,
    forced_language,
    language_name,
    FORCE_LANGUAGE_ENV,
    LanguageResolver,
)


# ─────────────────────────── detect_language ───────────────────────────

def test_detects_german_with_confidence():
    lang, conf = detect_language("Ich bin müde und habe keine Motivation")
    assert lang == "de"
    assert conf >= 0.6


def test_detects_english_with_confidence():
    lang, conf = detect_language("I have been running three times a week")
    assert lang == "en"
    assert conf >= 0.6


@pytest.mark.parametrize("text", ["", "   ", "123 456"])
def test_no_signal_returns_none(text):
    lang, conf = detect_language(text)
    assert lang is None
    assert conf == 0.0


def test_short_ambiguous_is_low_confidence():
    # A single cross-lingual token must not read as confident.
    _, conf = detect_language("okay")
    assert conf < 0.4


def test_umlaut_is_a_strong_german_signal():
    lang, conf = detect_language("schön")
    assert lang == "de"
    assert conf > 0.0


# ─────────────────────────── first-turn lock ───────────────────────────

def test_locks_on_first_confident_utterance():
    r = LanguageResolver()
    assert r.resolve("Ich habe heute keine Motivation") == "de"


def test_default_when_first_utterance_is_ambiguous():
    r = LanguageResolver(default="en")
    assert r.resolve("...") == "en"


def test_plan_seed_used_when_turn1_ambiguous():
    r = LanguageResolver()
    r.set_seed("de")
    assert r.resolve("ok") == "de"


def test_confident_detection_overrides_seed_on_turn1():
    r = LanguageResolver()
    r.set_seed("de")
    assert r.resolve("I want to discuss my weekly running plan") == "en"


# ─────────────────────── hold / reliability ───────────────────────

def test_holds_lock_through_ambiguous_input():
    r = LanguageResolver()
    r.resolve("Ich habe keine Motivation heute")  # lock de
    assert r.resolve("ok") == "de"
    assert r.resolve("ja") == "de"


def test_single_short_word_does_not_flip_language():
    r = LanguageResolver()
    r.resolve("I have been thinking about this a lot lately")  # lock en
    # A stray German particle must not flip a locked English session.
    assert r.resolve("ja") == "en"


# ─────────────── last-detected preferred over default/seed ───────────────

def test_holds_last_detected_over_default():
    # The user's question: after detecting a language, an ambiguous turn must
    # fall back to the LAST DETECTED language, not the static default.
    r = LanguageResolver(default="en")
    r.resolve("Ich habe heute echt keine Motivation mehr")  # detect de
    assert r.resolve("hmm") == "de"   # ambiguous → last detected (de), not default en


def test_provisional_default_yields_to_first_real_detection():
    # Turn-1 ambiguous → provisional default lock. The first genuine detection
    # then adopts at detect_threshold (it should NOT need the higher
    # switch_threshold, because the default was never actually detected).
    r = LanguageResolver(default="en", detect_threshold=0.2, switch_threshold=0.9)
    assert r.resolve("...") == "en"          # provisional default
    assert r.resolve("der") == "de"          # first real detection adopts (0.333 ≥ 0.2)
    # now confirmed: a same-strength opposite signal must NOT flip it
    assert r.resolve("the") == "de"          # en signal 0.333 < switch 0.9 → hold


def test_confirmed_lock_does_not_yield_at_detect_threshold():
    r = LanguageResolver(detect_threshold=0.2, switch_threshold=0.9)
    r.resolve("I have been running a lot this week")  # confident en → confirmed
    assert r.resolve("der") == "en"          # weak de (0.333) < switch 0.9 → hold


# ─────────────── acoustic signal (STT) vs text fallback ───────────────

def test_acoustic_signal_is_used_over_text():
    # When STT supplies an (lang, confidence) probe, the text is NOT inspected —
    # a German-looking word spoken in an English session stays English.
    r = LanguageResolver()
    assert r.resolve("ja", signal=("en", 0.97)) == "en"


def test_acoustic_signal_drives_switch():
    r = LanguageResolver()
    r.resolve("hi there and welcome along", signal=("en", 0.96))   # lock en (acoustic)
    # Sustained, confident German acoustic detection switches. One turn no
    # longer suffices (debounce is 3): STT guesses hardest on the shortest
    # turns, so a single vote was too cheap.
    de_turn = "wir sprechen jetzt bitte weiter auf deutsch"
    for _ in range(3):
        got = r.resolve(de_turn, signal=("de", 0.95))
    assert got == "de"


def test_acoustic_unsupported_language_holds_lock():
    r = LanguageResolver(supported=("en", "de"))
    r.resolve("hello", signal=("en", 0.96))         # lock en
    # Whisper confidently detects French → out of set → keep the lock (§7)
    assert r.resolve("bonjour", signal=("fr", 0.99)) == "en"


def test_low_confidence_acoustic_holds_lock():
    r = LanguageResolver()
    r.resolve("hello there friend", signal=("en", 0.96))  # lock en
    # a weak opposite acoustic probe (short/noisy clip) must not flip it
    assert r.resolve("...", signal=("de", 0.3)) == "en"


def test_text_fallback_when_no_signal():
    # No acoustic signal (typed input) → classify from the text itself (§8.3).
    r = LanguageResolver()
    assert r.resolve("Ich habe heute keine Motivation") == "de"


# ─────────────────────────── reset ───────────────────────────

def test_reset_clears_session_lock():
    r = LanguageResolver(default="en")
    r.resolve("Ich bin müde und total erschöpft heute")  # lock de
    assert r.locked == "de"
    r.reset()
    assert r.locked is None
    # after reset, the default applies again on an ambiguous first turn
    assert r.resolve("...") == "en"


def test_reset_preserves_config():
    r = LanguageResolver(default="en")
    r.apply_config({"switch_threshold": 0.85})
    r.resolve("Ich bin total müde")
    r.reset()
    assert r.switch_threshold == 0.85  # config survives reset


# ─────────────────────── confidence-gated switch ───────────────────────

def test_switches_on_sustained_confident_change():
    r = LanguageResolver()
    r.resolve("Ich habe heute echt keine Motivation")  # lock de
    en_turn = "Actually I would prefer to continue in English now"
    for _ in range(3):
        got = r.resolve(en_turn)
    assert got == "en"


def test_switch_requires_high_confidence():
    # switch_threshold (0.6) is higher than detect_threshold (0.4): a weak
    # opposite-language signal (one short word) does not switch a locked session.
    r = LanguageResolver()
    r.resolve("I have been running a lot this week")  # lock en
    assert r.resolve("der") == "en"


def test_debounce_requires_consecutive_detections():
    r = LanguageResolver(debounce=2)
    r.resolve("I have been running a lot this week")  # lock en
    assert r.resolve("Ich bin heute echt total müde und erschöpft") == "en"  # 1st
    assert r.resolve("Ich möchte wirklich auf Deutsch weitermachen bitte") == "de"  # 2nd


def test_debounce_resets_on_weak_opposite_signal():
    # A weak/ambiguous opposite signal BETWEEN two confident German turns must
    # reset the pending switch — "sustained" means CONSECUTIVE, so the two
    # confident turns must not accumulate across the gap (finding #3).
    r = LanguageResolver(debounce=2)
    r.resolve("I have been running a lot this week")  # lock en
    # NOTE: the interleaved turn must now be long enough to count as evidence
    # at all. Turns below the length gate are neutral — they neither advance a
    # pending switch nor reset one (see test_short_turns_do_not_cancel...).
    assert r.resolve("also ich laufe ziemlich viel", signal=("de", 0.95)) == "en"  # pending de = 1
    assert r.resolve("also ich laufe ziemlich viel", signal=("de", 0.50)) == "en"  # weak de < switch → reset
    assert r.resolve("also ich laufe ziemlich viel", signal=("de", 0.95)) == "en"  # pending de = 1 again, no flip
    assert r.resolve("also ich laufe ziemlich viel", signal=("de", 0.95)) == "de"  # now 2 consecutive → switch


# ─────────────────────── clamp to supported set ───────────────────────

def test_unsupported_language_does_not_win():
    r = LanguageResolver(supported=("en", "de"))
    r.resolve("Ich habe heute keine Zeit für das alles")  # lock de
    # Out-of-set input must keep the existing lock, never break TTS (RFC §7).
    assert r.resolve("bonjour tout le monde comment allez vous") == "de"


def test_seed_outside_supported_is_ignored():
    r = LanguageResolver(supported=("en", "de"), default="en")
    r.set_seed("fr")
    assert r.resolve("...") == "en"


# ─────────────────────────── apply_config ───────────────────────────

def test_apply_config_overrides_default_and_thresholds():
    r = LanguageResolver()
    r.apply_config({
        "supported": ["en", "de"],
        "default": "en",
        "detect_threshold": 0.5,
        "switch_threshold": 0.8,
        "debounce": 3,
    })
    assert r.default == "en"
    assert r.detect_threshold == 0.5
    assert r.switch_threshold == 0.8
    assert r.debounce == 3
    # default now takes effect on an ambiguous first turn
    assert r.resolve("...") == "en"


def test_apply_config_partial_keeps_other_defaults():
    r = LanguageResolver(default="de", switch_threshold=0.6)
    r.apply_config({"switch_threshold": 0.75})
    assert r.switch_threshold == 0.75
    assert r.default == "de"  # untouched


def test_apply_config_ignores_unknown_and_empty():
    r = LanguageResolver()
    r.apply_config({"nonsense": 1, "supported": []})
    assert r.supported == {"de", "en"}  # empty supported list ignored


# ─────────────────────────── helpers ───────────────────────────

@pytest.mark.parametrize("code,expected", [
    ("de", "German"),
    ("en", "English"),
    ("auto", "the user's language"),
    (None, "the user's language"),
])
def test_language_name(code, expected):
    assert language_name(code) == expected


# ─────────────────── deployment language pin (STELLA_LANGUAGE) ───────────────────
# The operator picks a language at deploy time; that deployment must then answer
# in it even when the first utterance is short or garbled — the case auto-detect
# cannot serve, because it needs a long enough utterance to be confident.

def test_forced_language_reads_env(monkeypatch):
    monkeypatch.setenv(FORCE_LANGUAGE_ENV, "de")
    assert forced_language() == "de"


@pytest.mark.parametrize("value", ["", "   ", "auto", "AUTO"])
def test_forced_language_absent_or_auto_means_autodetect(monkeypatch, value):
    monkeypatch.setenv(FORCE_LANGUAGE_ENV, value)
    assert forced_language() is None


def test_pin_wins_on_garbled_first_turn():
    """The endgoal: a short/garbled first message still answers in the pin."""
    r = LanguageResolver(forced="de")
    assert r.resolve("42 ok") == "de"   # no signal at all
    assert r.resolve("") == "de"
    # ...and a sub-2s utterance arriving with no acoustic signal (RFC §4 floor).
    assert r.resolve("mm", signal=None) == "de"


def test_pin_ignores_confident_opposite_detection():
    r = LanguageResolver(forced="de")
    assert r.resolve("I have been running three times a week") == "de"
    # Even a sustained, maximally confident English signal cannot flip a pin.
    for _ in range(5):
        assert r.resolve("This is clearly English", signal=("en", 1.0)) == "de"


def test_pin_outranks_plan_seed():
    r = LanguageResolver(forced="de")
    r.set_seed("en")
    assert r.resolve("hello there") == "de"


def test_pin_survives_session_reset():
    r = LanguageResolver(forced="de")
    r.resolve("hallo")
    r.reset()
    assert r.locked == "de"
    assert r.resolve("äh") == "de"


def test_unsupported_pin_falls_back_to_autodetect():
    r = LanguageResolver(forced="fr")
    assert r.forced is None
    # Clearing the pin leaves the previously-pinned language as a confirmed
    # lock, so switching away from it now needs sustained evidence like any
    # other change.
    for _ in range(3):
        got = r.resolve("I have been running three times a week")
    assert got == "en"


def test_pin_honored_after_config_widens_supported_set():
    r = LanguageResolver(forced="fr")
    assert r.forced is None  # rejected against the default en/de set
    r.apply_config({"supported": ["en", "de", "fr"]})
    assert r.forced == "fr"
    assert r.resolve("whatever") == "fr"


def test_pin_from_env_needs_no_wiring(monkeypatch):
    """Both agents construct LanguageResolver() bare — the env must reach it."""
    monkeypatch.setenv(FORCE_LANGUAGE_ENV, "de")
    r = LanguageResolver()
    assert r.resolve("42 ok") == "de"


def test_auto_still_falls_back_to_english(monkeypatch):
    """Unpinned + undetectable is the ONLY case that falls back to the default."""
    monkeypatch.delenv(FORCE_LANGUAGE_ENV, raising=False)
    r = LanguageResolver()
    assert detect_language("42 ok") == (None, 0.0)  # genuinely no signal
    assert r.resolve("42 ok") == "en"


def test_apply_config_force_key_pins():
    r = LanguageResolver()
    r.apply_config({"force": "de"})
    assert r.resolve("hello there") == "de"


def test_apply_config_force_auto_clears_pin():
    r = LanguageResolver(forced="de")
    r.apply_config({"force": "auto"})
    assert r.forced is None
    # Clearing the pin leaves the previously-pinned language as a confirmed
    # lock, so switching away from it now needs sustained evidence like any
    # other change.
    for _ in range(3):
        got = r.resolve("I have been running three times a week")
    assert got == "en"


# ---------------------------------------------------------------------------
# Lock the language in, then hold it (production 2026-08-25).
#
# debounce was 1, so a single confident detection flipped the conversation
# mid-stream. STT is least reliable on exactly the turns carrying the least
# language signal — short acknowledgements — so one vote was far too cheap:
# a German session had "Nicht so." and "Y'all." come back from Whisper as
# English.
# ---------------------------------------------------------------------------

def _resolver(**kw):
    from stella_agent_sdk.language import LanguageResolver
    kw.setdefault("supported", ["en", "de"])
    kw.setdefault("default", "en")
    return LanguageResolver(**kw)


def test_first_confident_detection_locks_in():
    r = _resolver()
    assert r.resolve("Hallo, wie geht es dir heute so?", signal=("de", 0.95)) == "de"


def test_one_confident_turn_no_longer_flips_the_lock():
    r = _resolver()
    r.resolve("Hallo, ich heisse Felix und komme aus Zuerich", signal=("de", 0.95))
    got = r.resolve("I think that is quite interesting actually", signal=("en", 0.95))
    assert got == "de", "a single turn must not switch a confirmed lock"


def test_a_sustained_switch_is_still_honoured():
    r = _resolver()
    r.resolve("Hallo, ich heisse Felix und komme aus Zuerich", signal=("de", 0.95))
    for _ in range(3):
        got = r.resolve("I would much rather keep talking in English now",
                        signal=("en", 0.95))
    assert got == "en", "sustained, substantial evidence must still switch"


def test_short_acknowledgements_cannot_vote():
    # The actual production failure: brief turns mis-transcribed by STT.
    r = _resolver()
    r.resolve("Hallo, ich heisse Felix und komme aus Zuerich", signal=("de", 0.95))
    for text in ("Y'all.", "Okay.", "Yeah.", "Nicht so.", "Sure."):
        assert r.resolve(text, signal=("en", 0.99)) == "de", text


def test_short_turns_do_not_cancel_a_real_switch_either():
    # They are not evidence in either direction, so an interleaved "okay"
    # must not reset a genuine, sustained switch back to zero.
    r = _resolver()
    r.resolve("Hallo, ich heisse Felix und komme aus Zuerich", signal=("de", 0.95))
    long_en = "I would honestly prefer to continue this conversation in English"
    r.resolve(long_en, signal=("en", 0.95))
    r.resolve("Okay.", signal=("en", 0.99))
    r.resolve(long_en, signal=("en", 0.95))
    assert r.resolve(long_en, signal=("en", 0.95)) == "en"


def test_a_pinned_deployment_never_switches():
    r = _resolver(forced="de")
    assert r.resolve("I would much rather speak English from now on please",
                     signal=("en", 0.99)) == "de"
