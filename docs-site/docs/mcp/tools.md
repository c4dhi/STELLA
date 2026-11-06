---
sidebar_position: 2
title: "MCP tool reference"
sidebar_label: "Tool reference"
---

# MCP tool reference

Every tool Stella's MCP server offers, with its scope, its inputs and what it returns. How to connect, the scopes and the limits are on [Connect an AI assistant](./index.md).

Conventions used on this page:

- An input marked *optional* can be left out. On an `…_update` tool, every field except the id is optional, and a field left out stays as it is.
- Ids are strings. Each id's description, as the assistant sees it, says which tool lists them.
- Each heading names the scope the tool needs: `mcp:read` or `mcp:write`. A read-only connection doesn't see the `mcp:write` tools, and gets `403` if it calls one by name.
- On failure, every tool returns `{ "error": { "status", "message" } }` instead of the result shown here. `404` also means "not yours".

## Account

### `whoami` · `mcp:read`

Who this connection acts as.

**Inputs:** none.

**Returns:** `userId`, `email`, `name`, `isSystemAdmin`, `projectRoles`, `scopes`, and `connectedVia`. `connectedVia` is `{ app }` for a signed-in app, or `{ personalAccessToken }` with the token's id.

## Personas

Who the agent is: its system prompt, voice and language.

### `personas_list` · `mcp:read`

The user's personas plus the system defaults.

**Inputs:** none.

**Returns:** `{ items }`. Each item has `id`, `name`, `description`, `icon`, `voice`, `language`, `isSystemDefault` and `updatedAt`, but not the system prompt or variables. System defaults have `isSystemDefault: true` and are read-only.

### `personas_get` · `mcp:read`

One persona in full.

**Inputs:** `personaId`.

**Returns:** the persona, including `systemPrompt` and `variables`.

### `personas_create` · `mcp:write`

Create a persona owned by the user.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `name` | string, 1–255 | Display name, e.g. "Grace" |
| `systemPrompt` | string, 1–20000 | Who the agent is. Used as written; `{{placeholders}}` aren't resolved here |
| `description` | string, ≤ 2000, *optional* | |
| `icon` | string, ≤ 16, *optional* | An emoji |
| `voice` | string, ≤ 128, *optional* | TTS voice id. Empty means the provider default |
| `language` | string, ≤ 16, *optional* | Fallback language when no plan sets one, e.g. `de` |
| `variables` | object of strings, *optional* | Values other prompts use as `{{persona.<key>}}` |

**Returns:** the new persona, as `personas_get` shows it.

### `personas_update` · `mcp:write`

Change a persona the user owns. System defaults can't be changed.

**Inputs:** `personaId`, plus any fields of `personas_create`.

**Returns:** the persona, as `personas_get` shows it.

## Plan templates

What happens in a conversation: states, tasks, transitions and deliverables. See [Plan structure](../plan-structure/index.md).

### `plan_templates_list` · `mcp:read`

The user's plan templates.

**Inputs:** none.

**Returns:** `{ items }`. Each item has `id`, `name`, `description`, `defaultPersonaId` and `updatedAt`, but not the content.

### `plan_templates_get` · `mcp:read`

One plan template in full.

**Inputs:** `planId`.

**Returns:** the plan template, including `content`.

### `plan_templates_create` · `mcp:write`

Create a plan template owned by the user.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `name` | string, 1–255 | |
| `content` | object | The plan. Its content is checked like a plan saved in the Plan Builder. It must not contain `system_prompt` or `voice`, which belong to a persona |
| `description` | string, ≤ 2000, *optional* | |

**Returns:** the new plan template, as `plan_templates_get` shows it.

### `plan_templates_update` · `mcp:write`

Change a plan template the user owns.

**Inputs:** `planId`, plus any fields of `plan_templates_create`. A new `content` replaces the whole plan.

**Returns:** the plan template, as `plan_templates_get` shows it.

## Agent types and configurations

An agent configuration holds the pipeline settings for one agent type, as sparse overrides of that type's defaults.

### `agent_types_list` · `mcp:read`

The agent types on this platform.

**Inputs:** none.

**Returns:** `{ items }`. Each item has `id`, `slug`, `name`, `description`, `icon`, `version` and `capabilities`.

