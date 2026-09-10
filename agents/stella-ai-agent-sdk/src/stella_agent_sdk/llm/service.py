"""Unified LLM Service for handling all language model interactions.

Provides a consistent interface across LLM providers (OpenAI via LangChain,
OpenAI direct/tool-calling, Ollama, Mock) with streaming and tool-call support.

This is the SINGLE source of truth for LLM access in the SDK — every agent
(stella-v2, stella-light, …) consumes ``stella_agent_sdk.llm`` rather than
shipping its own copy, so provider behavior, config loading, and usage tracking
stay identical across agents.
"""

import asyncio
import json
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Any, AsyncIterator, List, Optional, Tuple, Union
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class LLMProvider(Enum):
    """Supported LLM providers."""
    OPENAI_LANGCHAIN = "openai_langchain"
    OPENAI_DIRECT = "openai_direct"
    OLLAMA = "ollama"
    MOCK = "mock"


@dataclass
class LLMToolCall:
    """Represents a tool call from the LLM."""
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class LLMConfig:
    """Configuration for LLM requests."""
    model: str = "gpt-4o-mini"
    temperature: float = 0.7
    max_tokens: int = 800
    provider: LLMProvider = LLMProvider.OPENAI_LANGCHAIN
    streaming: bool = True
    timeout: float = 30.0
    base_url: Optional[str] = None
    context_length: int = 4096
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: str = "auto"
    # JSON mode: when True, force the model to output valid JSON
    json_mode: bool = False


@dataclass
class LLMMessage:
    """Standard message format for LLM interactions."""
    role: str  # "system", "user", "assistant", "tool"
    content: str
    metadata: Optional[Dict[str, Any]] = None
    tool_calls: Optional[List[LLMToolCall]] = None
    tool_call_id: Optional[str] = None


@dataclass
class LLMResponse:
    """Standard response format from LLM providers."""
    content: str
    model: str
    provider: str
    usage_tokens: int = 0
    cost_usd: float = 0.0
    response_time: float = 0.0
    metadata: Optional[Dict[str, Any]] = None
    tool_calls: Optional[List[LLMToolCall]] = None


class LLMStreamingCallback(ABC):
    """Abstract callback interface for streaming LLM responses."""

    @abstractmethod
    async def on_token(self, token: str, accumulated_text: str) -> None:
        """Called when a new token arrives."""

    @abstractmethod
    async def on_complete(self, final_response: LLMResponse) -> None:
        """Called when streaming is complete."""

    @abstractmethod
    async def on_error(self, error: Exception) -> None:
        """Called when an error occurs."""

    async def on_tool_call(self, tool_call: LLMToolCall) -> None:
        """Called when a tool call is made by the LLM."""


class LLMProviderInterface(ABC):
    """Abstract interface for LLM providers."""

    @abstractmethod
    async def generate(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: Optional[LLMStreamingCallback] = None
    ) -> LLMResponse:
        """Generate a response from the LLM."""

    @abstractmethod
    async def generate_stream(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: LLMStreamingCallback
    ) -> LLMResponse:
        """Generate a streaming response from the LLM."""

    @abstractmethod
    def get_provider_name(self) -> str:
        """Get the provider name."""

    @abstractmethod
    def is_available(self) -> bool:
        """Check if the provider is available."""


