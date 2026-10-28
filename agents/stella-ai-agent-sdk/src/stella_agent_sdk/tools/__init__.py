"""Tool infrastructure for stella-agent-sdk.

This module provides the foundation for LLM tool calling:
- BaseTool: Abstract base class for all tools
- ToolResult: Structured result from tool execution
- ToolRegistry: Manages available tools
- ToolExecutor: Handles tool execution loop with LLM
"""

from stella_agent_sdk.tools.base import BaseTool, ToolResult, ToolCall
from stella_agent_sdk.tools.registry import ToolRegistry
from stella_agent_sdk.tools.executor import ToolExecutor

__all__ = [
    "BaseTool",
    "ToolResult",
    "ToolCall",
    "ToolRegistry",
    "ToolExecutor",
]
