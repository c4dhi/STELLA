"""Tests for typed bridge selection and the fast-path (#304 A2/A3)."""

import os

import pytest
import yaml

from stella_v2_agent.pipeline.bridge_generator import (
    BridgeGenerator,
    select_bridge_type,
    pick_bridge_from_inventory,
    BRIDGE_TYPE_GREETING,
    BRIDGE_TYPE_ACKNOWLEDGEMENT,
    BRIDGE_TYPE_PENSIVE,
    BRIDGE_TYPE_MINIMAL,
    BRIDGE_TYPE_NONE,
    GREETING_BRIDGES_EN,
    GREETING_BRIDGES_DE,
    PENSIVE_BRIDGES_EN,
    PENSIVE_BRIDGES_DE,
    ACKNOWLEDGEMENT_BRIDGES_EN,
    ACKNOWLEDGEMENT_BRIDGES_DE,
    MINIMAL_BRIDGES_EN,
    MINIMAL_BRIDGES_DE,
    _BRIDGE_INVENTORY,
    _screen_risk,
    _gate_stream,
)
from stella_agent_sdk.llm import LLMResponse
from stella_v2_agent.prompts.template import render_prompt


# An ordinary turn: long enough not to be a receipt token, short enough not to
# be "substantial". Selects a full-reaction type, i.e. the LLM bridge path.
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


class TestSelectBridgeType:
    def test_greeting_picks_greeting(self):
        assert select_bridge_type("hi") == BRIDGE_TYPE_GREETING
        assert select_bridge_type("Hello!") == BRIDGE_TYPE_GREETING
        assert select_bridge_type("hallo") == BRIDGE_TYPE_GREETING

    def test_question_picks_pensive(self):
        assert select_bridge_type("What should I eat to lose weight?") == BRIDGE_TYPE_PENSIVE

    def test_long_input_picks_pensive(self):
        long_input = " ".join(["word"] * 30)
        assert select_bridge_type(long_input) == BRIDGE_TYPE_PENSIVE

    def test_ordinary_short_answer_picks_acknowledgement(self):
        assert select_bridge_type("I run three times a week") == BRIDGE_TYPE_ACKNOWLEDGEMENT

    def test_very_short_turn_picks_minimal(self):
        # There is nothing in "yeah" worth receiving in full — mirroring it back
        # is the empty acknowledgement the guidelines forbid.
        assert select_bridge_type("yeah") == BRIDGE_TYPE_MINIMAL
        assert select_bridge_type("twice a week") == BRIDGE_TYPE_MINIMAL

    def test_greeting_beats_everything(self):
        assert select_bridge_type("hi", previous_type=BRIDGE_TYPE_PENSIVE) == BRIDGE_TYPE_GREETING