class OpenAILangChainProvider(LLMProviderInterface):
    """OpenAI provider using LangChain."""

    #: Cap on distinct pooled client shapes (see _get_client).
    _MAX_POOLED_CLIENTS = 32

    def __init__(self):
        self.available = False
        self.ChatOpenAI = None
        # One pooled client per distinct (config, streaming) shape. LangChain
        # gives every ChatOpenAI its own httpx pool, so building one per call
        # threw away the warm TLS connection to api.openai.com each time —
        # measured at +64ms on the median call from the prod host (5 paired
        # runs: fresh 481ms vs pooled 417ms). No single call notices much, but a
        # turn makes roughly eight of them (six experts, arbitration, bridge,
        # response), and they are on the critical path.
        self._clients: Dict[Tuple, Any] = {}
        self._initialize()

    def _initialize(self):
        try:
            from langchain_openai import ChatOpenAI
            self.ChatOpenAI = ChatOpenAI
            self.available = True
            logger.info("OpenAI LangChain provider initialized")
        except ImportError as e:
            logger.warning(f"OpenAI LangChain provider not available: {e}")
            self.available = False

    def get_provider_name(self) -> str:
        return "openai_langchain"

    def is_available(self) -> bool:
        return self.available

    def _get_client(self, config: LLMConfig, streaming: bool):
        """Return a pooled client for this config shape, building one if absent.

        Keyed on ``streaming`` as well as the config: the two call paths used to
        flip ``client.streaming`` on the object they had just built, which was
        harmless while every call owned its own client and a race the moment
        they share one — six experts run concurrently on the same turn.
        """
        if not self.available:
            raise RuntimeError("OpenAI LangChain provider not available")
        key = (
            config.model, config.temperature, config.max_tokens,
            config.timeout, bool(config.json_mode), streaming,
        )
        client = self._clients.get(key)
        if client is None:
            # Distinct shapes are bounded by the configured nodes, but a caller
            # sweeping temperature would grow this without limit. Clear rather
            # than evict: rebuilding a handful of clients costs one handshake
            # each, which is exactly what this pool saves, and an LRU here would
            # be machinery for a case that should not arise.
            if len(self._clients) >= self._MAX_POOLED_CLIENTS:
                logger.info(
                    "LLM client pool hit %d shapes — clearing", len(self._clients)
                )
                self._clients.clear()
            client = self._create_client(config, streaming)
            self._clients[key] = client
        return client

    def _create_client(self, config: LLMConfig, streaming: bool):
        if not self.available:
            raise RuntimeError("OpenAI LangChain provider not available")

        kwargs = dict(
            model_name=config.model,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            streaming=streaming,
            request_timeout=config.timeout,
        )

        # Enable JSON mode if requested
        if config.json_mode:
            kwargs["model_kwargs"] = {"response_format": {"type": "json_object"}}

        return self.ChatOpenAI(**kwargs)

    def _convert_messages(self, messages: List[LLMMessage]) -> List[tuple]:
        return [(msg.role, msg.content) for msg in messages]

    async def generate(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: Optional[LLMStreamingCallback] = None
    ) -> LLMResponse:
        start_time = time.time()
        try:
            client = self._get_client(config, streaming=False)
            langchain_messages = self._convert_messages(messages)
            result = await client.ainvoke(langchain_messages)

            content = result.content if hasattr(result, 'content') else str(result)
            response_time = time.time() - start_time

            response = LLMResponse(
                content=content,
                model=config.model,
                provider=self.get_provider_name(),
                response_time=response_time,
                usage_tokens=int(len(content.split()) * 1.3),
            )
            if callback:
                await callback.on_complete(response)
            return response
        except Exception as e:
            if callback:
                await callback.on_error(e)
            raise

    async def generate_stream(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: LLMStreamingCallback
    ) -> LLMResponse:
        start_time = time.time()
        accumulated_content = ""
        try:
            client = self._get_client(config, streaming=True)
            langchain_messages = self._convert_messages(messages)

            async for chunk in client.astream(langchain_messages):
                if hasattr(chunk, 'content') and chunk.content:
                    accumulated_content += chunk.content
                    await callback.on_token(chunk.content, accumulated_content)

            response_time = time.time() - start_time
            response = LLMResponse(
                content=accumulated_content,
                model=config.model,
                provider=self.get_provider_name(),
                response_time=response_time,
                usage_tokens=int(len(accumulated_content.split()) * 1.3),
            )
            await callback.on_complete(response)
            return response
        except Exception as e:
            await callback.on_error(e)
            raise


