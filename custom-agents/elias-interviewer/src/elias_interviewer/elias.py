"""ELIAS, reached only through a STELLA connector.

The agent never sees the ELIAS token. STELLA's backend holds it and runs the
MCP call; the agent only names the connector handle and the tool.

The connector API (SDK ``self.connectors``) is::

    await connectors.call_tool(handle, tool, arguments) -> dict   # structured result
    raises ConnectorError(retryable=bool)
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Protocol

logger = logging.getLogger(__name__)

REQUIRED_TOOLS = (
    "get_interview_guide",
    "start_interview",
    "record_interview_message",
    "end_interview",
)


class Connectors(Protocol):
    async def call_tool(self, handle: str, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]: ...


class EliasUnavailable(Exception):
    """ELIAS could not be reached or refused the call."""


def _retryable(e: BaseException) -> bool:
    # ConnectorError carries .retryable; anything else (timeouts, transport) is worth a retry.
    return bool(getattr(e, "retryable", True))


async def with_retries(factory, *, attempts: int = 3, base_delay_s: float = 0.5):
    for i in range(attempts):
        try:
            return await factory()
        except Exception as e:
            if not _retryable(e) or i == attempts - 1:
                raise
            delay = base_delay_s * (2**i)
            logger.warning("[ELIAS] %s, retrying in %.1fs", e, delay)
            await asyncio.sleep(delay)


class Elias:
    def __init__(self, connectors: Connectors, handle: str, project_id: str) -> None:
        self._c = connectors
        self.handle = handle
        self.project_id = project_id

    async def _call(self, tool: str, args: Dict[str, Any], *, attempts: int = 3) -> Dict[str, Any]:
        try:
            result = await with_retries(lambda: self._c.call_tool(self.handle, tool, args), attempts=attempts)
        except Exception as e:
            raise EliasUnavailable(f"{tool}: {e}") from e
        if not isinstance(result, dict):
            raise EliasUnavailable(f"{tool}: unexpected reply")
        if result.get("error"):
            raise EliasUnavailable(f"{tool}: {result['error']}")
        return result

    async def get_guide(self) -> Dict[str, Any]:
        return await self._call("get_interview_guide", {"project_id": self.project_id})

    async def start_interview(self, participant_id: str, session_id: str) -> str:
        data = await self._call(
            "start_interview",
            {"project_id": self.project_id, "participant_id": participant_id, "session_id": session_id},
            # Not idempotent: a retry after a timeout could open a second
            # transcript. One attempt; the agent reports the failure.
            attempts=1,
        )
        tid = data.get("transcript_id") or data.get("id")
        if not tid:
            raise EliasUnavailable("start_interview returned no transcript_id")
        return str(tid)

    async def record(self, transcript_id: str, speaker: str, content: str, *, message_id: str, timestamp: str) -> None:
        await self._call(
            "record_interview_message",
            {
                "transcript_id": transcript_id,
                "speaker": speaker,
                "content": content,
                "timestamp": timestamp,
                "message_id": message_id,
            },
            attempts=4,
        )

    async def end_interview(self, transcript_id: str) -> None:
        await self._call("end_interview", {"transcript_id": transcript_id})


class Recorder:
    """Writes turns to ELIAS as they happen, in order, without making the
    participant wait. Each turn gets its message_id once, so a retry of the
    same turn is deduplicated by ELIAS."""

    def __init__(self, elias: Elias, transcript_id: str) -> None:
        self._elias = elias
        self.transcript_id = transcript_id
        self._queue: "asyncio.Queue[Dict[str, str]]" = asyncio.Queue()
        self._worker: Optional[asyncio.Task] = None
        self.written = 0
        self.failed: List[Dict[str, str]] = []

    def record(self, speaker: str, content: str) -> None:
        if not content.strip():
            return
        if self._worker is None:
            self._worker = asyncio.create_task(self._run())
        self._queue.put_nowait(
            {
                "speaker": speaker,
                "content": content,
                "message_id": uuid.uuid4().hex,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )

    async def flush(self, timeout_s: float = 20.0) -> None:
        if self._worker is None:
            return
        try:
            await asyncio.wait_for(self._queue.join(), timeout=timeout_s)
        except asyncio.TimeoutError:
            logger.error("[ELIAS] %d turn(s) still unwritten after %ss", self._queue.qsize(), timeout_s)

    async def close(self) -> None:
        await self.flush()
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except (asyncio.CancelledError, Exception):
                pass
            self._worker = None

    async def _run(self) -> None:
        while True:
            msg = await self._queue.get()
            try:
                await self._elias.record(
                    self.transcript_id,
                    msg["speaker"],
                    msg["content"],
                    message_id=msg["message_id"],
                    timestamp=msg["timestamp"],
                )
                self.written += 1
            except Exception as e:
                logger.error("[ELIAS] could not write %s turn: %s", msg["speaker"], e)
                self.failed.append(msg)
            finally:
                self._queue.task_done()
