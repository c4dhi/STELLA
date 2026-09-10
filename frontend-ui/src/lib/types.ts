
export type TurnId = string
export type Role = 'user' | 'assistant' | 'system' | 'other_user'
export type TurnStatus = 'partial' | 'final'

export type MessageSource = 'user_speech' | 'user_text' | 'agent_response'

// Delivery status for user messages (WhatsApp-style checkmarks)
export type DeliveryStatus = 'sending' | 'confirmed'

export interface TranscriptChunk {
  id: TurnId
  role: Role
  text: string
  status: TurnStatus
  startedAt: number
  finalizedAt?: number
  // Attribution fields
  participant_id?: string    // Backwards compat - sender identity
  speaker_id?: string        // Who spoke (for user_speech/user_text)
  speaker_name?: string      // Display name of speaker
  agent_id?: string          // Agent ID (for agent_response)
  agent_name?: string        // Agent display name
  source?: MessageSource     // Message origin: user_speech, user_text, agent_response
  // Delivery tracking for optimistic UI updates
  deliveryStatus?: DeliveryStatus  // 'sending' shows grey checkmarks, 'confirmed' shows solid
  correlationId?: string           // Used to match optimistic message with agent echo
  // The pipeline heard this, showed it, and then decided it was NOT a turn — a
  // backchannel, or an interruption the evaluator judged not actionable. The
  // words were really said so they stay in the transcript; this flag is what
  // lets a reader tell "the agent answered this" from "the agent heard this and
  // moved on", which is otherwise invisible after the fact.
  discarded?: boolean
}

// New message processing stream types
export interface DecisionStreamData {
  step: string
  decision: string
  confidence: number
  timing_ms: number
  metadata: {
    verdict?: 'safe' | 'unsafe'
    route?: string
    intent?: string
    risk_score?: number
    expert_configuration?: {
      experts?: string[]
      reason?: string
      risk_score?: number
      intent?: string
    }
    [key: string]: any
  }
  participant_id: string
  timestamp: string
  stream_id: string
}


export interface PromptExecutionData {
  agent_name: string
  prompt_type: 'system' | 'analysis' | 'execution' | 'synthesis'
  prompt_preview: string
  model: string
  temperature: number
  estimated_duration_ms: number
  participant_id: string
  timestamp: string
  stream_id: string
}

export interface ExpertStatusData {
  expert_name: string
  status: 'started' | 'progress' | 'completed' | 'timeout' | 'error'
  progress_percent?: number
  intermediate_finding?: string
  metadata?: {
    result?: {
      agent_name?: string
      findings?: string
      raw_response?: string
      success?: boolean
    }
    success?: boolean
    error_message?: string
    error_type?: string
  }
  participant_id: string
  timestamp: string
  stream_id: string
}

export interface SafetyCheckData {
  check_type: 'policy' | 'hallucination' | 'pii' | 'risk_assessment'
  status: 'checking' | 'passed' | 'warning' | 'blocked'
  details: string
  participant_id: string
  timestamp: string
  stream_id: string
}

export interface DebugData {
  component: string
  level: 'info' | 'debug' | 'warn' | 'error'
  message: string
  metadata?: Record<string, any>
}

// Processing message types that will be displayed in chat
export type ProcessingMessageType =
  | 'decision'
  | 'prompt_execution'
  | 'expert_status'
  | 'safety_check'
  | 'debug'

export interface ProcessingMessage {
  id: TurnId
  type: ProcessingMessageType
  role: 'system'
  status: TurnStatus
  startedAt: number
  finalizedAt?: number
  streamId: string
  data: DecisionStreamData | PromptExecutionData | ExpertStatusData | SafetyCheckData | DebugData
}

// Participant events for room join/leave notifications
export interface ParticipantEvent {
  id: TurnId
  type: 'joined' | 'left'
  participantId: string
  participantName?: string
  startedAt: number
  messageType: 'participant'
}

/**
 * Teleprompter (#241): an `agent_speech_progress` envelope payload emitted by
 * the SDK as it speaks the reply, mapping the audio playhead to a character
 * span in the published `agent_text`.
 */