class TestAntiLockstep:
    """The bridge must not perform a full reaction on every consecutive turn —
    that lockstep is what the conversation guidelines call a questionnaire."""

    def test_full_reaction_is_not_repeated_back_to_back(self):
        first = select_bridge_type("I run three times a week")
        assert first == BRIDGE_TYPE_ACKNOWLEDGEMENT
        assert select_bridge_type(
            "mostly in the evenings after work", previous_type=first
        ) == BRIDGE_TYPE_MINIMAL

    def test_substantial_turn_is_exempt_from_the_anti_lockstep_rule(self):
        # When someone actually opens up, receiving it properly beats varying
        # the shape — a long turn still gets a full reaction.
        long_turn = " ".join(["word"] * 30)
        assert select_bridge_type(
            long_turn, previous_type=BRIDGE_TYPE_ACKNOWLEDGEMENT
        ) == BRIDGE_TYPE_PENSIVE

    def test_a_personal_disclosure_is_never_demoted_to_a_receipt_token(self):
        """The worst failure this selector could have.

        A disclosure is emotionally substantial long before it is long enough to
        look computationally heavy, so the anti-lockstep exemption uses its own
        (much lower) threshold. Answering someone opening up with "Mm." because
        the previous turn happened to get a full reaction would be far worse
        than the lockstep the rule exists to prevent.
        """
        disclosure = (
            "Honestly I've been forcing myself through every single workout "
            "lately and it just feels like a chore I can't get out of"
        )
        assert len(disclosure.split()) < 25  # under the pensive threshold
        assert select_bridge_type(
            disclosure, previous_type=BRIDGE_TYPE_ACKNOWLEDGEMENT
        ) == BRIDGE_TYPE_ACKNOWLEDGEMENT

    def test_a_question_is_exempt_too(self):
        assert select_bridge_type(
            "so what should I do?", previous_type=BRIDGE_TYPE_PENSIVE
        ) == BRIDGE_TYPE_PENSIVE

    def test_alternates_rather_than_ticking(self):
        # An ordinary back-and-forth alternates full / minimal instead of
        # emitting a full reaction every single turn.
        seen, prev = [], None
        for _ in range(4):
            prev = select_bridge_type("I run three times a week", previous_type=prev)
            seen.append(prev)
        assert seen == [
            BRIDGE_TYPE_ACKNOWLEDGEMENT,
            BRIDGE_TYPE_MINIMAL,
            BRIDGE_TYPE_ACKNOWLEDGEMENT,
            BRIDGE_TYPE_MINIMAL,
        ]

    def test_silence_is_off_by_default(self):
        # Two bare turns running still speak, because a silent bridge trades
        # latency for naturalness and must be opted into.
        assert select_bridge_type("yeah", previous_type=BRIDGE_TYPE_MINIMAL) == BRIDGE_TYPE_MINIMAL

    def test_silence_opt_in_stops_the_tick(self):
        assert select_bridge_type(
            "yeah", previous_type=BRIDGE_TYPE_MINIMAL, allow_silence=True
        ) == BRIDGE_TYPE_NONE


class TestNoAssessmentBeforeDispreferred:
    """A2 acceptance: no evaluative/assessment token can ever be chosen.

    The structural guarantee is that no assessment sub-type or inventory exists,
    and the selectable inventories contain no evaluative openers.
    """

    _ASSESSMENT_OPENERS = (
        "that's", "thats", "what a", "wow", "oh wow", "amazing", "great",
        "wonderful", "fantastic", "perfect", "interesting", "toll", "super",
        "wunderbar", "fantastisch", "das ist",
    )

    def test_select_never_returns_assessment(self):
        # Whatever the input, the type is one of the four declared, never an
        # assessment (there is no assessment type at all).
        for inp in ["hi", "I feel terrible", "no", "What now?", "x " * 40]:
            assert select_bridge_type(inp) in {
                BRIDGE_TYPE_GREETING,
                BRIDGE_TYPE_MINIMAL,
                BRIDGE_TYPE_ACKNOWLEDGEMENT,
                BRIDGE_TYPE_PENSIVE,
                BRIDGE_TYPE_NONE,
            }

    def test_inventories_contain_no_assessment_openers(self):
        every_phrase = (
            ACKNOWLEDGEMENT_BRIDGES_EN + ACKNOWLEDGEMENT_BRIDGES_DE
            + PENSIVE_BRIDGES_EN + PENSIVE_BRIDGES_DE
            + GREETING_BRIDGES_EN + GREETING_BRIDGES_DE
            + MINIMAL_BRIDGES_EN + MINIMAL_BRIDGES_DE
        )
        for phrase in every_phrase:
            low = phrase.lower()
            for opener in self._ASSESSMENT_OPENERS:
                assert not low.startswith(opener), f"{phrase!r} is an assessment"

    def test_no_assessment_inventory_registered(self):
        types = {t for (t, _lang) in _BRIDGE_INVENTORY}
        assert "assessment" not in types


