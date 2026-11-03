"""Turn boundaries, decided in one place for every STT provider.

Four questions have to be answered about a stream of audio before anything
downstream can behave sensibly, and they are NOT the same question:

    1. is someone making a noise right now?          -> speech_started
    2. have they gone on long enough to mean it?     -> speech_confirmed
    3. have they stopped?                            -> speech_ended
    4. have they stopped for good, decode it?        -> FINALIZE

The agent's barge-in hierarchy consumes the first three (duck, yield, come
back up), and the recogniser consumes the fourth. Historically only the
whisper provider answered all four; sherpa answered question 1 from a bare
energy gate and nothing else, so on that provider the agent could get quieter
and then had nothing to tell it when to stop being quiet. That asymmetry was
invisible because the two providers each carried their own copy of the logic
and only one copy was ever finished.

So the machine lives here, exactly once, and providers supply the only thing
that genuinely differs between them: whether the current window is VOICED.
Everything downstream of that decision — the three-state machine, the
timings, the four signals — is identical by construction rather than by
somebody remembering to port it.

Deliberately pure: no audio, no models, no clock, no protobuf. `observe()`
takes a bool and a timestamp and returns signals. That makes the whole
(state x event) table enumerable in tests, which is what the old design could
not do — the missing "come back up" path was unreachable in a test and so
surfaced as a field report instead of a red bar.

Buffering stays with the provider. The gate says WHEN an utterance starts and
ends; what to do with the samples in between differs per recogniser (whisper
accumulates and decodes in one shot, sherpa streams into a live decoder) and
pretending otherwise would push provider detail in here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional


class SpeechState:
    """Where the speaker currently is, from the gate's point of view."""

    IDLE = "IDLE"
    #: Voiced audio is arriving.
    SPEAKING = "SPEAKING"
    #: They have gone quiet, but not yet long enough to call it a turn. A pause
    #: for breath and the end of a sentence look identical at this point; the
    #: continuation window is what tells them apart.
    MAYBE_ENDING = "MAYBE_ENDING"


class GateSignal:
    """What the gate has just concluded. Providers translate these to events."""

    #: A NEW utterance began (IDLE -> SPEAKING). Always accompanied by
    #: SPEECH_STARTED. Separate because the provider needs to mint a new
    #: transcript id here and only here — a resumption after a pause is the
    #: same utterance and must keep its id, or the agent sees two turns.
    UTTERANCE_BEGAN = "UTTERANCE_BEGAN"

    #: The user is making voiced sound. Emitted on a fresh start AND on
    #: resumption out of MAYBE_ENDING, because the agent un-ducked on the way
    #: in and has to duck again on the way back out.
    SPEECH_STARTED = "SPEECH_STARTED"

    #: They have now voiced more than `barge_in_min_speech_ms`. This is the
    #: interruption signal: duration is what separates "mhm" from a turn, and
    #: it is the only such signal that needs no transcript and no language.
    #: Fires at most once per utterance.
    SPEECH_CONFIRMED = "SPEECH_CONFIRMED"

    #: They stopped (SPEAKING -> MAYBE_ENDING). Pairs with SPEECH_STARTED to
    #: bracket "talking right now". Not final: speech may resume.
    SPEECH_ENDED = "SPEECH_ENDED"

    #: The utterance is over — decode it and reset. The gate returns to IDLE.
    FINALIZE = "FINALIZE"

    #: Speech resumed inside the continuation window (MAYBE_ENDING ->
    #: SPEAKING): a pause that nearly ended the turn. Logging only (#92); the
    #: pause is appended to `rescued_pauses`. Precedes the SPEECH_STARTED it
    #: comes with.
    PAUSE_RESCUED = "PAUSE_RESCUED"


@dataclass
class GateConfig:
    """Timings. All milliseconds, all from the provider's own config."""

    #: Quiet for this long inside SPEAKING -> the speaker has stopped.
    silence_duration_ms: float = 500.0

    #: Quiet for this long inside MAYBE_ENDING -> they are not coming back.
    #: This is the pause tolerance: it is what stops a mid-sentence breath
    #: from being cut into two turns.
    continuation_window_ms: float = 600.0

    #: Voiced audio needed before an interruption counts as taking the floor.
    barge_in_min_speech_ms: float = 600.0

    #: Sample rate the voiced-sample counter is measured in.
    sample_rate: int = 16000

    #: Hard ceiling on time in MAYBE_ENDING, measured from entry into it
    #: (#469). While the window is fixed the window always ends the hold
    #: first; the ceiling is what still bounds it once something extends the
    #: hold. Never shorter than the window: a shorter one would end every
    #: utterance early, so it is clamped up to it. None means no ceiling.
    max_endpointing_delay_ms: Optional[float] = None

    #: End-of-turn model scores at or above this end the hold now. None means
    #: no model: the window alone decides, as it always has.
    turn_finished_at: Optional[float] = None

    #: Scores at or below this keep the hold open past the window, up to the
    #: ceiling. Anything between the two leaves the decision to the window.
    turn_unfinished_below: float = 0.3

    #: How often to ask again while the silence lasts.
    turn_recheck_ms: float = 150.0

    #: The timers' silence threshold, when a model opens the hold earlier than
    #: they would. Only a pause that also got past this counts as rescued.
    rescue_silence_ms: Optional[float] = None

    def __post_init__(self) -> None:
        self.max_endpointing_delay_ms = clamp_endpointing_ceiling(
            self.max_endpointing_delay_ms, self.continuation_window_ms
        )