### `agent_types_get` · `mcp:read`

One agent type with what a configuration for it can change.

**Inputs:** `agentTypeId`.

**Returns:** the agent type, including its pipeline schema (`configSchema`) and defaults.

### `agent_configurations_list` · `mcp:read`

The user's agent configurations.

**Inputs:** `agentTypeId` *(optional)*, to list only those for one agent type.

**Returns:** `{ items }`. Each item has `id`, `name`, `description`, `agentTypeId`, `compatibility` and `updatedAt`, but not the overrides.

### `agent_configurations_get` · `mcp:read`

One agent configuration in full.

**Inputs:** `agentConfigurationId`.

**Returns:** the configuration, with its overrides, whether it is still compatible with its agent type, and `agentType` as `{ id, slug, name, icon }`.

### `agent_configurations_create` · `mcp:write`

Create a configuration for one agent type, owned by the user.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `name` | string, 1–255 | |
| `agentTypeId` | id | From `agent_types_list` |
| `configuration` | object | Sparse overrides of the agent type's defaults; see `agent_types_get` |
| `description` | string, ≤ 2000, *optional* | |

**Returns:** the new configuration, as `agent_configurations_get` shows it.

### `agent_configurations_update` · `mcp:write`

Change a configuration the user owns.

**Inputs:** `agentConfigurationId`, plus `name`, `description` or `configuration`, each *optional*. A new `configuration` replaces all overrides.

**Returns:** the configuration, as `agent_configurations_get` shows it.

## Projects and sessions

### `projects_list` · `mcp:read`

The projects the user is a member of.

**Inputs:** none.

**Returns:** `{ items }`. Each item has `id`, `name`, `isOwner`, `isPublic`, `agentInactivityTimeoutMinutes`, `activeSessions`, `activeAgents`, `totalSessions` and `createdAt`.

### `sessions_list` · `mcp:read`

The sessions in a project, newest first.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `projectId` | id | From `projects_list` |
| `status` | `ACTIVE`, `CLOSING` or `CLOSED`, *optional* | |
| `search` | string, *optional* | Matches the session or room name |
| `skip` | integer ≥ 0, *optional* | |
| `take` | integer 1–100, *optional* | |

**Returns:** `{ items, total, skip, take }`. Each item has these fields:

- `id`, `name`, `status`, `createdAt`, `closedAt`;
- `hasHumanParticipant`, `humanJoinedAt`, `humanLeftAt`, `firstAgentMessageAt`;
- `agentCount`, `participantCount`, `messageCount`.

### `sessions_get` · `mcp:read`

One session with its agents and the participants in it now.

**Inputs:** `sessionId`.

**Returns:**
- `id`, `projectId`, `name`, `status`, `createdAt`, `closedAt`;
- `agentSpawnMode`, `hasHumanParticipant`, `maxSessionDurationSeconds`, `messageCount`;
- `agents`, each as `agents_get` shows it;
- `participants`, each with `id`, `name` and `joinedAt`.

### `sessions_create` · `mcp:write`

Create an empty session in a project. Next, deploy an agent with `agents_deploy` and invite a participant with `session_invitations_create`.

**Inputs:** `projectId`, and `name` (string ≤ 255, *optional*).

**Returns:** the new session, as `sessions_get` shows it.

### `sessions_update` · `mcp:write`

Rename a session.

**Inputs:** `sessionId`, and `name` (string ≤ 255, *optional*).

**Returns:** the session, as `sessions_get` shows it.

### `sessions_close` · `mcp:write`

End a session. Its agents stop and nobody can join any more. The transcript stays readable. This can't be undone over MCP.

**Inputs:** `sessionId`.

**Returns:** the closed session, as `sessions_get` shows it.

### `session_transcript_get` · `mcp:read`

A session's messages in time order, one page at a time.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `sessionId` | id | |
| `cursor` | string, *optional* | A previous page's `nextCursor`, to get the page before it |
| `limit` | integer 1–100, *optional* | Default 50 |
| `includeDebug` | boolean, *optional* | Adds the agent's internal messages (expert decisions, plan updates) and each message's `metadata` |

