---
sidebar_position: 5
title: Database Schema
description: PostgreSQL database structure with Prisma ORM
---

# Database Schema

STELLA uses PostgreSQL with Prisma ORM for data persistence. This document describes the database structure and relationships between entities.

## Entity Relationship Diagram

```
┌─────────────┐       ┌───────────────────┐       ┌─────────────┐
│    User     │──────<│ ProjectMembership │>──────│   Project   │
└─────────────┘       └───────────────────┘       └─────────────┘
      │                                                  │
      │ owns                                             │ contains
      ▼                                                  ▼
┌─────────────┐                                   ┌─────────────┐
│  AgentType  │                                   │   Session   │
│ PlanTemplate│                                   └─────────────┘
│EnvVarTemplat│                                         │
└─────────────┘            ┌────────────────────────────┼────────────────────────────┐
                           │              │             │             │              │
                           ▼              ▼             ▼             ▼              ▼
                    ┌───────────┐  ┌─────────────┐ ┌─────────┐ ┌───────────┐ ┌────────────┐
                    │   Room    │  │AgentInstance│ │Particip.│ │ Invitation│ │  Message   │
                    └───────────┘  └─────────────┘ └─────────┘ └───────────┘ └────────────┘
```

## Core Models

### User

Represents authenticated users of the platform.

```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  password  String   // bcrypt hashed
  name      String?
  verified  Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  projectMemberships         ProjectMembership[]
  customAgentTypes           AgentType[]
  planTemplates              PlanTemplate[]
  envVarTemplates            EnvVarTemplate[]
  messages                   UserMessage[]
  sentProjectInvitations     ProjectInvitation[]
  receivedProjectInvitations ProjectInvitation[]
}
```

### Project

Organizational container for sessions. Supports public sharing.

```prisma
model Project {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Public Project Configuration
  isPublic               Boolean    @default(false)
  publicToken            String?    @unique
  publicAgentTypeId      String?
  publicAgentConfig      Json?      // { name, icon, plan | mode: 'companion' + availablePlanIds, envVarTemplateId, … }
  publicVisualizerType   String?
  publicVisualizerLocked Boolean    @default(false)
  publicExpiresAt        DateTime?
  publicEnabled          Boolean    @default(true)

  // Whether a session closes once everyone has left; false keeps it open.
  // Sessions follow this unless they set closeWhenEmpty themselves.
  closeSessionWhenEmpty  Boolean    @default(false)

  // Relations
  sessions           Session[]
  memberships        ProjectMembership[]
  projectInvitations ProjectInvitation[]
}
```

**Member Roles:**
| Role | Permissions |
|------|-------------|
| `OWNER` | Full control, delete project, manage members |
| `ADMIN` | Manage sessions, invite members |
| `MEMBER` | Create and view sessions |

### Session

A conversation instance with participants and agents.

```prisma
model Session {
  id        String        @id @default(uuid())
  projectId String
  name      String?
  status    SessionStatus @default(ACTIVE) // ACTIVE, CLOSED
  createdAt DateTime      @default(now())
  closedAt  DateTime?
  closeWhenEmpty Boolean?  // null = as the project's closeSessionWhenEmpty
  keptOpenAt     DateTime? // everyone left and the session was kept open; cleared when someone joins

  // Relations
  room         Room?
  agents       AgentInstance[]
  participants Participant[]
  invitations  Invitation[]
  messages     Message[]
  events       RoomEvent[]
  state        SessionState?
}
```

## Agent System

### AgentType

Registry of available agent types (built-in and custom).

```prisma
model AgentType {
  id          String  @id @default(uuid())
  slug        String  @unique  // "stella-agent", "memory-coach"
  name        String           // Display name
  description String
  icon        String?
  version     String  @default("1.0.0")
  isBuiltIn   Boolean @default(true)

  // Custom agent ownership
  userId String?

  // Package storage (custom agents)
  packagePath String?
  packageSize Int?
  packageHash String?

  // Docker image configuration
  imageUrl       String?  // Pre-built image URL
  dockerfilePath String?  // Path within package

  // Validation workflow
  validationStatus AgentValidationStatus @default(PENDING)
  validationNotes  String?
  validatedAt      DateTime?
  validatedBy      String?

  // Configuration schema (JSON Schema format)
  configSchema  Json?
  capabilities  Json?   // ["voice", "text", "progress"]
  defaultConfig Json?

  // Resource limits
  resourceMemory String? @default("512Mi")
  resourceCpu    String? @default("250m")
  resourceGpu    Boolean @default(false)
}
```

**Validation Status:**
| Status | Description |
|--------|-------------|
| `PENDING` | Awaiting admin review |
| `APPROVED` | Ready for use |
| `REJECTED` | Failed validation |

### AgentInstance

Running instance of an agent within a session.

```prisma
model AgentInstance {
  id            String      @id @default(uuid())
  sessionId     String
  name          String
  icon          String?
  status        AgentStatus @default(STARTING)
  agentType     String?     @default("stella-agent")
  agentTypeId   String?
  agentConfig   Json?

  // Kubernetes resources
  podName       String?
  secretName    String?
  configMapName String?

  // Health tracking
  healthState       String?   @default("unknown")
  lastHealthCheck   DateTime?
  lastError         String?
  messagesProcessed Int       @default(0)
  grpcAddress       String?

  // Environment variables
  envVarTemplateId String?
}
```

**Agent Status:**
| Status | Description |
|--------|-------------|
| `STARTING` | Pod being created |
| `RUNNING` | Active and processing |
| `STOPPING` | Shutdown in progress |
| `STOPPED` | Cleanly terminated |
| `FAILED` | Error state |

