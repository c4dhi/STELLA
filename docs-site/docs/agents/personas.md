---
sidebar_position: 2
title: "Personas"
---

# Personas

A persona is **who the agent is**: its name, its identity prompt, its voice, and a fallback language. Since 1.3.0 it is separate from the plan (what happens in the conversation) and from the pipeline configuration (how the agent thinks). The same persona can run any plan, and the same plan can be spoken by any persona.

## What a persona holds

| Field | What it does |
|-------|--------------|
| **Name**, **Description**, **Icon** | Shown when picking a persona at deploy time |
| **Prompt** | Character, tone and boundaries, not the steps. It is inserted into the agent's reply prompt as written |
| **Voice** | The voice id for speech. Empty uses the voice provider's default |
| **Language** | A fallback for deployments without a plan. A plan that declares a language always wins |
| **Variables** | Your own key and value pairs, referenced elsewhere as `{{persona.<key>}}` |

Create and edit personas under **Settings → Personas**.

## Built-in personas

Stella ships two personas: one written for plans, and **STELLA Companion** for [companion mode](./stella-v2/companion-mode.md). They are read-only. Duplicate one to make your own.

## Which persona a deployment uses

1. The persona picked in the deploy dialog. The dialog asks for the mode first and preselects the built-in persona that fits it; any persona can be picked instead.
2. If none is named: the persona the plan was built with (its default persona).
3. Otherwise the built-in default: STELLA Companion for a companion deployment, the plan default for everything else.

Public projects pick their persona in the Persona step of the setup wizard.

## Persona variables

A plan or a pipeline configuration sometimes has to name the agent. Instead of repeating the name there, refer to the persona:

```text
Introduce yourself as {{persona.name}} and explain that you are a {{persona.role}}.
```

`{{persona.name}}`, `{{persona.voice}}` and `{{persona.language}}` always exist. Anything else, such as `role` above, is a variable you define on the persona; a variable of your own with the same key wins over the built-in one. The Plan Builder lists the available variables and highlights them in the text.

The persona's own prompt is not a template: a placeholder written there is passed through as text.

## Plans no longer carry a prompt or a voice

Saving a plan that contains `system_prompt` or `voice` is rejected, and the AI plan generator no longer writes them. Put that text into a persona.

## Upgrading from 1.2.0

Existing plans carried their own prompt and voice. After updating, run this once on the host:

```bash
# Dry run: prints plan names, counts and persona names
npx ts-node scripts/migrations/extract-plan-personas.ts

# Read the output, then apply
npx ts-node scripts/migrations/extract-plan-personas.ts --apply
```

Add `--show-prompts` to the dry run to also print the prompt text. The script turns each plan's and each public project's prompt and voice into a persona and links the plan to it, so existing plans keep their personality. It is safe to run again. A custom persona that a saved configuration set in the old configurator slot is not carried over. [Back up the database](../deployment/backup-restore.md) before you upgrade.

Sessions that were paused before the upgrade keep their plan's own personality when they wake up. That fallback is temporary and is removed one release after 1.3.0.