**Returns:** `{ items, hasMore, nextCursor }`. Each item has `id`, `timestamp`, `role`, `messageType` and `content`, plus `metadata` when `includeDebug` is set.

### `session_state_get` · `mcp:read`

Where a session stands in its plan.

**Inputs:** `sessionId`.

**Returns:** `{ state }`: the current state, progress, turn counters, task status per state and the collected deliverables. `state` is `null` when the session never ran a plan.

## Invitations

The link a participant opens to join a session, without an account.

### `session_invitations_list` · `mcp:read`

A session's invitations, newest first.

**Inputs:** `sessionId`.

**Returns:** `{ items }`. Each item has these fields:

- `id`, `status`, `participantName`, `customMessage`;
- `visualizerType`, `visualizerLocked`, `maxSessionDurationSeconds`;
- `createdAt`, `expiresAt`, `acceptedAt`;
- `joinUrl`.

### `session_invitations_create` · `mcp:write`

Create the join link for an active session. A session has at most one open invitation: revoke it before making a new one.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `sessionId` | id | |
| `participantName` | string, *optional* | |
| `customMessage` | string, *optional* | Shown to the participant before they join |
| `visualizerType` | string, *optional* | e.g. `sphere`, `face`, `galaxy` |
| `visualizerLocked` | boolean, *optional* | |
| `expiresInHours` | number 1–8760, *optional* | |
| `maxSessionDurationSeconds` | number 60–7200, *optional* | Caps the conversation, counted from the agent's first message |

**Returns:** the invitation, as `session_invitations_list` shows each one, including its `joinUrl`.

### `session_invitations_revoke` · `mcp:write`

Make an open invitation link stop working. A participant who already joined stays.

**Inputs:** `invitationId`.

**Returns:** the revoked invitation, as `session_invitations_list` shows each one.

## Agents

### `env_var_templates_list` · `mcp:read`

The user's env var templates, which hold the API keys an agent needs.

**Inputs:** none.

**Returns:** `{ items }`. Each item has `id`, `name`, `description`, `variableKeys` and `agentTypeId`. The variables are listed by name only, **never their values**. A template only fits agents of its `agentTypeId`.

### `agents_deploy` · `mcp:write`

Start an agent in an active session. Starting takes a while: poll `agents_get` until `status` is `RUNNING`. Refused in a session that is closing or closed.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `sessionId` | id | |
| `name` | string, 1–255 | |
| `icon` | string, ≤ 10, *optional* | One emoji |
| `agentTypeId` | id, *optional* | Default: STELLA V2 |
| `mode` | `plan` or `companion`, *optional* | Default: `plan` |
| `planId` | id, *optional* | The plan to follow in plan mode. Without one, the agent runs with no plan. Ignored in companion mode |
| `availablePlanIds` | up to 20 ids, *optional* | The plans companion mode offers as activities |
| `personaId` | id, *optional* | Default: the default persona |
| `agentConfigurationId` | id, *optional* | Required by the STELLA V2 agent type |
| `envVarTemplateId` | id, *optional* | The template holding the API keys the agent type needs |
| `connectorBindings` | up to 20 of `{ connectorId, slot?, handle? }`, *optional* | Outside MCP servers the agent may call, from `connectors_list` with the session's `projectId`. Every required connector slot of the agent type needs one. The agent never receives their tokens |

It takes no raw configuration and no env var values.

**Returns:** the agent, as `agents_get` shows it.

### `agents_get` · `mcp:read`

The status and health of one agent.

**Inputs:** `agentId` (from `sessions_get`).

**Returns:** these fields, and `podStatus` when it is known:

- `id`, `sessionId`, `name`, `icon`, `agentType`;
- `status`, `healthState`, `lastError`;
- `createdAt`, `stoppedAt`, `pausedAt`, `pauseReason`.

The deployment snapshot, the Kubernetes names and the env vars are left out.

### `agent_logs_get` · `mcp:read`

The last 100 lines of the agent's log.

**Inputs:** `agentId`.

**Returns:** `{ logs }`. It is empty once the agent's pod is gone.

### `agents_restart` · `mcp:write`

Restart an agent with the configuration it was deployed with. Its current turn is cut off. Refused in a session that is closing or closed.

**Inputs:** `agentId`.

**Returns:** the agent, as `agents_get` shows it.

