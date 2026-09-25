"""Versioned registry + single compile entry point for SDK prompt compilers.

Agents don't construct a compiler directly — they call one method with the raw
prompt and the compiler version they want, and get back the final prompt:

    from stella_agent_sdk import prompts
    final = prompts.compile(
        raw_prompt,
        version="1.0.0",                 # omit for the latest
        sm_context=sm_context,
        conversation_history=history,
        user_input=text,
    )

Each compiler implementation registers itself under its ``VERSION``; new behavior
ships as a new version so old prompts keep compiling against the version they were
authored for. Custom agents can add versions with :func:`register_compiler`.
"""

from typing import Dict, List, Optional, Type, Any

from stella_agent_sdk.prompts.base import PromptCompiler
from stella_agent_sdk.prompts.placeholder_compiler import (
    PlaceholderPromptCompiler,
    PersonaAwarePlaceholderCompiler,
)

# version string -> compiler class
_REGISTRY: Dict[str, Type[PromptCompiler]] = {}


def _version_key(version: str):
    """Sort key for semantic-ish versions; non-numeric parts sort last."""
    parts = []
    for piece in str(version).split("."):
        parts.append((0, int(piece)) if piece.isdigit() else (1, piece))
    return tuple(parts)


def register_compiler(compiler_cls: Type[PromptCompiler]) -> Type[PromptCompiler]:
    """Register a compiler class under its ``VERSION`` (usable as a decorator)."""
    version = getattr(compiler_cls, "VERSION", None)
    if not version or version == "0.0.0":
        raise ValueError(f"Compiler {compiler_cls!r} must define a real VERSION")
    _REGISTRY[version] = compiler_cls
    return compiler_cls


def latest_version() -> str:
    """The highest registered compiler version."""
    if not _REGISTRY:
        raise LookupError("No prompt compilers are registered")
    return max(_REGISTRY, key=_version_key)


def available_versions() -> List[str]:
    """All registered compiler versions, oldest first."""
    return sorted(_REGISTRY, key=_version_key)


def get_compiler(version: str) -> Type[PromptCompiler]:
    """Return the compiler class for an explicit ``version``.

    The version is mandatory — there is intentionally no "latest" default, so an
    SDK upgrade can never silently change how an agent's prompts compile. Use
    :func:`latest_version` / :func:`available_versions` to discover versions, but
    the caller must choose one deliberately.
    """
    if not version:
        raise ValueError(
            "A prompt compiler version must be provided explicitly "
            f"(no default). Available: {', '.join(available_versions()) or '(none)'}"
        )
    try:
        return _REGISTRY[version]
    except KeyError:
        avail = ", ".join(available_versions()) or "(none)"
        raise KeyError(
            f"No prompt compiler registered for version '{version}'. Available: {avail}"
        )


def compile(
    template: Optional[str],
    version: str,
    *,
    sm_context: Optional[Dict[str, Any]] = None,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    user_input: str = "",
    speech_safe: bool = False,
) -> Optional[str]:
    """Compile a prompt with an explicitly requested compiler version.

    This is the single entry point agents use: pass the raw prompt (with
    placeholders) and the compiler ``version`` (required — no implicit latest),
    plus the runtime context the placeholders resolve against, and get back the
    prompt to hand to the LLM. Returns the input unchanged for falsy/token-free
    prompts. Raises ValueError if no version is given, KeyError if unknown.

    ``speech_safe=True`` asks the compiler to omit system-prompt scaffolding from
    resolved placeholders so the result is safe to speak verbatim (verdict
    templates). It is forwarded only when set, so compilers that predate the flag
    keep their existing constructor contract.
    """
    extra = {"speech_safe": True} if speech_safe else {}
    compiler = get_compiler(version)(
        sm_context,
        conversation_history=conversation_history,
        user_input=user_input,
        **extra,
    )
    return compiler.compile(template)


# Register the built-in compiler version(s) shipped with the SDK.
register_compiler(PlaceholderPromptCompiler)
register_compiler(PersonaAwarePlaceholderCompiler)
