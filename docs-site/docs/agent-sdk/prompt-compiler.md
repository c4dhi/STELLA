---
sidebar_position: 6
title: Prompt Compiler
description: Resolve {{placeholder}} tokens in agent prompts with a versioned, shared compiler
---

# Prompt Compiler

The prompt compiler turns an **authored** prompt — one written in the Agent
Configurator or a plan, containing `{{placeholder}}` tokens — into a **final**
prompt by resolving those tokens against the live runtime state (the plan, the
conversation so far, the current user message, …). It is a shared SDK library, so
every agent (stella-v2, stella-light, and any custom agent) resolves the same
tokens the same way.

```python
from stella_agent_sdk import prompts

final = prompts.compile(
    "You are helping with: {{current_focus}}\n\n{{history_8}}\n\n{{user_message}}",
    version="1.0.0",                     # required — see "Versioning" below
    sm_context=sm_context,               # live state-machine context
    conversation_history=history,        # list of {"role", "content"}
    user_input=text,                     # the current user message
)
# -> the same prompt with every {{token}} replaced by its runtime value
```

That single `compile()` call is the **only** entry point an agent needs. You pass
the raw prompt and the compiler version; you get back the string to hand to the
LLM.

## How it works

`compile()` scans the template for `{{name}}` tokens and replaces each with the
value produced by that placeholder's resolver. It is a no-op for falsy input or a
prompt with no tokens (returned unchanged), and **unknown tokens are left as-is**
so a typo can never silently blank out part of a prompt.

```python
prompts.compile("plain text", "1.0.0", sm_context=ctx)   # -> "plain text"
prompts.compile("{{unknown}}", "1.0.0", sm_context=ctx)  # -> "{{unknown}}"
```

## Available placeholders

These are the tokens the built-in compiler (version `1.0.0`) resolves. They are
also the canonical **Configurator palette** — agents mirror this list in their
manifest's `runtimeVariables` so the chips shown in the editor match what the
compiler can actually resolve.

| Placeholder | Resolves to |
|-------------|-------------|
| `{{plan}}` | Full plan: all states, tasks, deliverables with completion status |
| `{{current_focus}}` | Active task + pending deliverables with acceptance criteria |
| `{{pending_deliverables}}` | Pending deliverables with required/optional flags |
| `{{collected_deliverables}}` | Already-collected deliverable keys/values |
| `{{turns_without_progress}}` | Turns since the last deliverable was collected |
| `{{current_state}}` | Current state name, description, and processing mode |
| `{{progress_percentage}}` | Overall progress percentage |
| `{{processing_mode}}` | Processing mode (sequential / flexible / goal) |
| `{{history_N}}` | The last **N** conversation messages, e.g. `{{history_8}}` |
| `{{user_message}}` | The current user message |

`{{history_N}}` is **parametric**: `N` is any positive integer.

You can inspect the palette and validate a template programmatically:

```python
from stella_agent_sdk import prompts

prompts.palette()                       # list of {name, label, description, preview, parametric}
prompts.validate_template("{{plan}} {{bogus}}")   # -> ["bogus"]  (unknown tokens)
prompts.KNOWN_PLACEHOLDERS              # frozenset of resolvable names ("history_N" sentinel for the parametric one)
```

## Versioning

The version argument to `compile()` is **mandatory** — there is intentionally no
implicit "latest". This is the core guarantee: **an SDK upgrade can never silently
change how an agent's prompts compile.** A prompt authored against version `1.0.0`
keeps compiling against `1.0.0` until someone deliberately bumps it.

```python
prompts.compile("{{plan}}", sm_context=ctx)          # TypeError — version is required
prompts.compile("{{plan}}", None, sm_context=ctx)    # ValueError — no implicit latest
prompts.compile("{{plan}}", "99.0.0", sm_context=ctx) # KeyError — no such version registered
```

Discover what's registered:

```python
prompts.available_versions()   # e.g. ["1.0.0"]  (oldest first)
prompts.latest_version()       # e.g. "1.0.0"  (for tooling, NOT a runtime default)
```

### How an agent pins a version

Each agent pins the version it was written and tested against as a module
constant, and lets a deployment override it via config — it never relies on
"latest":

