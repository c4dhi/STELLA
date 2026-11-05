---
sidebar_position: 7
title: Agent platform
description: How STELLA and its agents stay decoupled, and the rules every change follows to keep it that way
---

# Agent platform standards

STELLA runs agents it knows nothing about. Everything it needs to know about an agent comes from that agent's `agent.yaml` ([the manifest](../../agent-sdk/agent-manifest.md)). Anyone can write an agent with the SDK, declare what it needs in the manifest, upload it and run it. No STELLA code changes for one specific agent.

These rules keep it that way. They apply to backend, frontend, SDK and scripts, and to people and AI agents alike. If a change breaks one, change the design, not the rule. Or propose changing the rule here first.

## 1. The manifest is the single source of truth

- **Anything an agent needs is declared in its manifest:** env vars, plans, persona, Configurator, connectors, resources, settings, SDK version. If the manifest doesn't declare something, STELLA doesn't support it.
- **What is declared is enforced.** A declaration that only the UI reads is a bug. Deploy, restart and wake check every declaration and refuse what doesn't fit with a 400 that names the problem.
- **What is not declared is refused.** It is never ignored. Unknown manifest keys are errors. A plan for an agent without `features.plans` is refused. So is a Configurator configuration for an agent without `features.configurator`, or a persona for one with `persona: false`.
- **Built-in agents get no special treatment.** stella-v2 and stella-light go through the same parser, mapper, requirements and checks as an upload. They differ only in `isBuiltIn` and where their image comes from: `agents/<slug>/` with the manifest's Dockerfile. There is no list of built-ins in code or scripts. Add a folder with an `agent.yaml` and it is seeded and built.

## 2. One owner per concern

Every concern has exactly one module that owns it. Everything else calls that module. It never re-implements, re-parses or copies it.

| Concern | Owner |
|---|---|
| Manifest format, validation, published JSON Schema | `src/agent-package/schemas/agent-manifest.schema.ts` |
| Older manifest formats (1.0) | `src/agent-package/manifest-normalizer.ts`. Nothing else reads an `x-stella-*` flag. |
| Manifest → `AgentType` row | `src/agent-package/manifest-mapper.ts` (seed and upload) |
| Defaults, maxima, vocabularies, SDK versions | `src/agent-package/manifest-defaults.ts` |
| Which SDK versions STELLA runs (build and deploy) | `src/agent-package/sdk-support.ts` |
| Where a built-in agent lives and how its image is built | `src/agent-package/agent-directory.ts` (`builtInDockerfilePath`), `builtInImageConfig` in `src/agent-image/agent-image.service.ts` |
| Experts an agent publishes | `src/agent-package/expert-defaults.ts` |
| What deploying a type takes | `src/agents/agent-requirements.ts` (`resolveAgentRequirements`) |
| Whether a deploy request is allowed | `src/agents/deploy-request.ts` |
| Whether a type may be deployed at all (review, image) | `src/agents/deployable-agent-type.util.ts` |
| The default agent type | `src/agents/default-agent-type.ts`, the only slug in `src/` |
| Pod resource clamping | `src/kubernetes/utils/resource-clamping.util.ts`, which reads its defaults from `manifest-defaults.ts` |
| Version comparison | `compareVersions` in `src/agent-configurations/configuration-compat.util.ts` |

Before writing a helper, search for the owner. Two copies of a rule always drift apart. The seed and upload once mapped manifests differently, and pods were once clamped to a different default than the one the database stored.

## 3. Low coupling between STELLA and agents

- **No agent slugs in platform code.** No `if (slug === 'stella-v2-agent')`. Behaviour that differs between agents is a manifest declaration. A spec fails the build when a slug literal appears in `src/` outside `default-agent-type.ts`.
- **Requirements, not raw schemas, cross boundaries.** The API returns `requirements` for each agent type. The deploy wizard renders from that and never parses `configSchema` itself.
- **The platform and the agent talk through declared contracts only:** the manifest going in, `AGENT_CONFIG` and env vars to the pod, and gRPC registration back. An agent uses the SDK's public API, never its private attributes. STELLA never relies on an agent's internals.
- **Platform keys and user settings are separate.**
  - STELLA sets `persona`, `mode`, `plan`, `available_plans` and `pipeline_config` (`PLATFORM_CONFIG_KEYS`).
  - Everything else is a user setting. `configSchema` describes it and `defaultConfig` fills it in.
- **Infrastructure has no business logic.** `KubernetesService` receives final values (merged env, resolved resources). It doesn't decide them.

## 4. High cohesion

- **Keep pure logic out of services.** Pure functions (requirements, deploy checks, mapping, normalizing) take plain data and return plain data or throw. They don't touch Prisma, Kubernetes or Nest, so they can be tested and reused. Services fetch the data, call them, and persist the result.
- **One pipeline per operation.** Every deploy entry point (wizard, public projects, auto-pause wake) goes through `AgentsService.create()`. Restart reuses the same checks. A new entry point calls these. It does not add a parallel path. Unreachable paths get deleted, not kept "just in case". `createStandaloneAgent` was one, and it skipped validation.
- **Changing a default takes one line.**
  - Resource defaults, maxima and the supported SDK floor are each set once, in `manifest-defaults.ts`.
  - Specs check that every other place that must agree (Prisma column defaults, clamping) does.

## 5. Contracts are versioned and evolve compatibly

- **A new manifest format** adds a step to the normalizer, so older files keep working with a deprecation warning. Golden tests pin that each built-in's old file upgrades to exactly its current one.
- **The SDK support window.**
  - `MIN_SUPPORTED_SDK_VERSION` is the oldest SDK STELLA still runs. `CURRENT_SDK_VERSION` is the one it ships, and a spec keeps it equal to the SDK's `pyproject.toml`.
  - The build records the SDK actually installed in each image (`AgentType.sdkVersion`). `sdk-support.ts` decides for both the build and the deploy.
  - An agent that needs a newer SDK, or was built with one older than the floor, is refused at deploy and has to be rebuilt.
  - Retiring an SDK takes one line plus a CHANGELOG entry.
- **Published artefacts are generated from code, never written by hand.** The manifest JSON Schema comes from `npm run manifest:schema`, and a spec fails when the committed file is stale.

## 6. Errors

- Validate at the boundary and fail before anything is persisted or created. A refused deploy leaves no agent row and no pod.
- Report every problem at once, in words the user can act on ("missing required environment variables: OPENAI_API_KEY"), never a stack trace or a field path alone.
- Never silently fix up bad input. Refuse it, or warn when the input is in a legacy format.

## 7. Every change ships with its proof

- Specs for the rule itself, plus a spec that pins the single source (defaults agree, no slug literals, generated files current).
- New spec files go into `.github/workflows/agent-validation-unit-tests.yml`.
- A CHANGELOG entry under Unreleased, and docs in `docs-site/docs/agent-sdk` when authors see the change.

## Checklist for a change

- [ ] Does it need agent-specific knowledge? Then make it a manifest declaration, not code.
- [ ] Is there already an owner for this concern? Extend that one.
- [ ] Is every new declaration enforced on deploy, restart and wake?
- [ ] Is a default or limit set in more than one place?
- [ ] Can older manifests and SDKs still be read, or is the break deliberate, versioned and in the CHANGELOG?
- [ ] Are there specs, a CI entry, a CHANGELOG line and docs?
