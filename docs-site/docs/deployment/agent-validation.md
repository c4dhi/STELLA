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

### A new version, and deleting

- **A new version replaces your old one.** Upload the package again with the same `metadata.slug` and a higher `metadata.version`. STELLA replaces your agent in place, so its env var templates, configurations and public projects keep pointing at it.
  - The new version must be built (and reviewed, if review is on) before it can be deployed.
  - Agents that are already running keep the old image until they stop.
- **Some uploads are refused.** This happens when the version is unchanged, or when the slug belongs to another user's agent or a built-in one. Another user's agent is never replaced.
- **Deleting an agent stops its running agents first.** They keep their transcripts. The delete is refused while a public project uses the agent.

## Recommended Workflow

If you are building your own agent, follow the deployment-test checklist in [Build Your Own Agent](../guides/build-your-own-agent.md#run-deployment-tests).
