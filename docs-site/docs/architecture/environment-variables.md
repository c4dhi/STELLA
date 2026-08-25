---
sidebar_position: 5
title: Environment Variables
description: Complete reference for all STELLA environment variables
---

# Environment Variables

Complete reference for all environment variables used in the STELLA platform. Variables are organized by category and include default values, requirements, and detailed descriptions.

## Quick Reference

Jump to a specific category:

| Category | Description |
|----------|-------------|
| [Core Server](#core-server) | Node environment, ports |
| [Database](#database) | PostgreSQL configuration |
| [Security](#security) | JWT, encryption keys |
| [LiveKit](#livekit) | WebRTC server configuration |
| [AI APIs](#ai-apis) | OpenAI and other AI services |
| [Speech-to-Text](#speech-to-text) | STT provider configuration |
| [Text-to-Speech](#text-to-speech) | TTS provider configuration |
| [GPU Acceleration](#gpu-acceleration) | GPU/CUDA settings |
| [Kubernetes](#kubernetes) | K8s namespace, DNS configuration |
| [Agent Configuration](#agent-configuration) | Agent images and directories |
| [Agent SDK (Pod-Level)](#agent-sdk-pod-level) | TTS, turn management, debouncing inside agent pods |
| [Public URLs](#public-urls) | Frontend URLs and API endpoints |
| [Storage](#storage) | Temporary directories and paths |

---

## Core Server

Basic server configuration for the STELLA backend.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `local` | Environment mode. Use `local` for development with localhost URLs, `production` for deployment with custom domains |
| `PORT` | No | `3000` | HTTP server port for the backend API |
| `GRPC_PORT` | No | `50051` | gRPC server port for internal service communication |
| `PRODUCTION_DOMAIN` | No | - | Your domain for production deployment (e.g., `yourdomain.com`). Only used when `NODE_ENV=production` |

---

## Database

PostgreSQL database connection settings.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | **Yes** | - | PostgreSQL connection string. Format: `postgresql://user:password@host:port/database?schema=public` |
| `POSTGRES_DB` | No | `session_management` | Database name |
| `POSTGRES_USER` | No | `postgres` | Database username |
| `POSTGRES_PASSWORD` | **Yes** | - | Database password. Use a strong, unique password in production |

**Example Configuration:**

```bash
POSTGRES_DB=session_management
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-secure-db-password
DATABASE_URL="postgresql://postgres:your-secure-db-password@localhost:5432/session_management?schema=public"
```

---

## Security

Authentication and encryption settings.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **Yes** | - | Secret key for signing JWT tokens. Use 64+ characters in production |
| `ENV_VAR_ENCRYPTION_KEY` | **Yes** (prod) | - | AES-256 encryption key for sensitive environment variables stored in database. Generate with: `openssl rand -hex 32` |

:::caution Encryption Key Security
The `ENV_VAR_ENCRYPTION_KEY` must be exactly 64 hex characters (32 bytes). **Losing this key means losing access to all encrypted environment variables!** Store it securely in a secrets manager.
:::

---

## LiveKit

WebRTC server configuration for real-time audio/video communication.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LIVEKIT_URL` | **Yes** | `ws://localhost:7880` | Internal LiveKit URL for services running in K8s pods |
| `PUBLIC_LIVEKIT_URL` | **Yes** | `ws://localhost:7880` | Public LiveKit URL for browser clients |
| `LIVEKIT_API_KEY` | **Yes** | `devkey` | LiveKit API key for authentication |
| `LIVEKIT_API_SECRET` | **Yes** | `secret` | LiveKit API secret |
| `LIVEKIT_TURN_ENABLED` | No | `false` | Enable TURN server for NAT traversal in production |
| `LIVEKIT_TURN_DOMAIN` | No | - | Domain for TURN server (e.g., `turn.yourdomain.com`) |

**URL Configuration:**

- **Local development**: Both URLs typically point to `ws://localhost:7880`
- **Production**: `LIVEKIT_URL` uses internal addressing (e.g., `ws://host.minikube.internal:7880`), while `PUBLIC_LIVEKIT_URL` uses your public domain with TLS (e.g., `wss://livekit.yourdomain.com`)

---

## AI APIs

API keys for AI services used by agents.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | **Yes** | - | OpenAI API key for agent conversations. Format: `sk-proj-xxxxx` |
| `OPENAI_PLAN_GENERATOR_API_KEY` | No | - | Separate OpenAI key for plan generation (cost isolation) |

---

## Speech-to-Text

Configure the speech recognition provider and settings.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STT_PROVIDER` | No | `sherpa` | STT provider: `sherpa` (lightweight CPU) or `whisper` (GPU-accelerated, best accuracy) |

<details>
<summary><strong>Whisper Configuration</strong></summary>

These settings only apply when `STT_PROVIDER=whisper`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WHISPER_MODEL` | No | `large-v3` | Model size. Options: `tiny.en`, `base.en`, `small.en`, `medium.en` (English-only) or `tiny`, `base`, `small`, `medium`, `large-v3` (multilingual) |
| `WHISPER_DEVICE` | No | `cpu` | Compute device: `cpu` or `cuda` |
| `WHISPER_COMPUTE_TYPE` | No | `int8` | Quantization type: `float16`, `int8`, `int8_float16` |
| `WHISPER_BEAM_SIZE` | No | `5` | Beam search width. Higher = more accurate but slower |
| `WHISPER_LANGUAGE` | No | (auto-detect) | Force specific language code (e.g., `en`, `de`, `fr`) for the whole STT service. Empty for auto-detection. To fix a *single* agent's language, set `STELLA_LANGUAGE` on that agent instead — it pins transcription per session without affecting other agents |

</details>

<details>
<summary><strong>VAD (Voice Activity Detection) Configuration</strong></summary>

Silero VAD settings for the whisper provider:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAD_THRESHOLD` | No | `0.5` | Voice detection threshold (0.0-1.0). Higher = less sensitive |
| `VAD_MIN_SILENCE_MS` | No | `500` | Minimum silence duration (ms) before considering speech ended |
| `PARTIAL_INTERVAL_MS` | No | `1000` | Interval for partial transcription updates |

</details>

---

## Text-to-Speech

Configure the speech synthesis provider and settings.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TTS_PROVIDER` | No | `piper` | TTS provider: `piper` (fast local CPU), `kokoro` (fast local GPU), `chatterbox` (multilingual), `elevenlabs` (best quality), or `auto` (fallback chain) |

**Provider Comparison:**

| Provider | Latency | Quality | Cost | Notes |
|----------|---------|---------|------|-------|
| `piper` | 30-80ms | Good | Free | CPU-only, lowest latency |
| `kokoro` | 50-100ms | Good | Free | GPU-accelerated |
| `chatterbox` | 100-200ms | Good | Free | Multilingual |
| `elevenlabs` | 200-300ms | Excellent | Paid | Best voice quality |
| `auto` | Varies | Varies | Mixed | Fallback: piper → chatterbox → kokoro |

<details>
<summary><strong>ElevenLabs Configuration</strong></summary>

These settings only apply when `TTS_PROVIDER=elevenlabs`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ELEVENLABS_API_KEY` | **Yes** | - | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | No | `Xb7hH8MSUJpSbSDYk0k2` | Voice ID from ElevenLabs |
| `ELEVENLABS_MODEL_ID` | No | `eleven_turbo_v2_5` | Model ID. `eleven_turbo_v2_5` offers best latency |

</details>

<details>
<summary><strong>Kokoro Configuration</strong></summary>

Kokoro is automatically configured based on GPU settings. When `ENABLE_GPU=true`, Kokoro uses CUDA acceleration for best performance.

</details>

---

## GPU Acceleration

Configure GPU support for STT and TTS services.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENABLE_GPU` | No | `false` | Enable GPU support. Set to `true` for CUDA-accelerated inference |
| `ONNX_PROVIDER` | No | `CUDAExecutionProvider,CPUExecutionProvider` | ONNX Runtime execution providers for STT/TTS |

**Requirements for GPU mode:**
- Linux with NVIDIA GPU (Tesla T4, RTX 3000+, etc.)
- NVIDIA drivers installed (`nvidia-smi` should work)
- K3s with NVIDIA Container Toolkit

:::note macOS
macOS automatically falls back to CPU mode as NVIDIA GPUs are not supported.
:::

---

## Kubernetes

Kubernetes cluster and DNS configuration.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KUBERNETES_NAMESPACE` | No | `ai-agents` | Namespace for agent pods |
| `CUSTOM_DNS_SERVERS` | No | - | Custom DNS servers for CoreDNS (space-separated). Example: `"8.8.8.8 8.8.4.4"` |
| `AUTO_DETECT_K8S_DNS` | No | `false` | Auto-detect CoreDNS IP in production |
| `KUBERNETES_DNS_NAMESERVER` | No | `10.96.0.10` | Fallback DNS IP for pod DNS resolution |

**DNS Configuration:**

Custom DNS is useful for bypassing network DNS interception (e.g., corporate SSL inspection):

```bash
# Google DNS (recommended for production)
CUSTOM_DNS_SERVERS="8.8.8.8 8.8.4.4"

# Cloudflare DNS
CUSTOM_DNS_SERVERS="1.1.1.1 1.0.0.1"

# Use system default (local development)
CUSTOM_DNS_SERVERS=""
```

---

## Agent Configuration

Settings for agent deployment and management.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_IMAGE` | No | `conversational-ai-server:latest` | Docker image for agent pods |
| `AGENTS_DIR` | No | `./agents` | Directory containing agent definitions |

---

## Public URLs

URLs exposed to clients and frontend applications.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PUBLIC_API_URL` | No | `http://localhost:3000` | Public URL for the backend API |
| `VITE_API_URL` | No | `http://localhost:3000` | API URL for Vite frontend build |
| `VITE_LIVEKIT_URL` | No | `ws://localhost:7880` | LiveKit URL for Vite frontend build |

---

## Storage

File storage and temporary directory configuration.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STELLA_AI_TEMP_DIR` | No | `/tmp` | Temporary directory for build artifacts, logs, and Docker image exports |

**Use Cases:**

- Docker build logs
- K3s image import/export (can be several GB)
- Temporary K8s manifests
- PID files for daemon mode

For production with limited root filesystem space:

```bash
STELLA_AI_TEMP_DIR=/mnt/stella-ai-temp
```

---

## Agent SDK (Pod-Level)

These environment variables are read by the STELLA Agent SDK inside each agent pod. They control audio pipeline behavior, turn management, and TTS. For how the audio pipeline actually works and why the timing constants are what they are, see [TTS & Audio Pipeline](./tts-pipeline.md). Agents declare them in their `agent.yaml` manifest under `x-stella-optional-env-vars` so the frontend deploy modal can expose them.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TTS_ENABLED` | No | `true` | Enable text-to-speech audio output. Set to `false` for text-only mode (skips TTS connection entirely) |
| `INTERRUPT_MODE` | No | `none` | Transcript interrupt behavior. `none` = strict turn-based gating (user speech suppressed while agent processes/narrates). `smart` = reserved for future barge-in with re-prompting |
| `TRANSCRIPT_DEBOUNCE_MS` | No | `300` | Debounce window in milliseconds for aggregating rapid successive final transcripts. Set to `0` to disable debouncing |
| `DISABLE_AEC` | No | `false` | Disable Acoustic Echo Cancellation (AEC) for debugging audio feedback issues |
| `STT_WARMUP_ENABLED` | No | `true` | Warm up the STT model on agent start and when participants join. Set to `false` to skip warmup |
| `STELLA_TTS_PREROLL_MS` | No | `800` | Jitter buffer (ms) held before the first frame of an utterance plays. Calibrated to the reference deployment's hardware, not a universal constant — faster GPUs should lower it. See [tuning guidance](./tts-pipeline.md#tuning-the-pre-roll-for-your-hardware) |
| `TTS_PROGRESS_TICK_MS` | No | `200` | How often a teleprompter progress envelope is emitted during playback |
| `TTS_VOICE` | No | provider default | Seed TTS voice, overridable per stream. Honored by voice-selecting providers, ignored by others |
| `TTS_LANGUAGE` | No | detected | Seed language for TTS (ISO 639-1). Empty = follow the per-turn detected language |
| `STELLA_TELEPROMPTER_ENABLED` | No | on | Stream the reply dimmed and light each word as it is spoken. Set `false` to disable |

### Turn Management

When `TTS_ENABLED=true` (the default), the SDK enforces strict turn-based flow:

```
User speaks → Final transcript → Gate CLOSES → Agent processes → TTS narrates → Gate OPENS
```

While the gate is closed:
- **No partials** published to LiveKit (user speech invisible in frontend)
- **No finals** queued for the agent (prevents stale/fragmented input)
- **No barge-in** callbacks fired (when `INTERRUPT_MODE=none`)
- **STT stream stays alive** (no reconnection cost when gate re-opens)

When `TTS_ENABLED=false`, the gate still discards finals during processing but allows partials through to LiveKit (lighter turn management since processing completes quickly without narration).

### Manifest Declaration

Agents declare these in `agent.yaml` so the frontend deploy modal can display them:

```yaml
configSchema:
  # ...
  x-stella-optional-env-vars:
    - name: TTS_ENABLED
      description: "Enable text-to-speech audio output. Set to 'false' for text-only mode."
      default: "true"
    - name: INTERRUPT_MODE
      description: "Transcript interrupt behavior: 'none' (turn-based gating) or 'smart' (barge-in)"
      default: "none"
    - name: TRANSCRIPT_DEBOUNCE_MS
      description: "Debounce window (ms) for aggregating rapid successive final transcripts."
      default: "300"
```

---

## Agent Environment Variable Injection

STELLA provides a secure mechanism for injecting environment variables into agent pods. This allows users to configure API keys and secrets without exposing them in code.

### Flow Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Frontend UI   │    │  STELLA Backend  │    │  Kubernetes     │
│                 │    │                  │    │                 │
│  Create Env     │───▶│  Encrypt with    │───▶│  Store as       │
│  Template       │    │  AES-256-GCM     │    │  K8s Secret     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                       │
                                                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Agent Pod     │◀───│  Mount Secret    │◀───│  Pod Creation   │
│                 │    │  as Env Vars     │    │                 │
│  Access via     │    │                  │    │  Session Start  │
│  os.environ     │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### How It Works

1. **Template Creation**: Users create environment variable templates in the Frontend UI
2. **Encrypted Storage**: Variables are encrypted with AES-256-GCM using `ENV_VAR_ENCRYPTION_KEY`
3. **Pod Creation**: When a session starts, the backend creates a Kubernetes Secret
4. **Secret Mounting**: The secret is mounted into the agent pod as environment variables
5. **Agent Access**: Agents access variables via `os.environ` in Python

### Required Agent Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | **Yes** | OpenAI API key for conversation |
| `ELEVENLABS_API_KEY` | No | ElevenLabs API key (if using ElevenLabs TTS) |

### SDK Usage

Agents using the STELLA SDK can access environment variables through the standard Python `os.environ`:

```python
import os
from stella_agent import run_agent_from_env

# Access environment variables
openai_key = os.environ.get("OPENAI_API_KEY")
elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY")

# Or use the SDK helper that configures everything
run_agent_from_env()
```

### Security Features

- **AES-256-GCM encryption**: All sensitive variables encrypted at rest
- **Per-session secrets**: Each session gets its own Kubernetes Secret
- **Automatic cleanup**: Secrets are deleted when the session ends
- **Namespace isolation**: Agent pods run in isolated namespace
- **No plaintext storage**: Variables never stored in plaintext in database

---

## Example Configurations

### Development Environment

Minimal configuration for local development:

```bash
# .env (Development)
NODE_ENV=local

# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/stella?schema=public"

# LiveKit (local)
LIVEKIT_URL=ws://localhost:7880
PUBLIC_LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret

# AI
OPENAI_API_KEY=sk-your-openai-key

# Security (can be simple for local dev)
JWT_SECRET=local-dev-secret-change-in-production
```

### Production Environment

Full configuration for production deployment:

```bash
# .env (Production)
NODE_ENV=production
PRODUCTION_DOMAIN=stella.yourdomain.com

# Database
POSTGRES_DB=stella
POSTGRES_USER=stella_user
POSTGRES_PASSWORD=<strong-password>
DATABASE_URL="postgresql://stella_user:<strong-password>@postgres:5432/stella?schema=public"

# Security
JWT_SECRET=<64+-character-secret>
ENV_VAR_ENCRYPTION_KEY=<output-of-openssl-rand-hex-32>

# LiveKit (production with TLS)
LIVEKIT_URL=ws://host.minikube.internal:7880
PUBLIC_LIVEKIT_URL=wss://livekit.stella.yourdomain.com
LIVEKIT_API_KEY=<your-livekit-key>
LIVEKIT_API_SECRET=<your-livekit-secret>
LIVEKIT_TURN_ENABLED=true
LIVEKIT_TURN_DOMAIN=turn.stella.yourdomain.com

# AI
OPENAI_API_KEY=sk-proj-xxxxx

# GPU (if available)
ENABLE_GPU=true
STT_PROVIDER=whisper
WHISPER_MODEL=large-v3
WHISPER_DEVICE=cuda
TTS_PROVIDER=kokoro

# Kubernetes
KUBERNETES_NAMESPACE=ai-agents
CUSTOM_DNS_SERVERS="8.8.8.8 8.8.4.4"

# Storage
STELLA_AI_TEMP_DIR=/mnt/stella-ai-temp
```

---

## Security Considerations

1. **Never commit `.env` files** - The `.env` file is gitignored by default
2. **Use strong secrets** - Generate cryptographic secrets with `openssl rand`
3. **Rotate keys periodically** - Especially `JWT_SECRET` and `ENV_VAR_ENCRYPTION_KEY`
4. **Use secrets managers** - In production, consider HashiCorp Vault or cloud-native solutions
5. **Limit API key scope** - Use API keys with minimal required permissions
6. **Separate keys per environment** - Use different API keys for development and production