class OpenAIDirectProvider(LLMProviderInterface):
    """Direct OpenAI provider with full tool calling and JSON mode support."""

    def __init__(self):
        self.available = False
        self.openai = None
        self._initialize()

    def _initialize(self):
        try:
            import openai
            self.openai = openai
            self.client = openai.AsyncOpenAI()
            self.available = True
            logger.info("OpenAI Direct provider initialized")
        except ImportError as e:
            logger.warning(f"OpenAI Direct provider not available: {e}")
            self.available = False

    def get_provider_name(self) -> str:
        return "openai_direct"

    def is_available(self) -> bool:
        return self.available

    def _convert_messages(self, messages: List[LLMMessage]) -> List[Dict[str, Any]]:
        result = []
        for msg in messages:
            message_dict: Dict[str, Any] = {
                "role": msg.role,
                "content": msg.content or ""
            }
            if msg.role == "tool" and msg.tool_call_id:
                message_dict["tool_call_id"] = msg.tool_call_id
            if msg.tool_calls:
                message_dict["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments)
                        }
                    }
                    for tc in msg.tool_calls
                ]
            result.append(message_dict)
        return result

    def _parse_tool_calls(self, openai_tool_calls) -> List[LLMToolCall]:
        if not openai_tool_calls:
            return []
        result = []
        for tc in openai_tool_calls:
            try:
                arguments = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                arguments = {}
            result.append(LLMToolCall(
                id=tc.id,
                name=tc.function.name,
                arguments=arguments
            ))
        return result

    async def generate(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: Optional[LLMStreamingCallback] = None
    ) -> LLMResponse:
        if not self.available:
            raise RuntimeError("OpenAI Direct provider not available")

        start_time = time.time()
        try:
            openai_messages = self._convert_messages(messages)
            kwargs: Dict[str, Any] = {
                "model": config.model,
                "messages": openai_messages,
                "temperature": config.temperature,
                "max_tokens": config.max_tokens,
            }
            if config.json_mode:
                kwargs["response_format"] = {"type": "json_object"}
            if config.tools:
                kwargs["tools"] = config.tools
                if config.tool_choice != "auto":
                    kwargs["tool_choice"] = config.tool_choice

            result = await self.client.chat.completions.create(**kwargs)
            choice = result.choices[0]
            content = choice.message.content or ""
            tool_calls = self._parse_tool_calls(choice.message.tool_calls)
            response_time = time.time() - start_time

            response = LLMResponse(
                content=content,
                model=config.model,
                provider=self.get_provider_name(),
                response_time=response_time,
                usage_tokens=result.usage.total_tokens if result.usage else 0,
                tool_calls=tool_calls if tool_calls else None
            )
            if callback:
                for tc in tool_calls:
                    await callback.on_tool_call(tc)
                await callback.on_complete(response)
            return response
        except Exception as e:
            if callback:
                await callback.on_error(e)
            raise

    async def generate_stream(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: LLMStreamingCallback
    ) -> LLMResponse:
        if not self.available:
            raise RuntimeError("OpenAI Direct provider not available")

        start_time = time.time()
        accumulated_content = ""
        tool_calls_builder: Dict[int, Dict[str, Any]] = {}

        try:
            openai_messages = self._convert_messages(messages)
            kwargs: Dict[str, Any] = {
                "model": config.model,
                "messages": openai_messages,
                "temperature": config.temperature,
                "max_tokens": config.max_tokens,
                "stream": True,
            }
            if config.json_mode:
                kwargs["response_format"] = {"type": "json_object"}
            if config.tools:
                kwargs["tools"] = config.tools
                if config.tool_choice != "auto":
                    kwargs["tool_choice"] = config.tool_choice

            stream = await self.client.chat.completions.create(**kwargs)

            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta:
                    if delta.content:
                        accumulated_content += delta.content
                        await callback.on_token(delta.content, accumulated_content)
                    if delta.tool_calls:
                        for tc_delta in delta.tool_calls:
                            idx = tc_delta.index
                            if idx not in tool_calls_builder:
                                tool_calls_builder[idx] = {"id": "", "name": "", "arguments": ""}
                            if tc_delta.id:
                                tool_calls_builder[idx]["id"] = tc_delta.id
                            if tc_delta.function:
                                if tc_delta.function.name:
                                    tool_calls_builder[idx]["name"] = tc_delta.function.name
                                if tc_delta.function.arguments:
                                    tool_calls_builder[idx]["arguments"] += tc_delta.function.arguments

            tool_calls = []
            for idx in sorted(tool_calls_builder.keys()):
                tc_data = tool_calls_builder[idx]
                try:
                    arguments = json.loads(tc_data["arguments"]) if tc_data["arguments"] else {}
                except json.JSONDecodeError:
                    arguments = {}
                tc = LLMToolCall(id=tc_data["id"], name=tc_data["name"], arguments=arguments)
                tool_calls.append(tc)
                await callback.on_tool_call(tc)

            response_time = time.time() - start_time
            response = LLMResponse(
                content=accumulated_content,
                model=config.model,
                provider=self.get_provider_name(),
                response_time=response_time,
                usage_tokens=int(len(accumulated_content.split()) * 1.3),
                tool_calls=tool_calls if tool_calls else None
            )
            await callback.on_complete(response)
            return response
        except Exception as e:
            await callback.on_error(e)
            raise


