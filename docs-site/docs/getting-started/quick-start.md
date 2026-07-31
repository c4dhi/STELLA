---
sidebar_position: 1
title: "🚀 Quick Start"
---

# 🚀 Quick Start

Get the entire STELLA system running in 2 commands.

## Prerequisites

Before starting, ensure you have:
- Docker Desktop or OrbStack (macOS) / Docker Engine (Linux)
- An OpenAI API key
- A LiveKit server (cloud or self-hosted)

## Deploy Everything

```bash
# 1. Clone the repository
git clone https://github.com/c4dhi/STELLA.git
cd STELLA

# 2. Deploy — the setup wizard runs automatically on first launch
./scripts/start-k8s.sh
```

On a fresh clone the script detects that setup is incomplete and offers the
guided wizard. Press **Enter** to accept it. The wizard asks for your
`OPENAI_API_KEY`, auto-generates the database password, JWT secret and
encryption key, and can bootstrap an initial admin login. It writes
`.env.local` (or `.env.production`) for you — there is no `.env` file to copy
or edit by hand.

Once the wizard finishes, it deploys the stack in the background automatically.

```bash
# Reconfigure anytime
./scripts/start-k8s.sh --setup    # required variables
./scripts/start-k8s.sh --config   # every variable
```

**Done!** System is now running at:

| Service | URL |
|---------|-----|
| Frontend UI | http://localhost:5173 |
| API | http://localhost:3000 |
| LiveKit | ws://localhost:7880 |
| Agents | Auto-created as Kubernetes pods |

## Deployment Modes

| Flag | Description | Use Case |
|------|-------------|----------|
| (default) | Foreground mode | Local development, press Ctrl+C to stop |
| `--daemon, -d` | Background mode | Remote servers, survives SSH logout |
| `--restart, -r` | Stop then restart | Apply code changes quickly |
| `--rebuild` | Force rebuild images | After Dockerfile changes |
| `--skip-build` | Skip builds | Restart pods only |
| `--stop` | Stop all services | Cleanup |
| `--dry-run` | Preview changes | Test before applying |
| `--production` | Production mode | Deploy with production settings |

## Examples

```bash
# Local development
./scripts/start-k8s.sh

# Production deployment in background
./scripts/start-k8s.sh --production --daemon

# Apply code changes (stop, rebuild, restart)
./scripts/start-k8s.sh --restart

# Force rebuild everything
./scripts/start-k8s.sh --rebuild

# Preview what would happen
./scripts/start-k8s.sh --dry-run --verbose
```

## Verify Deployment

```bash
# View all resources
kubectl get all -n ai-agents

# View backend logs
kubectl logs -f -n ai-agents -l app=session-management-server

# Monitor daemon mode logs
tail -f /tmp/stella-ai-k8s/stella-ai-k8s.log
```

## Next Steps

- [Installation Guide](./installation.md) - Detailed setup instructions
- [First Agent](./first-agent.md) - Deploy your first conversational AI agent
- [Agents Overview](../agents/overview.md) - Learn about different agent types
