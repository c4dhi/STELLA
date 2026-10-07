"""Stage 4: Response Generator — streaming final answer with arbitration context.

Takes the arbitration directive and injects it into the system prompt,
then streams the LLM response token-by-token via AgentOutput.text_chunk().

The directive section tells the LLM:
- What tone to use
- What must be included/avoided
- What the primary/secondary focus should be
- Expert summary context
"""

import re
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

# One or more leading "[tag]" markers (with surrounding space), e.g. "[happy] ".
_LEADING_TAGS_RE = re.compile(r"^(?:\s*\[[a-zA-Z_]+\]\s*)+")
# Punctuation/whitespace left dangling right after a stripped repeat, e.g. the
# "!" and space between "...Sam!" and "[curious]...".
_LEADING_PUNCT_RE = re.compile(r"^[\s.,!?;:]+")


# A "[tag" the stream has not closed yet.
_OPEN_TAG_RE = re.compile(r"^\s*\[[a-zA-Z_]*$")


def _strip_repeated_opener(spoken_prefix: str, continuation: str, is_final: bool = True) -> Optional[str]:
    """Drop a leading repeat of ``spoken_prefix`` from the model's continuation.

    The response prompt tells the model to continue from the bridge/prepend it
    already spoke and never repeat it, but it sometimes restarts with it anyway
    — most often because the emotion-tag directive asks every reply to open
    with a tag, and the untagged spoken prefix doesn't read as something it
    already said (#627: "Nice to meet you, Sam!" spoken, then the model's own
    continuation opened with "[happy] Nice to meet you, Sam!" again). Comparison
    ignores case, punctuation and any leading emotion tag(s), since those are
    exactly what differs between the two occurrences.

    The continuation arrives as a growing stream, and whatever is passed on is
    spoken at once and cannot be taken back. So while it could still turn out
    to be a repeat — it matches the prefix as far as it goes — this returns
    ``None`` and the caller holds its output. Passing the partial match on and
    stripping it a few chunks later would shorten text already sent, and the
    SDK then speaks the whole reply again from the start.
    """
    if not spoken_prefix or not continuation:
        return continuation

    tag_match = _LEADING_TAGS_RE.match(continuation)
    body = continuation[tag_match.end():] if tag_match else continuation
    if not is_final and _OPEN_TAG_RE.match(body):
        return None  # a tag still being written: what follows it is not known yet

    prefix_chars = [c.lower() for c in spoken_prefix if c.isalnum()]
    if not prefix_chars:
        return continuation

    pi = 0
    ci = 0
    while ci < len(body) and pi < len(prefix_chars):
        c = body[ci]
        if c.isalnum():
            if c.lower() != prefix_chars[pi]:
                return continuation
            pi += 1
        ci += 1

    if pi < len(prefix_chars):
        # Ran out before the whole prefix matched: a repeat in the making, or
        # a short reply that merely starts the same way.
        return continuation if is_final else None

    tail = body[ci:]
    if not tail and not is_final:
        return None  # matched to the last character; the word may still go on
    if tail[:1].isalnum():
        return continuation  # "Oh" spoken, "Ohio ..." is not a repeat of it
    punct_match = _LEADING_PUNCT_RE.match(tail)
    if punct_match:
        tail = tail[punct_match.end():]
    return tail


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
        self.custom_guidelines: Optional[str] = None
        # Identity from the deployed Persona entity (#467). Set by the agent from
        # the deploy config, not by apply_config: a persona is deliberately NOT a
        # pipeline slot, which is what keeps it free of agent-type version pinning.
        self.persona: Optional[str] = None
        # Emotion tags (#face-emotions): set by the agent from the pipeline's
        # own flag, so the prompt only asks for tags while something is there to
        # strip them back out.
        self.emotion_tags: bool = False
        self._logged_emotion_prompt: bool = False
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
        # "persona" was a slot here until #467. Identity is not pipeline config:
        # binding it to an agent type meant one saved configuration per persona,
        # when the whole point is that many personas share one configuration.
        # Configs saved before the slot was removed still carry the key; it is
        # deliberately ignored rather than pruned, so no stored data is rewritten.
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
        bridge: str = "",
        prepend: str = "",
        transcript_id: Optional[str] = None,
        guidelines: Optional[str] = None,
    ) -> AsyncIterator[AgentOutput]:
        """Generate a streaming response with arbitration context.

        Args:
            session_id: Current session ID.
            user_input: Current user message.
            directive: Arbitration directive with expert guidance.
            conversation_history: Recent conversation messages.
            sm_context: State machine context.
            bridge: Optional bridge phrase already emitted to TTS. The LLM
                    continues from this prefix so the response is coherent.
            prepend: Optional deterministic, literature-informed line (from a
                    "prepend" verdict directive) spoken verbatim before the
                    generated reply. The LLM continues from it without repeating it.
            transcript_id: Optional transcript ID to reuse (shared with bridge chunk).
            guidelines: Style guide for this turn only, in place of the configured
                    one. Companion mode passes its free-conversation guide here.

        Yields:
            AgentOutput.text_chunk() for each token, with is_final=True on the last one.
        """
        system_prompt = build_response_system_prompt(
            sm_context, directive,
            custom_guidelines=guidelines or self.custom_guidelines,
            persona=self.persona,
            emotion_tags=self.emotion_tags,
            conversation_history=conversation_history,
            history_limit=self.history_limit or len(conversation_history or []),
            bridge=bridge,
        )
        if self.emotion_tags and not self._logged_emotion_prompt:
            self._logged_emotion_prompt = True
            logger.info(
                "[EMOTION-TAGS] directive present in system prompt: %s",
                "EMOTIONAL EXPRESSION" in system_prompt,
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
        #
        # The "continue from the opener, don't repeat it" guidance also lives as
        # PROSE in the editable response prompt, around the {{bridge}} injection —
        # visible to operators, not hidden in the background (build_response_system_prompt
        # renders {{#if bridge}} / {{bridge}}). That prose is the only place this
        # guidance lived until #627's follow-up: an operator's custom guidelines can
        # under-specify or omit it, and even the default wording doesn't stop every
        # paraphrase — Felix hit a deployed agent whose bridge "Glad to hear that!
        # It sounds like it's been a pretty good day for you." was followed by "That's
        # great to hear!", a re-acknowledgment in different words, not a literal
        # repeat, so neither the prose nor _strip_repeated_opener() caught it. The
        # rule below is now ALWAYS injected here — on top of the prose, never
        # instead of it — so the guidance has a floor no custom prompt can drop
        # below.
        spoken_prefix = " ".join(p for p in (bridge, prepend) if p)
        if spoken_prefix:
            already_said = []
            if bridge:
                already_said.append(f'you said "{bridge}" as a natural acknowledgment')
            if prepend:
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
                    "- Do NOT comment on it, agree with it, or add another acknowledgment or "
                    "reaction to your own words — not even in different words\n"
                    "- Pick up right where it left off — your continuation should feel like the same person kept talking"
                ),
            ))
            # Replay the spoken prefix as the assistant's own in-progress turn so
            # the model literally continues it. Shares one transcript_id with the
            # bridge/prepend chunk(s) already sent → one seamless utterance.
            messages.append(LLMMessage(role="assistant", content=spoken_prefix))

        # A routing directive reports something the session has ALREADY done
        # (an activity started or stopped, she is about to sleep), so it is
        # repeated as the last instruction the model reads. Inside the system
        # prompt it sits ahead of the history, the tag examples and the
        # "continue from your opener" rules, and gpt-4o-mini followed those:
        # told to say goodbye and sleep, it asked a follow-up question 10
        # times out of 10 (session ba70e570). Nothing is added to it but a
        # plain lead-in: what the operator configured is what the model reads,
        # and it does not claim to overrule their persona or guidelines.
        if directive and directive.routing_directive:
            messages.insert(
                len(messages) - (1 if spoken_prefix else 0),
                LLMMessage(
                    role="system",
                    content="For this turn:\n" + directive.routing_directive,
                ),
            )

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
        # line, computed above) so TTS speaks prefix + response as one seamless
        # utterance. The LLM streams just its own continuation; we put the prefix
        # back in front of each accumulated chunk.
        prefix = (spoken_prefix + " ") if spoken_prefix else ""

        # Consume the stream through the shared SDK adapter (single source of
        # truth for callback→async-iterator) instead of hand-rolling a queue.
        try:
            async for llm_text, is_final in stream_completion(
                self._llm_service, messages, config, component_name="response_generator",
            ):
                cleaned = _strip_repeated_opener(spoken_prefix, llm_text, is_final)
                if cleaned is None:
                    continue  # could still be a repeat of the opener: hold it
                yield AgentOutput.text_chunk(
                    session_id,
                    (prefix + cleaned).strip(),
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
