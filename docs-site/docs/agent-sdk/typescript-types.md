---
sidebar_position: 6
title: "TypeScript Types"
---

# TypeScript Types

Complete TypeScript interfaces for the STELLA Session Management API.

## Installation

Copy these types directly into your project:

```typescript
// src/types/session-management.ts
```

## Enums

```typescript
export enum SessionStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED'
}

export enum AgentStatus {
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  FAILED = 'FAILED'
}

export type MessageType = 'text' | 'transcript' | 'system';
```

## Entity Types

### Project

```typescript
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithCounts extends Project {
  activeSessions: number;
  activeAgents: number;
  totalSessions: number;
}

export interface ProjectWithSessions extends Project {
  sessions: Session[];
}

export interface ProjectStats {
  totalSessions: number;
  activeSessions: number;
  totalAgents: number;
  activeAgents: number;
  totalMessages: number;
  totalParticipants: number;
}
```

### Session

```typescript
export interface Session {
  id: string;
  projectId: string;
  status: SessionStatus;
  createdAt: string;
  closedAt: string | null;
}

export interface SessionWithRoom extends Session {
  room: Room;
}

export interface SessionDetail extends SessionWithRoom {
  agents: AgentInstance[];
  participants: Participant[];
  _count: {
    messages: number;
    events: number;
  };
}

export interface SessionListItem extends SessionWithRoom {
  _count: {
    agents: number;
    participants: number;
    messages: number;
  };
}
```

### Room

```typescript
export interface Room {
  id: string;
  sessionId: string;
  livekitRoomName: string;
  serverUrl: string;
}
```

### Agent Instance

```typescript
export interface AgentInstance {
  id: string;
  sessionId: string;
  role: string;
  status: AgentStatus;
  podName: string | null;
  secretName: string | null;
  configMapName: string | null;
  planId: string | null;
  createdAt: string;
  stoppedAt: string | null;
}

export interface AgentWithSession extends AgentInstance {
  session: {
    id: string;
    room: {
      livekitRoomName: string;
      serverUrl: string;
    };
  };
}

export interface AgentWithPodStatus extends AgentWithSession {
  podStatus: {
    phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
    conditions: any[];
    containerStatuses: any[];
  } | null;
}
```

### Participant

```typescript
export interface Participant {
  id: string;
  sessionId: string;
  identity: string;
  joinedAt: string;
  leftAt: string | null;
}
```

### Message

```typescript
export interface Message {
  id: string;
  sessionId: string;
  participantId: string | null;
  content: string;
  messageType: MessageType;
  timestamp: string;
}

export interface MessageWithParticipant extends Message {
  participant: Participant | null;
}
```

### Room Event

```typescript
export interface RoomEvent {
  id: string;
  sessionId: string;
  eventType: string;
  data: Record<string, any>;
  timestamp: string;
}
```

### Timeline

```typescript
export type TimelineItem =
  | { type: 'message'; data: MessageWithParticipant }
  | { type: 'event'; data: RoomEvent };

export interface Timeline {
  timeline: TimelineItem[];
  total: number;
}
```

## Request DTOs

### Project Requests

```typescript
export interface CreateProjectDto {
  name: string; // 1-255 characters
}
```

### Session Requests

```typescript
export interface CreateSessionDto {
  planId?: string; // max 255 characters
}

export interface QuerySessionsDto {
  status?: SessionStatus;
  search?: string;
  skip?: number; // default: 0
  take?: number; // default: 20, max: 100
}

export interface CreateTokenDto {
  identity: string; // max 255 characters
  name?: string; // max 255 characters
}
```

### Agent Requests

```typescript
export interface CreateAgentDto {
  role: string; // max 255 characters
  planId?: string; // max 255 characters
}
```

## Response Types

### Paginated Response

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  skip: number;
  take: number;
}

export type SessionsResponse = PaginatedResponse<SessionListItem>;
```

### Join Token Response

```typescript
export interface JoinTokenResponse {
  token: string;
  serverUrl: string;
  roomName: string;
}
```

### Delete Response

```typescript
export interface DeleteResponse {
  message: string;
}
```

### Error Response

```typescript
export interface ApiError {
  statusCode: number;
  timestamp: string;
  path: string;
  message: string | string[];
}
```

## API Client Interface

```typescript
export interface ApiClient {
  // Projects
  createProject(data: CreateProjectDto): Promise<Project>;
  listProjects(): Promise<ProjectWithCounts[]>;
  getProject(projectId: string): Promise<ProjectWithSessions>;
  getProjectStats(projectId: string): Promise<ProjectStats>;
  deleteProject(projectId: string): Promise<DeleteResponse>;

