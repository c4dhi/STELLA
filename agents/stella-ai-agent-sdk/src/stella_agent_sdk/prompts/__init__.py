"""SDK prompt-compiler library.

Primary entry point — one call, given a prompt + compiler version, returns the
final prompt for the LLM:

    from stella_agent_sdk import prompts
    final = prompts.compile(raw_prompt, version="1.0.0", sm_context=ctx,
                            conversation_history=h, user_input=t)

Also exposed:
  - PromptCompiler / PlaceholderPromptCompiler  classes (advanced use)
  - get_compiler / register_compiler / available_versions / latest_version  registry
  - COMPILER_VERSION, KNOWN_PLACEHOLDERS, validate_template, palette  versioning primitives

There is intentionally no version-less ``compile_prompt`` in the public API: all
prompt compilation must go through ``compile(template, version=...)`` so an SDK
upgrade can never silently change how an agent's prompts resolve.
"""

from stella_agent_sdk.prompts.base import PromptCompiler
from stella_agent_sdk.prompts.placeholder_compiler import (
    PersonaAwarePlaceholderCompiler,
    resolve_persona_tokens,
    PlaceholderPromptCompiler,
    has_user_message_placeholder,
    validate_template,
    palette,
    PLACEHOLDER_SPECS,
    COMPILER_VERSION,
    KNOWN_PLACEHOLDERS,
    PLACEHOLDER_PATTERN,
    HISTORY_PATTERN,
    PLACEHOLDER_REGISTRY,
)
from stella_agent_sdk.prompts.registry import (
    compile,
    get_compiler,
    register_compiler,
    available_versions,
    latest_version,
)
from stella_agent_sdk.prompts.template import (
    render_prompt,
    PromptVariable,
    format_history,
)

__all__ = [
    "compile",
    "PromptCompiler",
    "PlaceholderPromptCompiler",
    "has_user_message_placeholder",
    "validate_template",
    "palette",
    "PLACEHOLDER_SPECS",
    "COMPILER_VERSION",
    "KNOWN_PLACEHOLDERS",
    "get_compiler",
    "register_compiler",
    "PersonaAwarePlaceholderCompiler",
    "resolve_persona_tokens",
    "available_versions",
    "latest_version",
    "render_prompt",
    "PromptVariable",
    "format_history",
    "PLACEHOLDER_PATTERN",
    "HISTORY_PATTERN",
    "PLACEHOLDER_REGISTRY",
]
