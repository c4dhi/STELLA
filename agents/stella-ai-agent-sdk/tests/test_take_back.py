"""Someone carries on after a final, before any of the reply was heard.

Replayed from a session where the end-of-turn model was right that "Ja." was a
finished sentence, and the speaker went on 606ms later. The agent answered the
fragment. A reply nobody has heard can simply be dropped.
"""

import asyncio
import sys
from pathlib import Path

import pytest

from stella_agent_sdk.agent.base import BaseAgent
from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.messages import AgentOutput
from stella_agent_sdk.messages.types import BargeInDecision

sys.path.insert(0, str(Path(__file__).parent))
from test_gate_carry_over import FakeRoom, drive, ev, queued, start_speaking


def _pipe(decision=BargeInDecision.COMMIT, window_ms=6000):
    pipe = AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    pipe._barge_in_enabled = True
    pipe.enable_take_back(window_ms)

    async def decide(_transcript):
        return decision

    pipe.set_barge_in_decider(decide)
    return pipe


def _stages(pipe):
    return [d["data"] for d in pipe._room.published if d.get("type") == "analytics"]


FIRST = [ev(started=True, tid="A"), ev(ended=True, tid="A"), ev("Ja.", is_final=True, tid="A")]


def _agent_starts(pipe):
    return lambda: pipe.begin_turn()


@pytest.mark.asyncio
async def test_carrying_on_drops_the_unheard_reply_and_joins_what_was_said():
    pipe = _pipe()
    held = []
    await drive(pipe, FIRST + [
        _agent_starts(pipe),
        ev(started=True, tid="B"),
        lambda: held.append(pipe.is_turn_suspended),
        ev(ended=True, tid="B"),
        ev("Letzte Woche war Allerheiligen.", is_final=True, tid="B"),
    ])
    assert held == [True], "paused at the first sound, with no duration threshold"
    assert pipe.is_turn_aborted
    turn = pipe._pending_barge_in
    assert turn.text == "Ja. Letzte Woche war Allerheiligen."
    assert turn.taken_back == ["Ja."]
    assert turn.is_barge_in is False, "nothing was interrupted"
    assert queued(pipe) == ["Ja."]


@pytest.mark.asyncio
async def test_both_halves_stay_in_the_transcript_as_they_were_said():
    pipe = _pipe()
    await drive(pipe, FIRST + [
        _agent_starts(pipe), ev(started=True, tid="B"), ev("Und dann.", is_final=True, tid="B"),
    ])
    finals = [d for d in pipe._room.published if d.get("type") != "analytics" and "Und dann." in str(d)]
    assert finals, "the second half was not published"
    assert not any("Ja. Und dann." in str(d) for d in pipe._room.published), "joined text is for the agent only"


@pytest.mark.asyncio
async def test_a_second_continuation_joins_too():
    pipe = _pipe()
    await drive(pipe, FIRST + [
        _agent_starts(pipe), ev(started=True, tid="B"), ev("Letzte Woche.", is_final=True, tid="B"),
        _agent_starts(pipe), ev(started=True, tid="C"), ev("War schön.", is_final=True, tid="C"),
    ])
    assert pipe._pending_barge_in.text == "Ja. Letzte Woche. War schön."
    assert pipe._pending_barge_in.taken_back == ["Ja.", "Letzte Woche."]


@pytest.mark.parametrize("text,decision", [("", BargeInDecision.COMMIT), ("mhm", BargeInDecision.RESUME)])
@pytest.mark.asyncio
async def test_a_cough_or_a_backchannel_gives_the_reply_back(text, decision):
    pipe = _pipe(decision)
    await drive(pipe, FIRST + [
        _agent_starts(pipe), ev(started=True, tid="B"), ev(text, is_final=True, tid="B"),
    ])
    assert not pipe.is_turn_suspended and not pipe.is_turn_aborted
    assert pipe._pending_barge_in is None
    assert pipe._barge_in_suppressed_until == 0.0 and not pipe._barge_in_active


@pytest.mark.asyncio
async def test_a_utterance_with_no_final_does_not_leave_the_reply_paused():
    pipe = _pipe()
    await drive(pipe, FIRST + [
        _agent_starts(pipe), ev(started=True, tid="B"), ev(started=True, tid="C"),
    ])
    assert pipe._take_back_tid != "B"


@pytest.mark.asyncio
async def test_the_safety_net_releases_a_hold_that_nothing_resolves():
    pipe = _pipe()
    pipe._barge_in_suspend_timeout_s = 0.01
    await drive(pipe, FIRST + [_agent_starts(pipe), ev(started=True, tid="B")])
    assert pipe.is_turn_suspended
    await asyncio.sleep(0.05)
    assert not pipe.is_turn_suspended and pipe._take_back_tid is None
    assert pipe._barge_in_committed_tid is None


@pytest.mark.asyncio
async def test_a_reply_that_reaches_the_speaker_during_the_hold_stays_silent():
    pipe = _pipe()
    await drive(pipe, FIRST + [
        _agent_starts(pipe), ev(started=True, tid="B"), lambda: start_speaking(pipe),
    ])
    assert pipe.is_suspended


@pytest.mark.asyncio
async def test_once_the_reply_was_heard_it_is_an_ordinary_barge_in():
    pipe = _pipe()
    def speak():
        pipe._audible_this_turn = True
        start_speaking(pipe)
    await drive(pipe, FIRST + [
        _agent_starts(pipe), speak,
        ev(started=True, tid="B"),
        lambda: None,
        ev(confirmed=True, tid="B"),
        ev("Und das war schön.", is_final=True, tid="B"),
    ])
    turn = pipe._pending_barge_in
    assert turn.text == "Und das war schön." and turn.is_barge_in is True and not turn.taken_back