class OllamaProvider(LLMProviderInterface):
    """Ollama provider for local LLMs."""

    def __init__(self):
        self.available = False
        self.requests = None
        self._initialize()

    def _initialize(self):
        try:
            import requests
            self.requests = requests
            self.available = True
            logger.info("Ollama provider initialized")
        except ImportError:
            logger.warning("Ollama provider requires 'requests' package")
            self.available = False

    def get_provider_name(self) -> str:
        return "ollama"

    def is_available(self) -> bool:
        return self.available

    async def generate(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: Optional[LLMStreamingCallback] = None
    ) -> LLMResponse:
        if not self.available:
            raise RuntimeError("Ollama provider not available")

        start_time = time.time()
        base_url = config.base_url or "http://localhost:11434"
        prompt = self._build_prompt(messages)

        payload = {
            "model": config.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": config.temperature,
                "num_predict": config.max_tokens,
                "num_ctx": config.context_length,
            },
        }

        try:
            response = self.requests.post(
                f"{base_url}/api/generate", json=payload, timeout=config.timeout
            )
            response.raise_for_status()
            result = response.json()
            content = result.get("response", "")
            response_time = time.time() - start_time

            llm_response = LLMResponse(
                content=content,
                model=config.model,
                provider=self.get_provider_name(),
                response_time=response_time,
                usage_tokens=int(len(content.split()) * 1.3),
            )
            if callback:
                await callback.on_complete(llm_response)
            return llm_response
        except Exception as e:
            if callback:
                await callback.on_error(e)
            raise

    async def generate_stream(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: LLMStreamingCallback
    ) -> LLMResponse:
        if not self.available:
            raise RuntimeError("Ollama provider not available")

        start_time = time.time()
        base_url = config.base_url or "http://localhost:11434"
        accumulated_content = ""
        prompt = self._build_prompt(messages)

        payload = {
            "model": config.model,
            "prompt": prompt,
            "stream": True,
            "options": {
                "temperature": config.temperature,
                "num_predict": config.max_tokens,
                "num_ctx": config.context_length,
            },
        }

        try:
            response = self.requests.post(
                f"{base_url}/api/generate", json=payload, stream=True, timeout=config.timeout
            )
            response.raise_for_status()

            for line in response.iter_lines():
                if line:
                    try:
                        chunk_data = json.loads(line.decode("utf-8"))
                        if "response" in chunk_data:
                            token = chunk_data["response"]
                            accumulated_content += token
                            await callback.on_token(token, accumulated_content)
                        if chunk_data.get("done", False):
                            break
                    except json.JSONDecodeError:
                        continue

            response_time = time.time() - start_time
            llm_response = LLMResponse(
                content=accumulated_content,
                model=config.model,
                provider=self.get_provider_name(),
                response_time=response_time,
                usage_tokens=int(len(accumulated_content.split()) * 1.3),
            )
            await callback.on_complete(llm_response)
            return llm_response
        except Exception as e:
            await callback.on_error(e)
            raise

    def _build_prompt(self, messages: List[LLMMessage]) -> str:
        prompt_parts = []
        for msg in messages:
            if msg.role == "system":
                prompt_parts.append(f"System: {msg.content}")
            elif msg.role == "user":
                prompt_parts.append(f"User: {msg.content}")
            elif msg.role == "assistant":
                prompt_parts.append(f"Assistant: {msg.content}")
        prompt_parts.append("Assistant:")
        return "\n\n".join(prompt_parts)


