"""Tests for bridge mode selection and the single LLM bridge path.

The hand-written phrase inventories are gone — they could only cover the two
languages someone had written lists for, repeated inside a session, and never
referred to anything the user had said. There is one LLM bridge now, and the
mode tells it what this turn needs.
"""

import os

import pytest
import yaml

from stella_v2_agent.pipeline.bridge_generator import (
    BridgeGenerator,
    select_bridge_mode,
    _turn_length,
    BRIDGE_MODE_BRIEF,
    BRIDGE_MODE_FULL,
    BRIDGE_MODE_THINKING,
    _MODE_DIRECTIVES,
    _MODE_MAX_TOKENS,
    _gate_stream,
    _is_echo,
)
from stella_agent_sdk.llm import LLMResponse
from stella_v2_agent.prompts.template import render_prompt


# An ordinary turn: long enough not to be a bare beat, short enough not to be
# "substantial" — i.e. it selects BRIDGE_MODE_FULL on a fresh turn.
_ORDINARY_TURN = "I run three times a week"


class _FakeStreamingLLM:
    """Streams ``text`` token-by-token via callback.on_token(token, accumulated),
    then on_complete — mimicking the real streaming LLM service for the bridge."""

    def __init__(self, text: str):
        self.text = text
        self.called = False

    async def generate(self, messages, config, callback, component_name="unknown"):
        self.called = True
        acc = ""
        for tok in self.text.split(" "):
            piece = (" " if acc else "") + tok
            acc += piece
            await callback.on_token(piece, acc)
        resp = LLMResponse(content=acc, model="t", provider="t")
        await callback.on_complete(resp)
        return resp


async def _drain(agen):
    return [x async for x in agen]


