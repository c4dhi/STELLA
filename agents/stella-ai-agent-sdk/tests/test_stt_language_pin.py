"""What language the pipeline asks STT to transcribe in.

The rule is narrow on purpose: pin STT to a language only when one was
DECLARED (a deployment pin, or the plan's own `language`), never to one that
was merely detected.

The asymmetry matters. A pinned session reports its pin back as the utterance's
"detected" language with confidence 1.0 — so feeding a detection back in would
make it confirm itself, and one bad first guess would be unrecoverable for the
rest of the conversation. That is exactly the failure this exists to prevent,
so it must not be reintroduced as a fix for it.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = None
    queued_playout_ms = 0.0

    def on_data_received(self, cb):
        pass

    async def publish_data(self, data, *a, **k):
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        pass

    def clear_playout(self):
        pass


def _pipe(monkeypatch, pin=None):
    if pin is None:
        monkeypatch.delenv("STELLA_LANGUAGE", raising=False)
    else:
        monkeypatch.setenv("STELLA_LANGUAGE", pin)
    return AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")


def test_no_declaration_means_auto_detect(monkeypatch):
    """Unchanged behaviour for plans that declare nothing: STT auto-detects,
    which is what yields the per-utterance detection signal for free."""
    pipe = _pipe(monkeypatch)
    assert pipe._resolve_stt_language() is None


def test_plan_declaration_pins_transcription(monkeypatch):
    pipe = _pipe(monkeypatch)
    pipe.set_stt_language("de")
    assert pipe._resolve_stt_language() == "de"


def test_auto_and_none_clear_the_pin(monkeypatch):
    pipe = _pipe(monkeypatch)
    pipe.set_stt_language("de")
    pipe.set_stt_language("auto")
    assert pipe._resolve_stt_language() is None
    pipe.set_stt_language("de")
    pipe.set_stt_language(None)
    assert pipe._resolve_stt_language() is None


def test_deployment_pin_outranks_the_plan(monkeypatch):
    """An operator who fixed the deployment to one language means it — a plan
    uploaded later must not quietly override the whole deployment."""
    pipe = _pipe(monkeypatch, pin="en")
    pipe.set_stt_language("de")
    assert pipe._resolve_stt_language() == "en"


def test_resolved_language_is_read_per_utterance(monkeypatch):
    """The provider is a callable, not a value captured when the stream opened,
    so a plan language that lands after the first utterance still applies."""
    pipe = _pipe(monkeypatch)
    assert pipe._resolve_stt_language() is None
    pipe.set_stt_language("de")
    assert pipe._resolve_stt_language() == "de"
