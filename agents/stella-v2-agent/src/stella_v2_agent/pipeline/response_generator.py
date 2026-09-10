"""Stage 4: Response Generator — streaming final answer with arbitration context.

Takes the arbitration directive and injects it into the system prompt,
then streams the LLM response token-by-token via AgentOutput.text_chunk().

The directive section tells the LLM:
- What tone to use
- What must be included/avoided
- What the primary/secondary focus should be
- Expert summary context
"""

import uuid
from typing import Dict, Any, List, AsyncIterator, Optional

from stella_agent_sdk import AgentOutput

from stella_agent_sdk.llm import (
    LLMService, LLMConfig, LLMMessage, LLMProvider, stream_completion,
)
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.prompts.response_prompt import (
    build_response_system_prompt,
    build_response_user_message,
)
import logging

logger = logging.getLogger(__name__)


class ResponseGenerator:
    """Generates the final streaming response with arbitration context injected.

    The response system prompt includes:
    - Persona and conversation guidelines
    - State machine context (current state, tasks, deliverables)
    - Arbitration directive (expert guidance for this specific response)
    """

    def __init__(self, llm_service: LLMService):
        self._llm_service = llm_service

        # LLM config (overridable via apply_config)
        self.response_model = "gpt-4o-mini"
        self.response_max_tokens = 200
        self.response_temperature = 0.7
        self.custom_persona: Optional[str] = None
        self.custom_guidelines: Optional[str] = None
        # 0 = use every turn the agent fetched. The agent decides how much
        # history is worth carrying (_custom_history_limit, 20 by default) and
        # hands exactly that much to generate(); this stage must not silently
        # halve it. It used to default to 10, so 20 turns were fetched and the
        # oldest 10 dropped on the floor — long-range callbacks ('you said
        # earlier you hate mornings') were structurally impossible past turn 10.
        self.history_limit: int = 0

    def apply_config(self, config: dict) -> None:
        """Apply configuration overrides from Agent Configurator."""
        if "model" in config:
            self.response_model = config["model"]
        if "max_tokens" in config:
            self.response_max_tokens = int(config["max_tokens"])
        if "temperature" in config:
            self.response_temperature = float(config["temperature"])
        if "persona" in config:
            self.custom_persona = config["persona"]
        if "conversation_guidelines" in config:
            self.custom_guidelines = config["conversation_guidelines"]
        if "history_limit" in config:
            self.history_limit = int(config["history_limit"])

    async def generate(
        self,
        session_id: str,
        user_input: str,
        directive: ResponseDirective,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        plan_system_prompt: Optional[str] = None,
        bridge: str = "",
        prepend: str = "",
        transcript_id: Optional[str] = None,
    ) -> AsyncIterator[AgentOutput]:
        """Generate a streaming response with arbitration context.

        Args:
            session_id: Current session ID.
            user_input: Current user message.
            directive: Arbitration directive with expert guidance.
            conversation_history: Recent conversation messages.
            sm_context: State machine context.
            plan_system_prompt: Optional custom system prompt from the plan.
            bridge: Optional bridge phrase already emitted to TTS. The LLM
                    continues from this prefix so the response is coherent.
            prepend: Optional deterministic, literature-informed line (from a
                    "prepend" verdict directive) spoken verbatim before the
                    generated reply. The LLM continues from it without repeating it.
            transcript_id: Optional transcript ID to reuse (shared with bridge chunk).

        Yields:
            AgentOutput.text_chunk() for each token, with is_final=True on the last one.
        """
        system_prompt = build_response_system_prompt(
            sm_context, directive, plan_system_prompt,
            custom_persona=self.custom_persona,
            custom_guidelines=self.custom_guidelines,
            conversation_history=conversation_history,
            history_limit=self.history_limit or len(conversation_history or []),
            bridge=bridge,
        )
        user_message = build_response_user_message(user_input)

        messages = [
            LLMMessage(role="system", content=system_prompt),
            LLMMessage(role="user", content=user_message),
        ]

        # Spoken prefix already emitted to TTS that the LLM must continue from
        # without repeating: the early acknowledgment "bridge" and/or a deterministic
        # "prepend" safety line. They share the response transcript, so the LLM
        # output is appended after them into one seamless utterance.
        if prepend:
            spoken_prefix = f"{bridge} {prepend}".strip() if bridge else prepend
            already_said = []
            if bridge:
                already_said.append(f'you said "{bridge}" as a natural acknowledgment')
            already_said.append(f'the user was told, verbatim: "{prepend}"')
            messages.insert(1, LLMMessage(
                role="system",
                content=(
                    "Before your reply, " + " and ".join(already_said) + ". "
                    "That text has ALREADY been spoken to the user. Now continue with your "
                    "actual response. The combined output will be spoken as one seamless "
                    "utterance, so it MUST flow naturally as a single conversation turn.\n\n"
                    "Rules:\n"
                    "- Do NOT repeat, rephrase, or contradict anything already spoken above\n"
                    "- Do NOT comment on it or add another greeting/acknowledgment\n"
                    "- Pick up right where it left off — your continuation should feel like the same person kept talking"
                ),
            ))
            messages.append(LLMMessage(role="assistant", content=spoken_prefix))
        elif bridge:
            # The "continue from the opener, don't repeat it" guidance is PROSE, so
            # it lives in the editable response prompt right around the {{bridge}}
            # injection (build_response_system_prompt renders {{#if bridge}} /
            # {{bridge}}) — visible to operators, not hidden in the background.
            # The only thing auto-injected here is the crucial, non-prose mechanism:
            # replay the bridge as the assistant's own in-progress turn so the model
            # literally continues it. The two share one transcript_id → one seamless
            # utterance.
            messages.append(LLMMessage(role="assistant", content=bridge))

        config = LLMConfig(
            model=self.response_model,
            temperature=self.response_temperature,
            max_tokens=self.response_max_tokens,
            provider=LLMProvider.OPENAI_LANGCHAIN,
            streaming=True,
        )

        if not transcript_id:
            transcript_id = f"response_{uuid.uuid4().hex[:8]}"

        # Prepend the already-spoken prefix (bridge and/or deterministic safety
        # line) so TTS speaks prefix + response as one seamless utterance. The LLM
        # streams just its own continuation; we put the prefix back in front of
        # each accumulated chunk.
        spoken_prefix = " ".join(p for p in (bridge, prepend) if p)
        prefix = (spoken_prefix + " ") if spoken_prefix else ""

        # Consume the stream through the shared SDK adapter (single source of
        # truth for callback→async-iterator) instead of hand-rolling a queue.
        try:
            async for llm_text, is_final in stream_completion(
                self._llm_service, messages, config, component_name="response_generator",
            ):
                yield AgentOutput.text_chunk(
                    session_id,
                    (prefix + llm_text).strip(),
                    transcript_id=transcript_id,
                    is_final=is_final,
                )
        except Exception as error:
            logger.error(f"Streaming error: {error}")
            yield AgentOutput.text_chunk(
                session_id,
                "I'm sorry, I encountered an issue. Could you try again?",
                transcript_id=transcript_id,
                is_final=True,
            )
