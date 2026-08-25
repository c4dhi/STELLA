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
    BRIDGE_MODE_BRIEF,
    BRIDGE_MODE_FULL,
    BRIDGE_MODE_THINKING,
    _MODE_DIRECTIVES,
    _MODE_MAX_TOKENS,
    _screen_risk,
    _gate_stream,
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
    """A2 acceptance: the bridge can never open with an evaluative token.

    This used to be guaranteed structurally, by there being no "assessment"
    phrase inventory. The inventories are gone, so the guarantee now rests
    entirely on _gate_stream rejecting evaluative openers and on no mode
    directive ever asking for one — which is what these pin.
    """

    _ASSESSMENT_OPENERS = (
        "That's great.", "That's a good question.", "What a good point.",
        "Wow, amazing.", "Perfect, thanks.", "Good point.", "Well done.",
        "Toll, super.", "Interessant.", "Sehr gut.",
    )

    # Naming the feeling or effort heard is reflection, which the bridge is
    # explicitly meant to do. Widening the opener list must not swallow these.
    _REFLECTIONS = (
        "That's draining, honestly.", "Okay, I hear you.",
        "Right, twice a week.", "Das klingt anstrengend.", "Ja, verstehe.",
    )

    def test_gate_rejects_every_assessment_opener(self):
        for opener in self._ASSESSMENT_OPENERS:
            accepted, stop = _gate_stream(opener, False, final=True)
            assert accepted == "", opener
            assert stop is True, opener

    def test_reflection_is_not_mistaken_for_assessment(self):
        for text in self._REFLECTIONS:
            accepted, stop = _gate_stream(text, False, final=True)
            assert accepted == text, text
            assert stop is False, text

    def test_selection_never_returns_an_assessment_mode(self):
        # Whatever the input, the mode is one of the three declared. There is no
        # assessment mode to select at all.
        for inp in ["hi", "I feel terrible", "no", "What now?", "x " * 40]:
            assert select_bridge_mode(inp) in {
                BRIDGE_MODE_BRIEF, BRIDGE_MODE_FULL, BRIDGE_MODE_THINKING,
            }

    def test_no_directive_asks_the_bridge_to_evaluate(self):
        banned = ("evaluate", "praise", "compliment", "assess")
        for mode, text in _MODE_DIRECTIVES.items():
            low = text.lower()
            for word in banned:
                # "do not evaluate" is fine; asking for evaluation is not.
                if word in low:
                    assert "do not" in low or "don't" in low or "never" in low, (mode, word)


class TestApplyConfig:
    """Bridge knobs are controlled via the Agent Configurator (apply_config)."""

    def test_appraisal_from_select_string(self):
        gen = BridgeGenerator(llm_service=None)
        # The configurator select sends "on"/"off" strings — bool("off") is True,
        # so this must be parsed, not cast.
        gen.apply_config({"appraisal": "on"})
        assert gen.appraisal_enabled is True
        gen.apply_config({"appraisal": "off"})
        assert gen.appraisal_enabled is False

    def test_unknown_knobs_are_ignored(self):
        # fast_path / allow_silence were removed; a stored config that still
        # carries them must not blow up an agent on startup.
        gen = BridgeGenerator(llm_service=None)
        gen.apply_config({"fast_path": "on", "allow_silence": "on"})
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


class TestAppraisalRiskScreen:
    """The cheap, deterministic screen that gates the appraisal tier (#343)."""

    @pytest.mark.parametrize("text", [
        "I hurt my knee last month",
        "I've been really depressed lately",
        "No, not really, I've been pretty lazy",
        "Ich hab mir das Knie verletzt",
        "Ich war ziemlich faul",
        "I haven't been doing much",
        "my dad died last week",
        "I might need a lawyer for this",
    ])
    def test_sensitive_or_dispreferred_trips_screen(self, text):
        assert _screen_risk(text) is True

    @pytest.mark.parametrize("text", [
        "I've been running three times a week",
        "I usually work out in the mornings",
        "Ich laufe dreimal die Woche",
        "I want to get stronger and feel better",
    ])
    def test_benign_clears_screen(self, text):
        assert _screen_risk(text) is False


