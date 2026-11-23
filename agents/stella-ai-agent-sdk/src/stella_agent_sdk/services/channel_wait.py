"""Wait for a speech service to come up, for as long as it may take to start (#151).

STT and TTS load their models before they accept connections, and their
Kubernetes startupProbes allow 10 minutes for it (``k8s/08-stt-service.yaml``,
``k8s/09-tts-service.yaml``: 10 s x 60). A cold TTS load took 366 s on
10 Nov 2026. An agent that started in that window used to try for about 80 s
and then exit, and agent pods are never restarted, so the session lost its
agent. Now it keeps trying for the same budget the deploy script waits
(``scripts/lib/deploy.sh``: the startupProbe plus 120 s), and logs how long
it has waited on every attempt.

``STELLA_SPEECH_WAIT_SECONDS`` changes the budget for a deployment.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable, Optional

import grpc

logger = logging.getLogger(__name__)

WAIT_ENV = "STELLA_SPEECH_WAIT_SECONDS"
# The speech services' startupProbe (10 s x 60) plus the deploy script's 120 s margin.
DEFAULT_WAIT_SECONDS = 720.0
ATTEMPT_TIMEOUT_SECONDS = 10.0
BASE_DELAY_SECONDS = 2.0
MAX_DELAY_SECONDS = 10.0


def speech_wait_seconds(env: Optional[dict] = None) -> float:
    """The budget from ``STELLA_SPEECH_WAIT_SECONDS``, or the default when unset or unreadable."""
    raw = (env if env is not None else os.environ).get(WAIT_ENV, "").strip()
    if not raw:
        return DEFAULT_WAIT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        logger.warning(f"{WAIT_ENV}={raw!r} is not a number; waiting {DEFAULT_WAIT_SECONDS:.0f}s")
        return DEFAULT_WAIT_SECONDS
    if value <= 0:
        logger.warning(f"{WAIT_ENV}={raw!r} is not positive; waiting {DEFAULT_WAIT_SECONDS:.0f}s")
        return DEFAULT_WAIT_SECONDS
    return value


async def open_ready_channel(
    name: str,
    address: str,
    wait_seconds: Optional[float] = None,
    *,
    make_channel: Callable[[str], Any] = grpc.aio.insecure_channel,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> Any:
    """A gRPC channel to ``address`` once it is ready, retrying for ``wait_seconds``.

    Each attempt waits up to 10 s for the channel; between attempts the delay
    doubles from 2 s up to 10 s. Raises ConnectionError, with how long it
    waited, when the budget runs out.
    """
    budget = speech_wait_seconds() if wait_seconds is None else wait_seconds
    start = clock()
    attempt = 0
    channel = None
    last_error: Optional[BaseException] = None
    while True:
        attempt += 1
        if channel is not None:
            await channel.close()
        channel = make_channel(address)
        remaining = budget - (clock() - start)
        try:
            await asyncio.wait_for(
                channel.channel_ready(),
                timeout=max(0.1, min(ATTEMPT_TIMEOUT_SECONDS, remaining)),
            )
            elapsed = clock() - start
            if attempt > 1:
                logger.info(f"{name} service at {address} ready after {elapsed:.0f}s ({attempt} attempts)")
            return channel
        except Exception as e:  # noqa: BLE001 - a timeout or a refused connection, retried alike
            last_error = e
        elapsed = clock() - start
        if elapsed >= budget:
            await channel.close()
            raise ConnectionError(
                f"{name} service at {address} not ready after {elapsed:.0f}s of {budget:.0f}s "
                f"({attempt} attempts): {last_error!r}"
            )
        delay = min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * (2 ** (attempt - 1)), budget - elapsed)
        logger.warning(
            f"{name} service at {address} not ready after {elapsed:.0f}s of {budget:.0f}s "
            f"(attempt {attempt}): {last_error!r}. Retrying in {delay:.0f}s"
        )
        await sleep(delay)
