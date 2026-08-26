"""
AudioPipeline - High-level audio abstraction for STELLA agents.

This module provides the main audio interface that agents use. It orchestrates
the complete audio flow between LiveKit, STT service, TTS service, and the agent.

INPUT FLOW (user → agent):
1. Subscribe to LiveKit audio track
2. Stream audio to STT service (gRPC)
3. Publish partial transcripts to LiveKit (for frontend display)
4. Yield final transcripts to agent

OUTPUT FLOW (agent → user) - DECOUPLED:
1. publish_text() - Send text to frontend for display (independent of TTS)
2. enqueue_sentence() - Dispatch sentences to TTS as they complete (independent of frontend)
3. speak() - Send complete text to TTS (for non-streaming use cases)

The SDK's run_audio_loop handles the coordination:
- Stream text chunks to frontend immediately via publish_text()
- Detect sentence boundaries and dispatch each sentence to TTS immediately
- TTS synthesis starts on the first complete sentence, not on is_final

Usage:
    # In your agent's run_audio_loop:
    async for event in self.audio.audio_in():
        # Partials already published to LiveKit
        # event is guaranteed to be final

        # Agent yields text chunks
        accumulated = ""
        async for output in agent.process(input):
            accumulated += output.content
            await self.audio.publish_text(accumulated, output.is_final, transcript_id)

            if output.is_final:
                await self.audio.speak(accumulated)
"""

import asyncio
import json
import logging
import os
import time
import uuid
from typing import AsyncIterator, Awaitable, Callable, List, Optional

from stella_agent_sdk.env import env_int as _env_int, env_float as _env_float
from stella_agent_sdk.language import forced_language
from stella_agent_sdk.livekit.room import RoomManager
from stella_agent_sdk.services.stt_client import STTClient, TranscriptEvent
from stella_agent_sdk.services.tts_client import TTSClient
from stella_agent_sdk.messages.types import BargeInDecision

logger = logging.getLogger(__name__)


# ── First-audible-token latency budget (#304 A1) ─────────────────────────────
# Targets grounded in turn-taking research. The natural between-turn gap clusters
# around ~200 ms across languages (Stivers et al. 2009, PNAS); spoken-dialogue
# systems start to feel unnatural past ~2 s and read as a breakdown past ~4 s
# (assemblyai low-latency-voice-ai; arXiv 2507.22352 / 2404.16053).
#   • bridge  — the floor-holding ack must land INSIDE the gap window to do its
#               job, so its target is tight (~500 ms).
#   • response — the first audible token of the substantive answer; ≤1 s is
#               comfortable.
# Both share warn (>2 s, unnatural) and alarm (>4 s, perceived dead air)
# ceilings. Targets are visibility-only (log + analytics payload); no behavior
# changes here. All four are env-tunable.
_BRIDGE_FIRST_BYTE_TARGET_MS = _env_int("STELLA_BRIDGE_FIRST_BYTE_TARGET_MS", 500)
_RESPONSE_FIRST_BYTE_TARGET_MS = _env_int("STELLA_RESPONSE_FIRST_BYTE_TARGET_MS", 1000)
_FIRST_BYTE_WARN_MS = _env_int("STELLA_FIRST_BYTE_WARN_MS", 2000)
_FIRST_BYTE_ALARM_MS = _env_int("STELLA_FIRST_BYTE_ALARM_MS", 4000)


def _first_byte_target_ms(source: str) -> int:
    """Per-source first-audible-token target in ms (bridge tight, response ≤1 s)."""
    return (
        _BRIDGE_FIRST_BYTE_TARGET_MS
        if source == "bridge"
        else _RESPONSE_FIRST_BYTE_TARGET_MS
    )


def _latency_status(source: str, elapsed_ms: float) -> str:
    """Classify a first-byte latency against the budget: ok | over_target | warn | alarm."""
    if elapsed_ms > _FIRST_BYTE_ALARM_MS:
        return "alarm"
    if elapsed_ms > _FIRST_BYTE_WARN_MS:
        return "warn"
    if elapsed_ms > _first_byte_target_ms(source):
        return "over_target"
    return "ok"


def _decode_diagnostic_fields(raw: str) -> dict:
    """Flatten the STT decode-diagnostics JSON into analytics event fields.

    The STT service ships a nested record; the analytics pipeline aggregates
    flat keys off ``data.<name>``, so nesting would mean a bespoke aggregator.
    Unknown or malformed input yields {} — diagnostics must never be able to
    break a turn, and they are absent entirely unless the STT service has them
    switched on.
    """
    if not raw:
        return {}
    try:
        record = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(record, dict):
        return {}

    fields: dict = {}

    def _put(key, value, cast=float):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            fields[key] = cast(value)

    def _section(name):
        # `or {}` is not enough: a truthy non-dict (a string, a list) would sail
        # through and blow up on .get inside a live turn.
        value = record.get(name)
        return value if isinstance(value, dict) else {}

    audio = _section("audio")
    _put("silence_fraction", audio.get("silence_fraction"))
    _put("speech_sec", audio.get("speech_sec"))
    _put("total_sec", audio.get("total_sec"))

    final = _section("final")
    _put("final_decode_ms", final.get("decode_ms"))
    _put("final_words", final.get("words"), int)
    for name in ("avg_logprob", "no_speech_prob", "compression_ratio"):
        stats = final.get(name)
        if isinstance(stats, dict):
            _put(f"{name}_worst", stats.get("worst"))
            _put(f"{name}_mean", stats.get("mean"))

    # The two comparisons the investigation turns on: could we have shipped the
    # earlier decode (shadow), and how much does the mid-speech partial miss.
    for source, prefix in (("shadow", "shadow"), ("last_partial", "partial")):
        block = record.get(source)
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("identical"), bool):
            fields[f"{prefix}_identical"] = block["identical"]
        if isinstance(block.get("is_prefix_of_reference"), bool):
            fields[f"{prefix}_is_prefix"] = block["is_prefix_of_reference"]
        _put(f"{prefix}_similarity", block.get("similarity"))
        _put(f"{prefix}_word_delta", block.get("word_delta"), int)
        _put(f"{prefix}_available_earlier_ms", block.get("available_earlier_ms"))

    return fields


# TTS output format (matches RoomManager's AudioSource and the TTS service).
_TTS_SAMPLE_RATE = 24000
_BYTES_PER_SAMPLE = 2  # 16-bit mono PCM
# Frame size for paced playback to the LiveKit track (20ms at 24kHz). Pushing
# in fixed frames lets us track a sample-accurate playhead for barge-in.
_PLAYOUT_FRAME_SAMPLES = 480
_PLAYOUT_FRAME_BYTES = _PLAYOUT_FRAME_SAMPLES * _BYTES_PER_SAMPLE

# Jitter buffer held before the first frame of an utterance goes out.
#
# LiveKit's AudioSource.capture_frame self-paces at 1x real time, so once
# playout starts the source drains steadily. TTS does NOT arrive steadily, and
# on the current deployment it barely arrives fast enough at all.
#
# Measured against the prod TTS service (Qwen3-TTS-12Hz-1.7B on an L4), three
# German sentences of 1.7-4.2s of audio:
#
#   real-time factor          0.92 - 1.33   (synthesis is ~as slow as playback,
#                                             and for short text SLOWER)
#   first chunk               ~235ms
#   whole sentence            2235 - 3907ms  <- what buffered playback waited for
#   max playout deficit       614 - 756ms    <- how far playout falls behind
#                                              arrival when started with no cushion
#
# The deficit is the number that sets this constant: playout must start late
# enough that it never catches up with synthesis. 300ms was NOT enough (starts
# at ~434ms, under the 756ms deficit) and still underran mid-sentence. 700-800ms
# clears it with margin, and lands in the same arriving lump, so 800ms costs
# nothing over 700ms.
#
# At 800ms the first frame goes out ~1037ms in, against 2235-3907ms before —
# and it is now CONSTANT rather than scaling with sentence length.
#
# The real fix is a faster provider: at the RTF ~0.3 the Qwen3 docs quote (4090,
# 0.6B) a 300ms cushion would be ample and first audio would land near 350ms.
# On this hardware there is no headroom to stream into.
_DEFAULT_TTS_PREROLL_MS = 800

# Wall-clock covered by one playout frame.
_PLAYOUT_FRAME_MS = _PLAYOUT_FRAME_SAMPLES * 1000 // _TTS_SAMPLE_RATE

# Underrun guard.
#
# A LiveKit AudioSource that runs dry does NOT emit silence. The client simply
# stops receiving packets, and Opus packet-loss concealment fills the hole by
# extrapolating the last frame it had — a synthetic, warbling continuation of
# whatever phoneme was in flight. That artifact is the "interference between
# chunks" people report; it is the client inventing audio, not TTS producing it.
#
# So when synthesis falls behind far enough that the source is about to empty,
# push real silence instead. A synthesis stall then sounds like a short pause,
# which is honest, rather than a warble, which is not.
_UNDERRUN_FLOOR_MS = 120.0    # top the source up once it drops below this
_UNDERRUN_POLL_MS = 10.0      # how often to re-check while starved

# De-click ramp applied on either side of inserted silence. Cutting a speech
# waveform to zero — or resuming it from zero — is a step discontinuity, and a
# step is audible as a click. A few ms of linear ramp removes it.
_DECLICK_MS = 5
_DECLICK_SAMPLES = _DECLICK_MS * _TTS_SAMPLE_RATE // 1000

# Teleprompter progress cadence (#241).
#
# The highlight used to be driven by ONE envelope per sentence, held until
# synthesis completed so it could carry the sentence's true byte length. That
# assumed synthesis finishes well before playback does (RTF ~0.3). It does not:
# the deployed model runs at RTF 0.92-1.33, so "synthesis complete" lands at the
# END of the sentence and the envelope describes almost nothing left to animate.
# Measured against the paced harness at a constant 500ms sentence:
#
#   RTF 0.3 -> 300ms still to animate (60% of the sentence)
#   RTF 0.6 -> 160ms (32%)
#   RTF 1.0 ->  40ms (8%)
#   RTF 1.3 ->  20ms (4%)   <- the highlight simply appears, fully lit
#
# So progress is now STREAMED: a tick every _PROGRESS_TICK_MS describes only the
# audio actually in hand, and the frontend chains those short segments. Each
# tick's timing is anchored to bytes really pushed, so it cannot outrun the
# audio no matter how slow synthesis is.
_PROGRESS_TICK_MS = float(os.getenv("TTS_PROGRESS_TICK_MS", "200"))

# Seed for the chars-per-millisecond estimate used to place the highlight inside
# a sentence that is still synthesizing (see _estimated_total_bytes). ~70ms/char
# is normal conversational TTS pace; it self-calibrates from the first completed sentence,
# so this only has to be in the right neighbourhood for the very first one.
_DEFAULT_MS_PER_CHAR = 70.0


def _now() -> float:
    """Monotonic seconds — never the wall clock, which can step."""
    return time.monotonic()


def _tail_sample(frame: bytes) -> int:
    """Last 16-bit sample of a frame (0 when there is not one)."""
    if len(frame) < _BYTES_PER_SAMPLE:
        return 0
    return int.from_bytes(frame[-_BYTES_PER_SAMPLE:], "little", signed=True)