export interface AgentSpeechProgress {
  transcript_id?: string
  char_start?: number
  char_end?: number
  spoken_char?: number
  /**
   * Char offset the highlight should reach by the end of this segment. While a
   * sentence is still synthesizing it stops short of `char_end` — only the last
   * tick of a sentence reaches it. Absent on older SDKs, where `char_end` is
   * the only target available.
   */
  target_char?: number
  duration_ms?: number
  delay_ms?: number
  /** 'speaking' | 'spoken' | 'interrupted' */
  state?: string
}

/**
 * Barge-in (#15): an `agent_playback` envelope. A teleprompter-independent
 * signal emitted by the SDK whenever agent playback is interrupted/resumed, so
 * the client can silence the agent track on barge-in even when the teleprompter
 * is disabled. Carries only the playback state — no highlight char offsets.
 */
export interface AgentPlaybackState {
  /** 'speaking' | 'interrupted' */
  state?: string
}

export interface TransportEvents {
  onConnected: () => void
  onDisconnected: (reason?: string) => void
  onError: (err: Error) => void
  onRemoteAudioTrack: (track: MediaStreamTrack) => void
  onTranscript: (chunk: TranscriptChunk) => void
  /** Teleprompter (#241): word-by-word speech-progress for the agent's reply. */
  onSpeechProgress: (data: AgentSpeechProgress) => void
  onProcessingMessage: (message: ProcessingMessage) => void
  onServerMessage: (msg: unknown) => void
  onTTSStart: () => void
  onTTSStop: () => void
  onTodoListUpdate: (data: CompleteTodoListMessage) => void
  onPlanProgress: (data: PlanProgressUpdate) => void
  onDeliverableUpdate: (data: PlanDeliverableUpdate) => void
  onStateChange: (data: StateChangeNotification) => void
  onParticipantJoined: (participantId: string, participantName?: string, isExisting?: boolean) => void
  onParticipantLeft: (participantId: string, participantName?: string) => void
  onLLMConfig: (config: any) => void
  onAudioLevel: (level: number) => void
  onRemoteSpeaking: (speaking: boolean) => void
  onProgressUpdate: (data: ProgressUpdateMessage) => void
}

export interface Transport extends TransportEvents {
  connect: (roomName?: string) => Promise<void>
  disconnect: () => Promise<void>
  sendUserText: (text: string, correlationId?: string) => void
  sendControl: (kind: string, payload?: unknown) => void
  attachMicStream: (stream: MediaStream) => void
  publishAudioTrack: (stream: MediaStream) => Promise<boolean>
  unpublishAudioTrack: () => Promise<void>
  setUserName: (name: string) => void
  // Connection state helpers
  isConnectedToRoom: (roomName: string) => boolean
  getConnectionState: () => 'idle' | 'connecting' | 'connected' | 'disconnecting'
  getCurrentRoomName: () => string | undefined
  // Audio analysis control (for face modal reactivity)
  resumeAudioAnalysis: () => Promise<void>
  // Enable/disable the audio-level analysis loop. Toggled on Face-modal open/close so the
  // 30 fps RMS loop (and its store writes) don't run while nothing renders the level (#305).
  setAudioAnalysisActive: (active: boolean) => void
}

export type EnvelopeType =
  | 'user_text'
  | 'barge_in'
  | 'heartbeat'
  | 'transcript'
  | 'transcript_chunk'
  | 'agent_text'
  | 'agent_speech_progress'
  | 'agent_playback'
  | 'system'
  | 'audio_data'
  | 'audio_stream_start'
  | 'audio_stream_chunk'
  | 'audio_stream_stop'
  | 'decision_stream'
  | 'progress_stream'
  | 'prompt_execution'
  | 'expert_status'
  | 'safety_check'
  | 'debug'
  | 'tts_start'
  | 'tts_stop'
  | 'tts_end'
  | 'tts_pause'
  | 'tts_resume'
  | 'tts_paused'
  | 'tts_resumed'
  | 'complete_todo_list'
  | 'plan_progress_update'
  | 'plan_deliverable_update'
  | 'state_change_notification'
  | 'task_progress_update'
  | 'llm_config'
  | 'progress_update'

export interface Envelope<T> {
  type: EnvelopeType
  data: T
  participant_id?: string  // Optional sender identity for data packets
}

