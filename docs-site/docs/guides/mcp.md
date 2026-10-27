---
sidebar_position: 5
title: "Connect an AI assistant (MCP)"
---

# Connect an AI assistant (MCP)

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

Sign-in tokens last an hour and renew themselves for up to 30 days of use. A replayed or stolen refresh token ends the connection.

### Personal access tokens (scripts)

For scripts and tools that can't sign in, create a personal access token in Settings → MCP Access:

- read or read/write access;
- valid for 7 to 365 days;
- shown **once**, so copy it right away;
- revocable at any time.

Send it in the `Authorization` header only:

```bash
claude mcp add --transport http stella https://backend.stella.example.org/mcp \
  --header "Authorization: Bearer stella_pat_…"
```

A token sent in the address (`?token=`) is refused.

## What an assistant can do

All 32 tools follow one shape, which the server explains to the assistant when it connects:

- Ids are named after what they point to, such as `personaId`, `planId` or `agentTypeId`.
- `…_list` returns short summaries, and `…_get` returns the full object.
- `…_update` takes the id and only the fields to change.
- Every change returns the resulting object.

| Area | Read | Read/write adds |
|---|---|---|
| Personas | `personas_list`, `personas_get` | `personas_create`, `personas_update` |
| Plan templates | `plan_templates_list`, `plan_templates_get` | `plan_templates_create`, `plan_templates_update` |
| Agent configurations | `agent_configurations_list`, `agent_configurations_get` | `agent_configurations_create`, `agent_configurations_update` |
| Agent types | `agent_types_list`, `agent_types_get` | |
| Projects and sessions | `projects_list`, `sessions_list`, `sessions_get`, `session_transcript_get`, `session_state_get` | `sessions_create`, `sessions_update`, `sessions_close` |
| Invitations | `session_invitations_list` | `session_invitations_create`, `session_invitations_revoke` |
| Agents | `agents_get`, `agent_logs_get`, `env_var_templates_list` | `agents_deploy`, `agents_restart`, `agents_stop` |
| Account | `whoami` | |

Limits:

- Nothing can be **deleted** over MCP.
- An assistant only reaches projects its user is a member of.
- `env_var_templates_list` returns variable names, never their values. Raw agent configuration and env var values can't be sent over MCP: `agents_deploy` names a plan, persona, configuration and env var template instead.
- Agents don't start or restart in a session that is closing or closed.
- `agents_stop` stops the agent; it doesn't delete it.

A typical run: create a session, create an invitation and send its join link to the participant, deploy an agent with a plan and persona, follow it with `agents_get` and `agent_logs_get`, then stop it and close the session.

## Audit log

Every MCP call is recorded in the `McpAuditLog` table. A record holds the user, the app or token that made the call, the tool and its arguments, with secrets removed. Records are deleted after 90 days.

## Known limitations

- After `agents_stop`, `agents_get` still shows the agent's last health as `ready` ([#807](https://github.com/c4dhi/STELLA/issues/807)).
- A session's `messageCount` counts every stored message, including analytics, not just what was said ([#808](https://github.com/c4dhi/STELLA/issues/808)).