class TestPickFromInventory:
    def test_greeting_language(self):
        assert pick_bridge_from_inventory(BRIDGE_TYPE_GREETING, is_german=True) in GREETING_BRIDGES_DE
        assert pick_bridge_from_inventory(BRIDGE_TYPE_GREETING, is_german=False) in GREETING_BRIDGES_EN

    def test_pensive_language(self):
        assert pick_bridge_from_inventory(BRIDGE_TYPE_PENSIVE, is_german=True) in PENSIVE_BRIDGES_DE
        assert pick_bridge_from_inventory(BRIDGE_TYPE_PENSIVE, is_german=False) in PENSIVE_BRIDGES_EN

    def test_minimal_language(self):
        assert pick_bridge_from_inventory(BRIDGE_TYPE_MINIMAL, is_german=True) in MINIMAL_BRIDGES_DE
        assert pick_bridge_from_inventory(BRIDGE_TYPE_MINIMAL, is_german=False) in MINIMAL_BRIDGES_EN

    def test_unknown_type_falls_back_to_acknowledgement(self):
        # An unregistered type must not raise — it falls back to ack.
        assert pick_bridge_from_inventory("no-such-type", is_german=False) in ACKNOWLEDGEMENT_BRIDGES_EN


class TestFastBridge:
    def test_fast_bridge_greeting_de(self):
        gen = BridgeGenerator(llm_service=None)
        assert gen.fast_bridge("hallo", language="de") in GREETING_BRIDGES_DE

    def test_fast_bridge_question_en_is_pensive(self):
        gen = BridgeGenerator(llm_service=None)
        assert gen.fast_bridge("What do you think I should do?", language="en") in PENSIVE_BRIDGES_EN

    @pytest.mark.asyncio
    async def test_generate_uses_fast_path_without_llm(self):
        # With the fast-path on, generate() must not touch the LLM service.
        gen = BridgeGenerator(llm_service=None)
        gen.fast_path_enabled = True
        bridge = await gen.generate("I run three times a week", [], language="en")
        assert bridge in ACKNOWLEDGEMENT_BRIDGES_EN


class TestApplyConfig:
    """Bridge knobs are controlled via the Agent Configurator (apply_config)."""

    def test_fast_path_from_select_string(self):
        gen = BridgeGenerator(llm_service=None)
        # The configurator select sends "on"/"off" strings — bool("off") is True,
        # so this must be parsed, not cast.
        gen.apply_config({"fast_path": "on"})
        assert gen.fast_path_enabled is True
        gen.apply_config({"fast_path": "off"})
        assert gen.fast_path_enabled is False

    def test_fast_path_from_bool(self):
        gen = BridgeGenerator(llm_service=None)
        gen.apply_config({"fast_path": True})
        assert gen.fast_path_enabled is True

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

    def test_yaml_bridge_carries_full_reflection(self):
        prompt = _slot_default("bridge_generator", "system_prompt")
        # The bridge owns the ENTIRE reaction and is told to lean long (a fuller
        # reflective bridge sounds present and buys the reply time), not just emit
        # a bare acknowledgment.
        assert "carry the ENTIRE reaction" in prompt
        assert "Lean LONG" in prompt

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
    async def test_question_only_falls_back_to_canned_bridge(self):
        gen = BridgeGenerator(llm_service=_FakeStreamingLLM("What do you enjoy doing?"))
        gen.bridge_timeout_s = 5.0
        out = await _drain(gen.generate_stream(_ORDINARY_TURN, [], language="en"))
        assert out, "must always yield at least a fallback"
        assert "?" not in out[-1]
        assert out[-1] in ACKNOWLEDGEMENT_BRIDGES_EN + PENSIVE_BRIDGES_EN

    @pytest.mark.asyncio
    async def test_fast_path_yields_single_canned_chunk_without_llm(self):
        fake = _FakeStreamingLLM("should not be used")
        gen = BridgeGenerator(llm_service=fake)
        gen.fast_path_enabled = True
        out = await _drain(gen.generate_stream("I run three times a week", [], language="en"))
        assert len(out) == 1 and out[0] in ACKNOWLEDGEMENT_BRIDGES_EN
        assert fake.called is False

    @pytest.mark.asyncio
    async def test_generate_delegates_and_returns_final_accumulated(self):
        gen = BridgeGenerator(llm_service=_FakeStreamingLLM("Right, that makes sense. Thanks for sharing."))
        gen.bridge_timeout_s = 5.0
        full = await gen.generate(_ORDINARY_TURN, [], language="en")
        assert full == "Right, that makes sense. Thanks for sharing."
