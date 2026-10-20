"""Redecode: the one-shot forced re-decode #57 needs for a doubtful turn.

A provider with no language steering (the lightweight dev default) must stay
a safe no-op rather than break the caller. WhisperProvider's own redecode must
run the SAME preprocessing as the live final path and return plain text, never
raising out through the caller even if the model errors.
"""

import asyncio
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import stt_pb2  # noqa: E402

if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    _torch.cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
    sys.modules["torch"] = _torch

from providers.base import STTProvider  # noqa: E402
from providers.whisper_provider import WhisperProvider  # noqa: E402


class _FakeSegment:
    def __init__(self, text):
        self.text = text


def _silence_pcm(ms: int = 600) -> bytes:
    return np.zeros(int(16000 * ms / 1000), dtype=np.int16).tobytes()


# ─────────────────────── base provider: safe no-op ───────────────────────

class _BareProvider(STTProvider):
    name = "bare"
    is_available = True

    async def initialize(self):
        return True

    def create_session(self, session_id, participant_id):
        return None

    async def cleanup(self):
        pass


def test_base_provider_redecode_is_a_safe_noop():
    provider = _BareProvider()
    result = asyncio.run(provider.redecode(_silence_pcm(), "de"))
    assert result is None


# ─────────────────────── WhisperProvider.redecode ───────────────────────

def _provider_with_model(transcribe_return):
    provider = WhisperProvider.__new__(WhisperProvider)  # skip env-reading __init__
    provider.model_ready = True
    provider.beam_size = 5
    provider.initial_prompt = None
    provider.whisper_model = types.SimpleNamespace(
        transcribe=lambda audio, **kw: transcribe_return(audio, kw)
    )
    return provider


def test_redecode_forces_the_given_language_and_returns_text():
    seen_kwargs = {}

    def _transcribe(audio, kwargs):
        seen_kwargs.update(kwargs)
        return ([_FakeSegment("hallo wie geht es dir")], object())

    provider = _provider_with_model(_transcribe)
    text = asyncio.run(provider.redecode(_silence_pcm(), "de"))

    assert text == "hallo wie geht es dir"
    assert seen_kwargs["language"] == "de"
    # The forced decode must never run free detection — that is the whole
    # point (a result fed back as evidence would be the self-confirming pin
    # bug #57's design exists to avoid).
    assert seen_kwargs["condition_on_previous_text"] is False


def test_redecode_returns_none_when_model_not_ready():
    provider = WhisperProvider.__new__(WhisperProvider)
    provider.model_ready = False
    provider.whisper_model = None
    assert asyncio.run(provider.redecode(_silence_pcm(), "de")) is None


def test_redecode_returns_none_on_empty_decode():
    provider = _provider_with_model(lambda audio, kwargs: ([], object()))
    assert asyncio.run(provider.redecode(_silence_pcm(), "de")) is None


def test_redecode_swallows_model_errors():
    def _boom(audio, kwargs):
        raise RuntimeError("model exploded")

    provider = _provider_with_model(_boom)
    assert asyncio.run(provider.redecode(_silence_pcm(), "de")) is None


def test_redecode_resamples_when_sample_rate_differs():
    seen = {}

    def _transcribe(audio, kwargs):
        seen["len"] = len(audio)
        return ([_FakeSegment("ok")], object())

    provider = _provider_with_model(_transcribe)
    # 8kHz input should be upsampled to 16kHz before decoding.
    pcm_8k = np.zeros(8000, dtype=np.int16).tobytes()  # 1s @ 8kHz
    asyncio.run(provider.redecode(pcm_8k, "de", sample_rate=8000))
    assert seen["len"] == pytest.approx(16000, rel=0.01)
