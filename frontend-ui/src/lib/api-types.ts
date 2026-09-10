// TypeScript types for Session Management Server API
// Based on session-management-server/docs/TYPESCRIPT_TYPES.md

// ============================================================================
// Enums
// ============================================================================

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

export enum AgentValidationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED'
}

export type MessageType = 'text' | 'transcript' | 'system' | 'task_update' | 'deliverable' | 'state_change' | 'participant_event'

export type PodPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'

// ============================================================================
// TTS capabilities (what the active TTS provider can synthesize)
// ============================================================================

export interface TtsVoiceInfo {
  id: string
  displayName: string
  languages: string[]      // ISO 639-1 codes this voice has a native clip for
  defaultLanguage: string
}

export interface TtsCapabilities {
  provider: string
  voices: TtsVoiceInfo[]
  languages: string[]      // ISO codes the provider can speak (broad set)
  defaultVoice: string
  supportsVoiceSelection: boolean
}

// ============================================================================
// Entity Types
// ============================================================================

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  agentInactivityTimeoutMinutes?: number | null
}

export interface ProjectWithCounts extends Project {
  activeSessions: number
  activeAgents: number
  totalSessions: number
  isPublic?: boolean
  publicToken?: string
  publicEnabled?: boolean
  ownerId?: string
  isOwner?: boolean
}

export interface ProjectWithSessions extends Project {
  sessions: Session[]
  isPublic?: boolean
  publicToken?: string
  publicEnabled?: boolean
  ownerId?: string
  isOwner?: boolean
}

export interface ProjectStats {
  totalSessions: number
  activeSessions: number
  totalAgents: number
  activeAgents: number
  totalMessages: number
  totalParticipants: number
}

export interface Session {
  id: string
  projectId: string
  name: string | null
  status: SessionStatus
  createdAt: string
  closedAt: string | null
}

export interface Room {
  id: string
  sessionId: string
  livekitRoomName: string
  serverUrl: string
}

export interface SessionWithRoom extends Session {
  room: Room
}

export interface SessionDetail extends SessionWithRoom {
  agents: AgentInstance[]
  participants: Participant[]
  _count: {
    messages: number
    events: number
  }
}

export interface SessionListItem extends SessionWithRoom {
  _count: {
    agents: number
    participants: number
    messages: number
  }
}

export interface AgentInstance {
  id: string
  sessionId: string
  name: string
  icon?: string | null
  status: AgentStatus
  podName: string | null
  secretName: string | null
  configMapName: string | null
  agentConfig: Record<string, unknown> | null
  createdAt: string
  stoppedAt: string | null
}

export interface AgentWithSession extends AgentInstance {
  session: {
    id: string
    room: {
      livekitRoomName: string
      serverUrl: string
    }
  }
}

export interface PodStatus {
  phase: PodPhase
  conditions: any[]
  containerStatuses: any[]
}

export interface AgentWithPodStatus extends AgentWithSession {
  podStatus: PodStatus | null
}

export interface Participant {
  id: string
  sessionId: string
  name: string
  identity: string
  joinedAt: string
  leftAt: string | null
}

export interface Message {
  id: string
  sessionId: string
  participantId: string | null
  content: string
  messageType: MessageType
  category?: string | null  // 'transcript' | 'processing' | 'task_update'
  role?: string | null  // 'user' | 'assistant' | 'system'
  status?: string | null  // 'partial' | 'final'
  metadata?: Record<string, any> | null  // JSON metadata for complex messages
  timestamp: string
  createdAt: string
}

export interface MessageWithParticipant extends Message {
  participant: Participant | null
}

export interface MessagesResponse {
  messages: MessageWithParticipant[]
  hasMore: boolean
  nextCursor: string | null
}

export interface LatestMessagesResponse {
  messages: MessageWithParticipant[]
}

export interface RoomEvent {
  id: string
  sessionId: string
  eventType: string
  data: Record<string, any>
  timestamp: string
}

export type TimelineItem =
  | { type: 'message'; data: MessageWithParticipant }
  | { type: 'event'; data: RoomEvent }

export interface Timeline {
  timeline: TimelineItem[]
  total: number
}

// ============================================================================
// Request DTOs
// ============================================================================

export interface CreateProjectDto {
  name: string // 1-255 characters
  agentInactivityTimeoutMinutes?: number | null
}

export interface CreateSessionDto {
  name?: string // max 255 characters, optional
  planId?: string // max 255 characters, optional
}

export interface QuerySessionsDto {
  status?: SessionStatus
  search?: string
  skip?: number // default: 0
  take?: number // default: 20, max: 100
}

export interface CreateTokenDto {
  identity: string // max 255 characters
  name?: string // max 255 characters, optional
}

export interface CreateAgentDto {
  name: string // max 255 characters, required
  icon?: string // max 10 characters (emoji), optional
  agentType?: string // agent type id (e.g., 'stella-agent', 'echo-agent')
  config?: Record<string, unknown> // agent-specific config (e.g., { plan: {...} })
  // Stored pipeline configuration to apply. When set, the backend loads it by ID,
  // verifies it matches this agent's type and is not outdated, and uses its
  // (defaults-merged) overrides as pipeline_config — ignoring any client pipeline_config.
  agentConfigurationId?: string
  envVarTemplateId?: string // environment variable template to use
  envVars?: Record<string, string> // additional env vars to merge with template (overrides template values)
}

