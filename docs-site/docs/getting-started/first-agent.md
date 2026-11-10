---
sidebar_position: 3
title: "🎯 First Agent"
---

import {EnvVarReference} from '@site/src/components';

# 🎯 Setting Up Your First Agent

This guide walks you through deploying your first conversational AI agent in STELLA.

## Prerequisites

Before deploying an agent, ensure:
- STELLA is running ](../scripts/start-k8s.sh`)
- You have an OpenAI API key
- You can access the Frontend UI at http://localhost:5173

## Step 1: Create an Environment Variable Template

Environment variable templates store API keys and configuration that agents need. Templates are encrypted and securely injected into agent pods as Kubernetes secrets.

1. Open the **Frontend UI** at http://localhost:5173
2. Go to **Settings** in the sidebar
3. Click **"New Template"** in the Environment Variables section
4. Add your `OPENAI_API_KEY` (required) and any optional keys (e.g., `ELEVENLABS_API_KEY`)
5. Give the template a name (e.g., "Production Keys") and save

<EnvVarReference
  category="agent-environment-variable-injection"
  text="Agent Environment Variables"
  description="Learn how environment variables are securely injected into agent pods and which variables are required."
/>

## Step 2: Deploy an Agent

1. Create or open a session from the **Sessions** page
2. Click **"Deploy Agent"** in the session view
3. Choose an agent. **Built-in** lists STELLA V2, STELLA Jev and the deprecated STELLA Light; **Custom** lists agents uploaded in Settings → Agent Library and shared with this project
4. Go through the steps the agent asks for. The wizard shows only what the agent's `agent.yaml` declares:
   - **Persona**, **plan** and **mode**, and a **Configurator configuration**, where the agent uses them
   - **Connectors**, for an agent that uses outside tools: tick the connectors to use, and a line above the list says what the agent still needs
   - **Voice & Language**, where the speech provider offers a choice
   - **Start From**: the agent's defaults or one of your environment variable templates. An agent with no saved templates skips this screen
   - **Agent Settings**: each setting the agent declares is one control (switch, slider, list, number or text), in tabs by topic, with anything else under **Custom**. The tabs open on **Keys**, and required keys such as `OPENAI_API_KEY` must be filled in before you can deploy. You can save what you set as a new template. **Back** keeps your changes unless you pick a different template
5. Click **Deploy**. A deploy that is missing something the agent requires is refused with a message that says what

The agent will start in a Kubernetes pod and automatically connect to the LiveKit room.

## Step 3: Interact with Your Agent

Once deployed, you can:

- **Voice**: Click the microphone button to speak with the agent
- **Text**: Type messages in the chat input
- **View transcripts**: See real-time transcription of the conversation

## Step 4: Monitor Your Agent

- View agent status in the session panel (Running, Starting, Stopped)
- **Speech recognition warming up.** After a quiet spell, speech recognition can need up to about 30 seconds to get ready when a session starts. The session view then shows an **STT warming up** chip with a timer and a line on the agent card, and the participant sees "Getting ready to listen…". After 30 seconds it says it is taking longer than usual; if warming up fails, the chip turns red and the participant is asked to tell the study team. Nothing shows when the model is already warm
- Click on the agent to see logs and metrics
- Stop the agent when done to free up resources

## Using the API

You can also deploy agents programmatically via the API:

### Create a Session

```bash
curl -X POST http://localhost:3000/projects/{projectId}/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Session"}'
```

### Start an Agent

```bash
curl -X POST http://localhost:3000/sessions/{sessionId}/agents \
  -H "Content-Type: application/json" \
  -d '{
    "role": "conversational-ai",
    "planId": "cognitive_stimulation_demo_sm"
  }'
```

### Get Agent Status

```bash
curl http://localhost:3000/agents/{agentId}
```

### View Agent Logs

```bash
curl http://localhost:3000/agents/{agentId}/logs
```

### Stop Agent

```bash
curl -X DELETE http://localhost:3000/agents/{agentId}
```

## Viewing Kubernetes Resources

```bash
# View agent pods
kubectl get pods -n ai-agents -l app=conversational-ai-agent

# View specific agent logs
kubectl logs -n ai-agents <agent-pod-name>

# Describe pod for detailed events
kubectl describe pod -n ai-agents <agent-pod-name>
```

## Troubleshooting

### Agent Won't Start

1. Check the agent image exists:
   ```bash
   docker images | grep stella
   ```

2. View pod events:
   ```bash
   kubectl describe pod <agent-pod-name> -n ai-agents
   ```

3. Check environment template has all required variables

### Agent Disconnects Immediately

1. Verify LiveKit connection:
   ```bash
   curl http://localhost:7880
   ```

2. Check agent logs for errors:
   ```bash
   kubectl logs <agent-pod-name> -n ai-agents
   ```

### No Audio from Agent

1. Ensure microphone permissions are granted in browser
2. Check TTS service is running:
   ```bash
   kubectl get pods -n ai-agents | grep tts
   ```

## Next Steps

- [Agents Overview](../agents/overview.md) - Learn about different agent types
- [Agent SDK](../agent-sdk/overview.md) - Build custom agents
- [Kubernetes Deployment](../deployment/kubernetes.md) - Production deployment
