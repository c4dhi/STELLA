---
sidebar_position: 2
title: "🏭 Production Deployment"
---

# Production Deployment Guide

This guide walks you through deploying STELLA on a production server with GPU support, Kubernetes (K3s), and LiveKit for real-time voice interactions.

:::warning
STELLA uses Caddy as its sole reverse proxy. Do **not** install nginx. All TLS termination and routing is handled by Caddy via the [STELLA_livekit](https://github.com/c4dhi/STELLA_livekit) repository.
:::

:::caution Known limitation: slow first utterance after 5 minutes of quiet
The first utterance of a session that starts after more than 5 minutes without any session can be delayed by up to about 30 s while speech recognition warms up, and sessions already running stall for the same time ([#561](https://github.com/c4dhi/STELLA/issues/561)). How many simultaneous sessions a server can carry hasn't been measured yet ([#559](https://github.com/c4dhi/STELLA/issues/559)).
:::

## Prerequisites

- A Linux server (Ubuntu 24.04 recommended) with a supported NVIDIA GPU (L4 or T4)
- NVIDIA drivers and CUDA toolkit installed
- A domain name with DNS access
- At least 100GB root disk + an external volume (400GB+ recommended)

## 1. External Volume Setup

The root disk is typically too small for container images and Kubernetes data. Mount an external volume first:

```bash
# Format the volume (only if fresh — this erases data)
sudo mkfs.ext4 /dev/sdb

# Mount it
sudo mkdir -p /mnt/data
sudo mount /dev/sdb /mnt/data

# Persist across reboots
echo '/dev/sdb /mnt/data ext4 defaults 0 2' | sudo tee -a /etc/fstab

# Verify
df -h /mnt/data
```

Create directories for Docker and Kubernetes:

```bash
sudo mkdir -p /mnt/data/docker /mnt/data/kubelet /mnt/data/containerd
```

## 2. Docker Installation

Configure Docker to use the external volume **before** installation:

```bash
sudo mkdir -p /etc/docker
cat <<EOF | sudo tee /etc/docker/daemon.json
{
  "data-root": "/mnt/data/docker"
}
EOF
```

Install Docker:

```bash
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sh /tmp/get-docker.sh
sudo systemctl enable docker
```

## 3. Kubernetes (K3s) Installation

Install K3s with the kubelet data directory pointed at the external volume:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--kubelet-arg=root-dir=/mnt/data/kubelet" sh -
```

Verify:

```bash
kubectl get nodes
```

## 4. GPU Verification

Confirm the GPU is detected and drivers are working:

```bash
nvidia-smi
```

This should display the GPU model, VRAM, driver version, and CUDA version.

## 5. LiveKit & Caddy Deployment

STELLA uses [STELLA_livekit](https://github.com/c4dhi/STELLA_livekit) to manage its LiveKit server, Caddy reverse proxy, and Redis. Caddy is the **only** reverse proxy — do not install nginx or any other web server.

### 5.1 Clone the Repository

```bash
cd ~
git clone https://github.com/c4dhi/STELLA_livekit.git
cd STELLA_livekit
```

### 5.2 Configuration

The repository contains the following configuration files that need to be customized for your deployment:

**`caddy.yaml`** — Caddy reverse proxy configuration. Update all domain references to match your domain. Caddy handles automatic TLS certificate provisioning via Let's Encrypt and routes traffic to STELLA services using Layer 4 SNI-based routing on port 443.

The Caddy config should include routes for:

| Subdomain | Proxies To | Service |
|-----------|------------|---------|
| `frontend.yourdomain.com` | `localhost:8080` | STELLA Web UI |
| `backend.yourdomain.com` | `localhost:3000` | STELLA API |
| `livekit.yourdomain.com` | `localhost:7880` | LiveKit Server |
| `livekit-v1.yourdomain.com` | `localhost:7880` | LiveKit Server (alt) |
| `livekit-turn.yourdomain.com` | `localhost:5349` | TURN Server |

:::danger Security
Do **not** add a database route to Caddy. PostgreSQL must never be exposed publicly. Access the database only via SSH tunnel or `kubectl port-forward`.
:::

**`livekit.yaml`** — LiveKit server configuration. Update the TURN domain and generate new API keys:

```bash
# Generate new API keys
docker run --rm livekit/generate
```

:::warning
Generate unique API keys for production. Never reuse development keys.
:::

**`redis.conf`** — Redis configuration. The default binds to localhost only, which is correct for production.

### 5.3 Start the Stack

```bash
cd ~/STELLA_livekit
docker compose -p livekit-prod up -d
```

Verify all three containers are running:

```bash
docker ps
```

You should see exactly three containers: Caddy, LiveKit, and Redis. All use `network_mode: host`, meaning they share the host's network namespace directly.

:::tip
Always use the `-p` (project name) flag with docker compose to avoid conflicts between environments. Use `livekit-prod` for production and `livekit-dev` for development.
:::

## 6. DNS Configuration

Create A records pointing to your server's public IP:

| Record | Type | Value |
|--------|------|-------|
| `frontend.yourdomain.com` | A | `<your-public-ip>` |
| `backend.yourdomain.com` | A | `<your-public-ip>` |
| `livekit.yourdomain.com` | A | `<your-public-ip>` |
| `livekit-v1.yourdomain.com` | A | `<your-public-ip>` |
| `livekit-turn.yourdomain.com` | A | `<your-public-ip>` |

Caddy will automatically obtain TLS certificates once DNS propagates and ports 80/443 are reachable.

## 7. Firewall / Security Group Rules

Open the following inbound ports:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (ACME/Let's Encrypt certificate challenges) |
| 443 | TCP | HTTPS (all web traffic + WebSocket) |
| 7881 | TCP | LiveKit WebRTC signaling |
| 3478 | UDP | TURN NAT traversal |
| 50000-60000 | UDP | WebRTC media streams |

## 8. STELLA Application Deployment

Once the infrastructure is running, deploy the STELLA application to K3s.

### 8.1 Clone and Configure

```bash
git clone <your-repo-url> ~/stella_backend
cd ~/stella_backend
```

### 8.2 Run the Setup Wizard

The setup wizard configures all required environment variables (database credentials, LiveKit keys, API keys, GPU settings, etc.):

```bash
./scripts/start-k8s.sh --setup --production
```

### 8.3 Deploy

```bash
./scripts/start-k8s.sh --production
```

This will:
1. Build all Docker images (backend, frontend, STT, TTS, agents)
2. Import images into K3s containerd
3. Apply Kubernetes manifests to the `ai-agents` namespace
4. Wait for all pods to become ready

### 8.4 Useful Commands

```bash
# List all pods
kubectl get pods -n ai-agents

# Stream pod logs
kubectl logs -f <pod-name> -n ai-agents

# Pod details and events
kubectl describe pod <pod-name> -n ai-agents

# Restart a deployment
kubectl rollout restart deployment/<name> -n ai-agents

# Check service endpoints
kubectl get svc -n ai-agents
```

## 9. Security Checklist

- [ ] **No nginx installed** — Caddy is the only reverse proxy
- [ ] PostgreSQL is **not** exposed via Caddy or any public route
- [ ] Database access is only available via SSH tunnel or `kubectl port-forward`
- [ ] Unique LiveKit API keys generated for production
- [ ] SSH access restricted to known IPs (if possible)
- [ ] TLS 1.2+ only (Caddy enforces this by default)
- [ ] No unnecessary Docker containers running (`docker ps` shows only expected services)
- [ ] Docker data stored on external volume, not root disk
- [ ] Only one docker compose project running per server (no duplicate deployments)

## 10. Troubleshooting

### Containers won't start (port conflict)

Check what's already using a port:

```bash
sudo ss -tlnp | grep :<port>
```

If an old deployment is running, stop it before starting the new one. Always use explicit project names with docker compose (`-p` flag) to avoid conflicts between environments.

### Multiple deployments fighting over ports

If you see duplicate containers (e.g., two Caddy or two Redis instances), you likely have more than one docker compose project running. Stop all livekit-related containers and start fresh:

```bash
docker stop $(docker ps -q --filter "name=livekit")
docker rm $(docker ps -aq --filter "name=livekit")
cd ~/STELLA_livekit
docker compose -p livekit-prod up -d
```

### Ghost containers that won't delete

If `docker rm` fails with "No such container":

```bash
sudo systemctl stop docker.socket docker
sudo find /var/lib/docker/containers -name "<container-id>*" -exec rm -rf {} +
sudo systemctl start docker
```

### Agent pods fail with "sudo: not found"

The K3s binary and containerd socket must be mounted into the session-management-server pod. This is handled automatically by the K8s manifests. If you see this error, redeploy:

```bash
./scripts/start-k8s.sh --production --rebuild
```

### Redis or LiveKit restart-looping

Usually a port conflict. With `network_mode: host`, all containers share the host's ports. Ensure only one instance of each service is running:

```bash
docker ps | grep -E "redis|livekit"
```

### TLS certificates not provisioning

Caddy needs ports 80 and 443 reachable from the internet, and DNS records must resolve to your server's public IP. Verify:

```bash
# Check Caddy logs for ACME errors
docker logs livekit-prod-caddy-1

# Verify DNS resolution
dig frontend.yourdomain.com
```

### GPU not detected

Verify the NVIDIA drivers and container toolkit are installed:

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

### STT service shows "unknown" status

The Whisper large-v3 model (~3GB) takes a few minutes to load into GPU memory on first startup. Check the logs:

```bash
kubectl logs -n ai-agents -l app=stt-service --tail=20
```

Wait for the `Model loaded successfully` message before expecting the service to respond.

### PVC resize errors

If you see `persistentvolumeclaims is forbidden: only dynamically provisioned pvc can be resized`, the PVC was created with a different storage size. Either match the manifest to the existing size, or delete and recreate:

```bash
kubectl delete pvc <pvc-name> -n ai-agents
./scripts/start-k8s.sh --production
```

Note: Deleting a model PVC will trigger a re-download of the models on next startup.

### Checking which process owns a port

If something unexpected is running on a port, check if it's a host process or a container:

```bash
# Find the PID
sudo ss -tlnp | grep :<port>

# Check if it's a container process
cat /proc/<PID>/cgroup
```

If the cgroup output contains a Docker container ID, the process is running inside a container, even though it appears as a host process (this is expected with `network_mode: host`).

## See Also

- [Kubernetes Architecture](./kubernetes.md)
- [Production Checklist](./production-checklist.md)
- [LiveKit Production](../integration/livekit-production.md)
- [Monitoring](./monitoring.md)
