"""Base classes for tool infrastructure.

Provides:
- BaseTool: Abstract base class that all tools must implement
- ToolResult: Structured result from tool execution
- ToolCall: Represents a tool call from the LLM
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ToolResult:
    """Result from tool execution.

    Attributes:
        success: Whether the tool executed successfully
        data: Optional data returned by the tool
        error: Error message if execution failed
    """
    success: bool
    data: Optional[Any] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {"success": self.success}
        if self.data is not None:
            result["data"] = self.data
        if self.error is not None:
            result["error"] = self.error
        return result


@dataclass
class ToolCall:
    """Represents a tool call from the LLM.

    Attributes:
        id: Unique identifier for this tool call (for matching results)
        name: Name of the tool to call
        arguments: Arguments to pass to the tool
    """
    id: str
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_openai(cls, tool_call: Dict[str, Any]) -> "ToolCall":
        """Create from OpenAI tool call format."""
        import json
        func = tool_call.get("function", {})
        args = func.get("arguments", "{}")
        if isinstance(args, str):
            args = json.loads(args)
        return cls(
            id=tool_call.get("id", ""),
            name=func.get("name", ""),
            arguments=args
        )

    @classmethod
    def from_anthropic(cls, tool_use: Dict[str, Any]) -> "ToolCall":
        """Create from Anthropic tool use format."""
        return cls(
            id=tool_use.get("id", ""),
            name=tool_use.get("name", ""),
            arguments=tool_use.get("input", {})
        )


class BaseTool(ABC):
    """Abstract base class for all tools.

    Subclasses must implement:
    - name: Unique tool name
    - description: Description for the LLM
    - parameters_schema: JSON Schema for parameters
    - execute(): Async method to execute the tool

    Example:
        class MyTool(BaseTool):
            @property
            def name(self) -> str:
                return "my_tool"

            @property
            def description(self) -> str:
                return "Does something useful"

            @property
            def parameters_schema(self) -> Dict[str, Any]:
                return {
                    "type": "object",
                    "properties": {
                        "param1": {"type": "string", "description": "First param"}
                    },
                    "required": ["param1"]
                }

            async def execute(self, param1: str) -> ToolResult:
                # Do something
                return ToolResult(success=True, data={"result": "value"})
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique tool name."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Tool description for the LLM."""
        pass

    @property
    @abstractmethod
    def parameters_schema(self) -> Dict[str, Any]:
        """JSON Schema for tool parameters."""
        pass

    @abstractmethod
    async def execute(self, **kwargs) -> ToolResult:
        """Execute the tool with given parameters.

        Args:
            **kwargs: Tool-specific parameters

        Returns:
            ToolResult with success status and optional data/error
        """
        pass

    def to_openai_schema(self) -> Dict[str, Any]:
        """Convert to OpenAI function calling format.

        Returns:
            Dict compatible with OpenAI's tools parameter
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters_schema
            }
        }

    def to_anthropic_schema(self) -> Dict[str, Any]:
        """Convert to Anthropic tool format.

        Returns:
            Dict compatible with Anthropic's tools parameter
        """
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters_schema
        }