### `agents_stop` · `mcp:write`

Stop an agent and remove its pod. The agent and its messages stay, and `agents_restart` brings it back.

**Inputs:** `agentId`.

**Returns:** the stopped agent, as `agents_get` shows it. Its `healthState` may still read `ready` ([#807](https://github.com/c4dhi/STELLA/issues/807)).

## Platform settings (system admins)

The platform-wide switches in Settings → Platform Defaults. Only a system admin sees these two tools; anyone else gets `403` calling them by name.

### `platform_settings_get` · `mcp:read`

**Inputs:** none.

**Returns:** `agentReviewRequired`, `mcpEnabled`, `ttsPlayback` (`null` when no default is set).

### `platform_settings_update` · `mcp:write`

Turn **Review uploaded agents** on or off. While it is on (the default), no uploaded agent deploys until a system admin approves it, and unreviewed agents stop coming back on restart or wake. While it is off, a user can deploy their own upload as soon as it is built, and members of the projects they share it with can deploy it there. The MCP switch and the TTS playback default can only be changed in the UI.

**Inputs:**

| Name | Type | |
|---|---|---|
| `agentReviewRequired` | boolean | Required |

**Returns:** the settings, as `platform_settings_get` shows them.
## Connectors

Outside MCP servers that agents call through STELLA, for example an interview-question server. The token stays in STELLA: agents only get the tools. See [Connectors](../agent-sdk/connectors.md) for how an agent uses them.

### `connectors_list` · `mcp:read`

The user's own connectors. With `projectId`: the connectors that can be bound to an agent in that project, the user's own plus those other members shared with it.

**Inputs:** `projectId` (from `projects_list`, *optional*).

**Returns:** `{ items }`. Each item has `id`, `name`, `handle`, `url`, `status` (`untested`, `ok` or `error`) and `tools`. Without `projectId`, items also have `authType`, `hasCredential`, `lastError`, `lastCheckedAt`, `serverInfo` and `sharedWith`. With it, they have `owned` and `ownerName`. No token is ever returned.

### `connectors_get` · `mcp:read`

One of the user's own connectors.

**Inputs:** `connectorId`.

**Returns:** the connector, as `connectors_list` shows each one without `projectId`.

### `connectors_create` · `mcp:write`

Add an outside MCP server. Run `connectors_test` next. Private and cluster-internal addresses are refused.

**Inputs:**

| Input | Type | Notes |
|---|---|---|
| `name` | string, 1–100 | e.g. "ELIAS interview questions" |
| `handle` | lowercase letters, digits, hyphens, ≤ 40 | How agents address it. Unique per user |
| `url` | string, ≤ 2048 | The MCP endpoint (Streamable HTTP). A trailing slash and `//` are cleaned up |
| `authType` | `bearer` or `none`, *optional* | Default `bearer` |
| `token` | string, ≤ 8192, *optional* | Stored encrypted. It passes through the chat; no tool returns it, and the audit log records it as `[redacted]` |

**Returns:** the connector, as `connectors_get` shows it.

### `connectors_update` · `mcp:write`

Change a connector the user owns. Leave out `token` to keep the stored one. Changing `url`, `authType` or `token` resets the status to `untested`.

**Inputs:** `connectorId`, and any of the fields of `connectors_create`.

**Returns:** the connector, as `connectors_get` shows it.

### `connectors_test` · `mcp:write`

Connect with the stored token (MCP `initialize` and `tools/list`) and store the result as the connector's status and tool list.

**Inputs:** `connectorId`.

**Returns:** `{ ok, errorCode?, error?, connector }`. `errorCode` is one of `unauthorized`, `unreachable`, `timeout`, `redirect`, `blocked_host` or `protocol`.

### `connector_shares_set` · `mcp:write`

Replace the set of projects a connector the user owns is shared with. `[]` unshares it everywhere. Only projects the user is a member of.

Members of those projects can bind the connector to their agents. The agents call it with the owner's token, and the audit log names the owner. Members never see the token and can't change the connector. Unsharing stops their agents' calls at once.

**Inputs:** `connectorId`, `projectIds` (up to 100, from `projects_list`).

**Returns:** the connector, as `connectors_get` shows it.
