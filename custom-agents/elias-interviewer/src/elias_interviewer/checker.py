"""Decide whether a participant's reply answers the question.

One small LLM call per reply, JSON out. Three outcomes:

- ``answered``: the reply responds to the question. Short, vague, negative or
  "I don't know" answers count; this is about relevance, not quality.
- ``unclear``: the reply doesn't answer it (off topic, garbled speech, a
  counter-question, a filler like "hm"). The agent asks again.
- ``declined``: the participant says they don't want to answer. The agent
  skips right away; asking a refusal two more times would be pushy.

If the check itself fails (timeout, bad JSON), the reply counts as answered.
Failing open keeps a participant from being stuck re-asked because of an
outage. ELIAS still gets the turn verbatim, and the analysis there judges it.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, List, Optional, Protocol

logger = logging.getLogger(__name__)

ANSWERED = "answered"
UNCLEAR = "unclear"
DECLINED = "declined"

SYSTEM_PROMPT = """You check replies in a qualitative research interview.
You get one interview question and what the participant said in reply \
(possibly across several attempts). Decide if the reply answers the question.

Return JSON: {"verdict": "answered" | "unclear" | "declined", "reason": "<short>"}

- "answered": the reply responds to the question in substance. Short, vague, \
negative, emotional or "I don't know / I can't remember" replies COUNT as \
answered. Judge relevance, not quality or length.
- "unclear": the reply does not respond to this question: off topic, \
unintelligible or garbled transcription, only a filler ("hm", "okay"), \
a request to repeat, or a counter-question.
- "declined": the participant clearly says they do not want to answer this.

The question may be in any language; the reply may be in another. Judge meaning."""


@dataclass(frozen=True)
class Verdict:
    outcome: str
    reason: str = ""
    fallback: bool = False  # True when the check failed and we failed open


class _Completer(Protocol):
    async def __call__(self, system: str, user: str) -> str: ...


class AnswerChecker:
    def __init__(
        self, completer: Optional[_Completer] = None, *, model: str = "gpt-4o-mini", timeout_s: float = 8.0
    ) -> None:
        self._completer = completer or _OpenAICompleter(model, timeout_s)

    async def check(self, question: str, replies: List[str], subquestions: Optional[List[str]] = None) -> Verdict:
        user = f"Question: {question}\n"
        if subquestions:
            user += "Aspects the question covers: " + "; ".join(subquestions) + "\n"
        user += "Participant's reply:\n" + "\n".join(f"- {r}" for r in replies)
        try:
            raw = await self._completer(SYSTEM_PROMPT, user)
            data: Any = json.loads(raw)
            outcome = str(data.get("verdict", "")).strip().lower()
            if outcome not in (ANSWERED, UNCLEAR, DECLINED):
                raise ValueError(f"unknown verdict {outcome!r}")
            return Verdict(outcome, str(data.get("reason", ""))[:300])
        except Exception as e:  # fail open, see module docstring
            logger.warning("[CHECK] answer check failed (%s), accepting the reply", e)
            return Verdict(ANSWERED, f"check unavailable: {e}"[:300], fallback=True)


class _OpenAICompleter:
    def __init__(self, model: str, timeout_s: float) -> None:
        self._model = model
        self._timeout_s = timeout_s
        self._client = None

    async def __call__(self, system: str, user: str) -> str:
        if self._client is None:
            from openai import AsyncOpenAI  # SDK dependency

            self._client = AsyncOpenAI(
                api_key=os.environ.get("OPENAI_API_KEY"),
                base_url=os.environ.get("OPENAI_BASE_URL") or None,
                timeout=self._timeout_s,
                # The participant waits on this check; a slow reply is accepted
                # as is (fail open) rather than retried.
                max_retries=0,
            )
        resp = await self._client.chat.completions.create(
            model=self._model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
        return resp.choices[0].message.content or "{}"
