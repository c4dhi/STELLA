#!/usr/bin/env python3
"""How long does each end-of-turn setting wait, and how often does it cut someone off?

Each recording must hold exactly one complete turn, so no labelling is needed: the
true end is the last voiced window, and a turn ended before it is a wrong cut-off.
Audio goes through the same Silero check and the same SpeechGate as the live
service, on simulated time. Model time is left out of the wait and reported on its own.

The recording's name up to the first "_" is its kind (finished_3.wav -> finished),
which gets its own cut-off count. Audio is only read locally, nothing is sent out.

Needs: torch, silero-vad, ffmpeg, and transformers + onnxruntime (smart_turn) or
transformers + peft + safetensors (voxturn). Download a model first with
`TURN_MODEL=<name> python download_turn_model.py`.

Usage: python evals/run_turn_model.py <recordings> [--models smart_turn voxturn] [--device cuda]
"""
import argparse
import csv
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vad.speech_gate import GateConfig, GateSignal, SpeechGate  # noqa: E402
from vad.turn_model import SAMPLE_RATE, TURN_MODEL_WINDOW_SAMPLES, load_turn_model  # noqa: E402

WINDOW = 512  # samples, as in the live service
TRAILING_SILENCE_S = 4.0
PRE_BUFFER = 3200
AUDIO_TYPES = {".wav", ".m4a", ".mp3", ".aiff", ".flac", ".ogg", ".webm"}


@dataclass
class Recording:
    name: str
    kind: str
    audio: np.ndarray
    voiced: list
    last_voiced: int


