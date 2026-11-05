"""The interview rules, with no I/O.

For each question, in guide order:

1. Ask it word for word. Nothing is rephrased.
2. Check the reply (see checker.py).
3. Answered: record it and move on. Declined: skip at once.
   Unclear: ask again, up to ``max_attempts`` asks in total, then skip.

``max_attempts`` counts every time the question is asked, the first one
included, so the default of 3 is "the question, plus two more tries".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from elias_interviewer.checker import ANSWERED, DECLINED, Verdict
from elias_interviewer.guide import Question

ANSWER = "answered"
REASK = "reask"
SKIP = "skipped"


@dataclass
class Step:
    kind: str  # ANSWER | REASK | SKIP
    question: Question
    answer: str = ""
    reason: str = ""


@dataclass
class Interview:
    questions: List[Question]
    max_attempts: int = 3
    index: int = 0
    attempts: int = 0
    replies: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.max_attempts = max(1, int(self.max_attempts))

    @property
    def current(self) -> Optional[Question]:
        return self.questions[self.index] if self.index < len(self.questions) else None

    @property
    def done(self) -> bool:
        return self.current is None

    @property
    def remaining(self) -> int:
        return max(0, len(self.questions) - self.index)

    def mark_asked(self) -> None:
        self.attempts += 1

    def add_reply(self, text: str) -> None:
        if text.strip():
            self.replies.append(text.strip())

    def resolve(self, verdict: Verdict) -> Step:
        q = self.current
        if q is None:
            raise RuntimeError("interview is already finished")
        if verdict.outcome == ANSWERED:
            step = Step(ANSWER, q, answer="\n".join(self.replies), reason=verdict.reason)
        elif verdict.outcome == DECLINED:
            step = Step(SKIP, q, reason=f"declined: {verdict.reason}".strip())
        elif self.attempts < self.max_attempts:
            return Step(REASK, q, reason=verdict.reason)
        else:
            step = Step(SKIP, q, reason=f"no clear answer after {self.attempts} asks: {verdict.reason}".strip())
        self._advance()
        return step

    def _advance(self) -> None:
        self.index += 1
        self.attempts = 0
        self.replies = []