def clamp_endpointing_ceiling(
    ceiling_ms: Optional[float], continuation_window_ms: float
) -> Optional[float]:
    """The ceiling, raised to the continuation window if it is shorter."""
    if ceiling_ms is None or ceiling_ms >= continuation_window_ms:
        return ceiling_ms
    print(
        f"[SpeechGate] max_endpointing_delay_ms={ceiling_ms:g} is shorter than "
        f"continuation_window_ms={continuation_window_ms:g}; using {continuation_window_ms:g}"
    )
    return continuation_window_ms


class SpeechGate:
    """The three-state turn machine. One instance per session.

    Usage is one call per fixed-size window of audio::

        for signal in gate.observe(voiced=is_speech, samples=len(w), now=t):
            ...

    `voiced` is the provider's business. Whisper compares a Silero probability
    against a threshold; sherpa asks sherpa-onnx's bundled Silero directly.
    Either way what arrives here is a decision, not an energy level — which is
    the point. An energy level cannot tell a voice from a passing truck, and
    the previous sherpa behaviour (RMS alone) is exactly what that costs.
    """

    def __init__(self, config: Optional[GateConfig] = None) -> None:
        self.config = config or GateConfig()
        self.state = SpeechState.IDLE
        self.speech_start_time: Optional[float] = None
        self.silence_start_time: Optional[float] = None
        self.pending_final_time: Optional[float] = None
        self.voiced_samples = 0
        self.barge_in_signalled = False
        #: Why the last MAYBE_ENDING ended: "model", "window" or "ceiling".
        self.last_exit_reason: Optional[str] = None
        #: The current utterance's rescued pauses (#92), oldest first. Cleared
        #: when the NEXT utterance begins rather than on reset, so a provider
        #: building the final after FINALIZE can still read them.
        self.rescued_pauses: List[Dict[str, int]] = []
        #: The pause behind the latest PAUSE_RESCUED, counted or not.
        self.last_pause: Dict[str, int] = {}
        #: Silence waited and speech length at the last FINALIZE (#92), kept
        #: for the same reason. See endpoint_timing().
        self._last_endpoint: Optional[Dict[str, int]] = None
        #: The end-of-turn model's latest score for this hold, None if not asked.
        #: Kept through reset, like the two above, for the provider's final.
        self.turn_score: Optional[float] = None
        self._turn_asked_at: Optional[float] = None

    # -- queries ---------------------------------------------------------

    @property
    def is_active(self) -> bool:
        """True while an utterance is in flight (SPEAKING or MAYBE_ENDING)."""
        return self.state != SpeechState.IDLE

    @property
    def voiced_ms(self) -> float:
        rate = self.config.sample_rate or 16000
        return self.voiced_samples / rate * 1000.0

    def silence_ms(self, now: float) -> float:
        """How long the current run of silence has lasted. 0 if not silent."""
        if self.silence_start_time is None:
            return 0.0
        return (now - self.silence_start_time) * 1000.0

    def endpoint_timing(self, now: float) -> Optional[Dict[str, int]]:
        """How the utterance being finalised ended (#92), or None if unknown.

        `trailing_silence_ms` is the silence waited through before the turn
        was ended; `speech_ms` runs from the first voiced window to the start
        of that silence. Measured live while the utterance is still active (a
        provider's own timeout ending it), else as recorded at FINALIZE.
        """
        if self.is_active:
            return self._timing(now)
        return dict(self._last_endpoint) if self._last_endpoint else None

    def _timing(self, now: float) -> Optional[Dict[str, int]]:
        if self.speech_start_time is None:
            return None
        speech_end = self.silence_start_time if self.silence_start_time is not None else now
        return {
            "trailing_silence_ms": int(round(self.silence_ms(now))),
            "speech_ms": int(round(max(speech_end - self.speech_start_time, 0.0) * 1000.0)),
        }

    def hold_expired(self, now: float) -> Optional[str]:
        """Whether MAYBE_ENDING is over: "ceiling", "model", "window", or None.

        The one place the hold's exit is decided; the provider's stream-end
        check asks here too. Both bounds are measured from entry into
        MAYBE_ENDING rather than from the start of the silence, so the full
        grace period is always granted even if a blocking decode ate part of it.
        """
        if self.state != SpeechState.MAYBE_ENDING or self.pending_final_time is None:
            return None
        waited = (now - self.pending_final_time) * 1000.0
        ceiling = self.config.max_endpointing_delay_ms
        if ceiling is not None and waited >= ceiling:
            return "ceiling"
        finished_at = self.config.turn_finished_at
        if finished_at is not None and self.turn_score is not None:
            if self.turn_score >= finished_at:
                return "model"
            if self.turn_score <= self.config.turn_unfinished_below:
                return None
        if waited >= self.config.continuation_window_ms:
            return "window"
        return None

    # -- the end-of-turn model -------------------------------------------
    #
    # The gate never sees the model, only its answer, so it stays pure: the
    # provider asks turn_check_due(), runs the model wherever it likes and hands
    # the score back. A model that is slow or broken simply never answers, which
    # leaves the hold to the window.

    def turn_check_due(self, now: float) -> bool:
        """Whether the provider should ask the end-of-turn model now."""
        if self.config.turn_finished_at is None or self.state != SpeechState.MAYBE_ENDING:
            return False
        if self._turn_asked_at is None:
            return True
        return (now - self._turn_asked_at) * 1000.0 >= self.config.turn_recheck_ms

    def turn_check_started(self, now: float) -> None:
        self._turn_asked_at = now

    def report_turn_score(self, score: float) -> None:
        """Record the model's answer. Only meaningful during the hold it was asked in."""
        if self.state == SpeechState.MAYBE_ENDING:
            self.turn_score = score

    # -- the machine -----------------------------------------------------

    def observe(self, *, voiced: bool, samples: int, now: float) -> List[str]:
        """Advance the machine by one window. Returns the signals it produced.

        Order matters within the returned list: UTTERANCE_BEGAN precedes
        SPEECH_STARTED so a provider can mint the transcript id before it
        stamps an event with it.
        """
        if voiced:
            return self._on_voiced(samples, now)
        return self._on_silence(now)

    def _on_voiced(self, samples: int, now: float) -> List[str]:
        signals: List[str] = []

        # Read before it is cleared: a rescued pause is measured to here.
        pause_ms = self.silence_ms(now)

        # Any voiced window cancels a pending stop. A single frame is enough:
        # the continuation window exists precisely so that a breath does not
        # end the turn, and undoing the stop is free while it is still pending.
        self.silence_start_time = None

        if self.state == SpeechState.IDLE:
            self.state = SpeechState.SPEAKING
            self.speech_start_time = now
            self.voiced_samples = 0
            self.barge_in_signalled = False
            self.rescued_pauses = []
            self._last_endpoint = None
            self.turn_score = None
            signals.append(GateSignal.UTTERANCE_BEGAN)
            signals.append(GateSignal.SPEECH_STARTED)

        elif self.state == SpeechState.MAYBE_ENDING:
            # Same utterance, resumed. The transcript id is deliberately kept —
            # this is one turn with a pause in it, not two turns.
            threshold = self.config.silence_duration_ms
            into_window = (now - self.pending_final_time) * 1000.0
            window = self.config.continuation_window_ms
            if self.config.rescue_silence_ms is not None:
                # A model asks from the first short pause, and a breath that
                # never came near ending the turn has rescued nothing.
                window += threshold - self.config.rescue_silence_ms
                threshold = self.config.rescue_silence_ms
                into_window = pause_ms - threshold
            self.last_pause = {
                "pause_ms": int(round(pause_ms)),
                "into_window_ms": int(round(into_window)),
                "silence_threshold_ms": int(round(threshold)),
                "continuation_window_ms": int(round(window)),
            }
            if into_window >= 0:
                self.rescued_pauses.append(self.last_pause)
            self.state = SpeechState.SPEAKING
            self.pending_final_time = None
            self.turn_score = None
            self._turn_asked_at = None
            signals.append(GateSignal.PAUSE_RESCUED)
            signals.append(GateSignal.SPEECH_STARTED)

        # Count VOICED audio only. Counting wall-clock instead would let a
        # thinking pause accumulate toward the interruption threshold, so a
        # hesitant "uh... yeah" would take the floor while a brisk "mhm" would
        # not — backwards.
        self.voiced_samples += samples
        if not self.barge_in_signalled:
            if self.voiced_ms >= self.config.barge_in_min_speech_ms:
                self.barge_in_signalled = True
                signals.append(GateSignal.SPEECH_CONFIRMED)

        return signals

    def _on_silence(self, now: float) -> List[str]:
        signals: List[str] = []

        if self.state == SpeechState.IDLE:
            return signals

        if self.silence_start_time is None:
            self.silence_start_time = now

        if self.state == SpeechState.SPEAKING:
            if self.silence_ms(now) >= self.config.silence_duration_ms:
                self.state = SpeechState.MAYBE_ENDING
                self.pending_final_time = now
                signals.append(GateSignal.SPEECH_ENDED)

        elif self.state == SpeechState.MAYBE_ENDING:
            reason = self.hold_expired(now)
            if reason:
                signals.append(GateSignal.FINALIZE)
                self._last_endpoint = self._timing(now)
                self.reset()
                self.last_exit_reason = reason

        return signals

    def reset(self) -> None:
        """Back to IDLE. Called after FINALIZE, and between sessions."""
        self.state = SpeechState.IDLE
        self.speech_start_time = None
        self.silence_start_time = None
        self.pending_final_time = None
        self.voiced_samples = 0
        self.barge_in_signalled = False
        self._turn_asked_at = None
