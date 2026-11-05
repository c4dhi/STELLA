/**
 * Types for Agent SDK communication.
 * These mirror the proto definitions in agent.proto
 */

// Agent state enum (matches proto AgentState)
export enum AgentState {
  UNKNOWN = 'unknown',
  INITIALIZING = 'initializing',
  READY = 'ready',
  PROCESSING = 'processing',
  INTERRUPTED = 'interrupted',
  ERROR = 'error',
  SHUTTING_DOWN = 'shutting_down',
}

// Input types (server -> agent)
export enum InputType {
  UNSPECIFIED = 0,
  TEXT = 1,
  INTERRUPT = 2,
  SESSION_START = 3,
  SESSION_END = 4,
  CONFIG = 5,
  HEALTH_CHECK = 6,
}

// Output types (agent -> server)
export enum OutputType {
  UNSPECIFIED = 0,
  TEXT_CHUNK = 1,
  TEXT_FINAL = 2,
  STATUS = 3,
  METADATA = 4,
  ERROR = 5,
  HEALTH_STATUS = 6,
}

// Status subtypes
export enum StatusSubtype {
  UNSPECIFIED = 0,
  PROCESSING = 1,
  THINKING = 2,
  EXPERT_START = 3,
  EXPERT_COMPLETE = 4,
  AGGREGATING = 5,
}

// Conversation turn
export interface ConversationTurn {
  role: string;
  content: string;
}

// Health check request
export interface HealthCheckRequest {
  requestId: string;
}

// Health status response
export interface AgentHealthStatus {
  requestId: string;
  state: AgentState;
  sessionId: string;
  agentType: string;
  agentVersion: string;
  uptimeSeconds: number;
  messagesProcessed: number;
  lastError?: string;
  metadata?: Record<string, string>;
}

// Agent input (server -> agent)
export interface AgentInput {
  sessionId: string;
  type: InputType;
  text?: string;
  history?: ConversationTurn[];
  metadata?: Record<string, string>;
  timestampMs: number;
  healthCheck?: HealthCheckRequest;
}

// Agent output (agent -> server)
export interface AgentOutput {
  sessionId: string;
  type: OutputType;
  content: string;
  isFinal: boolean;
  transcriptId?: string;
  statusSubtype?: StatusSubtype;
  metadataSubtype?: number;
  metadata?: Record<string, string>;
  timestampMs: number;
  healthStatus?: AgentHealthStatus;
}

// Registration request
export interface RegisterAgentRequest {
  agentType: string;
  agentVersion: string;
  capabilities?: Record<string, string>;
  // stella-ai-agent-sdk version the agent runs; empty from SDKs before 0.10.
  sdkVersion?: string;
}

// Registration response
export interface RegisterAgentResponse {
  success: boolean;
  sessionId?: string;
  message?: string;
  config?: Record<string, string>;
}

// Active orchestrated session state
export interface ActiveOrchestratedSession {
  sessionId: string;
  roomName: string;
  textBuffer: string;
  isProcessing: boolean;
  agentConnected: boolean;
}