export interface AgentType {
  id: string
  slug: string
  name: string
  description: string
  icon: string | null
  version: string
  isBuiltIn: boolean
  capabilities: string[]
  defaultConfig: Record<string, unknown>  // Default config for this agent type
  validationStatus?: AgentValidationStatus
  configSchema?: Record<string, unknown>  // JSON Schema for config options
  pipelineSchema?: PipelineSchema | null  // Pipeline topology + configurable slots
  runtimeVariables?: RuntimeVariable[] | null  // Manifest-declared {{placeholder}} palette
  expertDefaults?: ExpertDefault[] | null  // Agent-declared default experts (config/experts/*.json)
  compilerVersion?: string | null  // SDK prompt-compiler version this agent uses
  resourceGpu?: boolean
  authorName?: string | null
  authorEmail?: string | null
  tags?: string[]
  createdAt?: string
}

/** A {{placeholder}} the agent's prompt compiler can resolve (manifest-declared). */
export interface RuntimeVariable {
  name: string            // token base; {{name}} or, when parametric, {{name_N}}
  label?: string          // display label (e.g. "history_N")
  description?: string
  preview?: string        // example value shown in the editor
  parametric?: boolean    // true for {{name_N}}-style tokens
}

// Extended AgentType with build info (for my-agents endpoint)
export interface CustomAgentType extends AgentType {
  lastBuild: {
    status: string
    startedAt: string
    completedAt: string | null
  } | null
}

// Agent package upload response
export interface AgentUploadResponse {
  id: string
  slug: string
  name: string
  version: string
  validationStatus: AgentValidationStatus
  warnings: string[]
}

// Agent build status
export interface AgentBuildStatus {
  id: string
  status: 'pending' | 'building' | 'success' | 'failed'
  imageName?: string
  errorMessage?: string
  startedAt: string
  completedAt?: string
}

// Agent build trigger response
export interface AgentBuildResponse {
  buildLogId: string
  message: string
}

// Package validation result (for showing errors before upload)
export interface PackageValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface SessionEvent {
  type:
    | 'agent.starting' | 'agent.ready' | 'agent.failed' | 'agent.stopped'
    | 'participant.joined' | 'participant.left'
    // Join progress types for public project flow
    | 'join.session_created' | 'join.agent_deploying' | 'join.agent_starting'
    | 'join.agent_ready' | 'join.invitation_created' | 'join.complete' | 'join.failed'
    // Project-level session lifecycle events
    | 'session.created' | 'session.closed' | 'session.deleted'
  sessionId: string
  projectId?: string      // For project-level event filtering
  sessionName?: string    // For display in notifications
  agentId?: string
  agentName?: string
  agentType?: string
  participantId?: string
  participantIdentity?: string
  participantName?: string
  isOnline?: boolean
  error?: string
  timestamp: string
  // Join progress fields
  step?: number
  totalSteps?: number
  invitationToken?: string
}

// Project-level session events (for SessionsDashboard real-time updates)
export type ProjectSessionEventType =
  | 'session.created'
  | 'session.closed'
  | 'session.deleted'

export interface ProjectSessionEvent {
  type: ProjectSessionEventType
  sessionId: string
  projectId: string
  sessionName?: string
  timestamp: string
}

// ============================================================================
// Project Metrics Types (for ProjectOverviewBanner)
// ============================================================================

export interface ProjectMetrics {
  projectId: string
  timestamp: string
  sessions: {
    total: number
    active: number
    closed: number
  }
  agents: {
    total: number
    running: number
    starting: number
    failed: number
    stopped: number
  }
  participants: {
    total: number
    online: number
  }
  messages: {
    total: number
    todayCount: number
  }
  project: {
    name: string
    agentType: string | null
    agentTypeName: string | null
    planTemplateName: string | null
    isPublic: boolean
    createdAt: string
  }
}

// ============================================================================
// Invitation Types
// ============================================================================

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED'
}

export interface Invitation {
  id: string
  sessionId: string
  token: string
  participantName?: string
  customMessage?: string | null
  visualizerType?: string | null
  visualizerLocked: boolean
  status: InvitationStatus
  createdAt: string
  expiresAt?: string | null
  acceptedAt?: string | null
  participantId?: string | null
  participant?: {
    id: string
    name: string
    identity: string
    joinedAt: string
    leftAt?: string | null
    lastSeenAt?: string | null
  } | null
}

export interface CreateInvitationDto {
  participantName?: string
  customMessage?: string
  visualizerType?: string
  visualizerLocked?: boolean
  expiresInHours?: number
  // Max session duration in seconds (measured from first agent message).
  // null/undefined = no limit (default). Max 7200 (2h).
  maxSessionDurationSeconds?: number | null
}

export interface CreateInvitationResponse {
  invitation: Invitation
  joinUrl: string
}

