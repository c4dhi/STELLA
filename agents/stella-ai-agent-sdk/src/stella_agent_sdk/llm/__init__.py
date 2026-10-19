"""SDK LLM service — the single source of truth for LLM access across agents.

Agents import the public surface from here:

    from stella_agent_sdk.llm import LLMService, LLMConfig, LLMMessage, LLMProvider
"""

from stella_agent_sdk.llm.service import (
    LLMService,
    LLMConfig,
    LLMMessage,
    LLMResponse,
    LLMProvider,
    LLMToolCall,
    LLMStreamingCallback,
    LLMProviderInterface,
    LLMUsageStats,
    stream_completion,
    FirstTokenTimeout,
)

__all__ = [
    "LLMService",
    "LLMConfig",
    "LLMMessage",
    "LLMResponse",
    "LLMProvider",
    "LLMToolCall",
    "LLMStreamingCallback",
    "LLMProviderInterface",
    "LLMUsageStats",
    "stream_completion",
    "FirstTokenTimeout",
]
