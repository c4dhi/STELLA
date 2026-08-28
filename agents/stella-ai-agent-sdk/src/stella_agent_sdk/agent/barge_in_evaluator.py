"""Barge-in Evaluator — decides whether an interruption is worth acting on.

Both channels arrive here, but they arrive differently.

VOICE is filtered twice before this stage sees anything, because acoustics
answer most of the question for free and faster than any model can. The agent
ducks its own volume on the VAD's first frame — reversible, so being wrong
costs nothing — and goes silent once the user has been speaking for
BARGE_IN_MIN_SPEECH_MS, which is what separates a cough from someone taking the
floor. What duration cannot separate is "mhm" from "no, wait": both are short,
and only meaning tells them apart. So the SDK suspends playback (reversibly,
from the exact playhead) and asks this stage once, on the FINAL transcript.
Never on a partial and never speculatively — that cost a decode before the
judgement could even start, and the machinery built to hide that latency leaked
state that silently swallowed real interruptions.

TEXT has no acoustic signal at all — nothing about a typed message says whether
the user meant to cut the agent off — so it comes straight here.

Either way the SDK suspends playback, pauses generation, and hands the text on.
This stage uses a dedicated, configurable LLM prompt to classify it:

- COMMIT  → a real interruption (question/correction/stop/new request). The SDK
            discards the rest of the current reply and processes the transcript.
- RESUME  → backchannel/noise/filler. The SDK resumes playback from exactly
            where it was suspended; the transcript is discarded.

The prompt, model, provider, temperature, token budget and decision timeout are
all editable in the Agent Configurator (the "Barge-in Evaluator" node). The
prompt owns the full context layout via template variables — {{conversationHistory}}
(the recent turns), {{interruptedReply}} (the half-committed message that was being
spoken when the user cut in), {{bargeInTranscript}}, {{userInput}}, {{isBargeIn}} —
and the interruption itself is sent as the user message. The call
is bounded by a tight wall-clock timeout (BARGE_IN_EVAL_TIMEOUT_MS) defaulting to
COMMIT, because the turn stays silent until the decision resolves.
"""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

from stella_agent_sdk.env import env_float as _env_float
from stella_agent_sdk.messages.types import BargeInDecision

from stella_agent_sdk.llm import LLMService, LLMConfig, LLMMessage, LLMProvider
from stella_agent_sdk.prompts.template import render_prompt, format_history

logger = logging.getLogger(__name__)


# Minimal fallback only. The full, editable prompt — including where the
# conversation context goes — lives in agent.yaml (barge_in → system_prompt) and
# is what runs in production. The interruption itself arrives as the user message.
BARGE_IN_SYSTEM_PROMPT = """Decide whether the user's interruption of the assistant is a real interruption to act on (COMMIT) or backchannel/noise to ignore so the assistant keeps talking (RESUME).
{{#if conversationHistory}}

Conversation so far:
{{conversationHistory}}
{{/if}}
{{#if interruptedReply}}

The assistant was mid-sentence saying (the user cut in here): {{interruptedReply}}
{{/if}}

COMMIT if the words are meaningful in context — an answer to what was just asked, a question, a correction, a new request, "stop"/"wait", or a topic change. RESUME if it's just acknowledgement, thinking-aloud, or noise ("mhm", "yeah", "go on", a cough). When unsure, prefer COMMIT.

Output ONLY one word: COMMIT or RESUME."""