  // Sessions
  createSession(
    projectId: string,
    data: CreateSessionDto
  ): Promise<SessionWithRoom>;
  listSessions(
    projectId: string,
    query: QuerySessionsDto
  ): Promise<SessionsResponse>;
  getSession(sessionId: string): Promise<SessionDetail>;
  createJoinToken(
    sessionId: string,
    data: CreateTokenDto
  ): Promise<JoinTokenResponse>;
  getTimeline(
    sessionId: string,
    skip?: number,
    take?: number
  ): Promise<Timeline>;
  closeSession(sessionId: string): Promise<DeleteResponse>;

  // Agents
  createAgent(
    sessionId: string,
    data: CreateAgentDto
  ): Promise<AgentInstance>;
  getAgent(agentId: string): Promise<AgentWithPodStatus>;
  getAgentLogs(agentId: string): Promise<string>;
  stopAgent(agentId: string): Promise<DeleteResponse>;
}
```

## Usage Example

```typescript
import {
  ApiClient,
  CreateProjectDto,
  SessionDetail,
} from './types/session-management';

class SessionManagementClient implements ApiClient {
  constructor(private baseUrl: string) {}

  async createProject(data: CreateProjectDto) {
    const response = await fetch(`${this.baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return response.json();
  }

  // ... implement other methods
}

// Use with type safety
const client = new SessionManagementClient('http://localhost:3000');

const project = await client.createProject({ name: 'My Project' });
// project is typed as Project

const session = await client.createSession(project.id, {
  planId: 'cognitive_stimulation_demo_sm',
});
// session is typed as SessionWithRoom
```

## React Hooks

```typescript
import { useState, useEffect } from 'react';
import {
  Project,
  SessionDetail,
  AgentWithPodStatus,
} from './types/session-management';

// useProject hook
export function useProject(projectId: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchProject() {
      try {
        const response = await fetch(`/api/projects/${projectId}`);
        const data: Project = await response.json();
        setProject(data);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    }
    fetchProject();
  }, [projectId]);

  return { project, loading, error };
}

// useSession hook
export function useSession(sessionId: string) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSession() {
      const response = await fetch(`/api/sessions/${sessionId}`);
      const data: SessionDetail = await response.json();
      setSession(data);
      setLoading(false);
    }
    fetchSession();
  }, [sessionId]);

  return { session, loading };
}

// useAgent hook with polling
export function useAgent(agentId: string, pollInterval = 2000) {
  const [agent, setAgent] = useState<AgentWithPodStatus | null>(null);

  useEffect(() => {
    async function fetchAgent() {
      const response = await fetch(`/api/agents/${agentId}`);
      const data: AgentWithPodStatus = await response.json();
      setAgent(data);
    }

    fetchAgent();
    const interval = setInterval(fetchAgent, pollInterval);

    return () => clearInterval(interval);
  }, [agentId, pollInterval]);

  return { agent };
}
```

## Validation Helpers

```typescript
export const validators = {
  projectName: (name: string): boolean => {
    return name.length >= 1 && name.length <= 255;
  },

  identity: (identity: string): boolean => {
    return identity.length >= 1 && identity.length <= 255;
  },

  pagination: (skip: number, take: number): boolean => {
    return skip >= 0 && take >= 1 && take <= 100;
  },
};
```

## Type Guards

```typescript
export function isApiError(error: any): error is ApiError {
  return (
    error &&
    typeof error.statusCode === 'number' &&
    typeof error.timestamp === 'string' &&
    typeof error.path === 'string' &&
    (typeof error.message === 'string' || Array.isArray(error.message))
  );
}

export function isSessionActive(session: Session): boolean {
  return session.status === SessionStatus.ACTIVE;
}

export function isAgentRunning(agent: AgentInstance): boolean {
  return agent.status === AgentStatus.RUNNING;
}
```

## Constants

```typescript
export const DEFAULT_PAGINATION = {
  skip: 0,
  take: 20,
} as const;

export const MAX_PAGINATION = {
  take: 100,
} as const;

export const POLL_INTERVALS = {
  SESSIONS: 5000, // 5 seconds
  AGENTS: 2000,   // 2 seconds
  TIMELINE: 3000, // 3 seconds
} as const;
```

## See Also

- [SDK Overview](./overview.md)
- [Message Types](./message-types.md)
- [Frontend Integration](../integration/frontend.md)
