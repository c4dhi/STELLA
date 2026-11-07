---
sidebar_position: 2
title: "🏁 Getting Started"
---

# 🏁 Getting Started with the Agent SDK

This page builds a small LLM agent, runs it against a local LiveKit, and packages it for STELLA.

## Prerequisites

- Python 3.10 or newer
- For running locally: a LiveKit server and STELLA's STT and TTS services (a local STELLA started with `./scripts/start-k8s.sh` has all three)
- An OpenAI API key, for this example's LLM

## Project layout

```
my-agent/
├── agent.py           # the agent
├── agent.yaml         # the manifest: what STELLA knows about the agent
├── requirements.txt
└── Dockerfile
```

## The agent

`agent.py`:

```python
import asyncio
import logging
import os
import uuid
from typing import Any, AsyncIterator, Dict, List

from openai import AsyncOpenAI

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent, run_agent_from_env

logging.basicConfig(level=logging.INFO)


class MyAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self.client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self.history: List[Dict[str, str]] = []

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)  # fills self.session
        self.model = self.session.config.get("model", "gpt-4o-mini")
        persona = self.persona
        self.system_prompt = (
            persona.system_prompt if persona and persona.system_prompt
            else "You are a helpful assistant. Keep answers short: they are spoken."
        )
        self.history = []

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        self.history.append({"role": "user", "content": input.text})
        yield AgentOutput.thinking(input.session_id)

        transcript_id = f"response_{uuid.uuid4().hex[:8]}"
        reply = ""
        stream = await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": self.system_prompt}, *self.history],
            stream=True,
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                reply += chunk.choices[0].delta.content
                # Each chunk carries the whole reply so far, not just the new token.
                yield AgentOutput.text_chunk(input.session_id, reply, transcript_id=transcript_id)

        yield AgentOutput.text_chunk(input.session_id, reply, transcript_id=transcript_id, is_final=True)
        self.history.append({"role": "assistant", "content": reply})

    async def on_interrupt(self, session_id: str) -> None:
        pass

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        await super().on_session_end(session_id)
        return {"turns": len(self.history) // 2}


if __name__ == "__main__":
    asyncio.run(run_agent_from_env(MyAgent()))
```

What happens here:

- `process()` is called once per user turn. It yields a status (`AgentOutput.thinking`), then the reply as it streams in.
- All chunks of one reply share a `transcript_id`, and each chunk's text is the **accumulated** reply so far. The SDK publishes it to the screen, splits it into sentences and speaks each sentence as soon as it is complete. Text under one `transcript_id` may only grow. `AgentOutput.text_final(session_id, text)` sends a reply in one piece instead.
- `on_session_start` calls `super()` so that `self.session` and `self.persona` are filled from `AGENT_CONFIG`. `self.session.config` holds the agent's own settings (its `defaultConfig` in `agent.yaml`).
- When the user interrupts and the interruption is committed, the SDK drops what was not yet spoken; a typed interruption also stops it reading from `process()` at the next `yield`. See [Base Agent](./base-agent.md#barge-in).

## The manifest

`agent.yaml` tells STELLA what the agent is and what it needs. A minimal one:

```yaml
version: "2.0"

metadata:
  name: "My Agent"
  slug: "my-agent"
  version: "0.1.0"
  description: "A small LLM agent"
  icon: "🤖"

capabilities: [voice, text]

env:
  required:
    - OPENAI_API_KEY

image:
  dockerfile: "Dockerfile"

sdk:
  minVersion: "0.10.0"
```

Every block and rule is on [The agent manifest](./agent-manifest.md).

## Dependencies and Dockerfile

`requirements.txt`:

```
stella-ai-agent-sdk>=0.10.0
openai>=1.0.0
```

`Dockerfile`:

```dockerfile
FROM python:3.11-slim

# livekit-rtc needs libgobject from libglib2.0
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV PYTHONUNBUFFERED=1
CMD ["python", "agent.py"]
```

## Run it locally

On an agent pod STELLA sets every variable `run_agent_from_env()` reads. By hand, these five are required:

```bash
export LIVEKIT_URL=ws://localhost:7880
export ROOM_NAME=my-room
export AGENT_IDENTITY=agent-my-agent
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=devsecret
export OPENAI_API_KEY=sk-...
python agent.py
```

`LIVEKIT_TOKEN` (a ready-made room token) replaces the key and secret. The optional ones, with their in-cluster defaults:

| Variable | Default | What it is |
|----------|---------|------------|
| `STT_SERVICE_ADDRESS` | `stt-service:50051` | STT gRPC service |
| `TTS_SERVICE_ADDRESS` | `tts-service:50052` | TTS gRPC service |
| `TTS_ENABLED` | `true` | `false` turns the agent into a text-only chatbot |
| `SESSION_SERVER_URL` | `http://session-management-server:3000` | Used for chat history |
| `GRPC_SERVER` | `session-management-server:50051` | Where the agent registers |
| `SESSION_ID` | `ROOM_NAME` | The session's database id |
| `AGENT_CONFIG` | `{}` | Session config JSON, typed as `self.session` |
| `AGENT_TYPE`, `AGENT_VERSION` | class name, `1.0.0` | What the agent registers as; STELLA sets them from `agent.yaml` |
| `AGENT_NAME`, `AGENT_ID`, `AGENT_ICON` | `Agent`, `AGENT_IDENTITY`, `🤖` | How the agent is shown on screen |

The voice pipeline's tuning variables belong to the SDK; see [Platform Contract](./platform-contract.md#environment-variables-the-sdk-owns).

Outside STELLA nothing registers the session, so registration logs a warning; the agent still runs. To talk to it, join the same room from a LiveKit client.

## Put it on STELLA

STELLA builds the image itself from the package's `Dockerfile`. Zip `agent.yaml`, the `Dockerfile` and your code, and upload the zip in **Settings → Agent Library**. The steps, review and sharing are in [Build your own agent](../guides/build-your-own-agent.md#upload-it-to-stella) and [Agent validation](../deployment/agent-validation.md).

## Next steps

- [Base Agent](./base-agent.md): every hook and helper
- [Message Types](./message-types.md): everything `process()` can yield
- [Tools](./tools.md): give your LLM tools
- [Platform Contract](./platform-contract.md): session config, plans, session end