class BargeInEvaluator:
    """Classifies a user barge-in as COMMIT (act on it) or RESUME (ignore it)."""

    def __init__(self, llm_service: LLMService):
        self._llm_service = llm_service

        # LLM config (overridable via apply_config from the Agent Configurator).
        self.model = "gpt-4o-mini"
        self.provider = LLMProvider.OPENAI_LANGCHAIN
        self.max_tokens = 3
        self.temperature = 0.0
        self.custom_system_prompt: Optional[str] = None
        self.history_limit: int = 6  # recent turns of context for the decision
        # The decision sits on the user's barge-in latency: until it resolves,
        # playback is suspended and the user hears silence (base.py warns about
        # the RESUME path stalling). The 30s LLM request_timeout is far too loose
        # for that — bound the call tightly and default to COMMIT on timeout so a
        # slow classifier never leaves the user staring at a frozen agent.
        # Tunable via BARGE_IN_EVAL_TIMEOUT_MS.
        self.eval_timeout_s: float = _env_float("BARGE_IN_EVAL_TIMEOUT_MS", 2000.0) / 1000

    def apply_config(self, config: dict) -> None:
        """Apply configuration overrides from the Agent Configurator."""
        if "model" in config:
            self.model = config["model"]
        if "provider" in config:
            self.provider = self._parse_provider(config["provider"])
        if "max_tokens" in config:
            self.max_tokens = int(config["max_tokens"])
        if "temperature" in config:
            self.temperature = float(config["temperature"])
        if "system_prompt" in config:
            self.custom_system_prompt = config["system_prompt"]
        if "history_limit" in config:
            self.history_limit = int(config["history_limit"])
        if "timeout_ms" in config:
            self.eval_timeout_s = float(config["timeout_ms"]) / 1000

    @staticmethod
    def _parse_provider(provider: Any) -> LLMProvider:
        """Coerce a configured provider (enum or string) into an LLMProvider.

        Lets non-OpenAI deployments (e.g. Ollama) drive the evaluator from
        config instead of editing this file. Falls back to the OpenAI default
        on an unrecognised value rather than crashing the stage."""
        if isinstance(provider, LLMProvider):
            return provider
        try:
            return LLMProvider(str(provider).strip().lower())
        except ValueError:
            logger.warning(
                f"Unknown barge-in evaluator provider '{provider}'; "
                "falling back to openai_langchain"
            )
            return LLMProvider.OPENAI_LANGCHAIN

    async def evaluate(
        self,
        transcript: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        variables: Optional[Dict[str, Any]] = None,
    ) -> BargeInDecision:
        """Decide whether to commit or resume given the barge-in transcript.

        The conversation history is included so the decision is made IN CONTEXT
        — e.g. an on-topic answer to the assistant's last question is a real
        turn (COMMIT), not noise. Falls back to COMMIT on any error — never
        silently swallow a real interruption because the classifier failed.
        """
        if not transcript or not transcript.strip():
            # Nothing intelligible was said — treat as noise, keep speaking.
            return BargeInDecision.RESUME

        ctx: Dict[str, Any] = {
            "bargeInTranscript": transcript,
            "userInput": transcript,
            "isBargeIn": True,
            # The recent turns, formatted and trimmed, so the configured prompt
            # can place the context wherever it wants via {{conversationHistory}}.
            "conversationHistory": format_history(conversation_history, self.history_limit),
        }
        if variables:
            ctx.update(variables)

        start_time = time.time()
        try:
            raw_prompt = self.custom_system_prompt or BARGE_IN_SYSTEM_PROMPT
            system_prompt = render_prompt(raw_prompt, ctx)
            # The interruption itself is the data being classified — sent as the
            # user message. All surrounding context lives in the prompt template.
            user_message = transcript

            # Bound the call on wall-clock: a suspended turn is silent until this
            # returns, so a slow LLM must not stall it. On timeout we fall through
            # to the except below and default to COMMIT (treat as a real turn).
            response = await asyncio.wait_for(
                self._llm_service.generate(
                    messages=[
                        LLMMessage(role="system", content=system_prompt),
                        LLMMessage(role="user", content=user_message),
                    ],
                    config=LLMConfig(
                        model=self.model,
                        temperature=self.temperature,
                        max_tokens=self.max_tokens,
                        provider=self.provider,
                        streaming=False,
                        json_mode=False,
                    ),
                    component_name="barge_in_evaluator",
                ),
                timeout=self.eval_timeout_s,
            )
            decision = self._parse_decision(response.content)
            latency_ms = (time.time() - start_time) * 1000
            logger.info(f"Barge-in '{transcript[:40]}' -> {decision.value} in {latency_ms:.0f}ms")
            return decision
        except asyncio.TimeoutError:
            latency_ms = (time.time() - start_time) * 1000
            logger.warning(
                f"Barge-in eval timed out after {latency_ms:.0f}ms "
                f"(limit {self.eval_timeout_s * 1000:.0f}ms) — defaulting to COMMIT"
            )
            return BargeInDecision.COMMIT
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            logger.error(f"Barge-in eval failed in {latency_ms:.0f}ms: {e} — defaulting to COMMIT")
            return BargeInDecision.COMMIT

    @staticmethod
    def _parse_decision(raw: str) -> BargeInDecision:
        """Parse the LLM output into a decision. Defaults to COMMIT when the
        output does not clearly say RESUME."""
        text = (raw or "").strip().lower()
        if "resume" in text and "commit" not in text:
            return BargeInDecision.RESUME
        return BargeInDecision.COMMIT