// State Machine Architecture Types
export enum StateType {
  SEQUENTIAL = "sequential", // Renamed from "strict" (UI canonical value)
  FLEXIBLE = "flexible", // Renamed from "loose" (UI canonical value)
  GOAL = "goal"         // Goal-oriented natural conversation
}

export enum TaskStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  SKIPPED = "skipped"
}

export enum StateStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed"
}

export enum DeliverableStatus {
  PENDING = "pending",
  PARTIAL = "partial",
  COMPLETED = "completed",
  SKIPPED = "skipped"
}

export interface Deliverable {
  key: string
  type: 'string' | 'enum' | 'boolean' | 'number'
  description: string
  required: boolean
  enum_values?: string[]
  validation_pattern?: string
  acceptance_criteria?: string
}

export interface DeliverableState {
  deliverable: Deliverable
  status: DeliverableStatus
  value: any
  collected_at: string | null
  source_message?: string
  confidence: number
  reasoning?: string  // LLM explanation for why acceptance criteria was met
}

export interface Task {
  id: string
  description: string
  instruction: string
  required: boolean
  deliverables: Deliverable[]
  dependencies?: string[]
  status: TaskStatus
}

export interface StateTransition {
  target_state_id: string
  condition_type: string
  condition_data?: any
  priority: number
}

export interface State {
  id: string
  title: string
  type: StateType
  description: string
  tasks: Task[]
  transitions: StateTransition[]
  status?: StateStatus
  is_current?: boolean
  completed_at?: string
}

export interface Plan {
  id: string
  title: string
  description: string
  initial_state_id: string
  states: State[]
  metadata: {
    architecture: "state_machine"
    states_count: number
    tasks_count: number
    deliverables_count: number
  }
}

// Legacy support - keep for backward compatibility but mark as deprecated
/** @deprecated Use State instead */
export interface PlanStep {
  id: string
  type: 'Question' | 'Statement'
  title: string
  instruction: string
  deliverables: Deliverable[]
  auto_advance: boolean
}

export type StepStatus = 'not_started' | 'in_progress' | 'waiting_for_info' | 'completed' | 'skipped'

/** @deprecated Use State-based TodoList instead */
export interface TodoListStep {
  id: string
  title: string
  description: string
  status: StepStatus
  is_current: boolean
  created_at: string
  updated_at: string
  completed_at?: string
  expert_analysis_needed: boolean
  expert_findings_count: number
  deliverables: Array<{
    key: string
    description: string
    type: string
    required: boolean
    status: 'pending' | 'partial' | 'completed' | 'skipped'
    value?: any
    collected_at?: string | null
    confidence?: number
    reasoning?: string
  }>
  tasks: any[]
  metadata: Record<string, any>
  step_number?: number
}

export interface TodoList {
  initialized: boolean
  first_state_activated_at: string
  total_states: number
  current_state_index: number
  completed_states: number
  remaining_states: number
  progress_percentage: number
  agentIcon?: string  // Optional emoji icon for the agent
  current_state: {
    id: string
    title: string
    type: StateType
    description: string
    status: StateStatus
    state_number: number
    is_complete: boolean
  } | null
  current_task: {
    id: string
    description: string
    instruction: string
    required: boolean
    status: TaskStatus
  } | null
  states: Array<{
    id: string
    title: string
    type: StateType
    description: string
    status: StateStatus
    is_current: boolean
    completed_at?: string
    transitions?: Array<{
      target_state_id: string
      condition_type: string
      priority?: number
      condition_config?: Record<string, any>
    }>
    tasks: Array<{
      id: string
      description: string
      instruction: string
      required: boolean
      status: TaskStatus
      deliverables: Array<{
        key: string
        description: string
        type: string
        required: boolean
        status: DeliverableStatus
        value?: any
        collected_at?: string | null
        confidence?: number
        reasoning?: string
        acceptance_criteria?: string
      }>
    }>
  }>
  tasks_summary: {
    total_tasks: number
    completed_tasks: number
    pending_tasks: number
    current_tasks: number
  }
  conversation_age_minutes: number
  last_updated: string
  last_transition?: {
    from_state_id?: string
    to_state_id?: string
    condition_type?: string
    condition_config?: Record<string, any>
    priority?: number
  } | null

