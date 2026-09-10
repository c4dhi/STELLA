"""
Unified prompt builder for stella-light-agent.

Combines all prompt components into a single system prompt with:
- STELLA identity and personality
- Embedded safety/ethics guardrails (replaces expert system)
- State machine context
- Tool usage instructions
"""

from typing import Dict, List, Any, Optional

from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE
from stella_agent_sdk.language import language_name


class LightPromptBuilder:
    """Builds a unified prompt with embedded guardrails for the light agent.

    State is managed exclusively through the SDK toolbox, so prompts always
    instruct the model in terms of tool calls (set_deliverable, complete_task,
    skip_task, skip_state).
    """

    def build_system_prompt(
        self, context: Dict[str, Any], *, for_text_response: bool = False
    ) -> str:
        """
        Build complete system prompt with embedded guardrails.

        Args:
            context: State machine context from get_context_for_prompt()
                     May include 'persona' — the deployed identity (#467)
            for_text_response: When True, build the prompt for the spoken-reply
                     pass (Phase 1) — the steering assumes the user's latest answer
                     is being recorded this turn, so the reply moves forward instead
                     of re-confirming it. When False (default), build the
                     tool/extraction pass (Phase 2) with full collection pressure.

        Returns:
            Complete system prompt string
        """
        mode = context.get("processing_mode", "loose")
        state = context.get("state", {})
        deliverables = context.get("deliverables", [])
        progress = context.get("progress", {})
        state_just_changed = context.get("state_just_changed", False)
        turns_without_progress = context.get("turns_without_progress", 0)
        current_task = context.get("current_task")
        next_task = context.get("next_task")  # Preview task for strict mode
        available_tasks = context.get("available_tasks", [])
        collected_deliverables = context.get("collected_deliverables", {})
        # Identity has exactly ONE source: the deployed persona (#467). The plan's
        # own system_prompt and the Configurator's persona slot are both gone —
        # plans carry structure, the Configurator carries pipeline behaviour.
        persona = context.get("persona")
        custom_guidelines = context.get("custom_guidelines")
        # Operator-editable prose blocks (response.* slots). Default text lives in
        # the builders; these override it so the developer controls them from the
        # config screen without touching code.
        custom_safety = context.get("custom_safety_guidelines")
        custom_transition = context.get("custom_state_transition_note")

        # A custom delivery prompt (custom_guidelines) owns language — don't let
        # the default identity force German past it (#304 review #10).
        parts = [
            self._build_identity(
                persona, operator_owns_language=bool(custom_guidelines)
            ),
            self._build_conversational_style(custom_guidelines),
            self._build_guardrails(custom_safety),
        ]

        # Deterministic language directive (single source of truth, parity with
        # stella-v2). When the resolver locked a concrete language, state it
        # authoritatively — it overrides the soft "same language" rule above.
        language_directive = self._build_language_directive(context.get("language"))
        if language_directive:
            parts.append(language_directive)

        # Add mode-specific instructions (flexible vs sequential)
        parts.append(self._build_mode_instructions(mode, current_task, next_task))

        # Tool-based state management instructions.
        parts.append(self._build_tool_instructions(deliverables, available_tasks))

        # Add collected deliverables section (for update capability)
        collected_section = self._build_collected_section(collected_deliverables)
        if collected_section:
            parts.append(collected_section)

        # Add context if state machine is initialized
        if state:
            parts.append(self._build_context(state, mode, progress, current_task, available_tasks))

        # Add state transition warning if applicable
        if state_just_changed:
            parts.append(self._build_state_transition_warning(state, custom_transition))

        # Deliverable-driven steering for THIS turn (#306). Kept last so it is the
        # most salient instruction the model sees before responding.
        if state:
            parts.append(
                self._build_steering(
                    deliverables, turns_without_progress, for_text_response
                )
            )

        return "\n\n".join(parts)

    def _build_identity(
        self,
        persona: Optional[str] = None,
        operator_owns_language: bool = False,
    ) -> str:
        """Build the identity section — the persona, or the built-in default.

        Two branches, not four. Identity used to arrive from the plan, from the
        Configurator's persona slot, and from a merged system-prompt field, with
        precedence rules between them; #467 made the persona the single source,
        so there is nothing left to arbitrate.

        ``operator_owns_language`` suppresses the default identity's language rule
        when the operator supplied a custom delivery prompt (custom_guidelines)
        that should own language — otherwise the default "reply in German" rule
        leaks past the override and the operator can't configure, say, an
        English-only deployment (#304 review #10). It only affects the default
        branch; a persona replaces the whole block, language rule included.
        """
        if persona:
            return f"""## Your Identity
{persona}"""

        # Default identity, used when a deployment resolves no persona at all.
        # The language rule lives here (the single source of truth — the
        # conversational-style block only scopes its rules to that language,
        # #304 review #11) and is dropped when a custom delivery prompt owns
        # language (#304 review #10).
        language_block = "" if operator_owns_language else """

## Language (highest priority)
- Respond in the SAME language the user speaks. If they speak German, your ENTIRE reply must be in German — not a single English word. If they speak English, reply in English.
- When in doubt, default to German."""
        return f"""## Your Identity
You are STELLA, a warm and engaging AI companion supporting cognitive health and wellbeing.{language_block}

## Your Personality
- Friendly, warm, and genuinely interested in the person you're speaking with
- Supportive and encouraging, never judgmental
- Natural and conversational - avoid sounding robotic or scripted
- Concise but thorough - aim for 30-50 words per response
- Ask only ONE question at a time to keep the conversation flowing naturally"""

    def _build_conversational_style(self, custom_guidelines: Optional[str] = None) -> str:
        """Build conversational style rules for natural-sounding speech.

        Args:
            custom_guidelines: Optional guidelines injected via the Agent Configurator.
                               When provided, they replace the default speaking style
                               (mirrors stella-v2's custom_guidelines behavior).
        """
        if custom_guidelines:
            return custom_guidelines

        return """## Conversational Style (CRITICAL - Follow These Rules)
You are a calm, observant, and grounded conversationalist. Your goal is to sound like a thoughtful peer.

### Language scope
- All the rules below apply in WHATEVER language you are speaking — use that language's natural spoken register, not a literal translation of the English examples. (The rule for WHICH language to speak is in the identity section above.)

### Linguistic Rules
- **Mandatory Contractions**: Speak the way people actually talk, never like a written document.
  EN: "don't", "it's", "I'm", "that's", "you're" — never "do not", "it is".
  DE: "hab ich", "ist's", "geht's", "gibt's", "hab's" — never "habe ich", "ist es".
- **Safe Fillers**: Occasionally open with a short filler + comma.
  EN: "Yeah,", "Well,", "Right,", "I mean,".
  DE: "Ja,", "Also,", "Okay,", "Ich mein,".
  Do NOT use filler sounds that render poorly in TTS: "Mhmm", "Uh", "äh", "ähm".
- **Natural Transitions**: Use light spoken connectors, not formal linking words.
  EN: "Actually,", "Anyway,", "Plus".
  DE: "Eigentlich,", "Übrigens,", "Außerdem".
- **Lexical Mirroring**: Reuse the user's own words for things — if they say "workout," say "workout," not "exercise session"; if they say "Sport," keep "Sport," don't switch to "Bewegung." Don't rename or formalize the vocabulary they chose, and match their register (casual stays casual). Reusing someone's wording is how you signal you're actually listening.

### Preference-Shaped Delivery
- **Welcome content goes direct**: agreement, confirmation, or good news is delivered immediately with no hedging preface — get to the point.
- **Harder content gets eased into**: a correction, a "no," or unwelcome news takes a brief softener FIRST, then the gentle substance — never a flat, blunt refusal. People naturally preface and mitigate the harder messages; a uniform flat style sounds robotic.

### TTS Optimization (for natural speech rhythm)
- **Breathing Pauses**: Use a comma every 7-10 words to create natural pauses.
- **Thinking Pauses**: Use an ellipsis (...) after an opening filler to simulate a thoughtful beat (e.g., "Yeah... that's a good point.").
- **Pitch Control**: End thoughts with a period (.) for a natural pitch drop. Use one question mark (?) at the very end for rising intonation.

### Response Structure
1. Start with a "Safe Filler" + comma or ellipsis
2. Provide a concise, neutral observation (max 2 sentences)
3. End with a simple, low-pressure follow-up question

**Keep responses under 4 sentences total.**"""

    def _build_language_directive(self, language: Optional[str]) -> str:
        """Authoritative 'respond entirely in <language>' block when the resolver
        locked a concrete language; empty for auto/unknown so the soft prompt rule
        stands. Mirrors stella-v2's _language_directive (single source of truth)."""
        if not language or language == "auto":
            return ""
        name = language_name(language)
        return (
            "## Language (highest priority — overrides everything above)\n"
            f"- Respond ENTIRELY in {name}. Every single word, including any examples, must be in {name}.\n"
            "- This is the language detected for this conversation; do not switch languages on your own."
        )

    def _build_guardrails(self, custom: Optional[str] = None) -> str:
        """Build embedded safety guardrails (replaces expert system).

        Args:
            custom: Operator-provided safety guidelines from the Agent
                Configurator (response.safety_guidelines slot). When set, it
                replaces the default text entirely — the developer owns the
                guardrails from the config screen, with the default below as the
                safe fallback.
        """
        if custom:
            return custom
        return """## Safety Guidelines (IMPORTANT)
When users ask about sensitive topics, provide helpful general information while maintaining appropriate boundaries:

**Medical Questions:**
- Provide general health information and encourage healthy habits
- Always recommend consulting healthcare professionals for specific medical advice
- Never provide diagnoses or specific treatment recommendations

**Financial Questions:**
- Share general financial literacy information
- Suggest consulting financial advisors for specific investment or financial decisions
- Never give specific financial advice

**Legal Questions:**
- Provide general information about legal concepts when helpful
- Always recommend consulting legal professionals for specific legal matters
- Never give specific legal advice

**Harmful or Dangerous Requests:**
- Politely decline requests that could cause harm
- Redirect to appropriate resources or topics
- Maintain a caring, non-judgmental tone

**Ethical Dilemmas:**
- Provide balanced perspectives without imposing judgment
- Help users think through considerations
- Respect user autonomy in decision-making

Remember: You are a supportive companion, not a replacement for professional advice."""

    def _build_tool_instructions(
        self, deliverables: List[Dict], available_tasks: Optional[List[Dict]] = None
    ) -> str:
        """Build tool usage instructions for tool-based state management."""
        pending = [d for d in deliverables if d.get("status") == "pending"]

        parts = [
            (
                "## Response Guidelines\n"
                "- Respond naturally and conversationally (30-50 words)\n"
                "- Ask only ONE question at a time\n"
                "- Always include a complete, conversational response\n"
                "- Your response will be spoken aloud - make it sound natural"
            ),
            # Tool-calling mechanics come from the SDK — the single source of
            # truth, identical to stella-v2. Crucial plumbing, never hand-written
            # here or exposed as an editable slot.
            STATE_MACHINE_TOOL_GUIDANCE,
        ]

        if pending:
            parts.append("\n## Information to Collect")
            parts.append("Use set_deliverable when the user provides these:")
            for d in pending:
                required_marker = "*" if d.get("required", True) else "(optional)"
                parts.append(f"\n**{d['key']}** {required_marker}")
                parts.append(f"  Description: {d.get('description', '')}")

                # Show type information
                dtype = d.get("type", "string")
                if dtype == "enum" and d.get("enum_values"):
                    values = ", ".join(str(v) for v in d['enum_values'])
                    parts.append(f"  Type: enum - must be one of: {values}")
                elif dtype == "number":
                    parts.append(f"  Type: number (numeric value)")
                elif dtype != "string":
                    parts.append(f"  Type: {dtype}")

                if d.get("acceptance_criteria"):
                    parts.append(f"  Criteria: {d['acceptance_criteria']}")
                if d.get("examples"):
                    examples = ", ".join(str(e) for e in d['examples'][:5])
                    parts.append(f"  Examples: {examples}")

        if available_tasks:
            parts.append("\n## Tasks in this phase")
            parts.append(
                "Each of these must be explicitly completed (complete_task) or skipped "
                "(skip_task) for the conversation to advance — none complete on their own:"
            )
            for t in available_tasks:
                if t.get('has_deliverables', False):
                    hint = " — collect its deliverables, then complete_task"
                else:
                    hint = " — perform it, then complete_task"
                parts.append(f"- **{t.get('id')}**: {t.get('description', '')}{hint}")

        return "\n".join(parts)

    def _build_steering(
        self,
        deliverables: List[Dict],
        turns_without_progress: int = 0,
        for_text_response: bool = False,
    ) -> str:
        """Build deliverable-driven steering for the current turn (#306).

        Keeps the agent anchored to the *remaining pending deliverables* instead
        of drifting into open-ended coaching questions that collect nothing, and
        tells it to record answers the user already gave in recent history rather
        than re-asking. Escalates when the turn counter shows it is stuck.

        ``for_text_response`` switches to the spoken-reply (Phase 1) variant: the
        reply is composed from the turn-start snapshot, *before* extraction records
        the user's latest answer, so the collection-pressure framing ("keep
        pursuing X") makes the agent re-ask or echo-confirm what the user just
        said. The text variant instead tells it to assume the answer is being
        recorded and to move forward — while the tool/extraction pass keeps the
        full collection pressure so recording still happens.
        """
        pending = [d for d in deliverables if d.get("status") == "pending"]
        turns_without_progress = turns_without_progress or 0
        parts = ["## Steering This Turn (CRITICAL)"]

        if pending:
            keys = ", ".join(str(d.get("key")) for d in pending if d.get("key"))
            phase_clause = f" for this phase: {keys}" if keys else " for this phase"
            if for_text_response:
                # Phase 1 (spoken reply): the user has just responded; assume what
                # they gave is being recorded right now. Receive it and advance —
                # never re-ask or echo-confirm it (the #304 re-confirm loop).
                still_open = (
                    f" the items still open for this phase ({keys})"
                    if keys else " whatever is still open for this phase"
                )
                parts.append(
                    "The user has just responded. Assume whatever information they "
                    "provided is being recorded RIGHT NOW. Your spoken reply must "
                    "acknowledge what they said and MOVE THE CONVERSATION FORWARD — "
                    f"to one of{still_open}, or, if they just gave the last one, "
                    "wrap this topic up and ease toward what comes next."
                )
                parts.append(
                    "NEVER ask the user to confirm, repeat, or restate something "
                    'they just told you. No "just to confirm…", no "so you mean… '
                    'right?", no echoing their own answer back to them as a '
                    "question. Re-asking or re-confirming what they already gave you "
                    "— in this message or earlier — is the worst failure mode here."
                )
                parts.append(
                    "Do NOT ask open-ended questions that go nowhere "
                    '(e.g. "what motivates you?", "what do you enjoy most?"). '
                    "Anchor your one follow-up to the next thing still open."
                )
            else:
                parts.append(
                    "Your job this turn is to make progress on the remaining pending "
                    f"deliverables{phase_clause}. "
                    "Every question you ask must move toward one of them."
                )
                parts.append(
                    "Do NOT ask open-ended questions that collect none of these "
                    '(e.g. "what motivates you?", "what do you enjoy most?", '
                    '"want to experiment with different types?") — they make the '
                    "conversation linger without recording anything. Anchor your "
                    "follow-up to the next pending deliverable, record it with "
                    "set_deliverable, then complete_task and move on."
                )
                parts.append(
                    "**Recall what the user already said:** re-scan the recent "
                    "conversation above. If the user has ALREADY given information that "
                    "satisfies a pending deliverable — even a few turns ago, and even if "
                    "it was not in their latest message — call set_deliverable for it NOW "
                    "instead of asking again. Re-asking for something they already told "
                    "you is the worst failure mode."
                )
        else:
            parts.append(
                "All deliverables for this phase are already collected. Complete the "
                "remaining task(s) with complete_task and move the conversation "
                "forward — do not keep asking questions in this phase."
            )

        if turns_without_progress >= 2:
            parts.append(
                f"⚠️ You have now spent {turns_without_progress} turns in this phase "
                "without recording anything new. Either record the deliverable the "
                "user has effectively already given, or — if they clearly will not "
                "engage with the current item — skip_task it and move on. Do not loop."
            )

        return "\n".join(parts)

    def _build_context(
        self,
        state: Dict,
        mode: str,
        progress: Dict,
        current_task: Optional[Dict],
        available_tasks: Optional[List[Dict]] = None
    ) -> str:
        """Build current conversation context."""
        parts = ["## Current Context"]
        parts.append(f"**State:** {state.get('title', 'Unknown')} ({mode} mode)")

        if state.get('description'):
            parts.append(f"**Goal:** {state.get('description')}")

        parts.append(f"**Progress:** {progress.get('percentage', 0):.0f}% complete")

        if current_task:
            parts.append(f"\n**Current Focus:** {current_task.get('description', '')}")
            if current_task.get('instruction'):
                parts.append(f"**Instruction:** {current_task.get('instruction')}")

        # Show tasks without deliverables that need explicit completion
        if available_tasks:
            tasks_without_deliverables = [
                t for t in available_tasks
                if not t.get('has_deliverables', True)
            ]
            if tasks_without_deliverables:
                parts.append("\n**Tasks to complete (no data collection needed):**")
                for t in tasks_without_deliverables:
                    parts.append(f"- {t.get('id')}: {t.get('description', '')}")
                parts.append("Mark these as done using COMPLETED_TASKS when you perform them.")

        return "\n".join(parts)

    # Default behavioral guidance for a phase transition. The structural header
    # and the live phase title stay in code; only this prose is operator-editable
    # (response.state_transition_note slot) so it can be tuned without code edits.
    _DEFAULT_STATE_TRANSITION_NOTE = (
        "Take a moment to acknowledge this transition naturally and introduce the "
        "new topic/focus area.\nDo NOT continue collecting information from the "
        "previous state."
    )

    def _build_state_transition_warning(self, state: Dict, custom: Optional[str] = None) -> str:
        """Build the notice shown when the phase just changed. ``custom`` (the
        configured state_transition_note) replaces the default guidance prose;
        the header and the live phase title are always supplied by code."""
        body = custom or self._DEFAULT_STATE_TRANSITION_NOTE
        return (
            f"## State Transition Notice\n"
            f"You just transitioned to a new state: **{state.get('title', 'Unknown')}**\n"
            f"{body}"
        )

    def _build_mode_instructions(
        self,
        mode: str,
        current_task: Optional[Dict] = None,
        next_task: Optional[Dict] = None
    ) -> str:
        """
        Build mode-specific instructions for flexible vs sequential conversation.

        Args:
            mode: 'strict' (sequential) or 'loose' (flexible)
            current_task: The current task to focus on
            next_task: Preview of next task (for strict mode smooth transitions)
        """
        if mode == "strict":
            parts = ["""## Sequential Mode
You must complete tasks in ORDER. Focus on the current task until it's complete."""]

            if current_task:
                parts.append(f"\n**Current Task:** {current_task.get('description', '')}")
                if current_task.get('instruction'):
                    parts.append(f"**Instruction:** {current_task['instruction']}")

            if next_task:
                parts.append(f"\n**Coming Next:** {next_task.get('description', '')} (don't start yet, but you can transition smoothly)")

            parts.append("""
**Rules:**
- Complete the current task before moving to the next
- If user mentions info for the next task, acknowledge but stay focused on current
- Transition naturally when the current task completes""")

            return "\n".join(parts)
        else:
            # LOOSE (flexible) mode
            return """## Flexible Mode
You can collect information in any natural order based on conversation flow.

**Rules:**
- Ask about ONE thing at a time, but choose based on natural conversation flow
- If user provides multiple pieces of info in one response, collect them all
- Prioritize REQUIRED items first, then optional ones if naturally offered
- You CAN update already-collected information if user provides corrections"""

    def _build_collected_section(self, collected: Dict[str, Any]) -> str:
        """
        Build section showing already-collected deliverables for update capability.

        Args:
            collected: Dict of key -> value for collected deliverables
        """
        if not collected:
            return ""

        parts = ["## Already Collected (can be updated if user corrects)"]
        for key, value in collected.items():
            # Format value nicely
            if isinstance(value, str):
                display_value = f'"{value}"'
            else:
                display_value = str(value)
            parts.append(f"- **{key}**: {display_value}")

        parts.append("\nIf the user provides updated or corrected information for any of these, use set_deliverable to update the value.")

        return "\n".join(parts)

    def build_user_message(
        self,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        context: Dict[str, Any]
    ) -> str:
        """
        Build user message with conversation context.

        Args:
            user_input: Current user message
            conversation_history: Previous conversation turns
            context: State machine context

        Returns:
            Formatted user message
        """
        parts = []

        # Add recent conversation for context
        if conversation_history:
            parts.append("Recent conversation:")
            # Only include last 6 messages for context
            for msg in conversation_history[-6:]:
                role = msg.get("role", "user").upper()
                content = msg.get("content", "")
                # Truncate long messages
                if len(content) > 200:
                    content = content[:200] + "..."
                parts.append(f"{role}: {content}")
            parts.append("")

        parts.append(f"Current message: {user_input}")

        return "\n".join(parts)
