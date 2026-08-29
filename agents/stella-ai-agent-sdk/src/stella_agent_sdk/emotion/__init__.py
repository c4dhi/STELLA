"""Emotion tags: the vocabulary the LLM writes and the parser that removes it."""

from stella_agent_sdk.emotion.tags import (
    EMOTION_TAGS,
    EXPRESSION_TAGS,
    GESTURE_TAGS,
    EmotionCue,
    StripResult,
    strip_emotion_tags,
)

__all__ = [
    "EMOTION_TAGS",
    "EXPRESSION_TAGS",
    "GESTURE_TAGS",
    "EmotionCue",
    "StripResult",
    "strip_emotion_tags",
]