export interface InvitationDetails {
  participantName: string
  customMessage?: string | null
  visualizerType?: string | null
  visualizerLocked: boolean
  maxSessionDurationSeconds?: number | null
  sessionName?: string | null
  status: InvitationStatus
  // Participant info for rejoin scenarios
  participant?: {
    id: string
    isActive: boolean
  } | null
}

export interface AcceptInvitationResponse {
  participantId: string
  participantName: string
  identity: string
  sessionId: string
  token: string
  connectionInfo: {
    token: string
    serverUrl: string
    roomName: string
  }
  visualizerType?: string | null
  visualizerLocked: boolean
  maxSessionDurationSeconds?: number | null
}

// ============================================================================
// Response Types
// ============================================================================

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  skip: number
  take: number
}

export type SessionsResponse = PaginatedResponse<SessionListItem>

export interface JoinTokenResponse {
  token: string
  serverUrl: string
  roomName: string
}

export interface ParticipantConnectionInfo {
  token: string
  serverUrl: string
  roomName: string
  livekitUrl: string
}

export interface RegisterParticipantResponse {
  id: string
  name: string
  identity: string
  token: string // JWT token for participant authentication
  connectionInfo: ParticipantConnectionInfo
}

export interface ParticipantConnectionInfoResponse {
  participantId: string // Participant ID (returned for mobile client)
  participantName: string
  identity: string
  sessionId: string
  token?: string // JWT token (only included for dashboard requests)
  connectionInfo: ParticipantConnectionInfo
}

export interface DeleteResponse {
  message: string
}

export interface ListenerStatus {
  sessionId: string
  sessionStatus: SessionStatus
  listener: {
    isMonitoring: boolean
    isConnected: boolean
    roomState: string
    participantIdentity: string
    reconnectAttempts: number
    remoteParticipants?: number
  }
}

export interface LogEntry {
  timestamp: string
  level: 'log' | 'debug' | 'warn' | 'error'
  message: string
  sessionId?: string
  data?: any
}

export interface MonitoringLogsResponse {
  logs: LogEntry[]
  total: number
  sessionId: string | null
}

export interface NetworkInfoResponse {
  serverUrl: string
  livekitUrl: string
  frontendUrl: string
  hostname: string
  platform: string
  source: string
  environment: string
  detectedIp: string
}

