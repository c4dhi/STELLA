"""Shared voice-activity machinery, used by every STT provider."""

from vad.speech_gate import GateConfig, GateSignal, SpeechGate, SpeechState

__all__ = ["GateConfig", "GateSignal", "SpeechGate", "SpeechState"]
