---
sidebar_position: 9
title: "🔌 Connectors"
---

# 🔌 Connectors

Connectors let an agent call **outside MCP servers**, such as an interview-question service, a knowledge base, or a study's own API, without the agent ever seeing the server's credential.

Each STELLA user stores their own connectors in **Settings → Connectors** (a URL plus a bearer token) and can **share** a connector with projects they belong to. When anyone deploys an agent, they can bind their own connectors and those shared with the session's project. The agent then reaches them through the SDK as `self.connectors`. Every call goes through the STELLA backend, which is the MCP client: it decrypts the token and talks to the server, and the agent pod only ever holds its own per-deployment pass.

```
agent pod ──gRPC ConnectorService──▶ STELLA backend ──MCP (Streamable HTTP, Bearer)──▶ outside server
          (handle, tool, args)        (decrypts token,                    
                                       checks binding, audits)
```

:::info Not the same as MCP access
**Settings → MCP access** is the opposite direction: STELLA acting as an MCP *server* for Claude, ChatGPT and other AI apps. Connectors are STELLA acting as an MCP *client*.
:::

## Declaring connectors in `agent.yaml`

An agent that needs a connector declares a **slot** for it in the top-level `connectors:` list of `agent.yaml`. The deploy wizard's **Connectors** step shows one list of the user's connectors and those shared with the project, to tick, and STELLA fills the agent's slots from the ticked ones (see [How ticked connectors fill the slots](#how-ticked-connectors-fill-the-slots)):

```yaml
connectors:
  - slot: interview          # the handle the agent calls it by
    kind: mcp                # only "mcp" for now
    required: true           # deploy is refused without it
    label: ELIAS interview server
    description: Supplies the interview guide and records answers.
    requiredTools:           # checked against the connector's last test
      - get_interview_guide
      - start_interview
      - record_interview_message
      - end_interview
```

| Field | Required | Meaning |
|-------|----------|---------|
| `slot` | yes | Lowercase letters, digits and hyphens (max 40), unique within the agent. The bound connector's handle is the slot name, so the agent calls `call_tool("interview", ...)` whichever connector the user picked. |
| `kind` | yes | `mcp`. |
| `required` | no (default `false`) | A deployment without this slot bound is refused. |
| `label` | yes | What the deploy wizard shows. |
| `description` | no | Help text for the wizard. |
| `requiredTools` | no | Tools the connector must offer. Checked against the tool list from the user's last *Test connection*. |

### How ticked connectors fill the slots

The user ticks connectors in one list; the wizard does not ask slot by slot. Above the list, a line per slot says what the agent needs and which ticked connector fills it. STELLA assigns them like this:

1. Connectors whose last test shows every `requiredTools` entry are matched first. As many slots as possible get such a connector: a connector that fits two slots goes to the one no other ticked connector fits. Otherwise candidates are tried in the order they were ticked.
2. A slot still empty then takes a ticked connector that was never tested, so its tools are unknown.
3. One connector never fills two slots.

**Continue** stays off while a required slot is empty. A slot is preselected when exactly one of the user's connectors covers it.

Every other ticked connector is bound as an **extra connector** the agent did not declare. These show up in `self.connectors.list()` with `slot=None`, under the connector's own handle, so a general-purpose agent can discover and use whatever it is given.

## Managing connectors in Settings

**Settings → Connectors** shows the user's connectors, and those shared with their projects, as a grid of cards. Each connector has:

- **An emoji and a description** (up to 32 and 500 characters), shown on its card and in the deploy wizard. An empty description clears it.
- **A detail page** (click the card) with:
  - **Tools**: what the server offered at the last *Test connection*, with each tool's parameters read from its input schema.
  - **Try it**: a form per tool that calls it for real, with the owner's token, and shows the result. A tool that writes data writes it. Every call is recorded in the audit log like an agent's call. Only the connector's owner can use it.
  - **Connection**: the URL, authentication and last test.
  - **Sharing**: the projects it is shared with.
  - **Recent calls**: the last calls through the connector, with the agent that made them (or "A deleted agent"). Arguments are never shown. On a connector shared with a project, the owner sees the names of other users' agents that called it, just as those calls are in the audit.

A new connector is tested as soon as it is saved.

## Using connectors from an agent

```python
import logging

from stella_agent_sdk import BaseAgent, ConnectorError

logger = logging.getLogger(__name__)

class InterviewAgent(BaseAgent):
    async def on_session_start(self, session_id, config):
        await super().on_session_start(session_id, config)
        for c in await self.connectors.list():
            logger.info("connector %s (%s): %s", c.handle, c.slot, [t.name for t in c.tools])

        self.guide = await self.connectors.call_tool(
            "interview", "get_interview_guide", {"project_id": config["project_id"]}
        )

    async def record(self, interview_id, text):
        try:
            await self.connectors.call_tool(
                "interview", "record_interview_message",
                {"interview_id": interview_id, "role": "user", "content": text},
            )
        except ConnectorError as e:
            if e.retryable:
                ...  # queue and try again later
            else:
                logger.error("could not record answer: %s", e)
```

