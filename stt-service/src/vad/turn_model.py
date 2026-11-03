"""End-of-turn models: how likely is it that this person has finished speaking?

The silence timers treat a thinking pause and the end of a sentence alike, and
can only tell them apart by waiting. These models listen to the end of the turn
so far and answer straight away, which is what lets the wait get shorter.

Both take the last 8 seconds of 16 kHz mono audio and return a probability, and
that number is all the gate ever sees. They are named by TURN_MODEL:

    smart_turn  Smart Turn v3.2 (pipecat-ai, BSD-2). ONNX, runs on the CPU.
    voxturn     voxturn v1 (CC BY-NC 4.0: non-commercial use only). Needs a GPU;
                about 1 s per decision on a CPU, which is only fit for evals.

Revisions are pinned on purpose. voxturn's inference code ships inside its model
repo and is imported from there, so a floating ref would run whatever the repo
holds next. Re-read voxturn.py before moving its pin. Imports are local so that
TURN_MODEL=off costs nothing, not even the import of transformers.
"""

from __future__ import annotations

import sys
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16000
TURN_MODEL_WINDOW_SAMPLES = 8 * SAMPLE_RATE

SMART_TURN_REPO = "pipecat-ai/smart-turn-v3"
SMART_TURN_REVISION = "f766f81d3cfdf7737ac64aad813d91bbfd56bf93"
SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx"

VOXTURN_REPO = "AustinXiao/voxturn"
VOXTURN_REVISION = "10a0dff87335bbcd5ed7d4a26845a75accfad320"
# Must match BACKBONE_REVISION in voxturn.py at the pin above; it loads this itself.
VOXTURN_BACKBONE_REPO = "Qwen/Qwen3-ASR-0.6B-hf"
VOXTURN_BACKBONE_REVISION = "7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c"


class TurnModel(Protocol):
    def score(self, audio: np.ndarray) -> float:
        """Probability that the turn is over, from float32 16 kHz mono audio."""
        ...


class SmartTurnModel:
    def __init__(self, onnx_path: str) -> None:
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor

        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # The CPU build, on the CPU, whichever providers the GPU image offers.
        self._session = ort.InferenceSession(
            onnx_path, sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._features = WhisperFeatureExtractor(chunk_length=8)

    def score(self, audio: np.ndarray) -> float:
        inputs = self._features(
            pad_start(audio),
            sampling_rate=SAMPLE_RATE,
            return_tensors="np",
            padding="max_length",
            max_length=TURN_MODEL_WINDOW_SAMPLES,
            truncation=True,
            do_normalize=True,
        )
        features = inputs.input_features.astype(np.float32)
        return float(self._session.run(None, {"input_features": features})[0][0].item())


class VoxTurnModel:
    def __init__(self, path: str, device: str) -> None:
        sys.path.insert(0, path)
        from voxturn import VoxTurn

        self._model = VoxTurn.from_pretrained(path, device=device)

    def score(self, audio: np.ndarray) -> float:
        # lang picks the prompt language, which exists in English and Chinese
        # only. The audio itself can be German.
        return float(self._model.predict(audio, questions=["eot"], lang="en")["eot"]["yes"])


def pad_start(audio: np.ndarray) -> np.ndarray:
    """The last 8 seconds, with any shortfall as silence BEFORE the speech."""
    audio = audio[-TURN_MODEL_WINDOW_SAMPLES:]
    return np.pad(audio, (TURN_MODEL_WINDOW_SAMPLES - len(audio), 0))


def download_turn_model(name: str) -> None:
    """Fetch a model into the Hugging Face cache, for the init container."""
    from huggingface_hub import hf_hub_download, snapshot_download

    if name == "smart_turn":
        hf_hub_download(SMART_TURN_REPO, SMART_TURN_FILE, revision=SMART_TURN_REVISION)
    elif name == "voxturn":
        snapshot_download(VOXTURN_REPO, revision=VOXTURN_REVISION)
        snapshot_download(VOXTURN_BACKBONE_REPO, revision=VOXTURN_BACKBONE_REVISION)
    else:
        raise ValueError(f"Unknown TURN_MODEL '{name}'")


def load_turn_model(name: str, device: str = "cpu") -> TurnModel:
    """Load a model downloaded earlier. Raises if it is unknown or missing."""
    from huggingface_hub import hf_hub_download, snapshot_download

    if name == "smart_turn":
        return SmartTurnModel(hf_hub_download(
            SMART_TURN_REPO, SMART_TURN_FILE, revision=SMART_TURN_REVISION, local_files_only=True
        ))
    if name == "voxturn":
        return VoxTurnModel(
            snapshot_download(VOXTURN_REPO, revision=VOXTURN_REVISION, local_files_only=True), device
        )
    raise ValueError(f"Unknown TURN_MODEL '{name}'")


class TurnScorer:
    """Runs one model for every session, off the audio path, one call at a time."""

    def __init__(self, model: TurnModel) -> None:
        self._model = model
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="turn_model")

    def submit(self, audio: np.ndarray) -> Future:
        return self._executor.submit(self._model.score, audio)

    def warm_up(self) -> None:
        """Score once at startup, so the first person's turn does not pay for it."""
        self.submit(np.zeros(SAMPLE_RATE, dtype=np.float32)).result()
