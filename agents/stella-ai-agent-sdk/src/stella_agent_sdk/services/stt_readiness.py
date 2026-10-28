"""Tell the screens whether speech recognition is ready to listen (#564).

After a quiet spell the STT model has gone cold, and the warmup a joining
participant triggers can take up to ~30 s. Nothing in the transcript stream
says so: the participant talks and nothing happens. The agent's own Warmup
call is the one thing that knows, so it is wrapped here and its progress is
published as an ``stt_status`` envelope:

    {"type": "stt_status",
     "data": {"state": "warming" | "ready" | "failed",
              "elapsed_ms": int, "language": "de" | "en" | ""}}

``warming`` goes out only once the warmup has run for ``announce_after``
seconds, so a model that is still warm (Warmup returns at once) never flashes
the card. ``elapsed_ms`` is how long it has been warming as of sending, not a
timestamp: the client counts on from its own clock, which keeps the "taking
longer than usual" switch right across the agent/browser clock skew. The
current state is re-sent to a participant who joins mid-warmup.

An older client ignores the unknown envelope type.
"""

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

ENVELOPE_TYPE = "stt_status"


class SttReadiness:
    def __init__(
        self,
        publish: Callable[[dict], Awaitable[None]],
        language: Callable[[], Optional[str]] = lambda: None,
        announce_after: float = 1.5,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._publish = publish
        self._language = language
        self._announce_after = announce_after
        self._clock = clock
        self.state = "ready"
        self._announced = False
        self._started: Optional[float] = None

    def payload(self) -> dict:
        elapsed = 0
        if self.state == "warming" and self._started is not None:
            elapsed = int((self._clock() - self._started) * 1000)
        return {
            "type": ENVELOPE_TYPE,
            "data": {
                "state": self.state,
                "elapsed_ms": elapsed,
                "language": (self._language() or "").lower(),
            },
        }

    def needs_resend(self) -> bool:
        """Whether a participant joining now should be told the state."""
        return self._announced

    async def _send(self) -> None:
        try:
            await self._publish(self.payload())
        except Exception:
            logger.exception("[STT-STATUS] Could not publish %s", self.state)

    async def track(self, warmup: Awaitable[dict]) -> dict:
        """Run ``warmup`` (an STTClient.warmup call), announcing it if slow."""
        if self.state == "warming":
            # Another join while warming: the first call already reports.
            return await warmup
        self.state = "warming"
        self._announced = False
        self._started = self._clock()
        task = asyncio.ensure_future(warmup)
        try:
            done, _ = await asyncio.wait({task}, timeout=self._announce_after)
            if not done:
                logger.info("[STT-STATUS] Warmup still running after %.1fs: telling the screens", self._announce_after)
                self._announced = True
                await self._send()
            result = await task
        except Exception as e:
            result = {"success": False, "message": str(e)}
        ok = bool(result.get("success"))
        self.state = "ready" if ok else "failed"
        if self._announced or not ok:
            self._announced = True
            await self._send()
        if not ok:
            logger.warning("[STT-STATUS] Warmup failed: %s", result.get("message"))
        return result
