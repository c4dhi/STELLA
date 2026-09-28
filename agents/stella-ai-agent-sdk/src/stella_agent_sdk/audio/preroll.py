"""Choosing the head start (pre-roll) held back before each sentence plays.

Playback drains at 1x while synthesis fills at RTF x. When RTF <= 1 a small fixed
cushion is enough; when RTF > 1 the player overtakes synthesis unless it waits
first. For a sentence of D ms the wait needed is D * (RTF - 1) / RTF, which is
the rule in docs-site/docs/architecture/tts-pipeline.md.

Nothing here knows the hardware. It learns RTF from the sentences actually
synthesized, so a slow GPU converges on a longer head start within a couple of
sentences and a fast one stays at the floor. An explicit ``fixed_ms`` (the
STELLA_TTS_PREROLL_MS override) switches all of it off.
"""

from typing import Optional

_MIN_MEASURABLE_AUDIO_MS = 800  # shorter clips are dominated by first-chunk latency
_EMA_ALPHA = 0.35
_MARGIN = 1.25
_LOWER_STEP = 0.9  # shrink by at most 10% per sentence
_LOWER_HYSTERESIS = 0.8  # and only once the target is 20% under the current value


class PrerollController:
    def __init__(
        self,
        fixed_ms: Optional[int] = None,
        min_ms: int = 200,
        max_ms: int = 3000,
    ) -> None:
        self._fixed = fixed_ms
        self._min = min_ms
        self._max = max_ms
        self._cur: float = float(fixed_ms if fixed_ms is not None else min_ms)
        self._rtf: Optional[float] = None
        self._audio_ms: Optional[float] = None

    @property
    def fixed(self) -> bool:
        return self._fixed is not None

    @property
    def current_ms(self) -> int:
        return int(round(self._cur))

    @property
    def rtf(self) -> Optional[float]:
        return self._rtf

    def observe(self, audio_ms: float, synth_ms: float, bridged_ms: float = 0.0) -> None:
        """Feed one finished sentence: audio produced, synthesis wall time, and
        the milliseconds of silence the underrun guard had to insert."""
        if self._fixed is not None:
            return

        if audio_ms >= _MIN_MEASURABLE_AUDIO_MS and synth_ms > 0:
            rtf = synth_ms / audio_ms
            self._rtf = rtf if self._rtf is None else _ema(self._rtf, rtf)
            self._audio_ms = (
                audio_ms if self._audio_ms is None else _ema(self._audio_ms, audio_ms)
            )

        target = self._target()

        if bridged_ms > 0:
            # Playback demonstrably ran dry: do not wait for the average to agree.
            self._cur = min(
                self._max, max(self._cur * 1.5, self._cur + 200, target)
            )
        elif target > self._cur:
            self._cur = min(self._max, target)
        elif target < self._cur * _LOWER_HYSTERESIS or target <= self._min:
            self._cur = max(target, self._cur * _LOWER_STEP)
        if self._cur < self._min:
            self._cur = float(self._min)

    def _target(self) -> float:
        if self._rtf is None or self._audio_ms is None or self._rtf <= 1.0:
            return float(self._min)
        shortfall = self._audio_ms * (1.0 - 1.0 / self._rtf)
        return min(float(self._max), self._min + shortfall * _MARGIN)


def _ema(prev: float, new: float) -> float:
    return prev + _EMA_ALPHA * (new - prev)
