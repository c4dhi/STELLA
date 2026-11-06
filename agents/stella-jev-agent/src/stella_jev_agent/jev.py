"""The one connection to Jev. Every failure surfaces as JevUnavailable."""

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping

from typesafe_sdk import AsyncTypeSafeClient, RetryPolicy, TypeSafeError

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = float(os.environ.get("JEV_TIMEOUT_MS", "1500")) / 1000


class JevUnavailable(Exception):
    """Jev could not answer in time, so the caller uses its fallback."""


@dataclass
class JevAnswers:
    answers: Dict[str, Any]
    latency_ms: float


class JevClient:
    """Asks Jev once, with no retries: someone is waiting in silence."""

    def __init__(self, model: str = "jev-latest", timeout_s: float = DEFAULT_TIMEOUT_S):
        self.model = model
        self.timeout_s = timeout_s
        self._client = None

    async def ask(self, state: Dict[str, Any], questions: Mapping[str, Any], timeout_s: float = 0) -> JevAnswers:
        started = time.monotonic()
        try:
            # Created on first use so the agent still starts without a key.
            if self._client is None:
                self._client = AsyncTypeSafeClient(
                    model=self.model, retry=RetryPolicy(max_retries=0)
                )
            response = await self._client.system_one(
                state, questions, timeout=timeout_s or self.timeout_s
            )
        except TypeSafeError as e:
            raise JevUnavailable(type(e).__name__) from e
        return JevAnswers(response.answers, (time.monotonic() - started) * 1000)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