def _iter_dicts(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _iter_dicts(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_dicts(v)


def _slot_default(node_id: str, slot_id: str) -> str:
    """Read a configurator slot's default from agent.yaml — the prompt that
    actually runs in production (code prompts are only minimal fallbacks)."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(here, "agent.yaml")) as f:
        cfg = yaml.safe_load(f)
    for d in _iter_dicts(cfg):
        if d.get("id") == node_id and isinstance(d.get("slots"), list):
            for slot in d["slots"]:
                if slot.get("id") == slot_id:
                    return slot.get("default", "")
    raise AssertionError(f"{node_id}.{slot_id} not found in agent.yaml")


class TestSelectBridgeMode:
    def test_a_bare_turn_gets_a_beat(self):
        # There is nothing in "yeah" worth receiving in full — mirroring it back
        # is the empty acknowledgement the guidelines forbid.
        assert select_bridge_mode("yeah") == BRIDGE_MODE_BRIEF
        assert select_bridge_mode("twice a week") == BRIDGE_MODE_BRIEF

    def test_a_greeting_gets_a_beat(self):
        # No greeting-detection word list any more: a greeting is simply a very
        # short turn, and the LLM greets back in whatever language they used.
        assert select_bridge_mode("hi") == BRIDGE_MODE_BRIEF
        assert select_bridge_mode("hallo") == BRIDGE_MODE_BRIEF
        assert select_bridge_mode("bonjour") == BRIDGE_MODE_BRIEF

    def test_a_question_takes_a_visible_moment(self):
        assert select_bridge_mode("What should I eat to lose weight?") == BRIDGE_MODE_THINKING

    def test_a_long_turn_takes_a_visible_moment(self):
        assert select_bridge_mode(" ".join(["word"] * 30)) == BRIDGE_MODE_THINKING

    def test_an_ordinary_answer_is_received_in_full(self):
        assert select_bridge_mode(_ORDINARY_TURN) == BRIDGE_MODE_FULL


class TestTurnLengthAcrossScripts:
    """Mode selection is driven by how much the user said, so the length measure
    has to work in every language the agent can speak — not just the ones that
    put spaces between words.

    Whitespace splitting returns 1 for an entire Chinese or Japanese sentence.
    That made every CJK turn look bare, so every CJK turn got a two-word beat
    and a personal disclosure was brushed off with one — the exact failure the
    substantial threshold exists to prevent, total for those languages.
    """

    _DISCLOSURES = {
        "en": "Honestly I have been forcing myself through every single workout lately and it feels like a chore",
        "de": "Ehrlich gesagt quäle ich mich in letzter Zeit durch jedes Training und es fühlt sich an wie eine Pflicht",
        "fr": "Honnêtement je me force à faire chaque séance en ce moment et ça ressemble à une corvée pénible",
        "es": "La verdad es que últimamente me obligo a hacer cada entrenamiento y se siente como una tarea pesada",
        "zh": "老实说我最近每次锻炼都是强迫自己完成的感觉就像一件苦差事我不想再继续下去了",
        "ja": "正直なところ最近はどのトレーニングも自分を無理やり奮い立たせてやっていて雑用のように感じています",
        "th": "จริงๆแล้วช่วงนี้ผมต้องฝืนใจตัวเองทุกครั้งที่ออกกำลังกายมันรู้สึกเหมือนเป็นภาระ",
    }

    @pytest.mark.parametrize("lang", sorted(_DISCLOSURES))
    def test_a_disclosure_is_substantial_in_every_script(self, lang):
        text = self._DISCLOSURES[lang]
        assert _turn_length(text) >= 12, lang
        # Never a bare beat, and never demoted even after a full reception.
        assert select_bridge_mode(text) != BRIDGE_MODE_BRIEF, lang
        assert select_bridge_mode(text, previous_mode=BRIDGE_MODE_FULL) != BRIDGE_MODE_BRIEF, lang

    @pytest.mark.parametrize("text", ["是的", "うん", "ครับ", "yeah", "ja"])
    def test_a_bare_turn_is_still_bare_in_every_script(self, text):
        assert select_bridge_mode(text) == BRIDGE_MODE_BRIEF

    def test_korean_is_treated_as_space_delimited(self):
        # Hangul IS written with spaces, so whitespace splitting already works
        # and must not be double-counted as a dense script.
        assert _turn_length("네 맞아요") == 2

    def test_mixed_script_is_not_undercounted(self):
        # Code-switching is common in speech; take the larger of the two measures.
        assert _turn_length("老实说我really不想再继续下去了") > 2

    def test_empty_input_is_zero(self):
        assert _turn_length("") == 0
        assert _turn_length("   ") == 0


class TestAntiLockstep:
    """The bridge must not perform a full reception on every consecutive turn —
    that lockstep is what the conversation guidelines call a questionnaire."""

    def test_full_reception_is_not_repeated_back_to_back(self):
        first = select_bridge_mode(_ORDINARY_TURN)
        assert first == BRIDGE_MODE_FULL
        assert select_bridge_mode(
            "mostly in the evenings after work", previous_mode=first
        ) == BRIDGE_MODE_BRIEF

    def test_substantial_turn_is_exempt(self):
        assert select_bridge_mode(
            " ".join(["word"] * 30), previous_mode=BRIDGE_MODE_FULL
        ) == BRIDGE_MODE_THINKING

    def test_a_question_is_exempt_too(self):
        assert select_bridge_mode(
            "so what should I do?", previous_mode=BRIDGE_MODE_THINKING
        ) == BRIDGE_MODE_THINKING

    def test_a_personal_disclosure_is_never_demoted_to_a_beat(self):
        """The worst failure this selector could have.

        A disclosure is emotionally substantial long before it is long enough to
        look computationally heavy, so the anti-lockstep exemption uses its own
        (much lower) threshold. Answering someone opening up with a two-word
        beat, because the previous turn happened to get a full reception, would
        be far worse than the lockstep the rule exists to prevent.
        """
        disclosure = (
            "Honestly I've been forcing myself through every single workout "
            "lately and it just feels like a chore I can't get out of"
        )
        assert len(disclosure.split()) < 25  # under the thinking threshold
        assert select_bridge_mode(
            disclosure, previous_mode=BRIDGE_MODE_FULL
        ) == BRIDGE_MODE_FULL

    def test_alternates_rather_than_ticking(self):
        seen, prev = [], None
        for _ in range(4):
            prev = select_bridge_mode(_ORDINARY_TURN, previous_mode=prev)
            seen.append(prev)
        assert seen == [
            BRIDGE_MODE_FULL, BRIDGE_MODE_BRIEF,
            BRIDGE_MODE_FULL, BRIDGE_MODE_BRIEF,
        ]

    def test_first_turn_of_a_session_is_never_demoted(self):
        assert select_bridge_mode(_ORDINARY_TURN, previous_mode=None) == BRIDGE_MODE_FULL


class TestModeDirectives:
    def test_every_mode_has_a_directive(self):
        for mode in (BRIDGE_MODE_BRIEF, BRIDGE_MODE_FULL, BRIDGE_MODE_THINKING):
            assert _MODE_DIRECTIVES[mode].strip()

    def test_a_beat_is_capped_hard(self):
        # With no instant template left, the token cap is what keeps a bare beat
        # inside the turn-taking gap.
        assert _MODE_MAX_TOKENS[BRIDGE_MODE_BRIEF] <= 16

    def test_a_full_reception_is_not_capped(self):
        # Its whole job is to be substantial, so it uses the configured budget.
        assert BRIDGE_MODE_FULL not in _MODE_MAX_TOKENS

    def test_directives_never_invite_a_question(self):
        for mode, text in _MODE_DIRECTIVES.items():
            assert "?" not in text, mode


class TestNoAssessmentBeforeDispreferred:
    """A2 acceptance: the bridge can never appraise ahead of a dispreferred answer.

    The guarantee has moved twice. It was structural (no "assessment" phrase
    inventory existed), then briefly a hardcoded English/German opener list, and
    is now where it belongs: the bridge is UNCONDITIONALLY told never to
    evaluate, and the only stage permitted to appraise is the one that runs
    after the experts and is handed the tone.
    """

    def test_selection_never_returns_an_assessment_mode(self):
        for inp in ["hi", "I feel terrible", "no", "What now?", "x " * 40]:
            assert select_bridge_mode(inp) in {
                BRIDGE_MODE_BRIEF, BRIDGE_MODE_FULL, BRIDGE_MODE_THINKING,
            }

    def test_no_directive_asks_the_bridge_to_evaluate(self):
        banned = ("evaluate", "praise", "compliment", "assess")
        for mode, text in _MODE_DIRECTIVES.items():
            low = text.lower()
            for word in banned:
                if word in low:
                    assert "do not" in low or "don't" in low or "never" in low, (mode, word)

    def test_the_bridge_has_no_appraisal_switch_left(self):
        # Nothing a stored config or env var can set turns evaluation back on.
        gen = BridgeGenerator(llm_service=None)
        assert not hasattr(gen, "appraisal_enabled")
        gen.apply_config({"appraisal": "on"})
        assert not hasattr(gen, "appraisal_enabled")


class TestApplyConfig:
    """Bridge knobs are controlled via the Agent Configurator (apply_config)."""

    def test_unknown_knobs_are_ignored(self):
        # fast_path / allow_silence / appraisal were all removed; a stored config
        # that still carries them must not blow up an agent on startup.
        gen = BridgeGenerator(llm_service=None)
        gen.apply_config({"fast_path": "on", "allow_silence": "on", "appraisal": "on"})
        assert gen.bridge_model  # still constructed and usable

    def test_timeout_ms_overrides_env_default(self):
        gen = BridgeGenerator(llm_service=None)
        gen.apply_config({"timeout_ms": 1500})
        assert gen.bridge_timeout_s == 1.5

    def test_blank_timeout_is_ignored(self):
        gen = BridgeGenerator(llm_service=None)
        before = gen.bridge_timeout_s
        gen.apply_config({"timeout_ms": ""})
        assert gen.bridge_timeout_s == before

    def test_other_knobs_still_apply(self):
        gen = BridgeGenerator(llm_service=None)
        gen.apply_config({"model": "gpt-4o", "temperature": 0.2, "max_tokens": 40})
        assert gen.bridge_model == "gpt-4o"
        assert gen.bridge_temperature == 0.2
        assert gen.bridge_max_tokens == 40


def _validate_whole(raw):
    """Whole-string validation via the gate that actually runs in production."""
    return _gate_stream(raw, final=True)[0]


class TestValidateBridgeLength:
    """The bridge now carries the full reaction (up to ~35 words / 2-3 short
    sentences), so a fuller reflective opener must pass while runaway output is
    still rejected. A richer bridge speaks longer and covers more of the gap."""

    def test_fuller_reflective_bridge_within_35_words_passes(self):
        # The empathetic two-sentence opener that should land in the BRIDGE (not
        # be deferred into the main reply, leaving an awkward gap).
        bridge = (
            "Okay, I hear you. Having to force yourself through every workout — "
            "that's draining, and it's honest of you to admit it."
        )
        assert len(bridge.split()) <= 35
        assert _validate_whole(bridge) == bridge

    def test_thirty_word_bridge_passes(self):
        bridge = " ".join(["word"] * 30) + "."
        assert _validate_whole(bridge) == bridge

    def test_over_35_words_rejected(self):
        bridge = " ".join(["word"] * 36) + "."
        assert _validate_whole(bridge) == ""


class TestBridgeNeverAppraises:
    """The bridge runs BEFORE the experts, so it cannot know whether the user
    just disclosed something difficult. It is therefore never permitted to
    evaluate — unconditionally, with no tier to switch on.

    This used to be an opt-in tier guarded by a word-list risk screen. The screen
    was guessing at information that arrives ~200ms later in the same turn, and
    could only guess in English and German.
    """

    def test_the_ban_is_unconditional(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        assert "Do NOT evaluate or praise what they said" in prompt
        # No conditional at all — nothing can turn the ban off.
        assert "allowAppraisal" not in prompt
        assert render_prompt(prompt, {}) == render_prompt(prompt, {"allowAppraisal": True})

    def test_reflection_is_still_explicitly_allowed(self):
        # Naming what you hear is the bridge's job; only judging is banned.
        prompt = _slot_default("bridge_generator", "system_prompt")
        assert "Naming what you hear in it" in prompt
        assert "judging it is not" in prompt

    def test_appraisal_moved_to_the_stage_that_knows_the_tone(self):
        guidelines = _slot_default("response_generator", "conversation_guidelines")
        assert "Appraising their SITUATION" in guidelines
        assert "cautious tone, do not appraise" in guidelines


class TestConfigCarriesTheImprovements:
    """The voice improvements must live in agent.yaml (user-editable), not be
    hidden in code — these guard that the config screen is the source of truth."""

    def test_yaml_guidelines_forbid_empty_praise(self):
        guidelines = _slot_default("response_generator", "conversation_guidelines")
        assert "NEVER praise a mundane answer" in guidelines

    def test_yaml_bridge_carries_the_standing_rules(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        assert "never ask a question" in prompt
        # React in your own words — the "mirror their words" rule that produced
        # verbatim echoes in production is gone and must stay gone.
        assert "React to the specific thing they said" in prompt
        assert "in YOUR words, not theirs" in prompt
        # The repetition guard that replaced inventory randomisation: the LLM can
        # see what it already said, which a fixed phrase pool never could.
        assert "Do not reuse an opener you have already used" in prompt

    def test_yaml_bridge_exposes_the_per_turn_mode(self):
        # How long/full this turn's beat should be is per-turn, not baked into
        # the prompt — the mode directive carries it.
        assert "{{bridgeMode}}" in _slot_default("bridge_generator", "system_prompt")

    def test_yaml_bridge_prompt_matches_the_code_default(self):
        # agent.yaml is what actually runs; the code constant is the fallback.
        # They drifted before, so pin them together.
        from stella_v2_agent.pipeline.bridge_generator import BRIDGE_SYSTEM_PROMPT
        assert _slot_default("bridge_generator", "system_prompt").strip() == BRIDGE_SYSTEM_PROMPT.strip()



class TestNoEcho:
    """The bridge must never hand the user their own words back.

    Observed in production 2026-08-25, from a prompt that said "Mirror the
    SPECIFIC thing they said, their words and their numbers":

        user: "I don't know"     bridge: "I don't know."
        user: "no, not reallyy"  bridge: "not really."

    An echo is not acknowledgement. On a negative it reads as mockery, and
    everywhere else as a machine with nothing of its own to add. The prompt no
    longer asks for a mirror; this is the structural backstop, and it compares
    the two strings' own tokens so it holds in any language.
    """

    ECHOES = [
        ("no, not reallyy", "not really."),            # the real failure
        ("I don't know", "I don't know."),             # the other real failure
        ("my name is Felix", "Felix."),
        ("Ich laufe dreimal die Woche", "Dreimal die Woche."),
        ("是的", "是的。"),
    ]

    REACTIONS = [
        ("no, not reallyy", "Fair enough."),
        ("I don't know", "Okay, no worries."),
        ("my name is Felix", "Felix, good to meet you."),
        ("I run three times a week", "Three times a week is a real habit."),
        ("Ich laufe dreimal die Woche", "Alles klar, verstehe."),
        ("twice a week", "Twice a week, got it."),
        ("I hurt my knee", "Ah, that's rough."),
        ("nothing much", "Okay."),
    ]

    @pytest.mark.parametrize("user,bridge", ECHOES)
    def test_echo_is_detected(self, user, bridge):
        assert _is_echo(bridge, user) is True

    @pytest.mark.parametrize("user,bridge", REACTIONS)
    def test_real_reaction_is_not_an_echo(self, user, bridge):
        assert _is_echo(bridge, user) is False

    def test_stt_noise_does_not_defeat_it(self):
        # The user's turn comes from STT, so it carries transcription noise the
        # bridge will not reproduce. An exact-token check missed the real case
        # on a single duplicated letter.
        assert _is_echo("not really.", "no, not reallyy") is True

    def test_a_long_reception_may_reuse_their_words(self):
        # Only short bridges are checked; a real reaction that quotes a detail
        # while adding something of its own must pass.
        assert _is_echo("Three times a week, that's a real habit forming.",
                        "I run three times a week") is False

    def test_the_gate_drops_an_echo_entirely(self):
        accepted, stop = _gate_stream("I don't know.", final=True, user_input="I don't know")
        assert accepted == ""
        assert stop is True

    def test_the_gate_keeps_a_real_reaction(self):
        accepted, _ = _gate_stream("Fair enough.", final=True, user_input="no, not really")
        assert accepted == "Fair enough."

    def test_no_user_input_means_no_echo_check(self):
        # Barge-in and other paths may not supply it; must not crash or over-block.
        assert _gate_stream("Okay.", final=True)[0] == "Okay."


class TestPromptNoLongerAsksForAMirror:
    def test_standing_rules_forbid_repeating_the_user(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        assert "NEVER say the user's own words back to them" in prompt
        # The instruction that caused it must be gone.
        assert "Mirror the SPECIFIC thing they said" not in prompt

    def test_no_mode_asks_for_a_mirror(self):
        for mode, text in _MODE_DIRECTIVES.items():
            assert "mirror the specific" not in text.lower(), mode

    def test_full_mode_no_longer_asks_for_length(self):
        # "Lean long rather than short" pushed it toward padding, and padding is
        # what restating the user's turn is.
        assert "lean long" not in _MODE_DIRECTIVES[BRIDGE_MODE_FULL].lower()


class TestGateStream:
    """The sentence-gated streaming validator (_gate_stream) keeps the bridge's
    guarantees per completed sentence so TTS can start before it's finished."""

    def test_releases_only_complete_sentences(self):
        # Trailing incomplete text is held back (never speak half a sentence).
        out, stop = _gate_stream("Okay, I hear you. That sounds", final=False)
        assert out == "Okay, I hear you."
        assert stop is False

    def test_final_flushes_remainder_with_terminal_punctuation(self):
        out, stop = _gate_stream("Okay, I hear you. That sounds draining", final=True)
        assert out == "Okay, I hear you. That sounds draining."

    def test_question_sentence_is_dropped_and_stops(self):
        out, stop = _gate_stream("Okay, got it. So what do you enjoy?", final=True)
        assert out == "Okay, got it."
        assert stop is True

    def test_question_only_yields_nothing(self):
        out, stop = _gate_stream("What do you enjoy?", final=True)
        assert out == ""
        assert stop is True

    def test_word_cap_stops_before_overrun(self):
        out, stop = _gate_stream(" ".join(["word"] * 40) + ".", final=True)
        assert out == ""
        assert stop is True

    def test_evaluative_opener_allowed_under_appraisal(self):
        out, stop = _gate_stream("That's a great routine.", final=True)
        assert out == "That's a great routine."
        assert stop is False


class TestGenerateStream:
    """End-to-end streaming through a fake LLM: accumulated chunks, guardrails,
    and safe fallbacks — the path agent.py drives for early sentence-level TTS."""

    @pytest.mark.asyncio
    async def test_streams_multi_sentence_bridge_incrementally(self):
        gen = BridgeGenerator(llm_service=_FakeStreamingLLM("Okay, I hear you. That sounds really draining."))
        gen.bridge_timeout_s = 5.0
        out = await _drain(gen.generate_stream("I force myself to work out", [], language="en"))
        # First emit is just the opening sentence; final is the whole bridge.
        assert out[0] == "Okay, I hear you."
        assert out[-1] == "Okay, I hear you. That sounds really draining."
        # Each chunk is the full accumulated text so far (monotonic prefixes).
        assert all(out[-1].startswith(chunk) for chunk in out)

    @pytest.mark.asyncio
    async def test_a_question_only_bridge_is_silent_not_canned(self):
        """A bridge must never ask a question, and there is no longer a canned
        phrase to fall back on — so the turn simply says nothing and the reply
        carries the reaction instead. Better a missing opener than a stock one
        that would fit any answer."""
        gen = BridgeGenerator(llm_service=_FakeStreamingLLM("What do you enjoy doing?"))
        gen.bridge_timeout_s = 5.0
        out = await _drain(gen.generate_stream(_ORDINARY_TURN, [], language="en"))
        assert out == []

    @pytest.mark.asyncio
    async def test_llm_failure_is_silent_not_canned(self):
        class _Boom:
            async def generate(self, *a, **kw):
                raise RuntimeError("provider down")

        gen = BridgeGenerator(llm_service=_Boom())
        gen.bridge_timeout_s = 5.0
        out = await _drain(gen.generate_stream(_ORDINARY_TURN, [], language="en"))
        assert out == []

    @pytest.mark.asyncio
    async def test_generate_delegates_and_returns_final_accumulated(self):
        gen = BridgeGenerator(llm_service=_FakeStreamingLLM("Right, that makes sense. Thanks for sharing."))
        gen.bridge_timeout_s = 5.0
        full = await gen.generate(_ORDINARY_TURN, [], language="en")
        assert full == "Right, that makes sense. Thanks for sharing."