class MockLLMProvider(LLMProviderInterface):
    """Mock provider for testing."""

    def __init__(self, mock_responses: Optional[List[str]] = None):
        self.mock_responses = mock_responses or ["This is a mock response."]
        self.response_index = 0

    def get_provider_name(self) -> str:
        return "mock"

    def is_available(self) -> bool:
        return True

    async def generate(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: Optional[LLMStreamingCallback] = None
    ) -> LLMResponse:
        await asyncio.sleep(0.1)
        content = self.mock_responses[self.response_index % len(self.mock_responses)]
        self.response_index += 1

        response = LLMResponse(
            content=content, model="mock-model", provider="mock",
            response_time=0.1, usage_tokens=len(content.split()),
        )
        if callback:
            await callback.on_complete(response)
        return response

    async def generate_stream(
        self,
        messages: List[LLMMessage],
        config: LLMConfig,
        callback: LLMStreamingCallback
    ) -> LLMResponse:
        content = self.mock_responses[self.response_index % len(self.mock_responses)]
        self.response_index += 1

        accumulated = ""
        for word in content.split():
            accumulated += word + " "
            await callback.on_token(word + " ", accumulated)
            await asyncio.sleep(0.05)

        response = LLMResponse(
            content=content, model="mock-model", provider="mock",
            response_time=0.1, usage_tokens=len(content.split()),
        )
        await callback.on_complete(response)
        return response


@dataclass
class LLMUsageStats:
    """Track LLM usage statistics."""
    total_requests: int = 0
    successful_requests: int = 0
    failed_requests: int = 0
    total_tokens_used: int = 0
    total_cost_usd: float = 0.0
    avg_response_time: float = 0.0
    provider_stats: Dict[str, Dict[str, Any]] = field(default_factory=dict)


class LLMService:
    """Main LLM service that manages providers and handles requests.

    Provides a unified interface for generating LLM responses across
    multiple providers (OpenAI, Ollama, Mock) with streaming support,
    usage tracking, and automatic fallback.
    """

    def __init__(self, config_path: Optional[str] = None):
        self.providers: Dict[LLMProvider, LLMProviderInterface] = {}
        self.default_config = LLMConfig()
        self.usage_stats = LLMUsageStats()
        self.config_path = config_path

        self._initialize_providers()
        self._load_config()

    def _initialize_providers(self):
        openai_langchain_provider = OpenAILangChainProvider()
        if openai_langchain_provider.is_available():
            self.providers[LLMProvider.OPENAI_LANGCHAIN] = openai_langchain_provider

        openai_direct_provider = OpenAIDirectProvider()
        if openai_direct_provider.is_available():
            self.providers[LLMProvider.OPENAI_DIRECT] = openai_direct_provider

        ollama_provider = OllamaProvider()
        if ollama_provider.is_available():
            self.providers[LLMProvider.OLLAMA] = ollama_provider

        self.providers[LLMProvider.MOCK] = MockLLMProvider()

        logger.info(f"Initialized {len(self.providers)} providers: {list(self.providers.keys())}")

    def _load_config(self):
        if self.config_path and Path(self.config_path).exists():
            try:
                with open(self.config_path) as f:
                    config_data = json.load(f)
                    for key, value in config_data.items():
                        if hasattr(self.default_config, key):
                            if key == "provider" and isinstance(value, str):
                                try:
                                    value = LLMProvider(value)
                                except ValueError:
                                    logger.warning(f"Unknown provider '{value}', using default")
                                    continue
                            setattr(self.default_config, key, value)
                logger.info(f"Loaded config from {self.config_path}")

                provider_name = getattr(self.default_config.provider, 'value', str(self.default_config.provider))
                logger.info(f"Provider: {provider_name}, Model: {self.default_config.model}")
            except Exception as e:
                logger.error(f"Failed to load config: {e}")

    def get_available_providers(self) -> List[str]:
        return [provider.get_provider_name() for provider in self.providers.values()]

    def get_provider(self, provider_type: LLMProvider) -> Optional[LLMProviderInterface]:
        return self.providers.get(provider_type)

    async def generate(
        self,
        messages: Union[List[LLMMessage], List[tuple], str],
        config: Optional[LLMConfig] = None,
        callback: Optional[LLMStreamingCallback] = None,
        component_name: str = "unknown"
    ) -> LLMResponse:
        """Generate a response using the configured provider.

        Args:
            messages: Input messages (LLMMessage list, tuple list, or string).
            config: Optional LLM config override.
            callback: Optional streaming callback.
            component_name: Identifier for logging.

        Returns:
            LLMResponse with generated content.
        """
        if config is None:
            config = self.default_config

        if isinstance(messages, str):
            messages = [LLMMessage(role="user", content=messages)]
        elif isinstance(messages, list) and messages and isinstance(messages[0], tuple):
            messages = [LLMMessage(role=role, content=content) for role, content in messages]

        provider = self.providers.get(config.provider)
        if not provider:
            if self.providers:
                provider = list(self.providers.values())[0]
                logger.warning(f"Provider {config.provider} not available, using {provider.get_provider_name()}")
            else:
                raise RuntimeError("No LLM providers available")

        self.usage_stats.total_requests += 1

        try:
            if config.streaming and callback:
                response = await provider.generate_stream(messages, config, callback)
            else:
                response = await provider.generate(messages, config, callback)

            self.usage_stats.successful_requests += 1
            self.usage_stats.total_tokens_used += response.usage_tokens
            self.usage_stats.total_cost_usd += response.cost_usd

            total_time = self.usage_stats.avg_response_time * (self.usage_stats.successful_requests - 1) + response.response_time
            self.usage_stats.avg_response_time = total_time / self.usage_stats.successful_requests

            provider_name = provider.get_provider_name()
            if provider_name not in self.usage_stats.provider_stats:
                self.usage_stats.provider_stats[provider_name] = {
                    "requests": 0, "tokens": 0, "cost": 0.0, "avg_time": 0.0
                }

            stats = self.usage_stats.provider_stats[provider_name]
            stats["requests"] += 1
            stats["tokens"] += response.usage_tokens
            stats["cost"] += response.cost_usd
            stats["avg_time"] = (stats["avg_time"] * (stats["requests"] - 1) + response.response_time) / stats["requests"]

            logger.info(f"{component_name}: {provider_name} response in {response.response_time:.2f}s")
            return response

        except Exception as e:
            self.usage_stats.failed_requests += 1
            logger.error(f"{component_name}: Request failed: {e}")
            raise

    def get_usage_stats(self) -> Dict[str, Any]:
        return {
            "total_requests": self.usage_stats.total_requests,
            "successful_requests": self.usage_stats.successful_requests,
            "failed_requests": self.usage_stats.failed_requests,
            "success_rate": (self.usage_stats.successful_requests / max(1, self.usage_stats.total_requests)) * 100,
            "total_tokens": self.usage_stats.total_tokens_used,
            "total_cost_usd": self.usage_stats.total_cost_usd,
            "avg_response_time": self.usage_stats.avg_response_time,
            "providers": self.usage_stats.provider_stats,
        }

    def reset_stats(self):
        self.usage_stats = LLMUsageStats()


