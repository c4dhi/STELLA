---
sidebar_position: 1
title: Getting Started
description: Get STELLA running in minutes with this step-by-step guide
---

import {Steps, Step} from '@site/src/components/StepGuide';
import {EnvVarReference} from '@site/src/components';

# Getting Started with STELLA

Get the entire STELLA platform running in minutes. This guide walks you through setting up your development environment, configuring your credentials, and deploying your first voice AI agent.

## Prerequisites

Before you begin, make sure you have:

- **Docker**: [OrbStack](https://orbstack.dev/) (recommended for macOS), Docker Desktop (Windows), or Docker Engine (Linux)
- **kubectl** configured with a Kubernetes cluster (OrbStack and Docker Desktop include one)
- **OpenAI API key** for the conversational AI
- **LiveKit server** (cloud or self-hosted) for real-time communication — STELLA does not bundle one

:::tip New to LiveKit?
You can [sign up for a free LiveKit Cloud account](https://cloud.livekit.io) to get started quickly. LiveKit Cloud handles all the WebRTC infrastructure for you.

For local development, run LiveKit on your own machine at port `7880`. The setup wizard defaults to `ws://host.docker.internal:7880` (the internal URL pods use) and `ws://localhost:7880` (the public URL browsers use) with development credentials, so you won't need to enter anything.
:::

## Installation

<Steps>

<Step number={1} title="Clone the repository">

Clone the STELLA repository and navigate to the project directory.

```bash title="terminal"
git clone https://github.com/c4dhi/STELLA.git
cd STELLA
```

</Step>

<Step number={2} title="Run one command">

Start STELLA. There is no environment file to copy or hand-edit — on a fresh clone the script detects that setup is incomplete and offers the guided wizard.

```bash title="terminal"
./scripts/start-k8s.sh
```

```text title="terminal"
Setup not complete or missing required configuration

  Run setup wizard now? [Y/n]
```

Press **Enter** to accept. The wizard walks you through a few chapters:

| Chapter | What it does |
|---------|--------------|
| Credentials | Collects `OPENAI_API_KEY` and **auto-generates** `POSTGRES_PASSWORD`, `JWT_SECRET` and `ENV_VAR_ENCRYPTION_KEY` for you |
| Optional Settings | STT/TTS providers, GPU, data root — safe to skip |
| Admin | Bootstraps an initial system-admin login, so you can sign in right away (skippable) |

For local development, LiveKit falls back to built-in development credentials, so you can leave the LiveKit fields alone. For production the wizard additionally asks for your real `LIVEKIT_URL`, `PUBLIC_LIVEKIT_URL`, API key/secret and `PRODUCTION_DOMAIN`.

:::tip Where your settings are stored
The wizard writes `.env.local` (or `.env.production` in production mode) — not `.env`. You normally never edit these by hand; re-run the wizard instead.
:::

When the wizard finishes it stops any stale services and deploys the full stack in the background: building images, creating the Kubernetes namespace, deploying PostgreSQL, backend and frontend, and setting up port forwarding.

<EnvVarReference description="See all available configuration options including database, security, and provider settings." />

</Step>

<Step number={3} title="Verify the deployment" isLast>

Check that all services are running:

```bash title="terminal"
kubectl get pods -n ai-agents
```

You should see pods for `postgres`, `session-management-server`, and `frontend-ui` all in `Running` status.

</Step>

</Steps>

## Access the Application

Once deployed, STELLA is available at:

| Service | URL | Description |
|---------|-----|-------------|
| Frontend UI | http://localhost:5173 | Web interface for voice conversations |
| Backend API | http://localhost:3000 | REST API and WebSocket server |
| API Docs | http://localhost:3000/api | Swagger documentation |

## Your First Conversation

1. Open http://localhost:5173 in your browser
2. Create a new project or select an existing one
3. Click **Start Session** to begin a conversation
4. Grant microphone permissions when prompted
5. Start talking - the AI agent will respond in real-time

## Reconfigure Anytime

Configuration is always done through the wizard — there is no environment file to edit by hand.

```bash title="terminal"
# Re-run the onboarding wizard (required variables only)
./scripts/start-k8s.sh --setup

# Full configuration wizard (every variable)
./scripts/start-k8s.sh --config

# Target a specific environment
./scripts/start-k8s.sh --setup --local
./scripts/start-k8s.sh --setup --production

# Guided backup & restore (export/import the whole system)
./scripts/start-k8s.sh --backup
```

## Deployment Modes

STELLA supports several deployment modes for different use cases:

| Flag | Description | Use Case |
|------|-------------|----------|
| (default) | Foreground mode | Local development |
| `--daemon` | Background mode | Production servers |
| `--restart` | Stop and restart | Apply code changes |
| `--rebuild` | Force rebuild | After Dockerfile changes |
| `--production` | Production settings | Deploy to production |

### Examples

```bash title="terminal"
# Local development (foreground)
./scripts/start-k8s.sh

# Production deployment (background)
./scripts/start-k8s.sh --production --daemon

# Apply code changes
./scripts/start-k8s.sh --restart

# Stop all services
./scripts/start-k8s.sh --stop
```

## Troubleshooting

### Pods not starting

Check pod logs for errors:

```bash title="terminal"
kubectl logs -f -n ai-agents -l app=session-management-server
```

### Database connection issues

Ensure the PostgreSQL pod is running:

```bash title="terminal"
kubectl get pods -n ai-agents -l app=postgres
```

### LiveKit connection fails

Re-run `./scripts/start-k8s.sh --setup` to check your LiveKit URLs and credentials, and ensure WebSocket connections are allowed. Remember that `LIVEKIT_URL` is the URL the pods use internally — it must not be `localhost`.

## Next Steps

- [Build Your Own Agent](./build-your-own-agent.md) - Build a custom voice AI agent
- [Architecture Overview](../architecture/overview.md) - Understand how STELLA works
- [Agent SDK Reference](../sdk/overview.md) - Explore the Python SDK