### `await self.connectors.list()`

Returns a list of `ConnectorInfo(handle, name, slot, status, tools)` for the connectors bound to this deployment. `tools` comes from the user's last *Test connection* (`ConnectorTool(name, description, input_schema)`). It may be empty for a connector that was never tested. On a deployment without connectors, `list()` returns `[]`.

### `await self.connectors.list_tools(handle)`

Asks the server for its current tools (MCP `tools/list`).

### `await self.connectors.call_tool(handle, tool, args)`

Calls one tool (MCP `tools/call`) and returns its result:

- the tool's **`structuredContent`** when the server sends it;
- otherwise its **text content**, parsed as JSON when it is JSON, else the plain string;
- for non-text content (images, resources), the raw list of MCP content blocks.

`args` must be a JSON-serialisable dict.

### `ConnectorError`

Every failure raises `ConnectorError` with `code`, `message`, `retryable`, `handle`, `tool` and, for tool errors, the tool's `content`.

| `code` | Meaning | `retryable` |
|--------|---------|-------------|
| `tool_error` | The tool ran and reported a failure (MCP `isError`); `message` is the tool's text. | no |
| `timeout` | The server did not answer in time (60 s for a tool call). | yes |
| `unreachable` | The server or the STELLA backend could not be reached, or answered 5xx/429. | yes |
| `unauthorized` | The server refused the stored credential. The user must update the token in Settings. | no |
| `not_bound` | No connector with this handle is bound to the deployment, or since the deploy it was deleted or unshared from the project. | no |
| `not_configured` | This deployment has no connectors at all. | no |
| `tool_not_found` / `invalid_arguments` | Wrong tool name or arguments. | no |
| `redirect` | The server answered with a redirect, which STELLA does not follow (it would drop the token). Fix the URL. | no |
| `blocked_host` | The URL points at a private or cluster-internal address. | no |
| `unauthenticated`, `protocol`, `internal` | Something is wrong with the deployment or the server's MCP implementation. | `internal` only |

The SDK never retries by itself, because a tool call can have side effects (starting an interview twice is worse than failing once). Use `retryable` to decide.

## Security model

- **The token never reaches the agent pod.** It is stored encrypted (AES-256-GCM, `ENV_VAR_ENCRYPTION_KEY`) and decrypted only inside the backend's MCP client. The REST API never returns it after it is saved.
- **An agent can only call connectors bound to its own deployment.** Each pod gets a fresh random `STELLA_CONNECTOR_TOKEN` when it is created, restarted or woken from auto-pause. The backend stores only its hash, and the SDK sends it as `x-stella-connector-token` gRPC metadata. The token stops working when the agent stops, is paused or its session closes, so a token copied out of a pod doesn't outlive it.
- **Only connectors the deployer may use can be bound:** their own, or ones shared with the session's project. Bindings (`AgentInstance.connectorBindings`) are checked at deploy time and kept across restart and auto-pause/wake.
- **Sharing is re-checked on every call.** When the owner unshares a connector from a project, or deletes it, agents in that project get `not_bound` on their next call, not at their next deploy. Members never see the token and cannot edit, test or rotate a shared connector; only the owner can. Audit rows name the owner, whose credential was used, along with the agent and session.
- **Private addresses are refused.** Connector URLs that resolve to loopback, private, link-local, CGNAT, multicast or cluster-internal addresses are rejected, in every IPv6 spelling (IPv4-mapped, NAT64, 6to4) too, so a connector cannot be used to reach STELLA's internal services. The address is checked again inside each connection's own DNS lookup, so a host that answers publicly at first and privately later is still refused. For local development, set `CONNECTORS_ALLOW_PRIVATE_HOSTS=true` on the backend.
- **Every call is audited** in `ConnectorAuditLog`: connector, agent, session, tool, redacted argument summary, outcome and duration. Rows are kept for 90 days.

## URLs

STELLA normalises connector URLs on save: it drops the trailing slash, collapses `//` in the path and removes fragments. Behind nginx, `https://host/mcp/` often 307-redirects to `http://`, and the redirected request loses the `Authorization` header, so a correct token looks wrong. Use the exact MCP endpoint, for example `https://elias.apps.c4dhi.org/mcp`.

Connectors speak MCP's **Streamable HTTP** transport. Servers that reply with plain JSON and do not use `Mcp-Session-Id` work as well.

## Backend settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `CONNECTORS_CONNECT_TIMEOUT_MS` | `10000` | MCP `initialize` |
| `CONNECTORS_LIST_TIMEOUT_MS` | `15000` | `tools/list` |
| `CONNECTORS_CALL_TIMEOUT_MS` | `60000` | `tools/call` |
| `CONNECTORS_ALLOW_PRIVATE_HOSTS` | `false` | Allow localhost/private URLs (development only) |

On the agent side, the SDK reads `AGENT_ID`, `STELLA_CONNECTOR_TOKEN` and the backend's gRPC address from `CONNECTORS_ADDRESS`, falling back to `STATE_MACHINE_ADDRESS`, then `GRPC_SERVER`. STELLA sets all of these for you.