@pytest.mark.asyncio
async def test_outside_the_window_or_switched_off_nothing_is_held():
    for pipe in (_pipe(window_ms=0), _pipe(window_ms=1)):
        items = FIRST + [_agent_starts(pipe)]
        pipe._stt = None
        await drive(pipe, items)
        await asyncio.sleep(0.01)
        await drive(pipe, [ev(started=True, tid="B")])
        assert not pipe.is_turn_suspended


@pytest.mark.asyncio
async def test_no_turn_in_progress_means_nothing_to_take_back():
    pipe = _pipe()
    await drive(pipe, FIRST + [ev(started=True, tid="B")])
    assert not pipe.is_turn_suspended and pipe._take_back_tid is None


@pytest.mark.asyncio
async def test_what_happened_is_logged_without_the_words(monkeypatch):
    pipe = _pipe()
    seen = []

    async def record(stage, elapsed_ms, **fields):
        seen.append((stage, fields))

    monkeypatch.setattr(pipe, "_emit_analytics_event", record)
    await drive(pipe, FIRST + [
        _agent_starts(pipe), ev(started=True, tid="B"), ev("Letzte Woche.", is_final=True, tid="B"),
    ])
    stages = dict(seen)
    assert "since_final_ms" in stages["take_back_held"]
    assert stages["take_back_done"]["outcome"] == "joined" and stages["take_back_done"]["parts"] == 1
    assert "Letzte" not in str(seen)


@pytest.mark.asyncio
async def test_a_turn_is_final_once_its_reply_is_heard():
    pipe = _pipe()
    pipe.begin_turn()
    waiting = asyncio.create_task(pipe.wait_until_turn_is_final())
    await asyncio.sleep(0)
    assert not waiting.done()
    pipe._reply_settled.set()
    assert await waiting is True


@pytest.mark.asyncio
async def test_a_turn_taken_back_while_waiting_is_not_final():
    pipe = _pipe()
    pipe.begin_turn()
    waiting = asyncio.create_task(pipe.wait_until_turn_is_final())
    await asyncio.sleep(0)
    pipe.request_turn_abort()
    assert await waiting is False


@pytest.mark.asyncio
async def test_speech_that_never_starts_does_not_block_forever():
    pipe = _pipe()
    pipe.begin_turn()
    assert await pipe.wait_until_turn_is_final(timeout_s=0.25) is True


@pytest.mark.asyncio
async def test_a_hold_does_not_use_up_the_wait():
    pipe = _pipe()
    pipe.begin_turn()
    pipe._take_back_tid = "B"
    waiting = asyncio.create_task(pipe.wait_until_turn_is_final(timeout_s=0.25))
    await asyncio.sleep(0.6)
    assert not waiting.done()
    pipe.request_turn_abort()
    assert await waiting is False


@pytest.mark.asyncio
async def test_off_means_no_wait():
    pipe = _pipe(window_ms=0)
    pipe.begin_turn()
    assert await asyncio.wait_for(pipe.wait_until_turn_is_final(), 0.05) is True


@pytest.mark.asyncio
async def test_the_text_interface_means_no_wait_and_no_hold():
    # Nothing is played on the Text face, so no reply can go unheard (PR 878 review).
    pipe = _pipe()
    pipe.set_interaction_mode("text")
    pipe.begin_turn()
    assert await asyncio.wait_for(pipe.wait_until_turn_is_final(), 0.05) is True
    pipe = _pipe()
    pipe.set_interaction_mode("text")
    await drive(pipe, FIRST + [_agent_starts(pipe), ev(started=True, tid="B")])
    assert not pipe.is_turn_suspended and pipe._take_back_tid is None


@pytest.mark.asyncio
async def test_switching_to_text_mid_wait_ends_the_wait():
    pipe = _pipe()
    pipe.begin_turn()
    waiting = asyncio.create_task(pipe.wait_until_turn_is_final(timeout_s=5))
    await asyncio.sleep(0.05)
    pipe.set_interaction_mode("text")
    assert await asyncio.wait_for(waiting, 1.0) is True


class _Agent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.inputs = []
        self.first_turn_gate = asyncio.Event()

    async def process(self, input):
        self.inputs.append((input.text, (input.metadata or {}).get("taken_back")))
        if len(self.inputs) == 1:
            await self.first_turn_gate.wait()
        yield AgentOutput.text_final(input.session_id, f"reply to {input.text}")

    async def on_interrupt(self, session_id):
        pass


@pytest.mark.asyncio
async def test_the_whole_loop_answers_the_joined_turn_and_never_voices_the_first_reply():
    pipe = _pipe()
    pipe._tts_enabled = False
    pipe._take_back_window_ms = 6000
    agent = _Agent()
    agent._audio_pipeline = pipe
    agent._session_id = "s"
    spoken = []
    agent._enqueue_sentence = lambda text, *_a, **_k: spoken.append(text)
    loop = asyncio.create_task(agent.run_audio_loop())

    await drive(pipe, FIRST)
    await asyncio.sleep(0.01)
    assert agent.inputs == [("Ja.", None)]

    await drive(pipe, [ev(started=True, tid="B")])
    assert pipe.is_turn_suspended
    agent.first_turn_gate.set()
    await asyncio.sleep(0.01)
    assert not spoken and len(agent.inputs) == 1, "the first reply stays held"

    await drive(pipe, [ev("Letzte Woche war schön.", is_final=True, tid="B")])
    for _ in range(50):
        await asyncio.sleep(0.01)
        if len(agent.inputs) == 2:
            break
    assert agent.inputs[1] == ("Ja. Letzte Woche war schön.", ["Ja."])
    pipe._is_listening = False
    loop.cancel()
    await asyncio.gather(loop, return_exceptions=True)