  // Legacy support
  /** @deprecated Use states instead */
  steps?: TodoListStep[]
  /** @deprecated Use current_state instead */
  current_step?: {
    id: string
    title: string
    description: string
    status: StepStatus
    step_number: number
  } | null
}

export interface CompleteTodoListMessage {
  conversation_id: string
  todo_list: TodoList
  all_deliverable_states: Record<string, {
    state_title: string
    deliverables: Record<string, {
      description: string
      type: string
      required: boolean
      status: DeliverableStatus
      value: any
      collected_at: string | null
      confidence: number
      acceptance_criteria?: string
      reasoning?: string
    }>
  }>
  remaining_states_count: number
  context: {
    plan_id: string
    plan_title: string
    todo_list_initialized: boolean
    first_state_activated_at: string
    current_processing_mode: StateType
  }
  metadata: {
    created_at: string
    state_order: string[]
    architecture: "state_machine"
    states_count: number
    tasks_count: number
    deliverables_count: number
  }
  update_trigger: 'turn_completion' | 'first_message' | 'state_change' | 'task_update' | 'safe_route_completed' | 'unsafe_route_completed'
  participant_id: string
  timestamp: string
  stream_id: string
}

export interface PlanProgressUpdate {
  session_id: string
  progress: {
    total_states: number
    completed_states: number
    current_state_index: number
    percentage: number
  }
  current_state: {
    id: string
    title: string
    type: StateType
    status: StateStatus
  }
  deliverables: Record<string, {
    description: string
    type: string
    required: boolean
    status: DeliverableStatus
    value: any
    collected_at: string | null
    confidence?: number
    source_message?: string
    reasoning?: string
    acceptance_criteria?: string
  }>
  participant_id: string
  timestamp: string
  stream_id: string
}

export interface PlanDeliverableUpdate {
  session_id: string
  deliverable_key: string
  deliverable_value: any
  state_id: string
  reasoning: string  // Now required - LLM explanation for collection
  confidence: number // Now required - confidence score
  acceptance_criteria: string // Now required - criteria that was met
  source_message?: string
  status?: DeliverableStatus
  participant_id: string
  timestamp: string
  stream_id: string
}

export interface StateChangeNotification {
  previous_state: string
  current_state: string
  state_title: string
  state_description: string
  action_taken: string
  participant_id: string
  timestamp: string
  stream_id: string
}

// Legacy support
/** @deprecated Use StateChangeNotification instead */
export interface StepChangeNotification {
  previous_step: string
  current_step: string
  step_title: string
  step_description: string
  action_taken: string
  participant_id: string
  timestamp: string
  stream_id: string
}

// ============================================================================
// Generic Progress Types (from SDK)
// These are the new, agent-agnostic progress tracking types
// ============================================================================

export enum ExecutionMode {
  SEQUENTIAL = "sequential",  // Tasks must be completed in order
  FLEXIBLE = "flexible"       // Agent decides order based on conversation
}

export enum ProgressItemStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  SKIPPED = "skipped"
}

export enum ProgressGroupStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed"
}

export interface ProgressItem {
  id: string
  label: string
  status: ProgressItemStatus | string
  description?: string
  required: boolean
  value?: any
  confidence?: number
  collected_at?: string | null
  metadata?: Record<string, any>
}

export interface ProgressGroup {
  id: string
  label: string
  execution_mode: ExecutionMode | string
  status: ProgressGroupStatus | string
  items: ProgressItem[]
  is_current: boolean
  description?: string
  completed_at?: string | null
  metadata?: Record<string, any>
}

export interface ProgressState {
  groups: ProgressGroup[]
  current_group_id?: string
  current_item_id?: string
  progress_percentage: number
  elapsed_minutes: number
  started_at?: string
  last_updated?: string
  metadata?: Record<string, any>
}

export interface ProgressUpdateMessage {
  groups: ProgressGroup[]
  current_group_id?: string
  current_item_id?: string
  progress_percentage: number
  elapsed_minutes: number
  started_at?: string
  last_updated?: string
  update_trigger: string
  timestamp: string
  metadata?: Record<string, any>
}