def read_audio(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def voiced_windows(audio, vad, vad_threshold, rms_threshold):
    """The live service's decision for each window: an energy gate, then Silero."""
    import torch

    vad.reset_states()
    result = []
    for i in range(len(audio) // WINDOW):
        window = audio[i * WINDOW:(i + 1) * WINDOW]
        if float(np.sqrt(np.mean(window ** 2))) < rms_threshold:
            result.append(False)
        else:
            result.append(vad(torch.from_numpy(window), SAMPLE_RATE).item() > vad_threshold)
    return result


def load_recordings(folder, vad, vad_threshold, rms_threshold):
    recordings = []
    for path in sorted(p for p in Path(folder).rglob("*") if p.suffix.lower() in AUDIO_TYPES):
        audio = np.concatenate([read_audio(path), np.zeros(int(TRAILING_SILENCE_S * SAMPLE_RATE), np.float32)])
        voiced = voiced_windows(audio, vad, vad_threshold, rms_threshold)
        if not any(voiced):
            print(f"  skipped, no speech found: {path.name}")
            continue
        last_voiced = max(i for i, v in enumerate(voiced) if v)
        kind = path.stem.split("_")[0]
        recordings.append(Recording(str(path.relative_to(folder)), kind, audio, voiced, last_voiced))
    return recordings


class Scores:
    """Each point in a recording is scored once, however many settings ask about it."""

    def __init__(self, model):
        self.model, self.memo, self.times = model, {}, []

    def at(self, recording, audio_start, window_index):
        key = (recording.name, window_index)
        if key not in self.memo:
            end = (window_index + 1) * WINDOW
            clip = recording.audio[max(audio_start, end - TURN_MODEL_WINDOW_SAMPLES):end]
            started = time.perf_counter()
            self.memo[key] = self.model.score(clip)
            self.times.append((time.perf_counter() - started) * 1000)
        return self.memo[key]


def run_one(recording, config, scores, min_speech_samples):
    """Play one recording through the gate. Returns (ended at window, why)."""
    gate = SpeechGate(config)
    step = WINDOW / SAMPLE_RATE
    start = 0
    for i, voiced in enumerate(recording.voiced):
        was_idle = not gate.is_active
        now = i * step
        if GateSignal.FINALIZE in gate.observe(voiced=voiced, samples=WINDOW, now=now):
            return i, gate.last_exit_reason
        if was_idle and gate.is_active:
            start = max(i * WINDOW - PRE_BUFFER, 0)
        if (scores and gate.turn_check_due(now)
                and (i + 1) * WINDOW - start >= min_speech_samples):
            gate.turn_check_started(now)
            gate.report_turn_score(scores.at(recording, start, i))
            if gate.hold_expired(now) == "model":
                return i, "model"
    return len(recording.voiced), "stream"


def summarise(label, recordings, config, scores, min_speech_samples):
    step_ms = WINDOW / SAMPLE_RATE * 1000
    waits, cut, by_model = [], [], 0
    for recording in recordings:
        ended, why = run_one(recording, config, scores, min_speech_samples)
        by_model += why == "model"
        if ended < recording.last_voiced:
            cut.append(recording)
        else:
            waits.append((ended - recording.last_voiced) * step_ms)
    return {
        "setting": label,
        "turns": len(recordings),
        "cut_offs": len(cut),
        "cut_off_pct": round(100 * len(cut) / len(recordings), 1),
        "median_wait_ms": round(statistics.median(waits)) if waits else None,
        "p90_wait_ms": round(np.percentile(waits, 90)) if waits else None,
        "ended_by_model_pct": round(100 * by_model / len(recordings)),
        "cut_by_kind": ", ".join(
            f"{kind} {sum(r.kind == kind for r in cut)}/{sum(r.kind == kind for r in recordings)}"
            for kind in sorted({r.kind for r in recordings})
        ),
    }


def print_table(rows):
    columns = ["setting", "cut_offs", "cut_off_pct", "median_wait_ms", "p90_wait_ms", "ended_by_model_pct", "cut_by_kind"]
    widths = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in columns}
    print("  ".join(c.ljust(widths[c]) for c in columns))
    for row in rows:
        print("  ".join(str(row[c]).ljust(widths[c]) for c in columns))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("recordings")
    parser.add_argument("--models", nargs="+", default=["smart_turn"])
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--finished-at", nargs="+", type=float, default=[0.5, 0.6, 0.7, 0.8, 0.9, 0.95])
    parser.add_argument("--unfinished-below", type=float, default=0.3)
    parser.add_argument("--first-check-ms", type=int, default=250)
    parser.add_argument("--recheck-ms", type=int, default=150)
    parser.add_argument("--max-wait-ms", type=int, default=3000)
    parser.add_argument("--max-cut-off-pct", type=float, default=5.0)
    # Production values (scripts/templates/env.production.template).
    parser.add_argument("--silence-ms", type=int, default=800)
    parser.add_argument("--window-ms", type=int, default=1000)
    parser.add_argument("--vad-threshold", type=float, default=0.35)
    parser.add_argument("--rms-threshold", type=float, default=0.008)
    parser.add_argument("--min-speech-ms", type=int, default=200)
    parser.add_argument("--out")
    args = parser.parse_args()

    from silero_vad import load_silero_vad

    recordings = load_recordings(args.recordings, load_silero_vad(onnx=True), args.vad_threshold, args.rms_threshold)
    if not recordings:
        sys.exit(f"No recordings with speech in {args.recordings}")
    min_speech_samples = args.min_speech_ms * 16
    print(f"{len(recordings)} turns. One turn is {100 / len(recordings):.1f}% of the cut-off rate.\n")

    timer = GateConfig(
        silence_duration_ms=args.silence_ms, continuation_window_ms=args.window_ms, max_endpointing_delay_ms=2000,
    )
    rows = [summarise("timer only (today)", recordings, timer, None, min_speech_samples)]
    model_times = {}
    best = {}
    for name in args.models:
        scores = Scores(load_turn_model(name, device=args.device))
        for finished_at in args.finished_at:
            config = GateConfig(
                silence_duration_ms=args.first_check_ms,
                continuation_window_ms=args.silence_ms + args.window_ms - args.first_check_ms,
                max_endpointing_delay_ms=args.max_wait_ms - args.first_check_ms,
                turn_finished_at=finished_at,
                turn_unfinished_below=args.unfinished_below,
                turn_recheck_ms=args.recheck_ms,
            )
            row = summarise(f"{name} finished_at={finished_at}", recordings, config, scores, min_speech_samples)
            rows.append(row)
            if row["cut_off_pct"] <= args.max_cut_off_pct and row["median_wait_ms"] is not None:
                if name not in best or row["median_wait_ms"] < best[name]["median_wait_ms"]:
                    best[name] = row
        model_times[name] = scores.times

    print_table(rows)
    print()
    for name, times in model_times.items():
        print(f"{name}: {statistics.median(times):.0f} ms per check (median, on {args.device}), {len(times)} checks")
    for name in args.models:
        if name in best:
            print(f"{name}: best at or under {args.max_cut_off_pct:g}% cut-offs: {best[name]['setting']}, "
                  f"median wait {best[name]['median_wait_ms']} ms")
        else:
            print(f"{name}: no setting stays at or under {args.max_cut_off_pct:g}% cut-offs")

    if args.out:
        with open(args.out, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)


if __name__ == "__main__":
    main()
