---
sidebar_position: 1
title: "MCP: connect an AI assistant"
sidebar_label: "Connect an AI assistant"
---

# MCP: connect an AI assistant

Since 1.5.0, Stella has an [MCP](https://modelcontextprotocol.io/) server. An AI assistant such as Claude, ChatGPT or Claude Code can connect to your Stella account. It can then build personas, plan templates and agent configurations, set up and run sessions, and read transcripts, in the same projects you can reach yourself.

## Switch it on

MCP is **off** after installing or upgrading. While it is off, `/mcp` and its sign-in pages answer 404 and no token works.

A system admin switches it on for the whole platform in **Settings → Platform Defaults**. Switching it off again stops every connection and token immediately.

## Connect

Every user finds their connector address and step-by-step instructions in **Settings → MCP Access**. The address is the backend's public URL followed by `/mcp`, for example `https://backend.stella.example.org/mcp`.

Claude and ChatGPT reach Stella from their own servers, so the address must be public HTTPS. It is built from `PUBLIC_API_URL`, and the sign-in page from `PUBLIC_FRONTEND_URL`, so both must be the addresses the outside world reaches. Claude Code running on the same machine can also use a local address.

### Sign in with Stella (Claude, ChatGPT, Claude Code)

1. Add Stella as a custom connector in the app, with the connector address as its URL. In Claude this is **Settings → Connectors → Add custom connector**. ChatGPT needs **Developer mode** under Apps & Connectors, with OAuth as the authentication. In Claude Code, run `claude mcp add --transport http stella <connector address>`, then `/mcp` → **stella** → **Authenticate**.
2. A Stella page opens. Sign in and allow **read** or **read/write** access.
3. The app now has its own tokens. It appears under **Connected apps** in Settings → MCP Access, where you can disconnect it.

Access tokens last an hour and renew themselves. A connection that goes unused for 30 days ends, and the app has to sign in again. A replayed or stolen refresh token also ends the connection.

### Personal access tokens (scripts)

For scripts and tools that can't sign in, create a personal access token in Settings → MCP Access:

- read or read/write access;
- valid for 7, 30, 90 or 365 days;
- shown **once**, so copy it right away;
- revocable at any time.

Send it in the `Authorization` header only:

```bash
claude mcp add --transport http stella https://backend.stella.example.org/mcp \
  --header "Authorization: Bearer stella_pat_…"
```

A token sent in the address (`?token=`) is refused.

## Scopes: read and read/write

Every connection has one of two access levels, chosen when you sign in or create the token:

| Access | Scopes | What the assistant sees |
|---|---|---|
| Read | `mcp:read` | Only the read tools: lists, gets, transcripts, plan state, agent status and logs |
| Read/write | `mcp:read` + `mcp:write` | Also the tools that create, update, start, stop and close things |

A connection only gets the tools its scopes allow. A read-only connection that calls a write tool by name gets `403`.

Read/write covers starting and ending sessions, agents and invitation links, not only editing personas and plans.

Which tools need which scope:

| Scope | Tools |
|---|---|
| `mcp:read` (18) | `whoami`, `personas_list`, `personas_get`, `plan_templates_list`, `plan_templates_get`, `agent_types_list`, `agent_types_get`, `agent_configurations_list`, `agent_configurations_get`, `projects_list`, `sessions_list`, `sessions_get`, `session_transcript_get`, `session_state_get`, `session_invitations_list`, `env_var_templates_list`, `agents_get`, `agent_logs_get` |
| `mcp:write` (14) | `personas_create`, `personas_update`, `plan_templates_create`, `plan_templates_update`, `agent_configurations_create`, `agent_configurations_update`, `sessions_create`, `sessions_update`, `sessions_close`, `session_invitations_create`, `session_invitations_revoke`, `agents_deploy`, `agents_restart`, `agents_stop` |

## The tools

There are 32 tools. The [tool reference](./tools.md) lists each one with its inputs and what it returns. They all follow one shape, which the server also explains to the assistant when it connects:

- Ids are named after what they point to (`projectId`, `sessionId`, `agentId`, `invitationId`, `personaId`, `planId`, `agentConfigurationId`, `agentTypeId`, `envVarTemplateId`). The name is the same in every tool.
- `…_list` returns `{ items }` with a summary of each, and `…_get` returns one in full.
- `…_update` takes the id and only the fields to change.
- Every write returns the resulting object as the matching `…_get` shows it.
- A failed call returns `{ "error": { "status": …, "message": "…" } }`. `404` also means the user has no access to it.

A typical run looks like this:

1. `sessions_create`.
2. `agents_deploy` with a plan, persona and configuration.
3. `session_invitations_create`, then send its `joinUrl` to the participant.
4. Poll `agents_get` until the agent is `RUNNING`.
5. Afterwards, `session_transcript_get` to read the conversation.
6. `agents_stop` and `sessions_close`.

## Limits

- Nothing can be **deleted** over MCP. There are no delete tools.
- An assistant only reaches projects its user is a member of, and only personas, plans, configurations and env var templates its user owns. System-default personas can be read but not changed.
- **Closed sessions:** agents are refused in a session that is closing or closed. `agents_deploy` and `agents_restart` fail there, and a closed session can't be reopened over MCP.
- A session has at most one open invitation link. Revoke it before making a new one.
- **Secrets:** `env_var_templates_list` returns variable names, never their values. `agents_deploy` doesn't take raw configuration or env var values: it names a plan, persona, configuration and env var template instead. Agent output leaves out the deployment snapshot and Kubernetes names.
- `agents_stop` stops the agent and removes its pod; it doesn't delete the agent.

## Audit log

**Every** MCP call is recorded in the `McpAuditLog` table: reads and writes, successful or failed. A record holds:

- the user;
- the personal access token or signed-in app that made the call;
- the tool and a summary of its arguments, with secrets removed;
- whether it succeeded, and the error code if not;
- how long it took.

Records are deleted after 90 days.

## Known limitations

- After `agents_stop`, `agents_get` still shows the agent's last health as `ready` ([#807](https://github.com/c4dhi/STELLA/issues/807)).
- A session's `messageCount` counts every stored message, including analytics, not just what was said ([#808](https://github.com/c4dhi/STELLA/issues/808)).
