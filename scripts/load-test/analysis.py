"""Pure measurement maths for the load test: no network, no clock."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional


def percentile(values: Iterable[float], pct: float) -> Optional[float]:
    """Nearest-rank percentile; None for an empty list."""
    data = sorted(values)
    if not data:
        return None
    rank = max(1, int(-(-pct / 100.0 * len(data) // 1)))  # ceil
    return data[min(rank, len(data)) - 1]


def playout_starvation(chunks: list[tuple[float, float]], preroll_s: float = 0.0) -> tuple[float, float]:
    """Simulate the agent's player: it waits for `preroll_s` of audio, then plays on.

    `chunks` is (arrival_time_s, audio_duration_s) in arrival order. Returns
    (starved_s, audio_s): the time the player would have sat silent waiting for
    a chunk after it started, and the total audio played. A chunk that arrives
    after the buffer has run dry counts the gap as starvation. The pre-roll
    mirrors STELLA_TTS_PREROLL_MS: playback starts once that much audio has
    arrived (or when the last chunk arrives, for a shorter reply).
    """
    if not chunks:
        return 0.0, 0.0
    buffered = 0.0
    start = chunks[-1][0]
    for arrival, duration in chunks:
        buffered += duration
        if buffered >= preroll_s:
            start = arrival
            break
    played_until = start
    starved = 0.0
    audio = 0.0
    for arrival, duration in chunks:
        if arrival > played_until:
            starved += arrival - played_until
            played_until = arrival
        played_until += duration
        audio += duration
    return starved, audio


@dataclass
class LevelResult:
    """What one concurrency level measured."""

    sessions: int
    stt_final_s: list[float] = field(default_factory=list)  # end of speech -> final
    stt_partial_gap_s: list[float] = field(default_factory=list)
    stt_utterances: int = 0
    stt_finals_missed: int = 0
    stt_early_finals: int = 0  # finals that arrived before the end of speech
    tts_ttfa_s: list[float] = field(default_factory=list)
    tts_starved_s: float = 0.0
    tts_audio_s: float = 0.0
    errors: int = 0
    gpu_util_avg: Optional[float] = None
    gpu_util_max: Optional[float] = None
    gpu_mem_max_mb: Optional[float] = None

    def summary(self) -> dict:
        ms = lambda v: None if v is None else round(v * 1000.0, 1)
        return {
            "sessions": self.sessions,
            "stt_final_p50_ms": ms(percentile(self.stt_final_s, 50)),
            "stt_final_p95_ms": ms(percentile(self.stt_final_s, 95)),
            "stt_partial_gap_p95_ms": ms(percentile(self.stt_partial_gap_s, 95)),
            "stt_utterances": self.stt_utterances,
            "stt_finals_missed": self.stt_finals_missed,
            "stt_early_finals": self.stt_early_finals,
            "tts_ttfa_p50_ms": ms(percentile(self.tts_ttfa_s, 50)),
            "tts_ttfa_p95_ms": ms(percentile(self.tts_ttfa_s, 95)),
            "tts_starved_pct": round(100.0 * self.tts_starved_s / self.tts_audio_s, 2)
            if self.tts_audio_s
            else None,
            "errors": self.errors,
            "gpu_util_avg_pct": self.gpu_util_avg,
            "gpu_util_max_pct": self.gpu_util_max,
            "gpu_mem_max_mb": self.gpu_mem_max_mb,
        }


@dataclass
class Criteria:
    """When a level counts as 'the voice has slowed or stuttered'.

    Latency limits are relative to the single-session baseline, because the
    absolute figures differ per GPU and per model. Starvation is absolute.
    """

    stt_final_slack_ms: float = 1000.0
    tts_ttfa_slack_ms: float = 1000.0
    max_tts_starved_pct: float = 5.0
    max_finals_missed_pct: float = 0.0
    preroll_ms: float = 200.0  # player pre-roll used to judge starvation (SDK default)


def failures(level: dict, baseline: dict, c: Criteria) -> list[str]:
    """Reasons this level fails; empty when it passes. Both args are summary()s."""
    out: list[str] = []
    if level["errors"]:
        out.append(f"{level['errors']} request errors")
    n = level["stt_utterances"]
    if n and 100.0 * level["stt_finals_missed"] / n > c.max_finals_missed_pct:
        out.append(f"{level['stt_finals_missed']} of {n} utterances got no final transcript")
    for key, slack, label in (
        ("stt_final_p95_ms", c.stt_final_slack_ms, "speech recognition final"),
        ("tts_ttfa_p95_ms", c.tts_ttfa_slack_ms, "voice time-to-first-audio"),
    ):
        got, base = level[key], baseline[key]
        if got is not None and base is not None and got > base + slack:
            out.append(f"{label} p95 {got:.0f} ms vs {base:.0f} ms alone (limit +{slack:.0f} ms)")
    starved = level["tts_starved_pct"]
    if starved is not None and starved > c.max_tts_starved_pct:
        out.append(f"voice starved {starved:.1f}% of playback (limit {c.max_tts_starved_pct:.0f}%)")
    return out


def find_capacity(levels: list[dict], c: Criteria) -> dict:
    """Highest session count that passes, given levels in ascending order.

    The first level is the baseline. Capacity stops at the first failing level:
    a later level that happens to pass does not count, since the voice had
    already degraded below it.
    """
    if not levels:
        return {"sessions": 0, "limited_by": ["no levels measured"]}
    baseline = levels[0]
    capacity = 0
    limited_by: list[str] = []
    for level in levels:
        # The baseline has nothing to be relative to, so only the absolute limits apply.
        fails = failures(level, level if level is baseline else baseline, c)
        if fails:
            limited_by = fails
            break
        capacity = level["sessions"]
    return {"sessions": capacity, "limited_by": limited_by}
