---
sidebar_position: 2
title: "📦 Installation"
---

import {EnvVarReference} from '@site/src/components';

# 📦 Installation

Detailed guide for installing STELLA and its prerequisites.

## LiveKit Server (Required)

STELLA requires an external LiveKit server for WebRTC communication. You need to set up LiveKit before deploying STELLA:

- **LiveKit Cloud** (recommended): [livekit.io/cloud](https://livekit.io/cloud) - Managed service, easiest setup
- **Self-hosted**: [LiveKit Server Documentation](https://docs.livekit.io/home/self-hosting/local/) - Run your own server

Once LiveKit is set up, the setup wizard collects these values for you — you do
not edit them by hand:

| Variable | Meaning |
|----------|---------|
| `LIVEKIT_URL` | Internal URL the STELLA pods connect to (must **not** be `localhost`) |
| `PUBLIC_LIVEKIT_URL` | Public URL browsers connect to |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |

Run `./scripts/start-k8s.sh --setup` and fill them in when the LiveKit chapter
appears. For local development the wizard's defaults
(`ws://host.docker.internal:7880` / `ws://localhost:7880` with development
credentials) already work.

## Platform-Specific Setup

### macOS (OrbStack or Docker Desktop)

**Requirements:**
- **Docker**: [Docker Desktop](https://docker.com/products/docker-desktop) or [OrbStack](https://orbstack.dev) (recommended)
- **kubectl**: Auto-installed if missing
- **OpenAI API key**

OrbStack provides a built-in Kubernetes cluster that's lightweight and fast. The startup script auto-detects OrbStack and uses it automatically.

### Linux (K3s)

**Requirements:**
- **Docker**: Docker Engine
- **K3s**: Auto-installed by the startup script
- **OpenAI API key**

K3s is a lightweight Kubernetes distribution that's automatically installed and configured by the startup script on Linux systems.

### Windows (via WSL2)

STELLA supports Windows through WSL2 (Windows Subsystem for Linux). Follow the Linux instructions within WSL2.

## Environment Configuration

Configuration is handled by the setup wizard, which writes `.env.local` (or
`.env.production`). Do not create or edit these files by hand.

```bash
# Runs automatically on first launch, or invoke it explicitly:
./scripts/start-k8s.sh --setup

# Full configuration wizard (every variable)
./scripts/start-k8s.sh --config
```

### Essential Variables

The wizard collects the minimum required set for you:

| Variable | Source |
|----------|--------|
| `OPENAI_API_KEY` | You provide it |
| `POSTGRES_PASSWORD` | Auto-generated |
| `JWT_SECRET` | Auto-generated |
| `ENV_VAR_ENCRYPTION_KEY` | Auto-generated |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Development defaults locally; required in production |

In production mode the wizard additionally requires `PRODUCTION_DOMAIN`,
`LIVEKIT_URL` and `PUBLIC_LIVEKIT_URL`.

<EnvVarReference
  text="Complete Environment Variables Reference"
  description="See all available configuration options including STT/TTS providers, GPU settings, and Kubernetes configuration."
/>

## Local Development (Standalone)

For development without Kubernetes:

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate dev

# Start development server
npm run start:dev
```

## Database Migrations

STELLA uses Prisma ORM with PostgreSQL. See [Database Schema](../architecture/database.md) for the complete data model.

```bash
# Create a new migration
npx prisma migrate dev --name add_new_field

# Reset database
npx prisma migrate reset

# Deploy migrations to production
npx prisma migrate deploy
```

## Verify Installation

After deployment, verify all services are running:

```bash
# Check all pods are running
kubectl get pods -n ai-agents

# Test API health
curl http://localhost:3000/health

# Test frontend
curl http://localhost:5173
```

## Troubleshooting

### Connection Issues

**"Connection to database failed"**
- Ensure PostgreSQL pod is running: `kubectl get pods -n ai-agents`
- Re-check your database settings with `./scripts/start-k8s.sh --config`
- Run migrations: `npx prisma migrate deploy`

**"Failed to create pod: Forbidden"**
- Check Kubernetes RBAC permissions
- Ensure namespace exists: `kubectl get namespace ai-agents`
- Verify ServiceAccount: `kubectl get sa -n ai-agents`

**"Agent pod not starting"**
- Check agent image exists: `docker images | grep stella`
- View pod logs: `kubectl logs <pod-name> -n ai-agents`
- Check pod events: `kubectl describe pod <pod-name> -n ai-agents`

**"LiveKit connection refused"**
- Ensure LiveKit is properly configured
- Check port forwarding is active
- Verify LIVEKIT_URL in configuration

### Platform-Specific Issues

**macOS (OrbStack)**
- Ensure OrbStack is running before starting the script
- OrbStack provides Kubernetes automatically, no additional setup needed
- If using Docker Desktop instead, ensure Kubernetes is enabled in settings

**Linux (K3s)**
- K3s is auto-installed by the startup script
- Ensure user has docker group permissions: `sudo usermod -aG docker $USER`
- After adding to docker group, log out and back in

## Next Steps

- [First Agent](./first-agent.md) - Deploy your first agent
- [Database Schema](../architecture/database.md) - Understand the data model
- [Kubernetes Deployment](../deployment/kubernetes.md) - Production Kubernetes setup