def _validate_whole(raw, allow_appraisal=False):
    """Whole-string validation via the gate that actually runs in production.

    These invariants used to be asserted against BridgeGenerator._validate_bridge,
    a second validator kept for a non-streaming path that no longer existed. It
    has been removed, so they are asserted against _gate_stream(final=True) —
    the code the streaming bridge really passes through.
    """
    return _gate_stream(raw, allow_appraisal, final=True)[0]


class TestValidateBridgeAppraisalGate:
    """Evaluative openers are rejected by default, allowed only under the gate."""

    def test_evaluative_opener_rejected_by_default(self):
        assert _validate_whole("That's a good amount to work with.") == ""

    def test_evaluative_opener_allowed_when_appraisal(self):
        out = _validate_whole(
            "That's a good amount to work with.", allow_appraisal=True
        )
        assert out == "That's a good amount to work with."

    def test_question_still_rejected_even_with_appraisal(self):
        # The appraisal gate must NOT relax the no-questions rule.
        assert _validate_whole("That's good, right?", allow_appraisal=True) == ""


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


class TestAppraisalConfig:
    def test_appraisal_defaults_off(self):
        gen = BridgeGenerator(llm_service=None)
        assert gen.appraisal_enabled is False

    def test_appraisal_toggle_from_select_string(self):
        gen = BridgeGenerator(llm_service=None)
        gen.apply_config({"appraisal": "on"})
        assert gen.appraisal_enabled is True
        gen.apply_config({"appraisal": "off"})
        assert gen.appraisal_enabled is False


class TestBridgePromptRendering:
    """The appraisal permission/ban is wired through the PRODUCTION (agent.yaml)
    bridge prompt via the template conditionals — not the code fallback."""

    _BAN = "Do NOT evaluate what they said"
    _PERMISSION = "You MAY add a brief, understated appraisal"

    def test_ban_present_when_appraisal_off(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        rendered = render_prompt(prompt, {"allowAppraisal": False})
        assert self._BAN in rendered
        assert self._PERMISSION not in rendered

    def test_ban_dropped_and_permission_added_when_appraisal_on(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        rendered = render_prompt(prompt, {"allowAppraisal": True})
        assert self._BAN not in rendered
        assert self._PERMISSION in rendered


class TestConfigCarriesTheImprovements:
    """The voice improvements must live in agent.yaml (user-editable), not be
    hidden in code — these guard that the config screen is the source of truth."""

    def test_yaml_guidelines_forbid_empty_praise(self):
        guidelines = _slot_default("response_generator", "conversation_guidelines")
        assert "NEVER praise a mundane answer" in guidelines

    def test_yaml_bridge_carries_the_standing_rules(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        assert "never ask a question" in prompt
        assert "Mirror the SPECIFIC thing they said" in prompt
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

    def test_appraisal_default_on_in_config(self):
        assert _slot_default("bridge_generator", "appraisal") == "on"


class TestGateStream:
    """The sentence-gated streaming validator (_gate_stream) keeps the bridge's
    guarantees per completed sentence so TTS can start before it's finished."""

    def test_releases_only_complete_sentences(self):
        # Trailing incomplete text is held back (never speak half a sentence).
        out, stop = _gate_stream("Okay, I hear you. That sounds", allow_appraisal=False, final=False)
        assert out == "Okay, I hear you."
        assert stop is False

    def test_final_flushes_remainder_with_terminal_punctuation(self):
        out, stop = _gate_stream("Okay, I hear you. That sounds draining", allow_appraisal=False, final=True)
        assert out == "Okay, I hear you. That sounds draining."

    def test_question_sentence_is_dropped_and_stops(self):
        out, stop = _gate_stream("Okay, got it. So what do you enjoy?", allow_appraisal=False, final=True)
        assert out == "Okay, got it."
        assert stop is True

    def test_question_only_yields_nothing(self):
        out, stop = _gate_stream("What do you enjoy?", allow_appraisal=False, final=True)
        assert out == ""
        assert stop is True

    def test_word_cap_stops_before_overrun(self):
        out, stop = _gate_stream(" ".join(["word"] * 40) + ".", allow_appraisal=False, final=True)
        assert out == ""
        assert stop is True

    def test_evaluative_opener_blocked_by_default(self):
        out, stop = _gate_stream("That's a great routine.", allow_appraisal=False, final=True)
        assert out == ""
        assert stop is True

    def test_evaluative_opener_allowed_under_appraisal(self):
        out, stop = _gate_stream("That's a great routine.", allow_appraisal=True, final=True)
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