export interface ApiError {
  statusCode: number
  timestamp: string
  path: string
  message: string | string[]
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_PAGINATION = {
  skip: 0,
  take: 20,
} as const

export const MAX_PAGINATION = {
  take: 100,
} as const

export const POLL_INTERVALS = {
  SESSIONS: 5000, // 5 seconds
  AGENTS: 2000, // 2 seconds
  TIMELINE: 3000, // 3 seconds
} as const

// ============================================================================
// Validation Helpers
// ============================================================================

export const validators = {
  projectName: (name: string): boolean => {
    return name.length >= 1 && name.length <= 255
  },

  identity: (identity: string): boolean => {
    return identity.length >= 1 && identity.length <= 255
  },

  pagination: (skip: number, take: number): boolean => {
    return skip >= 0 && take >= 1 && take <= 100
  },
}

// ============================================================================
// Type Guards
// ============================================================================

export function isApiError(error: any): error is ApiError {
  return (
    error &&
    typeof error.statusCode === 'number' &&
    typeof error.timestamp === 'string' &&
    typeof error.path === 'string' &&
    (typeof error.message === 'string' || Array.isArray(error.message))
  )
}

export function isSessionActive(session: Session): boolean {
  return session.status === SessionStatus.ACTIVE
}

export function isAgentRunning(agent: AgentInstance): boolean {
  return agent.status === AgentStatus.RUNNING
}

// ============================================================================
// Plan Template Types (for Plan Builder)
// Canonical format matching stella-ai-agent-sdk/plan
// ============================================================================

/**
 * State execution mode (matches SDK StateType enum)
 * - sequential: Sequential task processing - one task at a time
 * - NOTE: Renamed from "strict" to "sequential" in UI/types (legacy "strict" still normalized at runtime)
 * - NOTE: Renamed from "loose" to "flexible" in UI/types (legacy "loose" still normalized at runtime)
 * - flexible: Flexible/parallel task processing - any order
 * - goal: Goal-oriented natural conversation - agent sees information gaps, not tasks
 */
export type StateType = 'sequential' | 'flexible' | 'goal'

/**
 * @deprecated Use StateType instead. Kept for backward compatibility.
 */
export type ExecutionMode = 'sequential' | 'flexible'

export type DeliverableType = 'string' | 'number' | 'boolean' | 'enum'

/**
 * A single deliverable within a task.
 * Represents a piece of information to collect from the user.
 */
export interface PlanDeliverable {
  key: string                      // Unique identifier (was: id)
  type: DeliverableType
  description: string              // What to collect (was: label)
  required: boolean
  acceptance_criteria?: string     // What constitutes a valid answer, with examples
  enum_values?: string[]           // For enum type (was: enumValues)
}

/**
 * A task within a state, containing deliverables.
 */
export interface PlanTask {
  id: string
  description: string              // Task title/name (was: label)
  instruction?: string             // Instructions for agent (was: description)
  required: boolean
  deliverables: PlanDeliverable[]
}

// Keep this union aligned with backend StateTransition.condition_type in state-machine.service.ts.
/**
 * Supported transition condition types for state routing.
 *
 * Condition config reference:
 * - all_tasks_complete: no config required
 * - turn_count_exceeded: { turns: number, scope: "without_progress" | "total" }
 * - deliverable_value: { key: string, value: string | number | boolean }
 * - deliverable_value_in: { key: string, values: Array<string | number | boolean> }
 * - deliverable_value_numeric:
 *   - { key: string, operator: "gt"|"gte"|"lt"|"lte"|"eq"|"neq", value: number }
 *   - { key: string, operator: "between", min: number, max: number, inclusive?: boolean }
 * - deliverable_exists: { key: string }
 * - all_of: { conditions: Array<{ condition_type, condition_config }> }
 * - any_of: { conditions: Array<{ condition_type, condition_config }> }
 * - compound: { operator: "and" | "or", conditions: Array<{ condition_type, condition_config }> }
 */
export type StateTransitionConditionType =
  | 'all_tasks_complete'
  | 'goal_achieved'
  | 'turn_count_exceeded'
  | 'deliverable_value'
  | 'deliverable_value_in'
  | 'deliverable_value_numeric'
  | 'compound'
  | 'all_of'
  | 'any_of'
  | 'deliverable_exists'

/**
 * One outgoing transition from a source state to a target state.
 *
 * Evaluation behavior:
 * - Transitions are checked by ascending `priority` (lower number first).
 * - First matched condition wins.
 * - `priority` defaults to backend behavior when omitted.
 */
export interface StateTransition {
  target_state_id: string          // Destination state ID
  condition_type: StateTransitionConditionType
  priority?: number                // Lower value = higher precedence
  condition_config?: Record<string, unknown> // Shape depends on condition_type
}

/**
 * Goal-mode context for natural, goal-oriented conversation states.
 */
export interface StateGoal {
  objective: string
  context?: string
  depth_guidance?: string
  boundaries?: string
  success_description?: string
  deliverables?: PlanDeliverable[]
}

/**
 * A state in the plan, containing tasks.
 */
export interface PlanState {
  id: string
  title: string                    // Display name (was: label)
  type: StateType                  // Processing mode (was: execution_mode)
  description?: string
  tasks: PlanTask[]
  transitions?: StateTransition[]
  goal?: StateGoal                 // Only used when type === 'goal'
}

/**
 * One pre-session input field shown before the conversation starts.
 *
 * Notes:
 * - `options` applies only when `type === "select"`.
 * - `default_value` uses snake_case for SDK compatibility.
 */
export interface SessionContextField {
  id: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  required: boolean
  description?: string
  options?: string[]  // For select type
  default_value?: string | number | boolean  // snake_case for SDK consistency
}

export interface SessionContext {
  fields: SessionContextField[]
}

/**
 * Absolute node position in the Plan Builder canvas.
 */
export interface PlanCanvasPosition {
  x: number
  y: number
}

/**
 * Configuration for the End node, stored in PlanCanvasMetadata.
 * Consumed by the backend when the state machine transitions to the end state.
 */
export interface EndNodeConfig {
  farewell_message?: string            // Final message the agent sends before the session closes
  summary_behavior?: 'none' | 'brief' | 'full'  // Whether to summarize the conversation on exit
}

/**
 * Visual metadata persisted by the Plan Builder canvas.
 *
 * Stored at: `metadata.plan_builder.canvas`
 *
 * Notes:
 * - `end_node_position` is UI layout only.
 * - `end_state_ids` marks states connected to the visual End node.
 * - `end_node_config` configures end-state runtime behavior (farewell, summary).
 */
export interface PlanCanvasMetadata {
  show_end_node?: boolean                               // Whether End node is visible
  end_node_position?: PlanCanvasPosition                // End node canvas coordinates
  end_state_ids?: string[]                              // State IDs connected to End node in UI
  end_node_config?: EndNodeConfig                       // End-state runtime behavior
}

/**
 * Determines when the agent is started for a session.
 * - immediate: start at session creation/start
 * - on_demand: start when interaction begins
 */
export type AgentSpawnMode = 'immediate' | 'on_demand'

/**
 * Start-node metadata persisted by the Plan Builder.
 *
 * Stored at: `metadata.plan_builder.start`
 */
export interface PlanStartMetadata {
  agent_spawn_mode?: AgentSpawnMode
  on_participant_join?: ParticipantEventMessageConfig
  on_participant_left?: ParticipantEventMessageConfig
}

export interface ParticipantEventMessageConfig {
  enabled?: boolean
  message_template?: string
}

/**
 * Optional plan metadata container.
 *
 * Known Plan Builder keys:
 * - `plan_builder.canvas`: visual node/edge layout metadata
 * - `plan_builder.start`: start-node behavior metadata
 */
export interface PlanMetadata {
  nodePositions?: Record<string, PlanCanvasPosition>
  plan_builder?: {
    canvas?: PlanCanvasMetadata
    start?: PlanStartMetadata
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Complete plan content structure.
 *
 * Note: id, title, description, initial_state_id are optional here because
 * they may come from the parent PlanTemplate when stored in the database.
 * When passed to the agent, these should be populated from PlanTemplate fields.
 *
 * Execution-focused fields:
 * - `states`, `initial_state_id`, `system_prompt`, `session_context`
 *
 * Builder metadata:
 * - `metadata.plan_builder.start` for start-node behavior
 * - `metadata.plan_builder.canvas` for visual canvas state
 */
export interface PlanContent {
  id?: string                      // Plan identifier (optional, from template)
  title?: string                   // Plan display name (optional, from template)
  description?: string             // Plan description (optional, from template)
  initial_state_id?: string        // Starting state ID
  states: PlanState[]
  metadata?: PlanMetadata
  // Initial prompt configuration
  system_prompt?: string           // Agent persona (snake_case for SDK consistency)
  session_context?: SessionContext
  /**
   * ISO 639-1 code the conversation is conducted in (e.g. "de"). Absent or
   * "auto" = detect per utterance.
   *
   * This is a declaration, not a hint: it pins Whisper's transcription for the
   * whole session. Worth setting whenever you know — auto-detect runs on a very
   * short window and, guessing wrong, TRANSLATES rather than mis-hears. A German
   * plan opening with "Hi Grace, kannst du mich hören" was transcribed as "Hi
   * Grace, can you hear me?" and never recovered.
   */
  language?: string
}

export interface PlanTemplate {
  id: string
  userId: string
  name: string
  description?: string
  content: PlanContent
  createdAt: string
  updatedAt: string
}

export interface CreatePlanTemplateDto {
  name: string
  description?: string
  content: PlanContent
}

export interface UpdatePlanTemplateDto {
  name?: string
  description?: string
  content?: PlanContent
}

// ============================================================================
// Plan Generator Types (AI-powered plan generation)
// ============================================================================

export interface GeneratePlanTemplateDto {
  prompt: string
  context?: string
}

export interface GeneratePlanTemplateResponse {
  content: PlanContent
  suggestedName: string
  suggestedDescription: string
}

// ============================================================================
// Environment Variable Template Types
// ============================================================================

export interface EnvVarTemplate {
  id: string
  userId: string
  name: string
  description?: string
  variableKeys: string[]  // Only keys, not values (for security)
  agentTypeId: string  // Required: every template is scoped to exactly one agent type
  createdAt: string
  updatedAt: string
}

export interface CreateEnvVarTemplateDto {
  name: string
  description?: string
  variables: Record<string, string>
  agentTypeId: string  // Required
}

export interface UpdateEnvVarTemplateDto {
  name?: string
  description?: string
  // Keys to add or overwrite (merged on top of existing values; untouched keys
  // keep their stored value, so unchanged secrets never need re-entry).
  variables?: Record<string, string>
  // Keys to delete from the template (lets you remove a var without re-typing the
  // secrets you keep).
  removeKeys?: string[]
  // agentTypeId is immutable post-create; duplicate the template to rebind.
}

// ============================================================================
// Agent Requirements (parsed from configSchema)
// ============================================================================

export interface AgentRequirements {
  requiresPlan: boolean
  requiredEnvVars: string[]
  supportsConfigurator: boolean
}

/**
 * Parse agent requirements from configSchema
 * Looks for:
 * - x-stella-requires-plan: true on any property
 * - x-stella-env-vars: ["VAR1", "VAR2"] at root level
 */
export function parseAgentRequirements(
  configSchema: Record<string, unknown> | null | undefined
): AgentRequirements {
  if (!configSchema) {
    return { requiresPlan: false, requiredEnvVars: [], supportsConfigurator: false }
  }

  const properties = (configSchema.properties as Record<string, any>) || {}
  const requiresPlan = Object.values(properties).some(
    (prop: any) => prop?.['x-stella-requires-plan'] === true
  )

  const requiredEnvVars = (configSchema['x-stella-env-vars'] as string[]) || []
  const supportsConfigurator = configSchema['x-stella-supports-configurator'] === true

  return { requiresPlan, requiredEnvVars, supportsConfigurator }
}

/** Declared env var keys an agent type exposes, split by requiredness. */
export interface DeclaredEnvVars {
  required: string[]
  optional: string[]
}

/**
 * Parse the env var keys an agent type declares in its configSchema. Mirrors the
 * backend extractors in src/kubernetes/utils/agent-config-injection.util.ts
 * (extractRequiredEnvVars / extractOptionalEnvVars):
 * - `x-stella-env-vars`          → required keys (string[])
 * - `x-stella-optional-env-vars` → optional specs ({ name, ... }[]) → names
 * Malformed entries are ignored defensively.
 */
export function parseDeclaredEnvVars(
  configSchema: Record<string, unknown> | null | undefined
): DeclaredEnvVars {
  if (!configSchema) return { required: [], optional: [] }

  const rawRequired = configSchema['x-stella-env-vars']
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((v): v is string => typeof v === 'string')
    : []

  const rawOptional = configSchema['x-stella-optional-env-vars']
  const optional = Array.isArray(rawOptional)
    ? rawOptional
        .filter((v): v is { name: string } => typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string')
        .map((v) => v.name)
    : []

  return { required, optional }
}

// ============================================================================
// Public Project Types
// ============================================================================

/**
 * Agent configuration for public projects
 */
export interface PublicAgentConfig {
  name: string
  icon?: string
  plan?: Record<string, unknown>
  config?: Record<string, unknown>
  pipelineConfig?: Record<string, unknown>
  // Preferred: the saved configuration's ID. At spawn the backend resolves it by
  // ID (type/version-checked, defaults-merged). pipelineConfig is kept only as a
  // backward-compatible snapshot for public projects saved before this field.
  agentConfigurationId?: string
  envVarTemplateId?: string
  envVars?: Record<string, string>
}

/**
 * DTO for updating public project configuration
 */
export interface UpdatePublicConfigDto {
  isPublic: boolean
  agentTypeId?: string
  agentConfig?: PublicAgentConfig
  visualizerType?: string
  visualizerLocked?: boolean
  expiresAt?: string
  enabled?: boolean
  // Max session duration in seconds. null = no limit (default). Max 7200 (2h).
  maxSessionDurationSeconds?: number | null
}

/**
 * Public project info returned from GET /p/:publicToken
 */
export interface PublicProjectInfo {
  projectName: string
  agentName: string
  agentIcon?: string
  visualizerType?: string
  visualizerLocked: boolean
  maxSessionDurationSeconds?: number | null
  isExpired: boolean
  isEnabled: boolean
}

/**
 * Response from POST /p/:publicToken/join (blocking/deprecated)
 */
export interface JoinPublicProjectResponse {
  invitationToken: string
  sessionId: string
  agentId: string
}

/**
 * Response from POST /p/:publicToken/start-join (non-blocking)
 * Returns immediately, frontend polls for progress updates
 */
export interface StartJoinPublicProjectResponse {
  sessionId: string
}

/**
 * Response from GET /p/:publicToken/join/:sessionId/status (polling endpoint)
 */
export interface JoinProgressResponse {
  step: number
  totalSteps: number
  status: 'in_progress' | 'complete' | 'failed'
  message: string
  agentId?: string
  invitationToken?: string
  error?: string
}

/**
 * Response from GET /projects/:projectId/public-link
 */
export interface PublicLinkResponse {
  publicLink: string | null
  isEnabled?: boolean
}

/**
 * Extended Project type with public project fields
 */
export interface ProjectWithPublicConfig extends Project {
  isPublic: boolean
  publicToken?: string
  publicAgentTypeId?: string
  publicAgentType?: {
    id: string
    name: string
    slug: string
    icon?: string
  }
  publicAgentConfig?: PublicAgentConfig
  publicVisualizerType?: string
  publicVisualizerLocked: boolean
  publicMaxSessionDurationSeconds?: number | null
  publicExpiresAt?: string
  publicEnabled: boolean
}

// ============================================================================
// User Messaging System Types
// ============================================================================

export enum UserMessageType {
  PROJECT_INVITATION = 'PROJECT_INVITATION',
}

export enum ProjectInvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}

export interface UserMessageMetadata {
  projectId?: string
  projectName?: string
  inviterName?: string
  inviterEmail?: string
  invitationId?: string
}

export interface UserMessage {
  id: string
  type: UserMessageType
  title: string
  body: string | null
  read: boolean
  createdAt: string
  relatedEntityId: string | null
  relatedEntityType: string | null
  metadata?: UserMessageMetadata
}

export interface UnreadCountResponse {
  count: number
}

export interface PaginatedMessagesResponse {
  messages: UserMessage[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// ============================================================================
// Project Collaboration Types
// ============================================================================

export interface Collaborator {
  userId: string
  email: string
  name: string | null
  role: 'OWNER' | 'COLLABORATOR'
  joinedAt: string
}

export interface PendingProjectInvitation {
  invitationId: string
  email: string
  name: string | null
  status: 'PENDING'
  invitedAt: string
}

export interface ProjectCollaboratorsResponse {
  collaborators: Collaborator[]
  pendingInvitations: PendingProjectInvitation[]
}

export interface ProjectInvitationResponse {
  id: string
  projectId: string
  projectName: string
  inviterId: string
  inviterName: string | null
  inviterEmail: string
  inviteeId: string
  inviteeName: string | null
  inviteeEmail: string
  status: string
  createdAt: string
  respondedAt: string | null
}

export interface InviteCollaboratorDto {
  email: string
}

// ============================================================================
// User Notification Event Types (for SSE)
// ============================================================================

export interface UserNotificationEvent {
  type: 'message.created' | 'message.deleted' | 'unread_count.changed'
  userId: string
  message?: UserMessage
  unreadCount?: number
  timestamp: string
}

// ============================================================================
// Transcript Export Types
// ============================================================================

export interface TranscriptExportMeta {
  sessionId: string
  sessionName: string | null
  projectId: string
  projectName: string
  exportedAt: string
  status: 'ACTIVE' | 'CLOSED'
  createdAt: string
  closedAt: string | null
  messageCount: number
  participantCount: number
  deliverableCount?: number
}

export interface TranscriptExportParticipant {
  id: string
  name: string
  identity: string
  joinedAt: string
  leftAt: string | null
}

export interface TranscriptExportAgent {
  id: string
  name: string
  agentType: string | null
  status: string
}

export interface TranscriptExportMessageDeliverable {
  key: string
  value: string
  confidence?: number
  reasoning?: string
}

export interface TranscriptExportMessage {
  id: string
  timestamp: string
  role: string
  messageType: string
  content: string
  speakerName: string | null
  speakerId: string | null
  collectedDeliverables?: TranscriptExportMessageDeliverable[]
}

export interface TranscriptExportDeliverable {
  value: string
  reasoning?: string
  collectedAt?: string
  description?: string
  required?: boolean
}

export interface TranscriptExport {
  meta: TranscriptExportMeta
  participants: TranscriptExportParticipant[]
  agents: TranscriptExportAgent[]
  deliverables?: Record<string, TranscriptExportDeliverable>
  messages: TranscriptExportMessage[]
}

// ============================================================================
// Agent Analytics Types
// ============================================================================

export interface StageLatency {
  stage: string
  count: number
  mean_ms: number
  p5_ms: number
  p25_ms: number
  p50_ms: number
  p75_ms: number
  p95_ms: number
  min_ms: number
  max_ms: number
  stddev_ms: number
}

export interface OutlierStage {
  stage: string
  sessionMean_ms: number
  globalP50_ms: number
}

export interface OutlierSession {
  sessionId: string
  sessionName: string
  createdAt: string
  outlierStages: OutlierStage[]
}

export interface MetricsSummary {
  planCompletion: { totalSessions: number; completedPlans: number; avgCompletionRate: number } | null
  safetyRouting: { totalTurns: number; safeTurns: number; unsafeTurns: number; interceptionRate: number } | null
  stateTransitions: { totalTransitions: number; expectedTransitions: number; accuracy: number } | null
  bridgeGeneration: { totalBridges: number; avgBridgeDuration_ms: number } | null
  bridgeDuration: { count: number; avg_ms: number } | null
  ttfr: { count: number; avg_ms: number } | null
  /** STT decode diagnostics; null unless STT_DECODE_DIAGNOSTICS is enabled. */
  sttDecode: {
    totalTurns: number
    avgSilenceFraction: number | null
    avgNoSpeechWorst: number | null
    avgLogprobWorst: number | null
    shadowTurns: number
    shadowAgreementRate: number | null
    avgShadowEarlier_ms: number | null
    partialTurns: number
    partialAgreementRate: number | null
  } | null
}

export interface AgentMetricsResponse {
  agentSlug: string
  projectId: string
  dateRange: { from: string; to: string }
  totalSessions: number
  totalTurns: number
  stages: StageLatency[]
  outlierSessions: OutlierSession[]
  summary: MetricsSummary
}

export interface StageDataPoint {
  sessionId: string
  sessionName: string
  avg_timing_ms: number
  count: number
  timestamp: string
}

export interface StageDataPointsResponse {
  points: StageDataPoint[]
}

export interface SessionStagePoint {
  stage: string
  timing_ms: number
  timestamp: string
}

export interface SessionAnalyticsResponse {
  sessionId: string
  totalTurns: number
  stages: StageLatency[]
  summary: MetricsSummary
  rawPoints: SessionStagePoint[]
}

export interface PlanCompletionSession {
  sessionId: string
  sessionName: string
  completionRate: number
  reachedEnd: boolean
  timestamp: string
}

export interface PlanCompletionSessionsResponse {
  sessions: PlanCompletionSession[]
}

export interface MetricsTimelinePoint {
  timestamp: string
  timing_ms: number
  sessionId: string
}

export interface MetricsTimelineResponse {
  points: MetricsTimelinePoint[]
}

// ============================================================================
// Admin Dashboard Types
// ============================================================================

export interface AdminDashboardMetrics {
  timestamp: string
  activeParticipants: number
  totalParticipants: number
  activeSessions: number
  totalSessions: number
  runningAgents: number
  startingAgents: number
  failedAgents: number
  pausedAgents: number  // Agents paused due to inactivity
  stoppedAgents: number // Agents that are stopped (not paused)
  totalAgents: number
  totalMessages: number
  messagesToday: number
  // Auto-stop feature metrics
  sessionsWithTimeout: number  // Sessions with inactivity timeout configured
}

export interface SessionActivityDay {
  date: string // YYYY-MM-DD
  activeCount: number
  closedCount: number
  errorCount: number
}

export interface HistoricalUsageData {
  date: string
  sessionsCreated: number
  peakParticipants: number
}

export interface GpuDeviceMetrics {
  index: number
  name: string
  usage: number // Percentage 0-100
  memoryUsed: string // BigInt as string
  memoryTotal: string // BigInt as string
  temperature: number | null // Celsius
}

export interface ServerMetrics {
  timestamp: string
  cpuUsage: number
  cpuCores: number
  memoryTotal: string // BigInt as string
  memoryUsed: string
  memoryFree: string
  gpuUsage: number | null
  gpuMemoryUsed: string | null
  gpuMemoryTotal: string | null
  gpuAvailable: boolean
  gpus: GpuDeviceMetrics[] // Per-GPU metrics for all detected GPUs
  k8sNodeCount: number | null
  k8sPodCount: number | null
  k8sCpuRequests: number | null
  k8sMemoryUsed: string | null
}

export interface AdminUserListItem {
  id: string
  email: string
  name: string | null
  verified: boolean
  isSystemAdmin: boolean
  createdAt: string
  projectCount: number
}

export interface AdminUsersResponse {
  users: AdminUserListItem[]
  total: number
  page: number
  totalPages: number
}

export interface SessionResourceUsage {
  cpuMillicores: number
  memoryBytes: number
  cpuPercent: number
  memoryPercent: number
}

export interface SessionAgentError {
  agentName: string
  status: string
  lastError: string | null
  healthState: string | null
}

export interface SessionStatusItem {
  id: string
  status: string // 'ACTIVE', 'CLOSED'
  hasError: boolean
  isIdle: boolean
  resourceUsage: SessionResourceUsage | null
  hasResourceWarning: boolean
  errors: SessionAgentError[]
  projectId: string
  createdAt: string
}

// ============================================================================
// Agent Configurator Types
// ============================================================================

/** Deterministic action an expert verdict applies to the final response.
 *  Mirrors stella-v2 VerdictDirective.action. */
export type VerdictAction = 'inform' | 'prepend' | 'override' | 'short_circuit'

/** Per-verdict deterministic response directive (a literature-informed template
 *  and the action it takes on the generated response). */
export interface VerdictDirective {
  action: VerdictAction
  template: string
  /** Plain-language explanation of the verdict, handed to the classifying LLM. */
  description?: string
}

/** An agent-declared default expert, as published from config/experts/*.json
 *  (raw snake_case shape mirroring the runtime ExpertConfig). */
export interface ExpertDefault {
  name: string
  description?: string
  priority?: number
  enabled?: boolean
  model?: string
  temperature?: number
  max_tokens?: number
  can_call_functions?: boolean
  system_prompt?: string
  output_format?: string
  output_schema?: Record<string, unknown>
  trigger_criteria?: string
  always_triggered?: boolean
  history_limit?: number
  min_confidence?: number
  verdict_directives?: Record<string, { action?: string; template?: string; description?: string }>
}

export interface ConfigurableSlot {
  id: string
  label: string
  type: 'text' | 'number' | 'select' | 'string_list' | 'key_value' | 'expert_list' | 'verdict_directives'
  description?: string
  default?: unknown
  options?: string[]  // for select type
  min?: number        // for number type
  max?: number        // for number type
  step?: number       // for number type
  maxLength?: number  // for text type
  isCustom?: boolean  // for expert_list type (custom experts)
}

export interface PipelineNode {
  id: string
  label: string
  description?: string
  icon?: string
  position: { row: number; col: number }
  slots: ConfigurableSlot[]
}

export interface PipelineEdge {
  source: string
  target: string
  label?: string
  style?: 'solid' | 'dashed'
}

export interface PipelineThreshold {
  id: string
  label: string
  description?: string
  type: 'number'
  min?: number
  max?: number
  step?: number
  default?: number
}

export interface PipelineSchema {
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  thresholds: PipelineThreshold[]
}

export interface AgentConfigurationPayload {
  nodes?: Record<string, Record<string, unknown>>
  thresholds?: Record<string, unknown>
}

export interface AgentConfiguration {
  id: string
  userId: string
  name: string
  description: string | null
  agentTypeId: string
  agentType?: {
    id: string
    slug: string
    name: string
    icon: string | null
    pipelineSchema?: PipelineSchema | null
  }
  configuration: AgentConfigurationPayload
  agentVersion: string | null
  // Minimum SDK prompt-compiler version this config's prompts require.
  minCompilerVersion: string | null
  // Compatibility of this config with its agent type's current pipeline schema,
  // recomputed by the backend reconciliation pass when the agent type changes.
  compatibility: ConfigCompatibility
  compatibilityNote: string | null
  lastReconciledAt: string | null
  createdAt: string
  updatedAt: string
}

export type ConfigCompatibility = 'CURRENT' | 'COMPATIBLE' | 'OUTDATED'

export interface CreateAgentConfigurationDto {
  name: string
  description?: string
  agentTypeId: string
  configuration: AgentConfigurationPayload
  agentVersion?: string
  // Optional; the backend defaults it to the agent type's current compilerVersion.
  minCompilerVersion?: string
}

export interface UpdateAgentConfigurationDto {
  name?: string
  description?: string
  configuration?: AgentConfigurationPayload
  agentVersion?: string
}

export type PublicHealthComponentStatus = 'operational' | 'degraded' | 'down'

export type PublicHealthComponentId = 'api' | 'database' | 'realtime' | 'stt' | 'tts'

export interface PublicHealthComponent {
  id: PublicHealthComponentId
  status: PublicHealthComponentStatus
  lastCheckedAt: string
}

export interface PublicHealthResponse {
  status: PublicHealthComponentStatus
  components: PublicHealthComponent[]
  generatedAt: string
}

export interface MediaTestSession {
  roomName: string
  publisherToken: string
  listenerToken: string
  livekitUrl: string
  expiresAt: string
  ttlSeconds: number
}