## Session State Machine

### SessionState

Persists conversation plan execution state.

```prisma
model SessionState {
  id        String @id @default(uuid())
  sessionId String @unique

  // Plan definition
  planId   String?
  planData Json    // Full plan (states, tasks, deliverables)

  // Execution state
  currentStateId String
  completedTasks String[] @default([])
  skippedTasks   String[] @default([])

  // Collected deliverables
  deliverables Json @default("{}")
  // Format: { key: { value, reasoning, collectedAt } }

  // Progress tracking
  turnsWithoutProgress Int @default(0)
  totalTurns           Int @default(0)

  lastTransitionAt DateTime?
}
```

## Participants & Invitations

### Participant

Users connected to a session via LiveKit.

```prisma
model Participant {
  id                   String    @id @default(uuid())
  sessionId            String
  name                 String
  identity             String    // LiveKit identity
  isManuallyRegistered Boolean   @default(false)
  joinedAt             DateTime  @default(now())
  leftAt               DateTime?
  tokenRevokedAt       DateTime?
  lastTokenRefresh     DateTime?
  lastSeenAt           DateTime?
}
```

### Invitation

Shareable links for session access.

```prisma
model Invitation {
  id              String           @id @default(uuid())
  sessionId       String
  token           String           @unique // URL token
  participantName String
  customMessage   String?

  // Visualizer settings
  visualizerType   String?
  visualizerLocked Boolean @default(false)

  // Status
  status    InvitationStatus @default(PENDING)
  statusBeforeAutoRevoke InvitationStatus? // set by an automatic close, see below
  expiresAt DateTime?
  acceptedAt DateTime?
  participantId String? @unique
}
```

**Invitation Status:**
| Status | Description |
|--------|-------------|
| `PENDING` | Waiting for participant |
| `ACCEPTED` | Participant joined |
| `EXPIRED` | Time-based expiration |
| `REVOKED` | Revoked by hand, or because the session closed |

A session that closes on its own (the room went empty, the plan ended, its maximum length ran out) revokes its pending and accepted invitations and keeps each one's earlier status in `statusBeforeAutoRevoke`. If somebody rejoins and the session reopens, those invitations get that status back, or `EXPIRED` if their own expiry passed in the meantime, so the participant's link works again. Invitations revoked by hand, or by **Close session**, have no earlier status and stay revoked.

## Messages & Events

### Message

Persisted conversation messages and events.

```prisma
model Message {
  id        String   @id @default(uuid())
  sessionId String
  content   String   @db.Text
  messageType String
  role      String?  // "user", "assistant", "system"
  status    String?  // "partial", "final"
  metadata  Json?
  timestamp DateTime @default(now())
}
```

**Message Types:**
| Type | Description |
|------|-------------|
| `transcript` | Speech-to-text transcription |
| `system` | System notifications |
| `task_update` | Plan task progress |
| `deliverable` | Collected deliverable |
| `state_change` | State machine transition |
| `participant_event` | Join/leave events |

### RoomEvent

LiveKit room events for audit logging.

```prisma
model RoomEvent {
  id        String   @id @default(uuid())
  sessionId String
  eventType String
  data      Json
  timestamp DateTime @default(now())
}
```

## User Templates

### PlanTemplate

Reusable conversation plan definitions.

```prisma
model PlanTemplate {
  id          String   @id @default(uuid())
  userId      String
  name        String
  description String?
  content     Json     // SDK format: { states, system_prompt, session_context }
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### EnvVarTemplate

Secure storage for API keys and secrets.

```prisma
model EnvVarTemplate {
  id          String  @id @default(uuid())
  userId      String
  name        String
  description String?
  variables   String  @db.Text  // AES-256-GCM encrypted JSON
  agentTypeId String?           // Optional scope to agent type
}
```

Variables are encrypted at rest using AES-256-GCM with the format:
```
{iv}:{authTag}:{encryptedData}
```

## User Messaging

### UserMessage

Generic inbox for user notifications.

```prisma
model UserMessage {
  id                String          @id @default(uuid())
  userId            String
  type              UserMessageType // PROJECT_INVITATION
  title             String
  body              String?
  read              Boolean         @default(false)
  relatedEntityId   String?
  relatedEntityType String?
  createdAt         DateTime        @default(now())
}
```

### ProjectInvitation

Collaboration invitations between users.

```prisma
model ProjectInvitation {
  id          String                  @id @default(uuid())
  projectId   String
  inviterId   String
  inviteeId   String
  status      ProjectInvitationStatus @default(PENDING)
  respondedAt DateTime?
}
```

## Database Indexes

Key indexes for query performance:

| Table | Index | Purpose |
|-------|-------|---------|
| `Session` | `projectId` | List sessions by project |
| `Session` | `status` | Filter active sessions |
| `Message` | `sessionId, timestamp` | Paginated message history |
| `AgentInstance` | `status` | Monitor running agents |
| `Invitation` | `token` | Fast token lookup |
| `UserMessage` | `userId, read` | Unread message count |

## Migrations

Prisma manages schema migrations:

```bash
# Generate migration from schema changes
npx prisma migrate dev --name description

# Apply migrations in production
npx prisma migrate deploy

# Reset database (development only)
npx prisma migrate reset
```

## Next Steps

- [Data Flow](./data-flow.md) - How data moves through the system
- [Session Lifecycle](./session-lifecycle.md) - Session states and transitions
