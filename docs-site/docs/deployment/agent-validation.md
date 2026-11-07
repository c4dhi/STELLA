---
sidebar_position: 2
title: Agent Validation
description: Validation paths for built-in and custom agents before deployment
---

# Agent Validation Before Deployment

Built-in agents and custom agents follow different validation paths.

## Built-In Agents

Built-in agents under `agents/` are validated continuously in GitHub Actions. This repository currently uses GitHub-hosted workflows to run:

- `npm run validate:agents` for manifest validation, Dockerfile presence, slug consistency, and SDK compatibility
- Python startup smoke tests to install the SDK and built-in agents, then verify they initialize with sample config

In practice, GitHub is currently part of the continuous validation path for built-in agents in this repository.

## Custom Agents

Custom agents are validated individually when they are packaged, uploaded, or built. STELLA validates the package contents and manifest for that one agent instead of running the repository-wide built-in agent workflow.

This means a custom agent does not need to be part of the built-in agent set to be validated before deployment.

### Who can use an uploaded agent

- **An upload is its owner's.** Nobody else sees it or can deploy it until the owner shares it.
- **Sharing is per project.** In Settings → Agent Library, the owner picks the projects to share it with. It is listed for those projects' members, marked "Shared by …", and they can deploy it in those projects only. Only the owner can build it, upload a new version, change its sharing or delete it, as with connectors.
- **Unsharing only stops new deploys.** Agents that are already running in that project keep running, and a paused one can still wake or restart, because that runs as the owner. Stop them from the session if they must go.
- **Upgrading.** Before this change, every approved upload was listed for everyone. The upgrade shares each upload with the projects that use it as their public agent, and with the projects where another user has it running or paused. Every other upload starts private to its owner.
- **Review.** While **Review uploaded agents** is on (the default), an upload needs an admin's approval before anyone can deploy it, its owner included, and before it is listed for the projects it is shared with. With review off, the owner can deploy it once it is built, and sharing is what lets others use it.

### Reviewing uploads (system admins)

Settings → **Agent Review** lists uploaded agents under **Pending**, **Approved** and **Rejected**. Only system admins see it. Pending uploads come oldest first.

- **Each entry starts with the latest build**: built, failed (with the error), building, or not built yet. Then it shows the name, version, slug, who uploaded it and when, the SDK it was built with, and whether it needs a GPU. Last come what its `agent.yaml` asks of a deployment: the keys it needs, its optional settings, connectors, persona and plans. **Builds and resources** opens the five latest builds, the capabilities and the CPU and memory limits.
- **Approve** takes optional notes. **Reject** needs a reason. The owner sees either one on their agent card in the Agent Library and in the deploy picker.
- **A decision can be reversed.** An approved agent can be rejected, which stops new deploys. A rejected one can be approved after all.
- Assistants with an admin's MCP token can do the same with the `agent_reviews_*` tools (see the [MCP tool reference](../mcp/tools.md#agent-review-system-admins)).

### A new version, and deleting

- **A new version replaces your old one.** Upload the package again with the same `metadata.slug` and a higher `metadata.version`. STELLA replaces your agent in place, so its env var templates, configurations, shares and public projects keep pointing at it.
  - The new version starts building on its own; see [How an upload is built](#how-an-upload-is-built).
  - It must be built (and approved, if review is on) before it can be deployed.
  - Agents that are running keep the old image until they stop.
  - A paused agent of it can't wake, and new deploys are refused, until the new version is built (and approved).
- **Some uploads are refused.** This happens when the version is unchanged, or when the slug belongs to another user's agent or a built-in one. Another user's agent is never replaced.
- **Deleting.**
  - Agents of it whose pod is gone (an OOMKilled pod, say) are cleaned up first.
  - Your own running agents of it are stopped. They keep their transcripts.
  - The delete is refused while it still runs in another user's session, or while a public project uses it. The message says how many.

### How an upload is built

- **The build starts on its own** as soon as the upload, or a new version, finishes saving — no separate Build step. The card shows its status live: Queued, Building, Built or Build Failed, with a link to the log. The button stays there as Rebuild, for building it again later.
- **Only one build of an agent type runs at a time.** An upload (or Rebuild) that arrives while one is already building queues behind it and runs next with whatever is then current on the agent type. A further upload while one is queued supersedes it — only the latest upload is ever built next, and the one it replaced is marked "Superseded by a newer upload" rather than left pending.
- **STELLA builds every upload from its own Dockerfile.** An upload can't point at a prebuilt image: a package whose `agent.yaml` sets `image.imageUrl` is refused. The Dockerfile path must be a plain relative path inside the package.
- **The Dockerfile installs `stella-ai-agent-sdk` from PyPI**, for example `stella-ai-agent-sdk>=0.10.0` in its `requirements.txt`.

### SDK versions

STELLA 2.0.0 supports Agent SDK 0.10.0 and newer, up to the version it ships (`GET /agent-types/sdk-support` returns `{ minSupported, current }`).

- **After every build, STELLA reads the SDK version actually installed in the image.** A build with no SDK, or with one older than `minSupported`, fails and says so.
- **An agent built with an SDK outside the window can't be deployed, restarted or woken.** My Agents marks it as needing an SDK update. Update the SDK in the package, then build it again.
- **Uploads built before 2.0.0 have no recorded SDK version**, so each one needs to be built once after upgrading (see [Upgrading](./upgrading.md#200)).

The manifest side of this is in [Agent manifest → SDK versions](../agent-sdk/agent-manifest.md#sdk-versions).