def _fade_in(frame: bytes) -> bytes:
    """Ramp the first _DECLICK_MS of ``frame`` up from zero."""
    n = min(len(frame) // _BYTES_PER_SAMPLE, _DECLICK_SAMPLES)
    if n <= 0:
        return frame
    out = bytearray(frame)
    for i in range(n):
        off = i * _BYTES_PER_SAMPLE
        sample = int.from_bytes(out[off:off + _BYTES_PER_SAMPLE], "little", signed=True)
        scaled = int(sample * (i + 1) / n)
        out[off:off + _BYTES_PER_SAMPLE] = scaled.to_bytes(
            _BYTES_PER_SAMPLE, "little", signed=True
        )
    return bytes(out)


def _apply_gain(frame: bytes, gain: float) -> bytes:
    """Scale a PCM frame. Used to duck the agent under the user's voice."""
    if gain >= 1.0:
        return frame
    out = bytearray(len(frame))
    for off in range(0, len(frame) - _BYTES_PER_SAMPLE + 1, _BYTES_PER_SAMPLE):
        sample = int.from_bytes(frame[off:off + _BYTES_PER_SAMPLE], "little", signed=True)
        out[off:off + _BYTES_PER_SAMPLE] = int(sample * gain).to_bytes(
            _BYTES_PER_SAMPLE, "little", signed=True
        )
    return bytes(out)


def _silence_frame(fade_from: int = 0) -> bytes:
    """A frame of silence, ramping down from ``fade_from`` so it does not click."""
    out = bytearray(_PLAYOUT_FRAME_BYTES)
    if fade_from:
        n = min(_DECLICK_SAMPLES, _PLAYOUT_FRAME_SAMPLES)
        for i in range(n):
            off = i * _BYTES_PER_SAMPLE
            scaled = int(fade_from * (1.0 - (i + 1) / n))
            out[off:off + _BYTES_PER_SAMPLE] = scaled.to_bytes(
                _BYTES_PER_SAMPLE, "little", signed=True
            )
    return bytes(out)


class _StreamingUtterance:
    """One sentence's PCM audio, appended to while synthesis streams it in.

    Lets playback start on the first chunk instead of the last. ``data`` is a
    bytearray the player binds to directly (``self._cur_audio``), so appends are
    visible to the playhead without copying; ``complete`` says whether more is
    coming; ``wait_for_data`` parks the player when it catches up with synthesis.
    """

    __slots__ = ("data", "complete", "error", "task", "_new")

    def __init__(self) -> None:
        self.data = bytearray()
        self.complete = False
        self.error: Optional[Exception] = None
        self.task: Optional[asyncio.Task] = None
        self._new = asyncio.Event()

    def append(self, audio: bytes) -> None:
        self.data += audio
        self._new.set()

    def finish(self, error: Optional[Exception] = None) -> None:
        self.error = error
        self.complete = True
        self._new.set()

    async def wait_for_data(
        self,
        want: int,
        stop_event: asyncio.Event,
        timeout: Optional[float] = None,
    ) -> bool:
        """Block until the buffer holds ``want`` bytes, synthesis ends, or stop.

        Returns False only when ``stop_event`` fired — the caller must abandon
        playback. Racing the stop event here is what keeps barge-in responsive
        while the player is starved: without it a slow synthesis would pin the
        speech worker with the transcript gate closed and drop user speech.

        With ``timeout`` set the wait also gives up when it expires and returns
        True WITHOUT the data having arrived, so the caller can top the output
        source up with silence and come back. Callers must therefore re-check
        the buffer rather than assume ``want`` bytes are present.
        """
        while len(self.data) < want and not self.complete:
            self._new.clear()
            # Re-check after clear(): the producer may have appended (and set the
            # event) between the length check and the clear, which would
            # otherwise park us on an event nobody will set again.
            if len(self.data) >= want or self.complete:
                break
            waiter = asyncio.ensure_future(self._new.wait())
            stopper = asyncio.ensure_future(stop_event.wait())
            try:
                await asyncio.wait(
                    {waiter, stopper},
                    return_when=asyncio.FIRST_COMPLETED,
                    timeout=timeout,
                )
            finally:
                waiter.cancel()
                stopper.cancel()
            if stop_event.is_set():
                return False
            if timeout is not None:
                # One bounded pass only — hand control back so the caller can
                # decide whether the output source needs bridging.
                return True
        return True

    def cancel(self) -> None:
        """Stop synthesising — the audio is no longer wanted."""
        if self.task is not None and not self.task.done():
            self.task.cancel()


class AudioPipeline:
    """
    Orchestrates complete audio flow between LiveKit, STT, TTS, and agent.

    This is the main audio interface for agents. It handles:

    INPUT (user speech → agent):
    - Subscribes to LiveKit audio tracks
    - Streams audio to external STT service (via gRPC)
    - Publishes ALL transcripts (partial + final) to LiveKit for frontend
    - Yields ONLY final transcripts to agent

    OUTPUT (agent response → user):
    - Accepts streaming text from agent
    - Publishes partial text to LiveKit for frontend display
    - Buffers text into complete sentences
    - Sends sentences to external TTS service (via gRPC)
    - Publishes TTS audio to LiveKit

    BARGE-IN:
    - Detects speech_started from STT VAD
    - Fires registered callbacks for agent to handle interruption
    """

    def __init__(
        self,
        room_manager: RoomManager,
        stt_client: STTClient,
        tts_client: TTSClient,
        session_id: str,
        participant_id: str = "human",  # Default to "human" - standard LiveKit identity for users
        agent_name: str = "Agent",
        agent_id: Optional[str] = None,
    ):
        """
        Initialize the AudioPipeline.

        Args:
            room_manager: LiveKit room manager for audio I/O
            stt_client: gRPC client for external STT service
            tts_client: gRPC client for external TTS service
            session_id: Session identifier
            participant_id: Default participant ID for audio attribution
            agent_name: Display name for agent messages (from AGENT_NAME env)
            agent_id: Unique agent ID for attribution (from AGENT_ID env)
        """
        self._room = room_manager
        self._stt = stt_client
        self._tts = tts_client
        self._session_id = session_id
        self._participant_id = participant_id
        self._agent_name = agent_name
        self._agent_id = agent_id

        # State tracking
        self._is_speaking = False
        self._is_listening = False
        self._stop_speaking_event = asyncio.Event()
        self._tts_task: Optional[asyncio.Task] = None

        # Barge-in callbacks
        self._speech_started_callbacks: List[Callable[[], Awaitable[None]]] = []

        # Speaker attribution: Lock in who is speaking at VAD speech_started
        # This prevents race conditions where current_audio_speaker changes
        # before the transcript for a previous speaker is received
        self._current_utterance_speaker: Optional[str] = None

        # Audio streaming
        self._audio_queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._stt_stream_task: Optional[asyncio.Task] = None
        self._transcript_queue: asyncio.Queue[TranscriptEvent] = asyncio.Queue()

        # Transcript debouncing (secondary defense against rapid successive finals).
        #
        # Off by default. The window only pays for itself if a second final can
        # actually land inside it, and with either STT provider in this tree it
        # cannot: both refuse to emit a final until they have seen a fixed span
        # of silence, and both reset to IDLE immediately afterwards, so the
        # floor between two consecutive finals is that span. whisper waits
        # VAD_SILENCE_DURATION_MS + VAD_CONTINUATION_WINDOW_MS (500 + 600 in
        # prod), sherpa waits SHERPA_SILENCE_THRESHOLD (1.5s). Both are far
        # wider than any sane debounce window, and the continuation window is
        # already the mechanism that stitches a mid-sentence pause back into
        # one turn — it cancels its own pending final when speech resumes.
        #
        # So the sleep was a fixed tax on every turn (300ms straight off
        # time-to-first-audio, measured from stt_end) guarding against an event
        # the upstream endpointing makes unreachable. Set TRANSCRIPT_DEBOUNCE_MS
        # to re-enable it for an STT provider that CAN fragment inside the
        # window; the aggregation path below is unchanged and still correct.
        self._debounce_window_ms = _env_int("TRANSCRIPT_DEBOUNCE_MS", 0)
        self._pending_transcript: Optional[TranscriptEvent] = None
        self._pending_transcript_time: float = 0
        self._debounce_task: Optional[asyncio.Task] = None

        # Transcript gating (turn management)
        self._transcript_gate_closed = False

        # Interrupt mode: "none" = strict gating (default), "smart" = future barge-in
        self._interrupt_mode = os.getenv("INTERRUPT_MODE", "none")

        # TTS enabled flag
        self._tts_enabled = os.getenv("TTS_ENABLED", "true").lower() != "false"

        # Deployment language PIN (STELLA_LANGUAGE). When set, this deployment
        # is fixed to one language: STT transcription is pinned to it below
        # instead of auto-detecting, and the resolver forces every turn to it.
        # None = auto-detect (default).
        self._language_pin = forced_language()
        # Language to transcribe in, when the conversation HAS a declared one
        # (plan-level, via set_stt_language). Only ever set from a declaration,
        # never from detection: pinning STT to a language we merely guessed
        # would make a wrong guess permanent and self-confirming.
        self._stt_language: Optional[str] = None

        # TTS language. Seeded from the env var for backward compatibility, then
        # from the deployment pin, so the first synthesis of a pinned deployment
        # is already correct before any turn has been resolved. The agent
        # overrides it per turn via set_tts_language() so the voice follows the
        # resolved conversation language (RFC §8/§9 #9).
        self._tts_language = os.getenv("TTS_LANGUAGE", None) or self._language_pin or None

        # TTS voice. Seeded from the env var; the agent can override it per
        # stream via set_tts_voice() so the spoken voice can change per turn.
        # Same contract as language — passed to the provider as a hint that
        # voice-selecting providers honor (e.g. Kokoro) and others disregard.
        self._tts_voice = os.getenv("TTS_VOICE", None) or None

        # Speaking rate. Same contract as voice/language: an env seed the agent
        # overrides per turn via set_tts_speed(). Providers that cannot change
        # rate ignore it; the Qwen3 provider resamples its own PCM to honour it.
        # This exists so a whole conversation is not synthesised at one fixed
        # rate and one fixed affect, which is a large part of sounding scripted.
        self._tts_speed: float = _env_float("TTS_SPEED", 1.0)

        # Sentence-level streaming TTS queue (tuple of sentence text + source label)
        self._speech_queue: asyncio.Queue = asyncio.Queue()
        # Serializes TTS generation — see the note in _begin_synthesis. The
        # service does not guard its own model, so concurrent synthesis garbles
        # audio; this keeps at most one stream in flight per pipeline.
        self._synthesis_lock: asyncio.Lock = asyncio.Lock()
        # Jitter buffer before an utterance starts playing (see the constant).
        # 0 disables it, which is only sane if the provider streams smoothly.
        try:
            _preroll_ms = int(
                os.getenv("STELLA_TTS_PREROLL_MS", str(_DEFAULT_TTS_PREROLL_MS))
            )
        except ValueError:
            _preroll_ms = _DEFAULT_TTS_PREROLL_MS
        self._preroll_bytes = max(
            0, int(_preroll_ms * _TTS_SAMPLE_RATE / 1000) * _BYTES_PER_SAMPLE
        )
        self._speech_worker_task: Optional[asyncio.Task] = None

        # ── Barge-in: reversible suspend / resume of playback ──────────────
        # When enabled, detecting user speech mid-utterance SUSPENDS playback
        # (reversible) instead of hard-stopping. The current utterance's audio
        # is held in memory and addressable by sample offset, so it can resume
        # from the exact point the user heard, or be discarded on commit.
        #
        # Whether barge-in is active is driven by the AGENT'S declared
        # capability (supports_barge_in), wired in via enable_barge_in() by the
        # run loop. The BARGE_IN_ENABLED env var is an optional operator
        # OVERRIDE: when set explicitly it wins (force on/off); when unset, the
        # agent's declaration decides.
        _bargein_env = os.getenv("BARGE_IN_ENABLED")
        if _bargein_env is None:
            self._barge_in_enabled = False  # until the agent declaration enables it
            self._barge_in_env_locked = False
        else:
            self._barge_in_enabled = _bargein_env.lower() in ("true", "1", "yes")
            self._barge_in_env_locked = True
        # Gate for the playback loop: set => may push frames, clear => paused.
        self._play_allowed = asyncio.Event()
        self._play_allowed.set()
        # Held audio for the currently-playing utterance (concatenated PCM) and
        # the playhead (byte offset of the next sample to push).
        self._cur_audio: bytes = b""
        self._cur_cursor: int = 0
        # Barge-in resolution: True between detecting the interruption and the
        # decision landing. The decider (set by run wiring) is the agent's
        # on_barge_in hook; it returns COMMIT or RESUME for a given transcript.
        self._barge_in_active = False
        self._barge_in_resolving = False
        # A committed barge-in turn, delivered to audio_in() out-of-band so it
        # survives the transcript-queue drain that open_transcript_gate() runs
        # when the interrupted speech worker exits.
        self._pending_barge_in: Optional[TranscriptEvent] = None
        # True only while audio frames are actually being pushed to the track —
        # i.e. the agent is *audibly* talking. A barge-in may only START when
        # this is True; `_is_speaking` is too coarse (it's set before the first
        # frame plays and during idle gaps, when the agent isn't really talking).
        self._audio_active = False
        # The agent's interruption decider. Used by the TEXT barge-in path only
        # (#278): a typed message carries no acoustic signal, so whether it is
        # worth interrupting for genuinely needs judgement. The VOICE path does
        # not consult it — see the barge-in block in _run_stt_stream_inner.
        self._barge_in_decider: Optional[
            Callable[[str], Awaitable["BargeInDecision"]]
        ] = None
        # How far to duck the agent's own voice while the user is speaking.
        # Ducking is the reflex; stopping is the decision. A human who is
        # interrupted trails off before they stop, and the listener hears that
        # instantly — long before anyone has parsed a word. Doing the same makes
        # the agent feel like it is listening rather than being switched off,
        # and because it is only a volume change it costs nothing to be wrong:
        # a cough ducks it for a moment and it carries on mid-sentence.
        self._barge_in_duck_gain = max(0.0, min(1.0, float(
            os.getenv("BARGE_IN_DUCK_GAIN", "0.25")
        )))
        self._ducked = False
        # transcript_id of an utterance we have committed a voice barge-in for,
        # while waiting for its final to deliver as the interrupting turn.
        # Keyed on the id, not a bare flag, so the state cannot outlive its
        # utterance — which is exactly how the previous design broke.
        self._barge_in_committed_tid: Optional[str] = None
        # Session-end wrap-up handler (issue #198): invoked when the backend signals
        # a graceful close over the data channel ({"type":"session_end"}).
        self._session_end_handler: Optional[
            Callable[[str, int], Awaitable[None]]
        ] = None
        # Safety net for the TEXT path, which is the only caller that suspends
        # playback reversibly: if its decider hangs, the suspend would otherwise
        # persist forever — permanent dead air, turn never completes. This
        # watchdog auto-resumes a suspend that goes this long unresolved.
        # Tunable via BARGE_IN_SUSPEND_TIMEOUT_MS.
        self._barge_in_suspend_timeout_s: float = float(
            os.getenv("BARGE_IN_SUSPEND_TIMEOUT_MS", "8000")
        ) / 1000
        self._barge_in_watchdog_task: Optional[asyncio.Task] = None

        # ── Generation-level interrupt (text barge-in #278) ────────────────
        # Voice barge-in (above) acts at the audio layer: it suspends/commits
        # TTS playback while the agent is *audibly* speaking. A typed message
        # must also interrupt a turn that is still GENERATING (and, with TTS
        # disabled, never speaks at all). These flags let the run loop pause or
        # halt the in-flight process() generator — but only at a yield boundary,
        # so any tool call awaiting between yields runs to completion first and
        # its result is preserved (never severed mid-write). See run_audio_loop.
        #   _turn_active   — a turn is being consumed by the run loop.
        #   _turn_suspended— generation should pause at the next yield boundary.
        #   _turn_release  — set when a suspend ends (resume OR abort) to unblock
        #                    the loop's wait.
        #   _turn_abort    — the suspended/active turn is superseded; halt it.
        self._turn_active = False
        self._turn_suspended = False
        self._turn_release = asyncio.Event()

        # Terminal-close gate (issue #198): once set, the conversation loop stops
        # accepting new user turns — the session is ending. Set by interrupt_for_closing()
        # when the backend signals session_end; the closing farewell is spoken
        # out-of-band by run.py, then the agent disconnects itself.
        self._closing = False
        self._turn_release.set()
        self._turn_abort = asyncio.Event()

        # Teleprompter (#241): emit agent_speech_progress envelopes so the
        # frontend can light up the published agent_text exactly as it is
        # spoken (and freeze it at the playhead on barge-in). ON BY DEFAULT —
        # an explicit STELLA_TELEPROMPTER_ENABLED env value (e.g. "false")
        # overrides and locks it for operators who want it off.
        _tp_env = os.getenv("STELLA_TELEPROMPTER_ENABLED")
        if _tp_env is None:
            self._teleprompter_enabled = True  # default on
            self._teleprompter_env_locked = False
        else:
            self._teleprompter_enabled = _tp_env.lower() in ("true", "1", "yes")
            self._teleprompter_env_locked = True
        # Character span of the sentence currently held in _cur_audio, used to
        # translate the byte-accurate playhead into a character offset in the
        # published agent_text. None when the held audio carries no offsets.
        self._cur_meta: Optional[dict] = None
        # Whether synthesis of the held utterance has finished. Until it has,
        # len(_cur_audio) is a PARTIAL total and the byte->char mapping has to
        # be estimated rather than divided out (see _estimated_total_bytes).
        self._cur_complete: bool = False
        # Highest char offset already published for the held sentence, so a
        # re-estimate can never walk the highlight backwards.
        self._cur_last_char: int = 0
        # Bytes of the held sentence already covered by an emitted segment.
        # Segments must TILE the sentence: the frontend chains them end to end
        # on the wall clock, so a segment measured from the live playhead rather
        # than from here would re-describe audio an earlier segment already
        # covered, and the schedule would outrun the sound.
        self._cur_promised: int = 0
        # Session-calibrated speaking pace, used to estimate where inside a
        # sentence the playhead is while the sentence is still synthesizing.
        # Re-measured from every sentence that completes, so it tracks the
        # voice, the language and the model actually in use.
        self._ms_per_char: float = _DEFAULT_MS_PER_CHAR
        # False until a real sentence has been measured, so the seed above is
        # replaced rather than averaged with the first measurement.
        self._pace_measured: bool = False
        # Last agent_playback state actually put on the wire. Progress is now
        # emitted on a tick, and the mute channel must not tick with it.
        self._last_playback_state: Optional[str] = None

        # Per-turn analytics state (raw event model)
        self._turn_stt_start_ts: float = 0
        self._turn_stt_end_ts: float = 0
        self._turn_id: Optional[str] = None
        self._turn_bridge_tts_first_byte_emitted: bool = False
        self._turn_response_tts_first_byte_emitted: bool = False
        self._last_response_tts_done_elapsed: float = 0

        # Register data message handler for text input from frontend
        self._room.on_data_received(self._handle_data_message)

    @property
    def is_speaking(self) -> bool:
        """Whether the agent is currently speaking (TTS playing)."""
        return self._is_speaking

    @property
    def is_closing(self) -> bool:
        """Whether the session is winding down (issue #198). While True, the
        conversation loop stops taking new user turns."""
        return self._closing

    async def interrupt_for_closing(self) -> None:
        """Terminal interrupt for session end (issue #198).

        The reversible counterpart is barge-in (the user briefly interrupts, then the
        conversation continues). This is the irreversible close. In one step it:
          • gates the conversation loop (``is_closing``) so no new user turn is taken,
          • locks out barge-in so the user can't interrupt the goodbye,
          • aborts the agent's own in-flight turn — generation and current audio,
          • settles the interrupted speech worker and clears the hard-stop flag,
        leaving the pipeline ready to voice the closing line with ``speak_line()`` (so
        the farewell still highlights word-by-word). After the farewell the caller
        publishes ``session_ended`` and disconnects.
        """
        if not self._closing:
            logger.info("[SESSION END] terminal interrupt — closing the session")
        self._closing = True
        self._barge_in_enabled = False  # the user can no longer interrupt the goodbye

        # Cut the agent's own in-flight turn: halt generation + stop current audio.
        self.request_turn_abort()
        await self.stop_speaking()

        # Settle the interrupted worker, then clear the stop flag so a FRESH worker
        # speaks the closing line from a clean slate (otherwise the stop flag, or an
        # end-of-turn flush still in flight, would swallow it).
        worker = self._speech_worker_task
        if worker is not None and not worker.done():
            try:
                # shield so the timeout doesn't cancel a worker that's exiting cleanly.
                await asyncio.wait_for(asyncio.shield(worker), timeout=2.0)
            except Exception:
                pass
            # A worker blocked in a slow TTS synthesize_stream only checks the stop
            # flag between awaits, so it may still be alive here. Cancel it outright —
            # we're tearing down, and enqueue_sentence only spawns a FRESH worker for
            # the farewell when the old one is done(); a lingering worker would instead
            # swallow the closing line onto its draining queue with the stop flag cleared.
            if not worker.done():
                worker.cancel()
                try:
                    await worker
                except (asyncio.CancelledError, Exception):
                    pass
        # Drop the reference unconditionally so the farewell's enqueue starts clean.
        self._speech_worker_task = None
        self._stop_speaking_event.clear()

    async def speak_line(self, text: str) -> None:
        """Voice one complete line and highlight it word-by-word, the same way a
        normal turn is spoken (publish the text, then synthesize it through the
        streaming queue so the teleprompter tracks it). Used for the session-end
        farewell — ``speak()`` would play audio but emit no teleprompter progress.
        """
        if not text.strip():
            return
        tid = f"line_{uuid.uuid4().hex[:8]}"
        await self.publish_text(text, is_final=True, transcript_id=tid)
        self.enqueue_sentence(text, transcript_id=tid, char_start=0, char_end=len(text))
        await self.flush_speech_queue()

    async def wait_for_playout_drain(self, max_wait_ms: int = 15_000) -> None:
        """Block until buffered TTS audio has actually played out to the client.

        ``flush_speech_queue()`` returns when the farewell's last frame is *pushed*
        to the room — but up to ``queued_playout_ms`` of audio is still draining the
        output + client buffers (see the CONTRACT note in ``_play_prefetched``).
        Before the terminal ``session_ended`` overlay we wait that out so the
        goodbye is fully heard rather than cut off by the disconnect (issue #198).
        Bounded by ``max_wait_ms`` so a stuck buffer can never stall shutdown.
        """
        try:
            waited = 0.0
            while waited < max_wait_ms:
                remaining = float(self._room.queued_playout_ms)
                if remaining <= 50:
                    return
                step = min(remaining, 250.0)
                await asyncio.sleep(step / 1000.0)
                waited += step
        except Exception:
            pass

    async def publish_session_ended(self, reason: str) -> None:
        """Tell the frontend the session has terminally ended (issue #198) so it can
        show the end overlay. Mirrors the session_completed signal used for a natural
        end. Best-effort: a failure here must not block shutdown."""
        try:
            await self._room.publish_data(
                {"type": "session_ended", "data": {"reason": reason}}
            )
        except Exception:
            logger.exception("[SESSION END] failed to publish session_ended")

    @property
    def barge_in_enabled(self) -> bool:
        """Whether barge-in (reversible suspend on user speech) is enabled
        for this deployment via the BARGE_IN_ENABLED env var."""
        return self._barge_in_enabled

    @property
    def is_suspended(self) -> bool:
        """Whether playback is currently suspended awaiting a barge-in decision."""
        return self._is_speaking and not self._play_allowed.is_set()

    @property
    def is_listening(self) -> bool:
        """Whether the pipeline is actively listening for user audio."""
        return self._is_listening

    @property
    def turn_anchor_ts(self) -> float:
        """Timestamp (perf_counter) of the turn's ground zero (stt_end), for analytics."""
        return self._turn_stt_end_ts

    def _begin_turn_analytics(self, turn_id: Optional[str]) -> None:
        """Establish analytics ground zero for a turn.

        Every stage event is reported as ``elapsed_ms`` relative to this
        timestamp, and every TTS timing event is gated on it being set, so a
        turn without an anchor records a full set of zeros rather than nothing
        — which reads on the dashboard as "the pipeline took 0ms", not as
        "unmeasured".

        Called from two places, deliberately:

        * the STT final branch, where ground zero is stt_end (the transcript is
          locked in and the pipeline starts working) — earlier and more
          accurate than the moment the agent dequeues it; and
        * ``audio_in()``, the single turn boundary, for any turn that reaches
          the agent WITHOUT having passed through that branch. Typed turns and
          committed barge-ins (voice and text alike) both do: the barge-in path
          ``continue``s before the anchor is set, and the user_text path never
          touches the STT stream at all.
        """
        self._turn_stt_end_ts = time.perf_counter()
        self._turn_id = turn_id
        self._turn_bridge_tts_first_byte_emitted = False
        self._turn_response_tts_first_byte_emitted = False

    def _anchor_turn_if_unanchored(self, event: "TranscriptEvent") -> None:
        """Anchor a turn that reached the agent without passing the STT branch.

        Only fires when no anchor is standing, so a spoken turn keeps stt_end as
        its ground zero rather than being re-anchored to the later moment the
        agent dequeued it. ``_reset_turn_analytics()`` clears the anchor at the
        end of every turn, so "no anchor standing" reliably means "this turn
        never got one".
        """
        if self._turn_stt_end_ts == 0:
            self._begin_turn_analytics(getattr(event, "transcript_id", None))

    async def _emit_analytics_event(self, stage: str, elapsed_ms: float, **kwargs) -> None:
        """Emit a raw timestamped analytics event relative to stt_end."""
        turn_id = self._turn_id or ""
        await self._room.publish_data({
            "type": "analytics",
            "data": {
                "stage": stage,
                "turn_id": turn_id,
                "elapsed_ms": round(elapsed_ms, 2),
                **kwargs,
            }
        })

    def close_transcript_gate(self) -> None:
        """Close the transcript gate — suppresses transcripts until reopened."""
        if not self._transcript_gate_closed:
            logger.info("[GATE] Closing transcript gate")
            self._transcript_gate_closed = True
            # Cancel pending debounce to prevent stale emission
            if self._debounce_task:
                self._debounce_task.cancel()
                self._debounce_task = None
            self._pending_transcript = None

    def open_transcript_gate(self) -> None:
        """Re-open the transcript gate. Drains stale items and applies
        a post-gate settling period to let echo from browser playback clear."""
        # The agent has stopped talking, so there is nothing left to duck.
        # Clearing it here guarantees the next utterance starts at full volume
        # even if the un-duck signal never arrived (STT hiccup, reconnect).
        self.unduck_speech()
        if self._transcript_gate_closed:
            drained = 0
            while not self._transcript_queue.empty():
                try:
                    self._transcript_queue.get_nowait()
                    drained += 1
                except asyncio.QueueEmpty:
                    break
            if drained > 0:
                logger.info(f"[GATE] Drained {drained} stale transcript(s)")

            self._room.flush_audio_queue()

            logger.info("[GATE] Opening transcript gate")
            self._transcript_gate_closed = False

    @property
    def is_gate_closed(self) -> bool:
        return self._transcript_gate_closed

    @property
    def session_id(self) -> str:
        """The current session ID."""
        return self._session_id

    async def start(self) -> None:
        """
        Start the audio pipeline.

        This begins:
        - Listening to LiveKit audio tracks
        - Streaming audio to STT service
        - Processing transcript events
        """
        if self._is_listening:
            logger.warning("Audio pipeline already started")
            return

        logger.info(f"Starting audio pipeline for session {self._session_id}")

        self._is_listening = True
        self._stop_speaking_event.clear()

        # Start the STT streaming task
        self._stt_stream_task = asyncio.create_task(self._run_stt_stream())

        logger.info("Audio pipeline started")

    async def stop(self) -> None:
        """Stop the audio pipeline and cleanup resources."""
        logger.info("Stopping audio pipeline")

        self._is_listening = False

        # Stop any ongoing TTS
        await self.stop_speaking()

        # Cancel STT stream task
        if self._stt_stream_task:
            self._stt_stream_task.cancel()
            try:
                await self._stt_stream_task
            except asyncio.CancelledError:
                pass
            self._stt_stream_task = None

        logger.info("Audio pipeline stopped")

    async def _run_stt_stream(self) -> None:
        """
        Run the STT streaming loop in the background with automatic reconnection.

        On recoverable errors (socket closed, unavailable), it will retry with
        exponential backoff up to max_retries times.

        Also handles stale connections by reconnecting STT if needed.
        """
        max_retries = 5
        base_delay = 1.0  # seconds
        retry_count = 0

        while self._is_listening and retry_count < max_retries:
            try:
                # Always check STT health before starting/restarting stream
                # This catches stale connections from service restarts (e.g., cluster restart)
                should_reconnect = retry_count > 0 or not self._stt.is_connected

                if not should_reconnect:
                    try:
                        logger.debug("Checking STT health before starting stream...")
                        is_healthy = await asyncio.wait_for(
                            self._stt.health_check(),
                            timeout=5.0
                        )
                        if not is_healthy:
                            logger.warning("STT health check returned unhealthy, will reconnect")
                            should_reconnect = True
                        else:
                            logger.debug("STT health check passed")
                    except Exception as e:
                        logger.warning(f"STT health check failed: {e}, will reconnect")
                        should_reconnect = True

                if should_reconnect:
                    logger.info("Reconnecting to STT service...")
                    try:
                        await self._stt.disconnect()
                    except Exception:
                        pass
                    await self._stt.connect()
                    logger.info("STT reconnection successful")

                await self._run_stt_stream_inner()
                # If we exit cleanly (pipeline stopped), don't restart
                if not self._is_listening:
                    break
                # Clean return while still listening means the audio source
                # ended (e.g., participant unsubscribed their track on mute).
                # Restart immediately so STT is ready for the next utterance,
                # and reset retry_count since this is not an error path.
                retry_count = 0
                logger.info("STT stream ended (audio paused), restarting...")
            except asyncio.CancelledError:
                logger.debug("STT stream task cancelled")
                break
            except Exception as e:
                error_str = str(e)
                # Check for recoverable gRPC errors
                is_recoverable = any(x in error_str for x in [
                    "Socket closed",
                    "UNAVAILABLE",
                    "Connection reset",
                    "Stream removed",
                    "EOF",
                    "Received RST_STREAM",
                ])

                if is_recoverable and self._is_listening:
                    retry_count += 1
                    delay = base_delay * (2 ** (retry_count - 1))  # Exponential backoff
                    logger.warning(
                        f"STT stream error (attempt {retry_count}/{max_retries}): {e}. "
                        f"Reconnecting in {delay:.1f}s..."
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(f"STT stream fatal error: {e}", exc_info=True)
                    break

        if retry_count >= max_retries:
            logger.error(f"STT stream failed after {max_retries} retries, giving up")

    async def _run_stt_stream_inner(self) -> None:
        """
        Inner STT streaming logic.

        This method:
        1. Subscribes to LiveKit audio
        2. Streams to external STT service
        3. Publishes ALL transcripts to LiveKit (for frontend display)
        4. Queues ONLY final transcripts for agent consumption
        """
        logger.info("STT stream task started, waiting for audio...")
        chunk_count = 0

        async def audio_generator():
            """Generate audio chunks from LiveKit, muting during gate/settling."""
            nonlocal chunk_count
            logger.info("Audio generator started, subscribing to LiveKit audio...")
            async for audio_data in self._room.subscribe_to_audio():
                if not self._is_listening:
                    logger.info("Pipeline stopped listening, ending audio generator")
                    break
                # Skip sending audio to STT while agent is speaking — EXCEPT in
                # barge-in mode, where we must keep feeding STT so its VAD can
                # detect the user interrupting. AEC cancels the agent's own
                # audio from the mic so this does not self-trigger.
                if (
                    self._transcript_gate_closed
                    and self._tts_enabled
                    and not self._barge_in_enabled
                ):
                    continue
                chunk_count += 1
                if chunk_count == 1:
                    logger.info(f"First audio chunk received ({len(audio_data)} bytes)")
                elif chunk_count % 100 == 0:
                    logger.debug(f"Streamed {chunk_count} audio chunks to STT")
                yield audio_data
            logger.info(f"Audio generator ended after {chunk_count} chunks")

        # Stream to STT service and process events
        # Pass sample_rate from LiveKit (STT service will resample if needed)
        sample_rate = self._room.audio_sample_rate
        logger.info(f"Starting STT stream_transcribe with sample_rate={sample_rate}Hz...")
        async for event in self._stt.stream_transcribe(
            audio_generator(),
            session_id=self._session_id,
            participant_id=self._participant_id,
            sample_rate=sample_rate,
            # Tell STT the language whenever the conversation has a declared
            # one — the deployment pin, or the language the plan declares. This
            # is the single biggest accuracy lever available on short
            # utterances: auto-detect runs on a very short window, and a wrong
            # guess does not just mis-hear, it translates.
            #
            # With nothing declared this stays None and STT auto-detects, which
            # yields the per-utterance detection signal for free (RFC §6). What
            # it deliberately does NOT do is feed a DETECTED language back:
            # a pinned session reports that pin as its detection with
            # confidence 1.0, so an early wrong guess would confirm itself
            # forever. A declaration is a fact; a detection is not.
            language_provider=self._resolve_stt_language,
        ):
            logger.debug(f"STT event: text='{event.text[:50] if event.text else ''}...', is_final={event.is_final}, speech_started={event.speech_started}")

            # A voice barge-in was committed for this utterance: its final IS
            # the interrupting turn. Handled before the gate check because
            # commit_interrupt() opens the gate asynchronously (the speech
            # worker does it on the way out), so by the time the final lands the
            # gate may be either side — and the turn must be delivered, and
            # flagged, either way.
            # A voice barge-in was suspended for this utterance: its final
            # decides what happens to the held speech. Handled before the gate
            # check because the gate may open underneath us.
            if self._barge_in_committed_tid is not None:
                if event.transcript_id != self._barge_in_committed_tid:
                    # A different utterance started first, so the interrupted
                    # one will never produce a final (STT dropped it or
                    # reconnected). Resume rather than leave the agent muted.
                    logger.info("[BARGE-IN] Interrupted utterance ended without a final — resuming")
                    self._barge_in_committed_tid = None
                    self.unduck_speech()
                    self.resume_speech()
                elif event.is_final:
                    self._barge_in_committed_tid = None
                    await self._publish_user_transcript(event)
                    text = (event.text or "").strip()
                    if text:
                        # A real turn. Discard the rest of what the agent was
                        # saying and hand the transcript over.
                        logger.info(f"[BARGE-IN] Committing — '{text[:40]}'")
                        self.commit_interrupt()
                        self._deliver_barge_in_turn(text)
                    else:
                        # The user made a noise long enough to look like speech
                        # but said nothing transcribable. Stopping the agent's
                        # turn over that is the worse error, so take it back:
                        # playback resumes from exactly where it paused.
                        logger.info("[BARGE-IN] False interruption (no transcript) — resuming")
                        self.unduck_speech()
                        self.resume_speech()
                    continue

            # While the agent is speaking, the turn gate is closed.
            if self._transcript_gate_closed and self._tts_enabled:
                if event.speech_started:
                    self._current_utterance_speaker = self._room.current_audio_speaker

                # Turn-based mode (no barge-in): ignore user audio while speaking.
                if not self._barge_in_enabled:
                    continue

                text = (event.text or "").strip()

                # ── Voice barge-in ────────────────────────────────────────
                # One rule: the STT service's VAD has heard enough continuous
                # speech (BARGE_IN_MIN_SPEECH_MS) that this is an interruption
                # and not a backchannel. Stop talking. That's the whole
                # decision.
                #
                # What this deliberately does NOT do, and why:
                #
                #  * It does not wait for a transcript. A partial costs a whole
                #    decode (~400-550ms measured on prod) before the agent could
                #    even react, and short utterances are exactly where whisper
                #    is least reliable — a 0.5s German "ja" came back as "down".
                #  * It does not ask an LLM whether the interruption was
                #    "meaningful". That added ~470ms on top of the decode, and
                #    hiding that latency needed speculative execution, banked
                #    verdicts and staleness guards — machinery whose leaked
                #    state then silently swallowed real interruptions.
                #  * It does not pause-then-maybe-resume. Nothing is suspended
                #    on a guess, so nothing has to be undone: a backchannel
                #    never dents playback at all, rather than stopping the agent
                #    for half a second and starting it again.
                #
                # Duration is the signal every voice stack uses for this
                # (LiveKit's min_interruption_duration, Pipecat's equivalent),
                # and it is the only one that is language-agnostic: "mhm", "ja"
                # and "aha" are short everywhere, with no word list to maintain.
                # 1. The user started making sound: duck immediately. No
                #    transcript, no decision, nothing to undo later.
                if event.speech_started and self._audio_active:
                    self.duck_speech()

                # 2. They stopped without ever clearing the threshold — a
                #    backchannel. Come back up; the agent never lost its turn.
                if event.speech_ended and self._barge_in_committed_tid is None:
                    self.unduck_speech()

                # 3. They kept going past BARGE_IN_MIN_SPEECH_MS: they are
                #    taking the floor. Go quiet — but SUSPEND rather than
                #    discard, so the held sentence can still be resumed if the
                #    utterance turns out to be nothing (see the final above).
                if event.speech_confirmed and self._audio_active:
                    logger.info("[BARGE-IN] Interruption confirmed by VAD — yielding the floor")
                    self._barge_in_committed_tid = event.transcript_id
                    self.suspend_speech()
                    await self._emit_barge_in_debug(
                        "✋ Barge-in — user has the floor, listening",
                        decision="detecting",
                        transcript=text,
                    )

                # Keep the on-screen transcript live either way.
                await self._publish_user_transcript(event)
                continue

            # 1. Publish ALL transcripts to LiveKit for frontend display.
            await self._publish_user_transcript(event)

            # 2. Handle speech_started for barge-in
            if event.speech_started:
                await self._handle_speech_started()

            # 3. Queue ONLY final transcripts for agent (with optional debouncing)
            # When TTS is disabled, gate still discards finals even though
            # partials are allowed through (lighter turn management).
            if event.is_final and event.text.strip():
                logger.info(f"Final transcript: '{event.text}'")

                # Capture stt_end and reset per-turn state
                self._begin_turn_analytics(getattr(event, 'transcript_id', None))

                # Ground zero = stt_end (transcript locked in, pipeline processing starts)
                # vad_trigger is emitted as a negative value showing how long the user spoke
                asyncio.create_task(self._emit_analytics_event("stt_end", 0.0))
                if self._turn_stt_start_ts > 0:
                    vad_elapsed = (self._turn_stt_start_ts - self._turn_stt_end_ts) * 1000  # negative
                    asyncio.create_task(self._emit_analytics_event("vad_trigger", vad_elapsed))

                # Decode diagnostics, when the STT service is running with them
                # on. Flattened here rather than shipped as nested JSON so the
                # backend aggregator stays a flat switch like every other stage.
                decode_fields = _decode_diagnostic_fields(
                    getattr(event, "decode_diagnostics", "")
                )
                if decode_fields:
                    asyncio.create_task(
                        self._emit_analytics_event("stt_decode", 0.0, **decode_fields)
                    )

                # Discard finals while agent is speaking
                if self._transcript_gate_closed:
                    logger.info(f"[GATE] Discarding final (gate closed): '{event.text}'")
                    continue

                # Apply debouncing to aggregate rapid successive finals
                if self._debounce_window_ms > 0:
                    await self._debounce_transcript(event)
                else:
                    await self._transcript_queue.put(event)

    async def _publish_user_transcript(self, event: TranscriptEvent) -> None:
        """Publish a user transcript (partial or final) to LiveKit for frontend
        display, with speaker attribution.

        Uses current_audio_speaker as ground truth; if it differs from the
        locked utterance speaker, a mid-stream speaker change occurred (no
        silence gap), so update it. event.participant_id from STT is ignored —
        it's the value passed at stream init, not the actual speaker.
        """
        current_speaker = self._room.current_audio_speaker
        if current_speaker and current_speaker != self._current_utterance_speaker:
            self._current_utterance_speaker = current_speaker
        speaker_id = self._current_utterance_speaker or current_speaker or self._participant_id
        speaker_name = self._room.get_participant_name(speaker_id) or speaker_id
        await self._room.publish_data({
            "type": "transcript",
            "data": {
                "text": event.text,
                "is_final": event.is_final,
                "transcript_id": event.transcript_id,
                # Speaker attribution (who spoke)
                "speaker_id": speaker_id,
                "speaker_name": speaker_name,
                "source": "user_speech",
                # Backwards compat
                "participant_id": speaker_id,
            },
        })

    async def _handle_speech_started(self) -> None:
        """Handle VAD speech_started signal (potential barge-in)."""
        # Capture stt_start timestamp for analytics
        self._turn_stt_start_ts = time.perf_counter()

        # Lock in the speaker identity at the START of each utterance
        self._current_utterance_speaker = self._room.current_audio_speaker
        logger.debug(f"Speech started detected - locked speaker: {self._current_utterance_speaker}")

        # Barge-in is NOT decided here. speech_started fires on the first VAD
        # frame over threshold, which a cough or a door clears; the interruption
        # signal is speech_confirmed (sustained voiced audio), handled in
        # _run_stt_stream_inner.

        # No barge-in while agent is speaking (gate closed)
        if self._interrupt_mode == "none" and self._transcript_gate_closed:
            logger.debug("[GATE] speech_started during closed gate (mode=none) - skipping callbacks")
            return

        # Fire all registered callbacks
        for callback in self._speech_started_callbacks:
            try:
                await callback()
            except Exception as e:
                logger.error(f"Error in speech_started callback: {e}")

    async def _debounce_transcript(self, event: TranscriptEvent) -> None:
        """Debounce rapid successive final transcripts.

        If another final comes within debounce_window_ms, aggregate them.
        This is a secondary defense layer against STT fragmentation.
        """
        current_time = time.time()

        if self._pending_transcript is None:
            # First transcript - start debounce window
            self._pending_transcript = event
            self._pending_transcript_time = current_time

            # Schedule delayed emission
            if self._debounce_task:
                self._debounce_task.cancel()
            self._debounce_task = asyncio.create_task(
                self._emit_debounced_transcript()
            )
        else:
            # Aggregate with pending transcript. Carry the language detection from
            # whichever fragment detected more confidently, so debouncing never
            # drops the acoustic signal.
            combined_text = f"{self._pending_transcript.text} {event.text}".strip()
            if event.language_confidence >= self._pending_transcript.language_confidence:
                detected_language = event.detected_language
                language_confidence = event.language_confidence
            else:
                detected_language = self._pending_transcript.detected_language
                language_confidence = self._pending_transcript.language_confidence
            self._pending_transcript = TranscriptEvent(
                text=combined_text,
                is_final=True,
                transcript_id=self._pending_transcript.transcript_id,
                participant_id=event.participant_id,
                confidence=min(self._pending_transcript.confidence, event.confidence),
                timestamp_ms=event.timestamp_ms,
                speech_started=False,
                detected_language=detected_language,
                language_confidence=language_confidence,
            )
            logger.info(f"Debounced: aggregated to '{combined_text}'")

            # Reset debounce timer
            if self._debounce_task:
                self._debounce_task.cancel()
            self._debounce_task = asyncio.create_task(
                self._emit_debounced_transcript()
            )

    async def _emit_debounced_transcript(self) -> None:
        """Emit pending transcript after debounce window expires."""
        try:
            await asyncio.sleep(self._debounce_window_ms / 1000.0)
            if self._pending_transcript:
                logger.info(f"Emitting debounced transcript: '{self._pending_transcript.text}'")
                await self._transcript_queue.put(self._pending_transcript)
                self._pending_transcript = None
        except asyncio.CancelledError:
            pass  # Debounce was reset - new transcript came in

    def _handle_data_message(self, participant_id: str, data: bytes) -> None:
        """
        Handle incoming data channel message from LiveKit.

        This processes text messages sent via the data channel (e.g., from
        the frontend chat input) and queues them as transcript events.

        Args:
            participant_id: Identity of the participant who sent the message (LiveKit identity)
            data: Raw bytes of the message (JSON encoded)
        """
        try:
            message = json.loads(data.decode("utf-8"))

            # Session-end wrap-up (issue #198): backend asks the agent to wind down.
            # Dispatch to the registered handler (run.py) while the loop is still live
            # so it can speak a final turn before the session locks down.
            if message.get("type") == "session_end":
                # Log receipt unconditionally so it's possible to tell "signal arrived"
                # apart from "handler ran" when diagnosing a missing farewell.
                logger.info(
                    f"[SESSION END] data message received from backend "
                    f"(handler_registered={self._session_end_handler is not None})"
                )
                if self._session_end_handler:
                    reason = message.get("reason", "session_end")
                    # Default matches the backend's GRACEFUL_CLOSE_WAIT_MS (30s) — the
                    # backend always sends deadline_ms, but a mismatched fallback would
                    # silently give a wrap_up agent half its real budget (issue #198).
                    deadline_ms = int(message.get("deadline_ms", 30000))
                    asyncio.create_task(self._session_end_handler(reason, deadline_ms))
                return

            # Handle user_text messages from frontend
            if message.get("type") == "user_text":
                # Handle both old format (data as string) and new format (data as object)
                data_field = message.get("data", "")
                if isinstance(data_field, dict):
                    # New format: { text: string, correlation_id?: string }
                    text = data_field.get("text", "").strip()
                    correlation_id = data_field.get("correlation_id")
                else:
                    # Old format: data is the text string directly
                    text = str(data_field).strip()
                    correlation_id = None

                if text:
                    # Use envelope's participant_id if available (actual username from frontend)
                    # Fall back to LiveKit callback participant_id ("human") if not present
                    envelope_participant_id = message.get("participant_id") or participant_id
                    # Also get the transcript_id from envelope if present (for deduplication)
                    envelope_transcript_id = message.get("transcript_id") or str(uuid.uuid4())

                    logger.info(f"Received text message from {envelope_participant_id}: {text[:50]}...")

                    # Create a transcript event for the text message
                    event = TranscriptEvent(
                        text=text,
                        is_final=True,
                        participant_id=envelope_participant_id,
                        transcript_id=envelope_transcript_id,
                        confidence=1.0,
                        timestamp_ms=int(time.time() * 1000),
                        speech_started=False,
                    )

                    # Echo the received text back to LiveKit so the frontend
                    # shows it. Done unconditionally (even if the agent later
                    # decides to RESUME rather than react): the bubble is the
                    # recorded user turn, exactly like a voice transcript, and
                    # the agent's barge-in verdict is recorded alongside it.
                    asyncio.create_task(self._echo_received_text(text, envelope_participant_id, envelope_transcript_id, correlation_id))

                    # Text barge-in (#278): if barge-in is enabled and a turn is
                    # in flight (still generating or audibly speaking), interrupt
                    # it instead of letting the message sit in the queue until the
                    # turn ends (the deferred-processing problem, #236). Otherwise
                    # — barge-in off, agent idle, or one already in progress —
                    # queue it as a normal next turn. The run loop is a single
                    # consumer, so turns never interleave (serialization, AC#3).
                    #
                    # _barge_in_active also covers an in-progress VOICE barge-in
                    # (suspended, awaiting the STT final): a typed message then
                    # queues rather than racing a second decider against the voice
                    # resolution.
                    if (
                        self._barge_in_enabled
                        and not self._barge_in_resolving
                        and not self._barge_in_active
                        and (self._turn_active or self._is_speaking)
                    ):
                        # Claim the resolution SYNCHRONOUSLY, before yielding to the
                        # loop. _handle_data_message is a sync callback and LiveKit
                        # can dispatch buffered data frames back-to-back in one loop
                        # iteration; if we left the flag for the spawned task to set
                        # (it does, too), a second frame arriving in the same tick
                        # would pass this guard and run a concurrent decider. The
                        # voice path claims it the same way before create_task().
                        self._barge_in_active = True
                        self._barge_in_resolving = True
                        asyncio.create_task(self._handle_text_barge_in(event))
                    else:
                        try:
                            self._transcript_queue.put_nowait(event)
                        except asyncio.QueueFull:
                            logger.warning("Transcript queue full, dropping text message")

        except json.JSONDecodeError:
            logger.debug(f"Received non-JSON data message from {participant_id}")
        except Exception as e:
            logger.error(f"Error handling data message: {e}")

    async def _echo_received_text(
        self, text: str, participant_id: str, transcript_id: str, correlation_id: Optional[str] = None
    ) -> None:
        """
        Echo received text message back to LiveKit for frontend display.

        Args:
            text: The text message to echo
            participant_id: The actual username from envelope (not LiveKit identity)
            transcript_id: The original transcript_id for deduplication
            correlation_id: Optional correlation_id for message delivery confirmation
        """
        try:
            # Use Envelope format: { type, data: { ... } }
            # Use the same transcript_id from the original message for deduplication
            data_payload = {
                "text": text,
                "is_final": True,
                "transcript_id": transcript_id,
                # Speaker attribution (user who typed - actual username)
                "speaker_id": participant_id,
                "speaker_name": participant_id,
                "source": "user_text",
                # Backwards compat
                "participant_id": participant_id,
            }

            # Include correlation_id if provided for message delivery confirmation
            if correlation_id:
                data_payload["correlation_id"] = correlation_id

            await self._room.publish_data({
                "type": "transcript",
                "data": data_payload,
            })
        except Exception as e:
            logger.error(f"Error echoing text message: {e}")

    async def audio_in(self) -> AsyncIterator[TranscriptEvent]:
        """
        Yield FINAL transcripts from user speech.

        This is the main input method for agents. Partial transcripts are
        automatically published to LiveKit for frontend display - agents
        only receive final transcripts ready for processing.

        Note: Barge-in (speech_started) is handled via callbacks registered
        with on_speech_started(), not through this iterator.

        Yields:
            TranscriptEvent with:
            - text: Final transcribed text
            - is_final: Always True (partials filtered out)
            - transcript_id: Groups related transcript events
            - confidence: Confidence score (0.0-1.0)

        Example:
            ```python
            async for event in self.audio.audio_in():
                # event.is_final is always True
                # Partials already sent to LiveKit for frontend

                transcript_id = f"response_{uuid.uuid4().hex[:8]}"
                accumulated = ""

                async for chunk in llm.stream(event.text):
                    accumulated += chunk
                    # Stream to frontend
                    await self.audio.publish_text(accumulated, is_final=False, transcript_id=transcript_id)

                # Mark final and speak
                await self.audio.publish_text(accumulated, is_final=True, transcript_id=transcript_id)
                await self.audio.speak(accumulated)
            ```
        """
        if not self._is_listening:
            raise RuntimeError(
                "Audio pipeline not started. Call start() first or use run_agent()."
            )

        while self._is_listening:
            # A committed barge-in is delivered out-of-band (not via the
            # transcript queue) so it survives the gate drain that runs when the
            # interrupted speech worker exits. Yield it first.
            if self._pending_barge_in is not None:
                event = self._pending_barge_in
                self._pending_barge_in = None
                self._anchor_turn_if_unanchored(event)
                yield event
                continue
            try:
                # Get transcript event with timeout
                event = await asyncio.wait_for(
                    self._transcript_queue.get(),
                    timeout=1.0,
                )

                # [GATE DISABLED] AEC handles echo cancellation at audio level
                self._anchor_turn_if_unanchored(event)
                yield event

            except asyncio.TimeoutError:
                # No event available, continue waiting
                continue
            except asyncio.CancelledError:
                break

    # =========================================================================
    # OUTPUT METHODS - DECOUPLED
    # =========================================================================
    #
    # The SDK provides two independent output methods:
    #
    # 1. publish_text() - Send text to frontend for real-time display
    #    - Independent of TTS
    #    - Supports streaming chunks with transcript_id for grouping
    #    - Frontend accumulates chunks and replaces by transcript_id
    #
    # 2. speak() - Send text to TTS for audio synthesis
    #    - Independent of frontend display
    #    - Handles sentence buffering and streaming TTS
    #    - Only called when TTS is available and desired
    #
    # This decoupling allows:
    # - Text-only responses (no TTS)
    # - Audio-only responses (no frontend)
    # - Combined responses with independent control
    # =========================================================================

    async def publish_text(
        self,
        text: str,
        is_final: bool = False,
        transcript_id: Optional[str] = None,
    ) -> None:
        """
        Publish text to frontend for display (independent of TTS).

        This method sends text to the LiveKit data channel for frontend display.
        It does NOT trigger TTS synthesis - use speak() for that.

        Args:
            text: The text to display. For streaming, this should be accumulated
                  text (frontend replaces by transcript_id).
            is_final: Whether this is the final chunk for this transcript_id.
            transcript_id: Groups related chunks. Frontend replaces previous
                          chunks with the same ID.

        Example:
            ```python
            transcript_id = f"response_{uuid.uuid4().hex[:8]}"
            accumulated = ""

            async for chunk in llm.stream(prompt):
                accumulated += chunk
                await self.audio.publish_text(
                    accumulated,
                    is_final=False,
                    transcript_id=transcript_id
                )

            # Mark final
            await self.audio.publish_text(
                accumulated,
                is_final=True,
                transcript_id=transcript_id
            )
            ```
        """
        await self._room.publish_data({
            "type": "agent_text",
            "data": {
                "text": text,
                "is_final": is_final,
                "transcript_id": transcript_id or str(uuid.uuid4()),
                "agent_id": self._agent_id,
                "agent_name": self._agent_name,
                "source": "agent_response",
            },
        })

    async def speak(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[float] = None,
        language: Optional[str] = None,
    ) -> None:
        """
        Send text to TTS for audio synthesis (independent of frontend display).

        This method sends text to the TTS service and publishes the resulting
        audio to LiveKit. It does NOT publish text to the frontend - use
        publish_text() for that.

        Args:
            text: Complete text to synthesize. Should be the full final message,
                  not individual chunks.
            voice: Optional voice override (provider-specific)
            speed: Speech rate (0.5-2.0, default 1.0)
            language: Optional ISO 639-1 language code (e.g., "en", "de").
                      If None, uses the TTS_LANGUAGE env var or provider default.

        Example:
            ```python
            # Stream text to frontend as chunks arrive
            accumulated = ""
            async for chunk in llm.stream(prompt):
                accumulated += chunk
                await self.audio.publish_text(accumulated, is_final=False, transcript_id=tid)

            # Mark as final
            await self.audio.publish_text(accumulated, is_final=True, transcript_id=tid)

            # Send final text to TTS (separately from frontend display)
            if accumulated.strip():
                await self.audio.speak(accumulated)
            ```
        """
        if not text.strip():
            return

        if not self._tts_enabled:
            logger.debug("TTS disabled (TTS_ENABLED=false), skipping speak()")
            return

        if self._tts is None:
            logger.debug("TTS not available, skipping speak()")
            return

        # Resolve language: explicit param > instance default (from env) > None (provider default)
        if language is None:
            language = self._tts_language
        # Resolve voice the same way (per-stream override > env seed > provider default)
        if voice is None:
            voice = self._tts_voice
        # …and rate, so a direct speak() follows the turn's rate like the queue does.
        if speed is None:
            speed = self._tts_speed

        logger.info(f"[TTS] speak() called with text: {text[:50]}... lang={language}")
        self._is_speaking = True
        self._stop_speaking_event.clear()
        self._play_allowed.set()
        self.close_transcript_gate()

        try:
            await self._speak_sentence(text, voice, speed, language)
        finally:
            self._is_speaking = False
            self._audio_active = False
            self.open_transcript_gate()

    @property
    def has_tts(self) -> bool:
        """Whether TTS is available for audio synthesis."""
        return self._tts is not None and self._tts_enabled

    async def _speak_sentence(
        self,
        sentence: str,
        voice: Optional[str] = None,
        speed: Optional[float] = None,
        language: Optional[str] = None,
        source: str = "response",
    ) -> None:
        """
        Send a sentence to TTS and publish audio to LiveKit with retry logic.

        Args:
            sentence: Complete sentence to speak
            voice: Optional voice override
            speed: Speech rate
            language: Optional ISO 639-1 language code (e.g., "en", "de")
            source: Sentence origin — "bridge" or "response" (for analytics)
        """
        if not sentence.strip():
            return

        logger.info(f"[TTS] Speaking {source} sentence: {sentence[:50]}...")

        max_retries = 3
        base_delay = 0.5  # seconds

        for attempt in range(max_retries):
            try:
                async for chunk in self._tts.synthesize_stream(
                    text=sentence,
                    session_id=self._session_id,
                    voice=voice,
                    speed=speed if speed is not None else self._tts_speed,
                    language=language,
                ):
                    if self._stop_speaking_event.is_set():
                        logger.info("TTS interrupted mid-sentence")
                        return  # Don't retry if intentionally interrupted

                    # Emit first-byte analytics + latency-budget check (once per
                    # source per turn). Shared with the prefetched path via
                    # _emit_first_byte so both report against the #304 A1 budget.
                    self._emit_first_byte(source)

                    self._audio_active = True
                    await self._room.publish_audio(chunk.audio_data)

                # Success - exit retry loop
                return

            except Exception as e:
                error_str = str(e)
                is_recoverable = any(x in error_str for x in [
                    "Socket closed",
                    "UNAVAILABLE",
                    "Connection reset",
                    "Stream removed",
                ])

                if is_recoverable and attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)
                    logger.warning(
                        f"TTS error (attempt {attempt + 1}/{max_retries}): {e}. "
                        f"Retrying in {delay:.1f}s..."
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(f"TTS error speaking sentence: {e}")
                    return

    def _drain_speech_queue(self) -> None:
        """Drop all queued sentences so they don't play after interruption."""
        while not self._speech_queue.empty():
            try:
                self._speech_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def stop_speaking(self) -> None:
        """
        Hard-stop current TTS playback (destructive).

        Call this when the user starts speaking (barge-in, non-reversible) to
        immediately stop agent speech. Drains queued sentences, discards the
        held utterance, and flushes the playout buffer so audio does not keep
        playing from the buffer after the producer stops.

        For reversible barge-in (suspend → evaluate → resume/commit), use
        suspend_speech()/resume_speech()/commit_interrupt() instead.
        """
        if not self._is_speaking:
            return

        logger.info("Stopping TTS playback")
        self._disarm_suspend_watchdog()

        # Teleprompter: freeze the highlight at the playhead before we discard
        # the held utterance (reads spoken_char from _cur_cursor/_cur_audio).
        self._emit_speech_progress("interrupted")

        self._drain_speech_queue()
        self._cur_audio = b""
        self._cur_cursor = 0
        self._audio_active = False
        self._stop_speaking_event.set()
        # Unblock the playback loop if it was suspended, so it observes the stop.
        self._play_allowed.set()
        # Drop already-buffered-but-unplayed audio from the output source.
        self._room.clear_playout()

        # Wait briefly for TTS to notice interruption
        await asyncio.sleep(0.05)

    # ─────────────────────────────────────────────────────────────────────
    # Barge-in: reversible suspend / resume / commit
    # ─────────────────────────────────────────────────────────────────────

    def duck_speech(self) -> None:
        """Drop the agent's own volume because the user has started speaking.

        Reversible and instant — it acts on the VAD's first frame, with no
        transcript and no decision. Being wrong is free: a cough ducks playback
        for a few hundred milliseconds and the agent carries on mid-sentence,
        never having lost its turn.
        """
        if self._ducked or self._barge_in_duck_gain >= 1.0:
            return
        self._ducked = True
        logger.info(f"[BARGE-IN] Ducking to {self._barge_in_duck_gain:.0%} — user is speaking")

    def unduck_speech(self) -> None:
        """Restore full volume: the user stopped without taking the floor."""
        if not self._ducked:
            return
        self._ducked = False
        logger.info("[BARGE-IN] Restored volume — user stopped without interrupting")

    def suspend_speech(self) -> None:
        """Suspend playback reversibly (barge-in reflex).

        Stops feeding the track and flushes the playout buffer so the user
        stops hearing the agent promptly, but KEEPS the held utterance, the
        playhead, and the queued sentences so playback can resume from exactly
        where it stopped. The transcript gate stays closed — the STT loop keeps
        handling the interruption directly (see _run_stt_stream_inner) while we
        decide whether to commit or resume.

        No-op if not currently speaking or already suspended.
        """
        if not self._is_speaking or not self._play_allowed.is_set():
            return

        # Rewind the playhead to what the user actually heard: the unplayed tail
        # sitting in the output buffer (which we are about to clear) was pushed
        # but never reached the speaker, so resume should start before it.
        queued_ms = self._room.queued_playout_ms
        queued_bytes = (
            int(queued_ms * _TTS_SAMPLE_RATE / 1000) * _BYTES_PER_SAMPLE
        )
        self._cur_cursor = max(0, self._cur_cursor - queued_bytes)

        self._play_allowed.clear()
        self._audio_active = False
        self._room.clear_playout()
        # Teleprompter: freeze the highlight at the playhead the user heard.
        self._emit_speech_progress("interrupted")
        # Safety net: auto-resume if no final transcript ever resolves this.
        self._arm_suspend_watchdog()
        logger.info(
            f"[BARGE-IN] Suspended playback at byte {self._cur_cursor}/"
            f"{len(self._cur_audio)} (rewound ~{queued_ms:.0f}ms of unplayed audio)"
        )

    def resume_speech(self) -> None:
        """Resume a suspended utterance from the exact point it was suspended
        (barge-in dismissed). Re-closes the transcript gate since the agent is
        speaking again. No-op if not suspended."""
        if self._play_allowed.is_set():
            return
        self._disarm_suspend_watchdog()
        logger.info("[BARGE-IN] Resuming playback from playhead")
        self.close_transcript_gate()
        self._play_allowed.set()
        # The agent is audibly talking again. suspend_speech() cleared this, and
        # waiting for the playout loop to set it on the next frame leaves a
        # window where a genuine interruption is ignored because a barge-in may
        # only START while _audio_active is True — precisely the "mhm, aber
        # warte..." case, where the real interruption arrives right behind a
        # dismissed backchannel.
        self._audio_active = True
        # Teleprompter: resume the word cursor from the frozen point over the
        # audio that's still left in this sentence.
        self._emit_speech_progress("speaking")

    def commit_interrupt(self) -> None:
        """Commit a barge-in (interruption is legitimate): discard the rest of
        the current utterance and all queued sentences. The transcript gate is
        left OPEN (the user's turn is being processed). After this the speech
        worker observes the stop and exits."""
        logger.info("[BARGE-IN] Committing interruption — discarding remaining speech")
        self._disarm_suspend_watchdog()
        self.unduck_speech()
        # Teleprompter: freeze the highlight at the playhead before discarding.
        # (After a suspend the cursor is already rewound to what was heard.)
        self._emit_speech_progress("interrupted")
        self._drain_speech_queue()
        self._cur_audio = b""
        self._cur_cursor = 0
        self._audio_active = False
        self._stop_speaking_event.set()
        # Unblock the (suspended) playback loop so it observes the stop and exits.
        self._play_allowed.set()
        self._room.clear_playout()

    async def _await_resume_or_stop(self) -> bool:
        """Block while playback is suspended. Returns True if resumed, False if
        the utterance was aborted (commit / hard stop) while suspended."""
        play_waiter = asyncio.create_task(self._play_allowed.wait())
        stop_waiter = asyncio.create_task(self._stop_speaking_event.wait())
        try:
            await asyncio.wait(
                {play_waiter, stop_waiter},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            play_waiter.cancel()
            stop_waiter.cancel()
        return not self._stop_speaking_event.is_set()

    # ─────────────────────────────────────────────────────────────────────
    # Generation-level interrupt (text barge-in #278)
    # ─────────────────────────────────────────────────────────────────────
    #
    # The audio suspend/resume/commit above stops the agent's *voice*. These
    # mirror it one layer up, for the agent's *generation*: the run loop marks
    # a turn active while it consumes process(), and a text barge-in can pause
    # (suspend) or supersede (abort) that turn. The loop only observes these at
    # a yield boundary, so an in-flight tool await always completes first.

    def begin_turn(self) -> None:
        """Mark the start of a turn the run loop is about to consume. Resets the
        suspend/abort state so a stale flag from a prior turn can't leak in."""
        self._turn_active = True
        self._turn_suspended = False
        self._turn_abort.clear()
        self._turn_release.set()

    def end_turn(self) -> None:
        """Mark the end of a turn (generation done and TTS flushed)."""
        self._turn_active = False
        self._turn_suspended = False
        self._turn_abort.clear()
        self._turn_release.set()

    @property
    def is_turn_active(self) -> bool:
        """Whether the run loop is currently consuming a turn (generating or
        speaking). Used to decide whether typed input is a barge-in or a fresh
        turn."""
        return self._turn_active

    @property
    def is_turn_suspended(self) -> bool:
        return self._turn_suspended

    @property
    def is_turn_aborted(self) -> bool:
        return self._turn_abort.is_set()

    def request_turn_suspend(self) -> None:
        """Ask the run loop to pause generation at the next yield boundary.
        No-op if no turn is active."""
        if not self._turn_active:
            return
        self._turn_suspended = True
        self._turn_release.clear()

    def request_turn_resume(self) -> None:
        """Release a generation suspend so the run loop continues the SAME turn
        from exactly where it paused (no work is re-run)."""
        self._turn_suspended = False
        self._turn_release.set()

    def request_turn_abort(self) -> None:
        """Supersede the active turn: the run loop breaks out of process() at the
        next yield boundary. Also releases any suspend so the loop observes it."""
        self._turn_abort.set()
        self._turn_suspended = False
        self._turn_release.set()

    async def await_turn_release(self) -> bool:
        """Block while the turn is suspended. Returns True if it was resumed,
        False if it was aborted (superseded) while suspended."""
        await self._turn_release.wait()
        return not self._turn_abort.is_set()

    def enable_barge_in(self) -> None:
        """Enable barge-in because the agent declares it supports it.

        Honors an explicit BARGE_IN_ENABLED env override: if the operator set
        it (to either value), that wins and this is a no-op. Otherwise the
        agent's declaration turns barge-in on.
        """
        if self._barge_in_env_locked:
            logger.info(
                f"[BARGE-IN] Agent declares support; env override in effect "
                f"(enabled={self._barge_in_enabled})"
            )
            return
        self._barge_in_enabled = True
        logger.info("[BARGE-IN] Enabled from agent declaration")

    def enable_teleprompter(self) -> None:
        """Enable the teleprompter because the agent declares it supports it.

        Honors an explicit STELLA_TELEPROMPTER_ENABLED env override: if the
        operator set it (to either value), that wins and this is a no-op.
        Otherwise the agent's declaration turns emission on.
        """
        if self._teleprompter_env_locked:
            logger.info(
                f"[TELEPROMPTER] Agent declares support; env override in effect "
                f"(enabled={self._teleprompter_enabled})"
            )
            return
        self._teleprompter_enabled = True
        logger.info("[TELEPROMPTER] Enabled from agent declaration")

    def set_barge_in_decider(
        self, decider: Callable[[str], Awaitable["BargeInDecision"]]
    ) -> None:
        """Register the async callback that decides COMMIT vs RESUME for a
        barge-in transcript (wired to the agent's on_barge_in hook)."""
        self._barge_in_decider = decider

    def set_session_end_handler(
        self, handler: Callable[[str, int], Awaitable[None]]
    ) -> None:
        """Register the async callback invoked when the backend signals a graceful
        close ({"type":"session_end"}) over the data channel — wired in run.py to
        run the agent's on_session_ending wrap-up, then shut down (issue #198)."""
        self._session_end_handler = handler

    async def _emit_barge_in_debug(self, content: str, **metadata) -> None:
        """Publish a barge-in debug message to the chat (frontend debug feed)
        so the commit/resume verdict and flow are visible while testing."""
        try:
            await self._room.publish_data({
                "type": "debug",
                "data": {
                    "content": content,
                    "component": "barge_in",
                    "level": "info",
                    "metadata": metadata,
                },
            })
        except Exception as e:
            logger.error(f"[BARGE-IN] Failed to emit debug message: {e}")

    def _emit_playback_state(self, state: str) -> None:
        """Publish an ``agent_playback`` envelope so the client can silence the
        agent track on barge-in.

        Deliberately separate from ``agent_speech_progress``: client silencing is
        a barge-in concern, but the speech-progress envelope is gated on the
        teleprompter flag AND on the sentence having a char span, so driving the
        mute off it would silently no-op when the teleprompter is off or a
        sentence couldn't be located in the published text. This signal is gated
        only on barge-in (the feature that needs it) and carries no char offsets.

        Only the two states that gate the mute are emitted: ``interrupted``
        (silence) and ``speaking`` (un-silence on resume or a fresh utterance).
        """
        if not self._barge_in_enabled:
            return
        if state not in ("speaking", "interrupted"):
            return
        # Progress ticks call through here several times a second; the client
        # only cares about TRANSITIONS (mute / un-mute), so collapse repeats.
        if state == self._last_playback_state:
            return
        self._last_playback_state = state
        payload = {
            "type": "agent_playback",
            "data": {"state": state, "agent_id": self._agent_id},
        }
        try:
            # Ordered, not create_task: this envelope and the speech-progress
            # one are emitted back to back, and two independent tasks would let
            # them reach the wire in scheduler order rather than call order.
            self._room.publish_data_ordered(payload)
        except RuntimeError:
            # No running loop (e.g. sync test context) — skip.
            pass

    def _arm_suspend_watchdog(self) -> None:
        """(Re)arm the watchdog that auto-resumes a suspend that never resolves."""
        self._disarm_suspend_watchdog()
        try:
            self._barge_in_watchdog_task = asyncio.create_task(self._suspend_watchdog())
        except RuntimeError:
            # No running loop (sync test context) — nothing to guard.
            self._barge_in_watchdog_task = None

    def _disarm_suspend_watchdog(self) -> None:
        """Cancel the suspension watchdog (resolution arrived in time)."""
        task = self._barge_in_watchdog_task
        self._barge_in_watchdog_task = None
        if task is not None and not task.done():
            task.cancel()

    async def _suspend_watchdog(self) -> None:
        """Auto-resume a suspend that nothing ever resolves.

        Only the text path suspends playback reversibly, and it resolves on its
        decider — so this fires when that decider hangs or dies. Resuming is the
        safe default: keep talking and drop the interruption rather than discard
        the agent's turn and leave the user in silence.
        """
        try:
            await asyncio.sleep(self._barge_in_suspend_timeout_s)
        except asyncio.CancelledError:
            return
        # Resolved (resumed/committed) while we slept — nothing to do.
        if self._play_allowed.is_set():
            return
        logger.warning(
            f"[BARGE-IN] Suspension watchdog fired after "
            f"{self._barge_in_suspend_timeout_s:.0f}s with no resolving transcript "
            "— auto-resuming"
        )
        # Drop our own ref first so resume_speech()'s disarm is a no-op (no
        # self-cancel of the task currently running).
        self._barge_in_watchdog_task = None
        self._barge_in_active = False
        self._barge_in_resolving = False
        self._pending_barge_in = None
        self._barge_in_committed_tid = None
        self.unduck_speech()
        self.resume_speech()
        await self._emit_barge_in_debug(
            "▶️ Barge-in never resolved (no final transcript) — auto-resumed",
            decision="resume",
        )

    def _estimated_total_bytes(self, span: int) -> int:
        """Byte length to divide the playhead by when mapping bytes to chars.

        Once synthesis is done this is simply what we hold. While it is still
        running, ``len(_cur_audio)`` is a partial total — dividing by it would
        put the playhead at ~100% of the sentence from the very first frame,
        which is exactly the "highlight jumps to the end" bug. So estimate the
        finished length from the sentence's character count at the session's
        measured speaking pace.

        Clamped to never fall BELOW the audio already in hand: underestimating
        pushes the highlight past the end of the sentence, and a highlight that
        runs ahead of the voice is far worse to read than one that trails.
        """
        known = len(self._cur_audio)
        if self._cur_complete or span <= 0:
            return known
        est = int(
            span * self._ms_per_char * _TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE / 1000
        )
        return max(known, est)

    def _calibrate_pace(self, meta: Optional[dict]) -> None:
        """Re-measure ms-per-character from a sentence that just finished.

        Exponential moving average so one odd sentence (a number, an acronym,
        a long pause) cannot swing the estimate, but a genuine change of voice
        or language converges within a few sentences.
        """
        if not meta:
            return
        span = max(0, meta["char_end"] - meta["char_start"])
        total = len(self._cur_audio)
        if span < 8 or total <= 0:
            return  # too short to measure anything trustworthy
        ms = total / (_TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE) * 1000
        measured = ms / span
        if not self._pace_measured:
            # First real sentence of the session: the seed was only ever a
            # placeholder, so adopt the measurement outright. Averaging it in
            # would drag a badly-seeded estimate out over several sentences, and
            # a wrong estimate is what makes the highlight lag then jump when
            # the true length lands.
            self._ms_per_char = measured
            self._pace_measured = True
        else:
            self._ms_per_char = 0.7 * self._ms_per_char + 0.3 * measured

    def _emit_speech_progress(self, state: str, meta: Optional[dict] = None) -> None:
        """Publish an ``agent_speech_progress`` envelope for the teleprompter.

        Drives the on-screen highlight (#241). ``state`` is one of:
          - ``speaking``     — this sentence's audio is now playing (fresh or
                               resumed). Carries ``duration_ms`` = audible time
                               left so the frontend can advance a word cursor.
          - ``spoken``       — the sentence's last frame was *pushed* (not yet
                               necessarily heard — see the contract note at the
                               emission site in ``_play_prefetched``).
          - ``interrupted``  — barge-in froze playback; the highlight stays at
                               the playhead.

        ``spoken_char`` is the absolute character offset reached so far,
        derived from the byte-accurate playhead so the highlight matches what
        the user actually heard. No-op when the teleprompter is disabled or the
        sentence carries no character span.
        """
        # Drive client-side barge-in silencing first, on its own barge-in-gated
        # channel — it must NOT be suppressed by the teleprompter flag or by a
        # missing char span below (see _emit_playback_state).
        self._emit_playback_state(state)
        if not self._teleprompter_enabled:
            return
        meta = meta if meta is not None else self._cur_meta
        if not meta:
            # No character span for this sentence (base._enqueue_sentence could
            # not locate it in the published agent_text) — nothing to anchor the
            # highlight to, so emit nothing.
            return

        char_start = meta["char_start"]
        char_end = meta["char_end"]
        span = max(0, char_end - char_start)
        known = len(self._cur_audio)
        total = self._estimated_total_bytes(span)

        def char_at(byte_offset: int) -> int:
            if total <= 0:
                return char_end
            frac = min(1.0, max(0.0, byte_offset / total))
            return char_start + round(frac * span)

        lead_ms = 0.0
        if state == "spoken":
            spoken_char = target_char = char_end
            duration_ms = 0
        elif state == "interrupted":
            # Freeze at what was actually heard. Deliberately NOT clamped
            # monotonically: a barge-in rewinds the playhead on purpose, and
            # anything already promised past it was never heard.
            spoken_char = target_char = char_at(self._cur_cursor)
            duration_ms = 0
            self._cur_promised = self._cur_cursor
            self._cur_last_char = spoken_char
        else:  # "speaking" — the next CONTIGUOUS stretch of this sentence
            # How far the highlight may be carried: all the audio synthesized so
            # far, but at least one tick's worth. The floor matters at RTF ~1,
            # where the player consumes frames as fast as they arrive so `known`
            # sits barely ahead of the playhead; without it a tick would promise
            # ~20ms of movement followed by a wait — a visibly stepping cursor.
            # Extrapolation is capped at the sentence's estimated end and
            # corrected by the next tick, so the error stays under one tick.
            horizon = self._cur_cursor + int(
                _PROGRESS_TICK_MS * _TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE / 1000
            )
            promise = min(max(known, horizon), total) if total > 0 else known
            # Start where the LAST segment ended, not at the live playhead. The
            # frontend lays segments end to end on the wall clock, so measuring
            # from the playhead would re-describe audio an earlier segment
            # already covered: with a deep jitter buffer every tick re-promised
            # the whole buffer and the schedule ran 2.3-3.3x longer than the
            # sound, which reads as the highlight stalling mid-message.
            start = max(self._cur_promised, self._cur_cursor)
            if promise <= start:
                return  # nothing new to schedule yet
            # _cur_last_char holds the PREVIOUS segment's target, so segments
            # butt exactly. Without this the re-estimated mapping could place
            # this segment's start a character or two before the last one's end
            # and the highlight would flick backwards at every tick boundary.
            spoken_char = max(char_at(start), self._cur_last_char)
            target_char = max(char_at(promise), spoken_char)
            duration_ms = int(
                (promise - start) / (_TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE) * 1000
            )
            # This segment starts where the previous one ended, which is `start`
            # bytes into the stream — already-queued audio must drain first, and
            # so must anything between the playhead and `start`.
            lead_ms = max(0, start - self._cur_cursor) / (
                _TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE
            ) * 1000
            self._cur_promised = promise
            self._cur_last_char = target_char

        # How long until this sentence is actually audible: audio already queued
        # in the output buffer must drain first. Lets the frontend start the word
        # cursor in time with playout rather than with this (earlier) publish.
        try:
            delay_ms = (
                int(self._room.queued_playout_ms + lead_ms) if state == "speaking" else 0
            )
        except Exception:
            delay_ms = 0

        payload = {
            "type": "agent_speech_progress",
            "data": {
                "transcript_id": meta["transcript_id"],
                "char_start": char_start,
                "char_end": char_end,
                "spoken_char": int(spoken_char),
                # Where the highlight should reach by the end of this segment.
                # Equal to char_end only on the tick carrying a sentence's final
                # audio; earlier ticks stop short, because the rest of the
                # sentence is not synthesized yet.
                #
                # COUPLED DEPLOY: a client that ignores this field animates each
                # tick to char_end instead, then starts the next tick further
                # back — i.e. the highlight steps FORWARD then BACK once per
                # tick. Ship the frontend with the agent image; a new frontend
                # against an old agent is fine (no ticks, unchanged behaviour),
                # the reverse is not.
                "target_char": int(target_char),
                "duration_ms": duration_ms,
                "delay_ms": delay_ms,
                "state": state,
                "agent_id": self._agent_id,
            },
        }
        try:
            # Ordered, not create_task — see _emit_playback_state. Consecutive
            # sentences emit spoken(N) then speaking(N+1) microseconds apart
            # under streaming playback; reordering those makes the teleprompter
            # jump backwards.
            self._room.publish_data_ordered(payload)
        except RuntimeError:
            # No running loop (e.g. called from sync test context) — skip.
            pass

    async def _handle_text_barge_in(self, event: TranscriptEvent) -> None:
        """Resolve a typed message that arrived mid-turn (#278).

        Text is a deterministic interruption channel — there is no VAD or
        noise-vs-intent ambiguity and the full utterance is known immediately,
        so unlike the voice path there is no transcript to wait for, no
        min-chars gate, and no suspend watchdog. We still run the SAME decider
        the voice path uses (the agent's on_barge_in / BargeInEvaluator) so the
        agent decides whether to RESUME its current thought or react — matching
        the voice-path decision behavior (AC#2).

        Flow:
          1. Suspend audio (reversible, instant) AND request a generation pause
             at the next tool-safe yield boundary.
          2. Run the decider on the typed text.
          3. RESUME → resume audio + generation; the message is dropped (it was
             judged not actionable), exactly like a voice backchannel.
             COMMIT → commit the audio interrupt, abort the in-flight turn, and
             deliver the text as the next turn (is_barge_in=True).

        Serialized by _barge_in_active / _barge_in_resolving, which the caller
        (_handle_data_message) claims synchronously before spawning this task, so
        two rapid sends — even in the same event-loop tick — can't run concurrent
        deciders. Re-set here too so direct callers (tests) are also covered.
        """
        self._barge_in_active = True
        self._barge_in_resolving = True
        try:
            # 1. Stop the voice now (no-op if TTS is disabled or not yet audible)
            #    and pause generation at the next yield boundary. With TTS off
            #    there is no audio to stop, so the generation pause is what makes
            #    the interruption block only until the answer is generated (AC#4).
            self.suspend_speech()
            # suspend_speech() arms the 8s STT-final watchdog (the voice path
            # needs it because a final may never come). Text resolves right here
            # on the decider, so disarm it: if it fired it would resume_speech()
            # WITHOUT request_turn_resume(), un-muting audio while generation
            # stays paused — a transient blip before a slow-decider COMMIT.
            self._disarm_suspend_watchdog()
            self.request_turn_suspend()

            transcript = event.text
            decider = self._barge_in_decider
            try:
                if decider is not None:
                    decision = await decider(transcript)
                else:
                    decision = BargeInDecision.COMMIT
            except Exception as e:
                logger.error(f"[TEXT BARGE-IN] Decider failed: {e} — committing")
                decision = BargeInDecision.COMMIT

            if decision == BargeInDecision.RESUME:
                logger.info(
                    f"[TEXT BARGE-IN] RESUME — '{transcript[:40]}' was not actionable"
                )
                await self._emit_barge_in_debug(
                    f"🔁 Text barge-in RESUME — judged not actionable, resuming "
                    f"previous turn. Typed: \"{transcript[:100]}\"",
                    decision="resume",
                    transcript=transcript,
                    channel="text",
                )
                self.resume_speech()
                self.request_turn_resume()
                return

            logger.info(f"[TEXT BARGE-IN] COMMIT — interrupting for '{transcript[:40]}'")
            await self._emit_barge_in_debug(
                f"✋ Text barge-in COMMIT — interrupting and processing as a new "
                f"turn: \"{transcript[:100]}\"",
                decision="commit",
                transcript=transcript,
                channel="text",
            )
            # Stop the voice and halt the superseded generation, then hand the
            # typed text to the loop as the next turn. commit_interrupt() is a
            # no-op for audio when TTS is off; request_turn_abort() is what stops
            # the old turn from continuing to emit (AC#5).
            self.commit_interrupt()
            self.request_turn_abort()
            self._deliver_barge_in_turn(transcript, speaker=event.participant_id)
        finally:
            self._barge_in_active = False
            self._barge_in_resolving = False

    def _deliver_barge_in_turn(
        self, transcript: str, speaker: Optional[str] = None
    ) -> None:
        """Deliver a committed interruption as the next user turn, out-of-band.

        NOT via _transcript_queue: an interrupted speech worker's exit runs
        open_transcript_gate(), which drains that queue and would silently drop
        this turn. audio_in() picks up _pending_barge_in first. Shared by the
        voice path (the VAD barge-in block in _run_stt_stream_inner) and the
        text path (_handle_text_barge_in).
        """
        self._pending_barge_in = TranscriptEvent(
            text=transcript,
            is_final=True,
            transcript_id=f"bargein_{uuid.uuid4().hex[:8]}",
            participant_id=speaker or self._current_utterance_speaker or self._participant_id,
            confidence=1.0,
            timestamp_ms=int(time.time() * 1000),
            speech_started=False,
            is_barge_in=True,
        )

    # ─────────────────────────────────────────────────────────────────────
    # Sentence-level streaming TTS
    # ─────────────────────────────────────────────────────────────────────

    def _resolve_stt_language(self) -> Optional[str]:
        """The language to transcribe in, or None to let STT auto-detect.

        Read per utterance, so a plan language declared after the stream opened
        still takes effect on the next one.
        """
        return self._language_pin or self._stt_language

    def set_stt_language(self, language: Optional[str]) -> None:
        """Pin STT transcription to a DECLARED conversation language.

        Only ever called with a declaration (a plan's ``language``, a
        deployment pin) — never with a detected language. See
        ``_resolve_stt_language`` at the STT stream for why that distinction is
        load-bearing. ``None``/``"auto"`` clears the pin back to auto-detect.
        """
        want = language if language and language != "auto" else None
        if want != self._stt_language:
            logger.info(f"[STT] language pinned to '{want}' (was '{self._stt_language}')")
            self._stt_language = want

    def set_tts_language(self, language: Optional[str]) -> None:
        """Set the language used for subsequent TTS synthesis.

        Called by the agent loop per turn from the resolved conversation
        language so the voice follows the spoken language and stays coherent
        with the bridge (RFC §8.2.1). ``None``/``"auto"`` is ignored, leaving the
        current value (env seed or previously-resolved language) in place.
        """
        if language and language != "auto" and language != self._tts_language:
            logger.info(f"[TTS] language set to '{language}' (was '{self._tts_language}')")
            self._tts_language = language

    def set_tts_voice(self, voice: Optional[str]) -> None:
        """Set the voice used for subsequent TTS synthesis (per-stream).

        Called by the agent loop from ``metadata["voice"]`` so the spoken voice
        can change on a per-stream basis. The value is forwarded to the provider
        as a hint: voice-selecting providers honor it (e.g. Kokoro tries the
        requested voice first), the rest disregard it without erroring.
        ``None``/``"auto"``/``"default"`` is ignored, leaving the current value
        (env seed or previously-set voice) in place.
        """
        if voice and voice not in ("auto", "default") and voice != self._tts_voice:
            logger.info(f"[TTS] voice set to '{voice}' (was '{self._tts_voice}')")
            self._tts_voice = voice

    def set_tts_speed(self, speed) -> None:
        """Set the speaking rate for subsequent TTS synthesis (per-turn).

        Called by the agent loop from ``metadata["speed"]``. Same contract as
        voice and language: a hint the provider may honour (Qwen3 resamples its
        own PCM) or ignore. Out-of-range and non-numeric values are ignored
        rather than clamped here — the provider owns the valid range, and a
        silently clamped value would hide a caller bug.

        Kept deliberately small in practice: this shifts pitch along with rate,
        so a few percent reads as natural variation while a large factor reads
        as a different speaker.
        """
        try:
            value = float(speed)
        except (TypeError, ValueError):
            return
        if not 0.5 <= value <= 2.0:
            logger.warning(f"[TTS] ignoring out-of-range speed {value}")
            return
        if abs(value - self._tts_speed) > 1e-6:
            logger.info(f"[TTS] speed set to {value:.3f} (was {self._tts_speed:.3f})")
            self._tts_speed = value

    def enqueue_sentence(
        self,
        sentence: str,
        source: str = "response",
        transcript_id: Optional[str] = None,
        char_start: Optional[int] = None,
        char_end: Optional[int] = None,
    ) -> None:
        """Enqueue a complete sentence for TTS synthesis.

        Sentences are spoken sequentially by a background worker in the
        order they are enqueued. This allows the agent to dispatch TTS
        at sentence boundaries while streaming, without blocking the
        output loop.

        The worker is started lazily on the first enqueue and shut down
        by flush_speech_queue().

        Args:
            sentence: The text to synthesize.
            source: Label for analytics — "bridge" or "response".
            transcript_id: The agent_text transcript this sentence belongs to.
            char_start: Start offset of this sentence within that agent_text.
            char_end: End offset (exclusive) within that agent_text.

        The teleprompter (#241) uses transcript_id/char_start/char_end to map
        the audio playhead back to a character span in the on-screen text. They
        are optional — without them the sentence is spoken normally and emits no
        progress envelope.
        """
        if not sentence.strip():
            return

        # Start worker lazily
        if self._speech_worker_task is None or self._speech_worker_task.done():
            self._speech_worker_task = asyncio.create_task(self._speech_worker())

        meta = None
        if (
            transcript_id is not None
            and char_start is not None
            and char_end is not None
        ):
            meta = {
                "transcript_id": transcript_id,
                "char_start": int(char_start),
                "char_end": int(char_end),
            }

        self._speech_queue.put_nowait((sentence, source, meta))
        logger.info(f"[TTS] Enqueued {source} sentence ({len(sentence.split())} words): {sentence[:60]}...")

    async def flush_speech_queue(self) -> None:
        """Signal end-of-stream and wait for all queued sentences to finish.

        Must be called after the last sentence is enqueued (typically in
        the finally block of run_audio_loop). Blocks until the worker
        has spoken every queued sentence or is interrupted.
        """
        if self._speech_worker_task is None or self._speech_worker_task.done():
            # Even without TTS work, emit analytics if we have timing data
            self._reset_turn_analytics()
            return

        # Send sentinel to tell worker there are no more sentences
        await self._speech_queue.put(None)

        try:
            await self._speech_worker_task
        except asyncio.CancelledError:
            pass
        finally:
            self._speech_worker_task = None
            self._reset_turn_analytics()

    def _reset_turn_analytics(self) -> None:
        """Reset per-turn analytics state for the next turn."""
        self._turn_stt_start_ts = 0
        self._turn_stt_end_ts = 0
        self._turn_id = None
        self._turn_bridge_tts_first_byte_emitted = False
        self._turn_response_tts_first_byte_emitted = False
        self._last_response_tts_done_elapsed = 0

    def _begin_synthesis(
        self, sentence: str, voice=None, speed: Optional[float] = None, language=None
    ) -> "_StreamingUtterance":
        """Start synthesising a sentence and return its buffer IMMEDIATELY.

        The returned ``_StreamingUtterance`` fills in the background as chunks
        arrive from the TTS service, so playback can begin on the first chunk
        instead of the last. Nothing here awaits synthesis.

        This replaces the old ``_prefetch_sentence``, which collected every
        chunk into a list before returning — meaning the first audible sample of
        a sentence waited for the WHOLE sentence to synthesize. Measured against
        the Qwen3 provider that is time-to-first-audio ~235ms versus a full
        stream of 1040-4138ms per sentence, i.e. we were paying 4-17x the
        latency the provider was already capable of delivering.
        """
        utt = _StreamingUtterance()

        async def _pump() -> None:
            try:
                # ONE generation at a time. The TTS service shares a single model
                # instance across a 10-thread gRPC pool with no lock of its own,
                # so two overlapping synthesize_stream calls contend on the same
                # weights and CUDA graphs. Observed on prod: two streams starting
                # in the same millisecond, finishing in lockstep, and
                # time-to-first-audio doubling from ~235ms to ~495ms — with
                # audibly garbled output.
                #
                # Before playback streamed, this could not happen: sentence N was
                # fully synthesized before it began playing, so only N+1 was ever
                # in flight. Streaming playback removed that ACCIDENTAL
                # serialization, so make it explicit. The next sentence is still
                # armed early and simply waits here; the provider runs well
                # faster than real time, so it acquires the lock early in the
                # current sentence's playback and the prefetch overlap survives.
                async with self._synthesis_lock:
                    async for chunk in self._tts.synthesize_stream(
                        text=sentence,
                        session_id=self._session_id,
                        voice=voice if voice is not None else self._tts_voice,
                        speed=speed if speed is not None else self._tts_speed,
                        language=language if language is not None else self._tts_language,
                    ):
                        utt.append(chunk.audio_data)
            except asyncio.CancelledError:
                utt.finish()
                raise
            except Exception as e:
                # Same contract as the old _prefetch_sentence: never raise into
                # the speech worker. A failed synthesis yields whatever audio
                # arrived (usually none) and the worker moves on.
                logger.error(f"[TTS] Synthesis failed: {e}")
                utt.finish(error=e)
            else:
                utt.finish()

        utt.task = asyncio.create_task(_pump())
        return utt

    def _emit_first_byte(self, source: str) -> None:
        """Emit the TTS first-byte analytics event once per source per turn.

        Also evaluates the elapsed time against the #304 A1 latency budget,
        logging at warn/error when the first audible token lands past the
        unnatural/breakdown ceilings, and stamping target+status onto the
        analytics payload so dashboards can chart it without re-deriving targets.
        """
        if source == "bridge" and not self._turn_bridge_tts_first_byte_emitted:
            self._turn_bridge_tts_first_byte_emitted = True
            if self.turn_anchor_ts > 0:
                elapsed = (time.perf_counter() - self.turn_anchor_ts) * 1000
                self._report_first_byte_latency("bridge", elapsed)
        elif source == "response" and not self._turn_response_tts_first_byte_emitted:
            self._turn_response_tts_first_byte_emitted = True
            if self.turn_anchor_ts > 0:
                elapsed = (time.perf_counter() - self.turn_anchor_ts) * 1000
                self._report_first_byte_latency("response", elapsed)

    def _report_first_byte_latency(self, source: str, elapsed_ms: float) -> None:
        """Log first-byte latency vs. the budget and emit the analytics event.

        Centralises A1 so every first-byte path (streaming + prefetched) reports
        identically. ``status`` ∈ {ok, over_target, warn, alarm}.
        """
        target_ms = _first_byte_target_ms(source)
        status = _latency_status(source, elapsed_ms)
        msg = (
            f"[latency] {source} first audible token: {elapsed_ms:.0f}ms "
            f"(target ≤{target_ms}ms, warn>{_FIRST_BYTE_WARN_MS}ms, "
            f"alarm>{_FIRST_BYTE_ALARM_MS}ms) → {status}"
        )
        if status == "alarm":
            logger.error(msg)
        elif status == "warn":
            logger.warning(msg)
        else:
            logger.info(msg)
        asyncio.create_task(
            self._emit_analytics_event(
                f"{source}_tts_first_byte",
                elapsed_ms,
                target_ms=target_ms,
                status=status,
            )
        )

    async def _play_prefetched(
        self, chunks, source: str = "response", meta: Optional[dict] = None
    ) -> None:
        """Play an ALREADY-COMPLETE list of TTS chunks.

        A thin adapter over ``_play_utterance`` for callers that hold the whole
        utterance up front — synthesis that finished before playback began, and
        the barge-in / teleprompter tests, which drive the playhead with
        synthetic audio and must keep exercising the real playback loop.
        """
        utt = _StreamingUtterance()
        for c in chunks:
            utt.append(c.audio_data)
        utt.finish()
        await self._play_utterance(utt, source=source, meta=meta)

    async def _play_utterance(
        self, utt: "_StreamingUtterance", source: str = "response", meta: Optional[dict] = None
    ) -> None:
        """Play an utterance to LiveKit AS IT SYNTHESIZES, in fixed frames from a
        sample-accurate playhead so playback can be suspended and resumed.

        ``self._cur_audio`` is the utterance's buffer — the SAME object the
        synthesis task appends to, so it grows underneath this loop — and
        ``self._cur_cursor`` tracks the next byte to push. When the cursor
        catches up with synthesis we wait for more audio (racing the stop event,
        so barge-in stays responsive) rather than returning. When barge-in
        suspends playback the loop pauses here (without returning) until resumed
        or aborted, so the speech worker does not advance to the next sentence.

        Only WHOLE frames are published while synthesis is still running; a
        short final frame is allowed once the buffer is complete. Publishing a
        partial frame early would glitch the output.

        ``meta`` carries the sentence's character span in the published
        agent_text; with it (and the teleprompter enabled) this emits a
        ``speaking`` progress envelope and ``spoken`` once the whole utterance
        has played. Interruption envelopes come from suspend_speech()/
        stop_speaking()/commit_interrupt(), which read the live playhead.

        TELEPROMPTER TIMING: progress is STREAMED as a tick every
        ``_PROGRESS_TICK_MS``, starting on the first frame. Each tick describes
        only audio already synthesized (plus at most one tick of extrapolation),
        so it can never promise the frontend a sentence that is not there yet.

        This deliberately replaces holding one envelope per sentence until
        synthesis completed. That held envelope carried the true byte length,
        but only arrived when the buffer did — and at the deployed RTF of ~1
        that is the END of the sentence, so it described 4-8% of it and the
        highlight jumped. Ticks decouple the highlight from synthesis speed
        entirely; see ``_PROGRESS_TICK_MS`` for the measurements.
        """
        # Bind the growing buffer directly — no copy, so appends are visible here.
        self._cur_audio = utt.data
        self._cur_cursor = 0
        self._cur_meta = meta
        first = True
        # True while playback has caught up with synthesis and is waiting.
        starved = False
        # True when the last thing pushed was bridging silence, so the next
        # real frame gets a fade-in.
        bridged = False
        last_sample = 0
        starve_count = 0
        bridged_ms = 0.0
        self._cur_complete = utt.complete
        self._cur_last_char = 0
        self._cur_promised = 0
        # Re-announce playback state for every sentence (the dedupe in
        # _emit_playback_state only suppresses the ticks WITHIN a sentence), so
        # a client that missed the first envelope is not left muted.
        self._last_playback_state = None
        # Monotonic deadline for the next teleprompter progress tick.
        next_tick_at = 0.0

        try:
            while True:
                # Reversible suspend (barge-in): pause until resumed or aborted.
                if not self._play_allowed.is_set():
                    resumed = await self._await_resume_or_stop()
                    if not resumed:
                        break  # committed / hard-stopped while suspended

                if self._stop_speaking_event.is_set():
                    logger.info("TTS interrupted mid-sentence")
                    break

                # Synthesis may finish at any point. The moment it does the
                # byte->char mapping stops being an estimate and becomes exact,
                # so spend a tick on it right away rather than waiting for the
                # next deadline.
                if utt.complete and not self._cur_complete:
                    self._cur_complete = True
                    if not first:
                        self._emit_speech_progress("speaking", meta=meta)
                        next_tick_at = _now() + _PROGRESS_TICK_MS / 1000.0

                # Tick HERE, not in the frame-push path below: at RTF ~1 the
                # loop spends most of its time waiting for synthesis, and a tick
                # that only fired alongside a pushed frame stopped firing
                # exactly when playback was starved — the schedule then covered
                # a third of the sentence and the highlight fell behind.
                if not first and _now() >= next_tick_at:
                    self._emit_speech_progress("speaking", meta=meta)
                    next_tick_at = _now() + _PROGRESS_TICK_MS / 1000.0

                available = len(self._cur_audio) - self._cur_cursor
                # The jitter buffer is armed ONCE, before the first frame.
                # After that the LiveKit source IS the buffer: it holds
                # everything already pushed and drains at 1x, so the player
                # only ever needs the NEXT frame to keep it topped up.
                #
                # Re-arming the cushion mid-sentence (which this used to do on
                # every starve) is actively harmful at RTF ~1: the player dumps
                # its buffer into the source, immediately runs dry, then stops
                # pushing for a whole pre-roll while the source drains that
                # same amount. The source sawtooths down to empty on every
                # cycle, and an empty source is exactly when the client starts
                # concealing — see _bridge_underrun for what that sounds like.
                need = _PLAYOUT_FRAME_BYTES if not first else 1
                want = max(need, self._preroll_bytes if first else 0)
                if available < want and not utt.complete:
                    if not await utt.wait_for_data(
                        self._cur_cursor + want,
                        self._stop_speaking_event,
                        # Before the first frame there is nothing to protect, so
                        # wait outright. Once playing, wake up often enough to
                        # keep the source fed while synthesis catches up.
                        timeout=None if first else _UNDERRUN_POLL_MS / 1000.0,
                    ):
                        break  # stopped while waiting
                    if (
                        not first
                        and not utt.complete
                        and len(self._cur_audio) - self._cur_cursor < want
                    ):
                        if not starved:
                            starved = True
                            starve_count += 1
                        pushed = await self._bridge_underrun(
                            fade_from=0 if bridged else last_sample
                        )
                        if pushed:
                            bridged = True
                            bridged_ms += pushed
                    continue
                if available <= 0:
                    break  # nothing left and nothing more coming
                starved = False

                frame = bytes(
                    self._cur_audio[self._cur_cursor:self._cur_cursor + _PLAYOUT_FRAME_BYTES]
                )
                self._cur_cursor += len(frame)
                if bridged:
                    # Coming back from inserted silence — ramp in so the
                    # restart is a fade, not a step (a step is a click).
                    frame = _fade_in(frame)
                    bridged = False
                last_sample = _tail_sample(frame)

                if first:
                    first = False
                    self._emit_first_byte(source)
                    # Emit immediately, complete or not. A tick only ever
                    # describes audio already synthesized, so there is nothing
                    # to wait for — and waiting is what broke the highlight at
                    # RTF ~1 (see _PROGRESS_TICK_MS).
                    self._emit_speech_progress("speaking", meta=meta)
                    next_tick_at = _now() + _PROGRESS_TICK_MS / 1000.0

                # The agent is now audibly talking — a barge-in may start.
                self._audio_active = True
                if self._ducked:
                    frame = _apply_gain(frame, self._barge_in_duck_gain)
                await self._room.publish_audio(frame)

            # Did the utterance play to the end (vs. abort via break)?
            completed = (
                not first  # something was actually spoken
                and utt.complete
                and self._cur_cursor >= len(self._cur_audio)
            )
            if completed:
                # Learn this sentence's real pace before the buffer is released,
                # so the NEXT sentence's mid-synthesis estimate is grounded in
                # measurement rather than the seeded default.
                self._calibrate_pace(meta)
                # CONTRACT: "spoken" fires when the last frame is *pushed*, not
                # when the user *hears* the end — up to queued_playout_ms of this
                # audio is still draining the output + client buffers. The
                # frontend must therefore drive end-of-highlight timing from the
                # "speaking" envelope's schedule (delay_ms + duration_ms), and
                # treat "spoken" only as "this sentence is done, settle it fully
                # lit".
                self._emit_speech_progress("spoken", meta=meta)

            if starve_count:
                # Without this the sawtooth is invisible: playback stalls do not
                # surface anywhere else, so a session that sounds wrong leaves no
                # trace to diagnose it from.
                logger.info(
                    f"[TTS] Playout starved {starve_count}x on a "
                    f"{len(self._cur_audio)}B {source} utterance; bridged "
                    f"{bridged_ms:.0f}ms of silence to keep the source fed"
                )
        finally:
            # Never leave synthesis running for audio nobody will hear.
            utt.cancel()
            # Utterance finished (or aborted) — release held audio.
            self._cur_audio = b""
            self._cur_cursor = 0
            self._cur_meta = None
            self._cur_complete = False
            self._cur_last_char = 0
            self._cur_promised = 0

    async def _bridge_underrun(self, fade_from: int = 0) -> float:
        """Push silence when the output source is about to run dry.

        A LiveKit AudioSource that empties does not play silence — the client
        stops receiving packets and Opus concealment extrapolates the last frame
        it had, producing the warbling "interference between chunks" that a
        synthesis stall is heard as. Pushing real silence keeps the stream
        continuous, so the same stall reads as a short pause instead.

        Only fires once the source has actually drained below the floor, so a
        healthy stream never has silence spliced into it. ``fade_from`` ramps the
        silence down from the last real sample rather than cutting to zero.

        Note the inserted silence deliberately does NOT advance ``_cur_cursor``:
        the teleprompter playhead tracks synthesized audio, not wall clock, so a
        bridged sentence highlights slightly ahead of the sound for the duration
        of the stall. That is the lesser evil — the alternative is a highlight
        that stops dead.

        Returns the milliseconds pushed (0 when the source still has depth).
        """
        # Cap the floor at half the jitter buffer. A floor larger than the
        # cushion itself would fire the moment playback starts and splice
        # silence into a perfectly healthy stream.
        cushion_ms = self._preroll_bytes / (_TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE) * 1000
        floor_ms = min(_UNDERRUN_FLOOR_MS, cushion_ms / 2)
        try:
            queued = float(self._room.queued_playout_ms)
        except Exception:
            return 0.0
        if queued > floor_ms:
            return 0.0
        await self._room.publish_audio(_silence_frame(fade_from))
        return float(_PLAYOUT_FRAME_MS)

    async def _speech_worker(self) -> None:
        """Background worker that speaks queued sentences with prefetch.

        While playing sentence N, starts synthesizing sentence N+1 in parallel.
        This eliminates the gap between sentences caused by waiting for synthesis.
        """
        logger.info("[TTS] Speech worker started")
        self._is_speaking = True
        self._stop_speaking_event.clear()
        self._play_allowed.set()  # start un-suspended
        self.close_transcript_gate()

        try:
            pending = None
            pending_source = None
            pending_meta = None

            while True:
                # If the previous iteration armed the next sentence, take it —
                # its synthesis has been running during the last playback. No
                # await here any more: an utterance is usable the moment it
                # exists, so the worker never blocks on synthesis and the old
                # "race the prefetch against the stop signal" dance is gone.
                if pending is not None:
                    utt = pending
                    source = pending_source
                    meta = pending_meta
                    pending = None
                    pending_source = None
                    pending_meta = None
                else:
                    # Race the queue against the stop signal. A commit/stop
                    # drains the queue (including the flush sentinel), so a bare
                    # blocking get() here would hang forever when the
                    # interruption lands on the last sentence — deadlocking the
                    # worker and stalling the turn that should follow.
                    get_task = asyncio.create_task(self._speech_queue.get())
                    stop_waiter = asyncio.create_task(self._stop_speaking_event.wait())
                    try:
                        await asyncio.wait(
                            {get_task, stop_waiter},
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        stop_waiter.cancel()
                    if self._stop_speaking_event.is_set():
                        get_task.cancel()
                        logger.info("[TTS] Speech worker: interrupted, skipping remaining")
                        break
                    item = await get_task
                    if item is None:
                        break
                    sentence, source, meta = item
                    # Nothing armed (first sentence of a turn, or the peek below
                    # lost the race). Start synthesis now — this returns at once
                    # and playback begins on the first chunk, so the cost of
                    # arriving here is time-to-first-audio, not a whole sentence.
                    utt = self._begin_synthesis(sentence)

                if self._stop_speaking_event.is_set():
                    utt.cancel()
                    break

                # Before playing, peek at the next sentence and arm its synthesis
                try:
                    next_item = self._speech_queue.get_nowait()
                    if next_item is not None:
                        next_sentence, next_source, next_meta = next_item
                        pending = self._begin_synthesis(next_sentence)
                        pending_source = next_source
                        pending_meta = next_meta
                    else:
                        # Sentinel — put it back so the main loop sees it
                        self._speech_queue.put_nowait(None)
                except asyncio.QueueEmpty:
                    pass  # Not enqueued yet — see #460; costs TTFA, not a stream

                # Play the current sentence as it synthesizes
                await self._play_utterance(utt, source=source, meta=meta)

                # Emit tts_done events after each sentence completes
                if self.turn_anchor_ts > 0:
                    elapsed = (time.perf_counter() - self.turn_anchor_ts) * 1000
                    if source == "bridge":
                        asyncio.create_task(self._emit_analytics_event("bridge_tts_done", elapsed))
                    else:
                        self._last_response_tts_done_elapsed = elapsed

        except asyncio.CancelledError:
            logger.info("[TTS] Speech worker cancelled")
            if pending:
                pending.cancel()
        except Exception as e:
            logger.error(f"[TTS] Speech worker error: {e}")
            if pending:
                pending.cancel()
        finally:
            # Emit response_tts_done with the last response sentence's completion time
            if hasattr(self, '_last_response_tts_done_elapsed') and self._last_response_tts_done_elapsed > 0:
                asyncio.create_task(self._emit_analytics_event("response_tts_done", self._last_response_tts_done_elapsed))
                self._last_response_tts_done_elapsed = 0
            self._is_speaking = False
            self._audio_active = False
            self.open_transcript_gate()
            logger.info("[TTS] Speech worker stopped")

    def on_speech_started(self, callback: Callable[[], Awaitable[None]]) -> None:
        """
        Register callback for when VAD detects user speech start.

        This is the primary mechanism for barge-in detection. When the
        STT service's VAD detects speech onset, all registered callbacks
        are fired.

        Args:
            callback: Async function to call on speech start

        Example:
            ```python
            async def handle_barge_in():
                await self.audio.stop_speaking()
                # Reset any agent state

            self.audio.on_speech_started(handle_barge_in)
            ```
        """
        self._speech_started_callbacks.append(callback)

    def clear_speech_started_callbacks(self) -> None:
        """Clear all registered speech_started callbacks."""
        self._speech_started_callbacks.clear()
