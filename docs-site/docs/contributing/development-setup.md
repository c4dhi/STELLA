---
sidebar_position: 2
title: Development Setup
description: Set up your local development environment
---

# Development Setup

This guide walks through setting up a complete development environment for STELLA.

## Prerequisites

### Required Software

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | 18+ | Backend and frontend |
| Python | 3.11+ | Agent development |
| Docker | 24+ | Containerization |
| kubectl | 1.28+ | Kubernetes management |
| Git | 2.40+ | Version control |

### Installation

**macOS (using Homebrew):**

```bash
# Install Node.js
brew install node@18

# Install Python
brew install python@3.11

# Install Docker Desktop (includes kubectl)
brew install --cask docker

# Install kubectl (if not using Docker Desktop)
brew install kubectl

# Install Git
brew install git
```

**Linux (Ubuntu/Debian):**

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Python
sudo apt-get install -y python3.11 python3.11-venv python3-pip

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl
sudo mv kubectl /usr/local/bin/
```

## Clone the Repository

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/STELLA.git
cd STELLA

# Add upstream remote
git remote add upstream https://github.com/c4dhi/STELLA.git

# Verify remotes
git remote -v
```

## Backend Setup (NestJS)

```bash
# Navigate to root (backend is at root level)
cd STELLA

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your credentials
# Required: OPENAI_API_KEY, LIVEKIT_* credentials

# Generate Prisma client
npx prisma generate

# Start development server
npm run start:dev
```

The backend runs at http://localhost:3000.

## Frontend Setup (React)

```bash
# Navigate to frontend
cd frontend-ui

# Install dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Start development server
npm run dev
```

The frontend runs at http://localhost:5173.

## Agent Setup (Python)

```bash
# Navigate to an agent directory (stella-v2-agent or stella-light-agent)
cd agents/stella-v2-agent

# Create virtual environment
python3.11 -m venv venv
source venv/bin/activate  # Linux/macOS
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt

# Install development dependencies
pip install -r requirements-dev.txt

# Copy environment file
cp .env.example .env

# Run agent locally (for testing)
python -m src.agent
```

## Database Setup

STELLA uses PostgreSQL with Prisma ORM. See [Database Schema](../architecture/database.md) for the complete data model.

### Using Docker (Recommended)

```bash
# Start PostgreSQL with Docker
docker run -d \
  --name stella-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=stella \
  -p 5432:5432 \
  postgres:15

# Run migrations
npx prisma migrate dev
```

### Using Local PostgreSQL

```bash
# Create database
createdb stella

# Update DATABASE_URL in .env
# DATABASE_URL=postgresql://user:password@localhost:5432/stella

# Run migrations
npx prisma migrate dev
```

## Kubernetes Setup (Local)

### Docker Desktop

1. Open Docker Desktop settings
2. Enable Kubernetes
3. Wait for Kubernetes to start (green indicator)

### Minikube (Alternative)

```bash
# Install minikube
brew install minikube  # macOS
# or: curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64

# Start cluster
minikube start --cpus=4 --memory=8g

# Enable ingress
minikube addons enable ingress
```

### Verify Setup

```bash
# Check kubectl is working
kubectl cluster-info

# Check nodes
kubectl get nodes
```

## Running the Full Stack

### Option 1: Kubernetes (Production-like)

```bash
# Deploy everything
./scripts/start-k8s.sh

# Watch pods start
kubectl get pods -n ai-agents -w

# View logs
kubectl logs -f -n ai-agents -l app=session-management-server
```

### Option 2: Local Development

Run each component separately for faster iteration:

```bash
# Terminal 1: PostgreSQL
docker start stella-postgres

# Terminal 2: Backend
npm run start:dev

# Terminal 3: Frontend
cd frontend-ui && npm run dev

# Terminal 4: Agent (when testing)
cd agents/stella-v2-agent
source venv/bin/activate
python -m stella_v2_agent
```

## IDE Setup

### VS Code (Recommended)

Install recommended extensions:

```bash
# Install extensions
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension prisma.prisma
code --install-extension ms-python.python
code --install-extension bradlc.vscode-tailwindcss
```

Workspace settings (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[python]": {
    "editor.defaultFormatter": "ms-python.black-formatter"
  },
  "python.linting.enabled": true,
  "python.linting.pylintEnabled": true
}
```

### PyCharm

1. Open the agent directory you're working in, e.g. `agents/stella-v2-agent`
2. Configure Python interpreter (point to venv)
3. Install Python Requirements plugin
4. Enable Black formatter

## Troubleshooting

### Node modules issues

```bash
# Clear and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Prisma issues

```bash
# Regenerate client
npx prisma generate

# Reset database
npx prisma migrate reset
```

### Kubernetes issues

```bash
# Check pod status
kubectl get pods -n ai-agents

# View pod logs
kubectl logs -n ai-agents <pod-name>

# Describe pod for events
kubectl describe pod -n ai-agents <pod-name>
```

### Port conflicts

```bash
# Find process using port
lsof -i :3000

# Kill process
kill -9 <PID>
```

## Next Steps

- [Coding Standards](./coding-standards/index.md) - Code style guide
- [Pull Request Process](./pull-request-process.md) - PR workflow
- [Database Schema](../architecture/database.md) - Data model reference
