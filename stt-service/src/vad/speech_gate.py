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
from typing import List, Optional


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

    #: Documented ceiling on MAYBE_ENDING that is NOT enforced here, exactly
    #: as it was not enforced in the whisper machine this replaces. Carried so
    #: the value has somewhere to live when #469 implements it; wiring it up
    #: now would smuggle a behaviour change into an extraction.
    max_endpointing_delay_ms: Optional[float] = None


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

        # Any voiced window cancels a pending stop. A single frame is enough:
        # the continuation window exists precisely so that a breath does not
        # end the turn, and undoing the stop is free while it is still pending.
        self.silence_start_time = None

        if self.state == SpeechState.IDLE:
            self.state = SpeechState.SPEAKING
            self.speech_start_time = now
            self.voiced_samples = 0
            self.barge_in_signalled = False
            signals.append(GateSignal.UTTERANCE_BEGAN)
            signals.append(GateSignal.SPEECH_STARTED)

        elif self.state == SpeechState.MAYBE_ENDING:
            # Same utterance, resumed. The transcript id is deliberately kept —
            # this is one turn with a pause in it, not two turns.
            self.state = SpeechState.SPEAKING
            self.pending_final_time = None
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
            # Measured from entry into MAYBE_ENDING rather than from the start
            # of the silence, so the full grace period is always granted even
            # if a blocking decode ate part of it.
            waited = (now - (self.pending_final_time or now)) * 1000.0
            if waited >= self.config.continuation_window_ms:
                signals.append(GateSignal.FINALIZE)
                self.reset()

        return signals

    def reset(self) -> None:
        """Back to IDLE. Called after FINALIZE, and between sessions."""
        self.state = SpeechState.IDLE
        self.speech_start_time = None
        self.silence_start_time = None
        self.pending_final_time = None
        self.voiced_samples = 0
        self.barge_in_signalled = False