```python
# Pinned on purpose. Bump deliberately when adopting a new compiler version.
PROMPT_COMPILER_VERSION = "1.0.0"

class MyAgent(BaseAgent):
    async def on_session_start(self, session_id, config):
        # config override, else the agent's pinned default
        self._compiler_version = config.get("compiler_version") or PROMPT_COMPILER_VERSION

    def _render(self, text, sm_context, history, user_input):
        return prompts.compile(
            text,
            version=self._compiler_version,
            sm_context=sm_context,
            conversation_history=history,
            user_input=user_input,
        )
```

Both stella-light (`PROMPT_COMPILER_VERSION` in `agent.py`) and stella-v2 (the
version threaded into `ExpertRunner` via `ExpertPool`) follow exactly this
pattern.

### Manifest & configuration

Two declarations tie the running compiler to the configs authored against it:

- An agent's **manifest** declares the version it ships with:

  ```yaml
  promptCompiler:
    version: "1.0.0"
  runtimeVariables:        # mirrors the compiler palette for the Configurator
    - name: plan
    - name: current_focus
    # …
  ```

  This is persisted onto `AgentType.compilerVersion`. A drift-guard test asserts
  the manifest version matches the agent's pinned `PROMPT_COMPILER_VERSION` and
  that every declared `runtimeVariable` is actually resolvable by the compiler.

- A saved **AgentConfiguration** may declare `minCompilerVersion`. At deploy time
  the backend refuses (and reconciliation flags `OUTDATED`) any config that
  requires a newer compiler than the agent currently ships — so a config can never
  be handed to an agent that can't reliably process it.

## Adding a new compiler version

You add a version when you change the token grammar — add/remove a placeholder, or
change how one renders. Ship it as a **new version** so existing prompts keep
compiling against the version they were authored for.

There are two ways, depending on how much you're changing.

### 1. Extend the placeholder compiler (most common)

Subclass `PlaceholderPromptCompiler`, bump `VERSION`, and register it:

```python
from stella_agent_sdk.prompts import (
    PlaceholderPromptCompiler,
    register_compiler,
)

@register_compiler
class PlaceholderPromptCompilerV1_1(PlaceholderPromptCompiler):
    NAME = "placeholder"
    VERSION = "1.1.0"
    # override resolution / add placeholders as needed

# Now selectable explicitly:
prompts.compile("{{plan}}", version="1.1.0", sm_context=ctx)
```

`register_compiler` keys the class by its `VERSION` (and rejects the placeholder
`0.0.0`). `available_versions()` / `latest_version()` immediately reflect it.

### 2. Write a compiler from scratch

For a different grammar entirely, implement the `PromptCompiler` interface:

```python
from typing import Optional
from stella_agent_sdk.prompts import PromptCompiler, register_compiler

@register_compiler
class MyCompiler(PromptCompiler):
    NAME = "my-grammar"
    VERSION = "1.0.0"

    def __init__(self, sm_context=None, *, conversation_history=None, user_input=""):
        self._ctx = sm_context or {}
        # …stash whatever per-turn context your resolvers need…

    def compile(self, template: Optional[str]) -> Optional[str]:
        if not template:
            return template
        # …resolve your tokens and return the final prompt…
        return template
```

The constructor signature must accept `(sm_context, *, conversation_history,
user_input)` because that's what the `compile()` entry point passes when it
instantiates your compiler.

### After adding a version

1. Bump the agent's `PROMPT_COMPILER_VERSION` (and the manifest
   `promptCompiler.version`) **only when you want that agent to adopt it** — the
   drift-guard test enforces the two stay in lockstep.
2. Leave older versions registered so configs authored against them still compile.

## Reference

- `prompts.compile(template, version, *, sm_context=None, conversation_history=None, user_input="")` — the single entry point.
- `prompts.get_compiler(version)` — the compiler **class** for a version (version required).
- `prompts.register_compiler(cls)` — register a compiler class under its `VERSION` (usable as a decorator).
- `prompts.available_versions()` / `prompts.latest_version()` — discover registered versions.
- `prompts.validate_template(text)` — list unknown tokens in a template.
- `prompts.palette()` / `prompts.PLACEHOLDER_SPECS` — the Configurator palette metadata.
- `prompts.PromptCompiler` / `prompts.PlaceholderPromptCompiler` — base class and built-in compiler.

> There is intentionally **no** version-less `compile_prompt` in the public API.
> All compilation goes through `compile(version=...)`, so the version is always
> explicit.