async def stream_completion(
    llm_service: "LLMService",
    messages: List[LLMMessage],
    config: LLMConfig,
    component_name: str = "unknown",
) -> AsyncIterator[Tuple[str, bool]]:
    """Consume a streaming LLM generation as an async iterator.

    SINGLE SOURCE OF TRUTH for adapting the callback-based streaming API into an
    ``async for``. Pipeline stages used to each hand-roll the same
    queue+callback+create_task bridge; they now share this one. Yields
    ``(accumulated_text, is_final)`` pairs — the full text so far, then a final
    pair with ``is_final=True`` carrying the authoritative final text.

    Built on ``llm_service.generate(callback=...)`` so any service (real or a
    test double) that honours that contract works unchanged. Raises if the
    generation errors (the provider signals ``on_error``, or the underlying task
    raises before any callback fires — covered by the done-callback below, so the
    consumer never hangs on a silent failure).
    """
    queue: asyncio.Queue = asyncio.Queue()

    class _QueueCallback(LLMStreamingCallback):
        async def on_token(self, token: str, accumulated_text: str) -> None:
            await queue.put(("token", accumulated_text))

        async def on_complete(self, final_response: LLMResponse) -> None:
            await queue.put(("complete", final_response))

        async def on_error(self, error: Exception) -> None:
            await queue.put(("error", error))

    task = asyncio.create_task(
        llm_service.generate(
            messages=messages, config=config,
            callback=_QueueCallback(), component_name=component_name,
        )
    )

    # If generate() raises BEFORE any callback fires, no event is ever queued and
    # the drain below would hang. Surface that exception as an error event.
    def _on_done(t: asyncio.Task) -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            queue.put_nowait(("error", exc))

    task.add_done_callback(_on_done)

    last = ""
    try:
        while True:
            kind, payload = await queue.get()
            if kind == "token":
                last = payload
                yield last, False
            elif kind == "complete":
                final_text = payload.content if (payload and getattr(payload, "content", None)) else last
                yield final_text, True
                return
            else:  # "error"
                raise payload
    finally:
        if not task.done():
            task.cancel()
