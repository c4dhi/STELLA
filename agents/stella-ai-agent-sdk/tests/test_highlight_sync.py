"""End-to-end sync: does the highlight actually land with the voice?

The other teleprompter tests check the SDK's envelopes in isolation. This one
closes the loop: it ports the frontend's scheduler (useTeleprompter.applyProgress)
and replays real envelopes through it, then compares where the highlight sits
against where the voice actually is at the same instant.

That is the only place a whole class of bugs is visible. Segment tiling can be
perfect and the highlight still sit a fixed distance behind, because the offset
lives in a frontend constant rather than in anything the SDK emits.
"""
import asyncio
import time

import pytest

from stella_agent_sdk.audio.pipeline import _PLAYOUT_FRAME_MS

from .test_streaming_playback import SlowTTS, RealtimeRoom, make_realtime_pipeline

# Mirrors TELEPROMPTER_CLIENT_LAG_MS / TELEPROMPTER_REBASE_TOLERANCE_MS in
# frontend-ui/src/hooks/useTeleprompter.ts. Keep in step with that file.
CLIENT_LAG_MS = 60
REBASE_TOLERANCE_MS = 600

SPAN, START = 28, 100
META = {"transcript_id": "t1", "char_start": START, "char_end": START + SPAN}


class StampedRoom(RealtimeRoom):
    """RealtimeRoom that timestamps envelopes relative to the first audio frame."""

    def __init__(self):
        super().__init__()
        self.stamped = []

    def publish_data_ordered(self, payload, *a, **k):
        now = time.perf_counter()
        base = self._first_push if self._first_push else now
        self.stamped.append(((now - base) * 1000, payload))
        self.data.append(payload)


def schedule(stamped, lag_ms=CLIENT_LAG_MS):
    """Port of useTeleprompter's segment scheduling, on a ms-since-first-audio clock."""
    segments, scheduled_until = [], 0.0
    for emit_ms, envelope in stamped:
        if envelope.get("type") != "agent_speech_progress":
            continue
        data = envelope["data"]
        if data["state"] != "speaking":
            continue
        audible_at = emit_ms + data["delay_ms"] + lag_ms
        drifted = scheduled_until - audible_at > REBASE_TOLERANCE_MS
        if drifted:
            segments = [s for s in segments if s["start"] <= emit_ms]
        start = audible_at if drifted else max(audible_at, scheduled_until)
        end = start + max(1, data["duration_ms"])
        segments.append({"from": data["spoken_char"], "to": data["target_char"],
                         "start": start, "end": end})
        scheduled_until = end
    return segments


def highlight_at(segments, t_ms):
    """The lit char offset at t_ms — the frontend's rAF cursor derivation."""
    if not segments:
        return None
    cursor = segments[0]["from"]
    for s in segments:
        if t_ms >= s["end"]:
            cursor = s["to"]
        elif t_ms >= s["start"]:
            frac = (t_ms - s["start"]) / (s["end"] - s["start"])
            return s["from"] + frac * (s["to"] - s["from"])
        else:
            break
    return cursor


async def trail_profile(rtf, lag_ms=CLIENT_LAG_MS, frames=100):
    """Sorted per-sample trail in ms. Positive = highlight behind the voice."""
    audio_ms = frames * _PLAYOUT_FRAME_MS
    tts = SlowTTS(frames=frames, gap=_PLAYOUT_FRAME_MS / 1000.0 * rtf)
    pipe, _ = make_realtime_pipeline(tts)
    pipe._room = StampedRoom()
    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=30)
    for _ in range(5):
        await asyncio.sleep(0)

    segments = schedule(pipe._room.stamped, lag_ms)
    trails = []
    for t in range(0, audio_ms, 25):
        lit = highlight_at(segments, t)
        if lit is None:
            continue
        # The source drains at 1x, so the voice reaches char `lit` at this time.
        voice_t = (lit - START) / SPAN * audio_ms
        trails.append(t - voice_t)
    return sorted(trails)


@pytest.mark.asyncio
@pytest.mark.parametrize("rtf", [0.6, 1.0, 1.3])
async def test_highlight_never_runs_ahead_of_the_voice(rtf):
    """The one asymmetric requirement.

    Trailing slightly reads as natural; leading does not — it shows the reader
    words before they are spoken, which breaks the illusion the feature exists
    to create. So the estimate is deliberately biased to lag, and this pins it.
    """
    trails = await trail_profile(rtf)
    assert trails[0] >= -50, f"RTF {rtf}: highlight led the voice by {-trails[0]:.0f}ms"


@pytest.mark.asyncio
@pytest.mark.parametrize("rtf", [0.6, 1.0, 1.3])
async def test_highlight_stays_within_a_readable_distance(rtf):
    """It may trail, but not so far that it stops reading as the same sentence."""
    trails = await trail_profile(rtf)
    median = trails[len(trails) // 2]
    assert median <= 250, f"RTF {rtf}: median trail {median:.0f}ms"
    assert trails[9 * len(trails) // 10] <= 400, (
        f"RTF {rtf}: p90 trail {trails[9 * len(trails) // 10]:.0f}ms"
    )


@pytest.mark.asyncio
async def test_the_client_lag_constant_is_what_sets_the_trail():
    """Documents where the knob is.

    Segment tiling and the SDK's delay_ms are calibrated, so the residual offset
    is the frontend constant almost exactly. If this ever stops holding, the
    trail has gained a second cause and tuning the constant will not fix it.
    """
    at_zero = await trail_profile(1.0, lag_ms=0)
    at_lag = await trail_profile(1.0, lag_ms=CLIENT_LAG_MS)
    shift = at_lag[len(at_lag) // 2] - at_zero[len(at_zero) // 2]
    assert abs(shift - CLIENT_LAG_MS) < 40, (
        f"changing the lag by {CLIENT_LAG_MS}ms moved the trail {shift:.0f}ms — "
        "something else is now contributing"
    )
