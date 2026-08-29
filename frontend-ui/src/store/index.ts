
import { create } from 'zustand'
import { generateUUID } from '../lib/uuid'
import type {
  TranscriptChunk,
  AgentSpeechProgress,
  AgentEmotionCues,
  Transport,
  ProcessingMessage,
  ParticipantEvent,
  TodoList,
  PlanProgressUpdate,
  CompleteTodoListMessage,
  StateChangeNotification,
} from '../lib/types'
import { StateType, StateStatus, TaskStatus, DeliverableStatus } from '../lib/types'
import { apiClient } from '../services/ApiClient'
import { PeerTransport } from '../services/PeerTransport'
import { progressUpdateToTodoList } from '../lib/progressConversion'

type ConnectionState = {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  rttMs?: number
  error?: string
  transport: Transport  // No longer optional - always available
}
type ConnectionActions = {
  setStatus: (s: ConnectionState['status']) => void
  setRtt: (ms?: number) => void
  setError: (e?: string) => void
  setTransport: (t: Transport) => void
}

type MediaState = {
  micGranted: boolean
  vu: number
  vadEnabled: boolean
  playing: boolean
  isPushToTalkActive: boolean
  isRecording: boolean
  isMuted: boolean
  isTTSPlaying: boolean
  isTTSPaused: boolean
  // Face interface state
  isFaceModalOpen: boolean
  audioLevel: number
  isRemoteSpeaking: boolean
  // Emotion tags (#face-emotions): what the face is currently doing. Resolved
  // from the emotion cues by whichever view owns the teleprompter cursor, and
  // published here because the face renders in a SIBLING subtree (the visualizer)
  // rather than under that view. Low-frequency — a few changes per turn.
  faceExpression: string | null
  /** One-shot gesture. The seq is what makes a repeat of the same tag fire again. */
  faceGesture: { tag: string; seq: number } | null
  // Agent readiness state - controls audio processing
  agentReady: boolean
}
type MediaActions = {
  setMicGranted: (v: boolean) => void
  setVu: (v: number) => void
  setVadEnabled: (v: boolean) => void
  setPlaying: (v: boolean) => void
  setPushToTalkActive: (v: boolean) => void
  setIsRecording: (v: boolean) => void
  setIsMuted: (v: boolean) => void
  setTTSPlaying: (v: boolean) => void
  setTTSPaused: (v: boolean) => void
  // Face interface actions
  setFaceModalOpen: (v: boolean) => void
  setFaceExpression: (tag: string | null) => void
  triggerFaceGesture: (tag: string) => void
  setAudioLevel: (v: number) => void
  setIsRemoteSpeaking: (v: boolean) => void
  // Agent readiness action
  setAgentReady: (v: boolean) => void
}

type LLMConfigState = {
  llmConfig: {
    provider: string
    model: string
    base_url?: string
    temperature: number
    max_tokens: number
    streaming: boolean
  } | null
}
type LLMConfigActions = {
  setLLMConfig: (config: LLMConfigState['llmConfig']) => void
}

type ChatState = {
  turns: TranscriptChunk[]
  processingMessages: ProcessingMessage[]
  participantEvents: ParticipantEvent[]
  showProcessingMessages: boolean
  lastAssistantMessageId?: string  // Track last assistant message ID to detect new messages

  // Teleprompter (#241): latest agent_speech_progress envelope, bridged from the
  // transport to the view that renders the word-by-word highlight. Discrete and
  // low-frequency (a few per turn); the 60fps cursor lives in useTeleprompter.
  lastSpeechProgress: { data: AgentSpeechProgress; seq: number } | null

  // Emotion tags (#face-emotions): latest agent_emotion_cues envelope, bridged
  // the same way. Carries the full cue list for its transcript, so applying the
  // newest one is always correct.
  lastEmotionCues: { data: AgentEmotionCues; seq: number } | null

  // Optimistic message tracking - correlationIds of messages awaiting confirmation
  pendingMessageIds: Set<string>

  // Historical messages from database
  historicalMessages: any[]
  isLoadingHistory: boolean
  hasMoreHistory: boolean
  historyCursor: string | null
  historicalMessagesLoadAttempted: Map<string, boolean>  // Track which sessions have attempted load
}
type ChatActions = {
  upsertChunk: (c: TranscriptChunk) => void
  setSpeechProgress: (data: AgentSpeechProgress) => void
  setEmotionCues: (data: AgentEmotionCues) => void
  addFinal: (role: TranscriptChunk['role'], text: string) => void
  addProcessingMessage: (message: ProcessingMessage) => void
  addParticipantEvent: (event: ParticipantEvent) => void
  setShowProcessingMessages: (show: boolean) => void
  clear: () => void

  // Optimistic message actions
  addOptimisticMessage: (chunk: TranscriptChunk) => void
  confirmMessage: (correlationId: string) => void

  // Historical message actions
  loadHistoricalMessages: (sessionId: string) => Promise<void>
  loadMoreHistory: (sessionId: string) => Promise<void>
  clearHistory: () => void
}

interface UpdateNotification {
  id: string
  type: 'deliverable_collected' | 'state_changed' | 'task_completed' | 'progress_updated'
  title: string
  message: string
  timestamp: string
  data?: any
  read: boolean
  importance: 'low' | 'medium' | 'high'
}

interface RecentUpdate {
  id: string
  type: 'deliverable' | 'state' | 'task' | 'progress'
  description: string
  timestamp: string
  data: any
}

type TaskState = {
  // Multi-agent task lists: agentId -> TodoList
  agentTaskLists: Map<string, TodoList & { agentName?: string }>

  // Legacy support (uses first agent's data)
  todoList: TodoList | null
  deliverables: Record<string, any>
  allDeliverableStates: Record<string, {
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
  planProgress: number
  currentStateId: string | null
  currentTaskId: string | null
  processingMode: StateType | null
  showTaskPanel: boolean
  lastDeliverableUpdate: {
    key: string
    value: any
    confidence: number
    reasoning?: string
    acceptance_criteria?: string
    state_id?: string
    timestamp: string
  } | null
  lastStateChange: {
    previous_state: string
    current_state: string
    state_title: string
    timestamp: string
  } | null
  // New notification and update tracking
  notifications: UpdateNotification[]
  recentUpdates: RecentUpdate[]
  focusMode: boolean
  lastUpdateTimestamp: string | null

  // Task timeline for time machine feature
  taskUpdateHistory: Array<{
    timestamp: number
    messageId: string
    agentId: string
    agentName?: string
    todoList: TodoList
  }>
  isTaskPanelInHistoryMode: boolean
  currentHistoricalTimestamp: number | null
  // Per-card hide/show (soft hide — data preserved in timeline)
  hiddenAgentIds: Set<string>
}
type TaskActions = {
  // Multi-agent actions
  setAgentTaskList: (agentId: string, todoList: TodoList, agentName?: string) => void
  removeAgentTaskList: (agentId: string) => void
  hideAgentTaskList: (agentId: string) => void
  unhideAgentTaskList: (agentId: string) => void
  removeAgentFromTimeline: (agentId: string) => void
  addLiveTaskUpdate: (agentId: string, todoList: TodoList, agentName?: string) => void

  // Legacy actions (for backward compatibility)
  setTodoList: (todoList: TodoList) => void
  setAllDeliverableStates: (states: TaskState['allDeliverableStates']) => void
  updateDeliverable: (key: string, value: any, stateId?: string, confidence?: number, sourceMessage?: string, reasoning?: string, acceptanceCriteria?: string) => void
  setProgress: (progress: number) => void
  updateStateStatus: (stateId: string, status: StateStatus) => void
  updateTaskStatus: (stateId: string, taskId: string, status: TaskStatus) => void
  setCurrentState: (stateId: string | null, taskId?: string | null) => void
  setProcessingMode: (mode: StateType | null) => void
  handleStateChange: (data: StateChangeNotification) => void
  setShowTaskPanel: (show: boolean) => void
  clearTasks: () => void
  // New notification and update actions
  addNotification: (notification: Omit<UpdateNotification, 'id' | 'timestamp' | 'read'>) => void
  markNotificationRead: (id: string) => void
  clearNotifications: () => void
  addRecentUpdate: (update: Omit<RecentUpdate, 'id' | 'timestamp'>) => void
  setFocusMode: (enabled: boolean) => void
  updateLastTimestamp: () => void
  // Task timeline actions for time machine feature
  buildTaskUpdateTimeline: (messages: any[]) => void
  applyLatestTaskState: () => void
  applyTaskStateAtTime: (timestamp: number) => void
  setTaskHistoryMode: (enabled: boolean, timestamp?: number | null) => void
  clearTaskTimeline: () => void
}

export const useStore = create<
  ConnectionState & ConnectionActions & MediaState & MediaActions & LLMConfigState & LLMConfigActions & ChatState & ChatActions & TaskState & TaskActions
>((set, get) => ({
  // connection
  status: 'idle',
  transport: new PeerTransport(), // Create transport immediately during store initialization
  setStatus: (s) => set({ status: s }),
  setRtt: (rttMs) => set({ rttMs }),
  setError: (error) => set({ error }),
  setTransport: (transport) => set({ transport }),

  // media
  micGranted: false,
  vu: 0,
  vadEnabled: true,
  playing: false,
  isPushToTalkActive: false,
  isRecording: false,
  isMuted: true, // Default to muted
  isTTSPlaying: false,
  isTTSPaused: false,
  isFaceModalOpen: false,
  audioLevel: 0,
  isRemoteSpeaking: false,
  faceExpression: null,
  faceGesture: null,
  agentReady: false, // Audio disabled until agent is ready
  setMicGranted: (v) => set({ micGranted: v }),
  setVu: (v) => set({ vu: v }),
  setVadEnabled: (v) => set({ vadEnabled: v }),
  setPlaying: (v) => set({ playing: v }),
  setPushToTalkActive: (v) => set({ isPushToTalkActive: v }),
  setIsRecording: (v) => set({ isRecording: v }),
  setIsMuted: (v) => set({ isMuted: v }),
  setTTSPlaying: (v) => set({ isTTSPlaying: v }),
  setTTSPaused: (v) => set({ isTTSPaused: v }),
  setFaceModalOpen: (v) => set({ isFaceModalOpen: v }),
  setFaceExpression: (tag) => set(s => (s.faceExpression === tag ? s : { faceExpression: tag })),
  triggerFaceGesture: (tag) => set(s => ({
    faceGesture: { tag, seq: (s.faceGesture?.seq ?? 0) + 1 },
  })),
  setAudioLevel: (v) => set({ audioLevel: v }),
  setIsRemoteSpeaking: (v) => set({ isRemoteSpeaking: v }),
  setAgentReady: (v) => set({ agentReady: v }),

  // llm config
  llmConfig: null,
  setLLMConfig: (config) => set({ llmConfig: config }),

  // chat
  turns: [],
  processingMessages: [],
  participantEvents: [],
  showProcessingMessages: false,
  lastAssistantMessageId: undefined,
  lastSpeechProgress: null,
  lastEmotionCues: null,
  pendingMessageIds: new Set<string>(),
  // Teleprompter (#241): record the latest progress envelope with a monotonic
  // seq so a useEffect in the consuming view applies each one exactly once.
  setSpeechProgress: (data) => set(s => ({
    lastSpeechProgress: { data, seq: (s.lastSpeechProgress?.seq ?? 0) + 1 },
  })),
  setEmotionCues: (data) => set(s => ({
    lastEmotionCues: { data, seq: (s.lastEmotionCues?.seq ?? 0) + 1 },
  })),
  upsertChunk: (c) => set(() => {
    const state = get()
    const existing = state.turns
    let next
    let newPendingIds = state.pendingMessageIds

    // Check if this is an echo of a pending optimistic message
    // Agent echoes back user_text messages with the same correlationId
    if (c.role === 'user' && c.source === 'user_text' && c.correlationId && state.pendingMessageIds.has(c.correlationId)) {
      // Find the existing optimistic message by correlationId
      const optimisticIdx = existing.findIndex(t => t.correlationId === c.correlationId)
      if (optimisticIdx >= 0) {
        // Update the optimistic message's delivery status to confirmed
        next = [...existing]
        next[optimisticIdx] = {
          ...next[optimisticIdx],
          deliveryStatus: 'confirmed' as const,
        }
        // Remove from pending set
        newPendingIds = new Set(state.pendingMessageIds)
        newPendingIds.delete(c.correlationId)
        return { turns: next.slice(-50), pendingMessageIds: newPendingIds }
      }
    }

    // Normal upsert logic
    const idx = existing.findIndex(t => t.id === c.id)

    // Check if this is a new assistant message (different ID from last one)
    const isNewAssistantMessage = c.role === 'assistant' &&
                                 c.id !== state.lastAssistantMessageId &&
                                 state.lastAssistantMessageId !== undefined

    // If it's a new assistant message and TTS is paused, reset TTS state for new message
    if (isNewAssistantMessage && state.isTTSPaused) {
      // Reset TTS state for new message (abandon old TTS playback, not message content)
      set({
        isTTSPaused: false,
        isTTSPlaying: false  // Will be set to true when new message TTS starts
      })
    }

    if (idx >= 0) {
      next = [...existing];
      // Replace with new chunk (SDK sends accumulated text)
      next[idx] = c
    } else {
      next = [...existing, c]
    }

    // Update last assistant message ID when we see an assistant message
    const newState: any = { turns: next.slice(-50) }
    if (c.role === 'assistant') {
      newState.lastAssistantMessageId = c.id
    }

    return newState
  }),

  // Optimistic message handling - add message immediately with 'sending' status
  addOptimisticMessage: (chunk) => set(() => {
    const state = get()
    const next = [...state.turns, chunk]
    const newPendingIds = new Set(state.pendingMessageIds)
    if (chunk.correlationId) {
      newPendingIds.add(chunk.correlationId)
    }
    return {
      turns: next.slice(-50),
      pendingMessageIds: newPendingIds,
    }
  }),

  // Manually confirm a message by its correlationId
  confirmMessage: (correlationId) => set(() => {
    const state = get()
    const newPendingIds = new Set(state.pendingMessageIds)
    newPendingIds.delete(correlationId)

    // Update the message's delivery status
    const turns = state.turns.map(turn => {
      if (turn.correlationId === correlationId) {
        return { ...turn, deliveryStatus: 'confirmed' as const }
      }
      return turn
    })

    return { turns, pendingMessageIds: newPendingIds }
  }),
  addFinal: (role, text) => set(() => {
    const chunk: TranscriptChunk = {
      id: generateUUID(),
      role, text, status: 'final', startedAt: Date.now(), finalizedAt: Date.now()
    }
    const next = [...get().turns, chunk]
    return { turns: next.slice(-50) }
  }),
  addProcessingMessage: (message) => set(() => {
    const existing = get().processingMessages
    const next = [...existing, message]
    return { processingMessages: next.slice(-100) } // Keep last 100 processing messages
  }),
  addParticipantEvent: (event) => set(() => {
    const existing = get().participantEvents
    const next = [...existing, event]
    return { participantEvents: next.slice(-50) } // Keep last 50 participant events
  }),
  setShowProcessingMessages: (show) => set({ showProcessingMessages: show }),
  clear: () => set(() => { return { turns: [], processingMessages: [], participantEvents: [], pendingMessageIds: new Set<string>() } }),

  // historical messages
  historicalMessages: [],
  isLoadingHistory: false,
  hasMoreHistory: false,
  historyCursor: null,
  historicalMessagesLoadAttempted: new Map(),

  loadHistoricalMessages: async (sessionId: string) => {
    const { isLoadingHistory, historicalMessagesLoadAttempted } = get()

    // Prevent duplicate loads for the same session
    if (isLoadingHistory || historicalMessagesLoadAttempted.get(sessionId)) {
      console.debug('[Store] Skipping duplicate load for session', sessionId)
      return
    }

    console.log('[Store] Loading historical messages for session', sessionId)

    // Mark this session as load attempted
    const newAttemptedMap = new Map(historicalMessagesLoadAttempted)
    newAttemptedMap.set(sessionId, true)

    set({
      isLoadingHistory: true,
      historicalMessagesLoadAttempted: newAttemptedMap,
    })

    try {
      const result = await apiClient.getSessionMessages(sessionId, { limit: 200, includeDebug: true })

      // If no messages returned, stop pagination
      const hasMore = result.messages.length > 0 ? result.hasMore : false

      console.log('[Store] Loaded', result.messages.length, 'messages, hasMore:', hasMore)

      set({
        historicalMessages: result.messages,
        hasMoreHistory: hasMore,
        historyCursor: result.nextCursor,
        isLoadingHistory: false,
      })
    } catch (error) {
      console.error('[Store] Failed to load historical messages:', error)
      set({ isLoadingHistory: false, hasMoreHistory: false })
    }
  },

  loadMoreHistory: async (sessionId: string) => {
    const { historyCursor, isLoadingHistory } = get()

    if (!historyCursor || isLoadingHistory) {
      return
    }

    set({ isLoadingHistory: true })

    try {
      const result = await apiClient.getSessionMessages(sessionId, {
        cursor: historyCursor,
        limit: 200,
        includeDebug: true,
      })

      // If no messages returned, stop pagination
      const hasMore = result.messages.length > 0 ? result.hasMore : false

      set((state) => ({
        historicalMessages: [...result.messages, ...state.historicalMessages],
        hasMoreHistory: hasMore,
        historyCursor: result.nextCursor,
        isLoadingHistory: false,
      }))
    } catch (error) {
      console.error('Failed to load more historical messages:', error)
      set({ isLoadingHistory: false })
    }
  },

  clearHistory: () => {
    console.log('[Store] Clearing history')
    set({
      historicalMessages: [],
      isLoadingHistory: false,
      hasMoreHistory: false,
      historyCursor: null,
      historicalMessagesLoadAttempted: new Map(),
    })
  },

  // tasks
  agentTaskLists: new Map(),
  todoList: null,
  deliverables: {},
  allDeliverableStates: {},
  planProgress: 0,
  currentStateId: null,
  currentTaskId: null,
  processingMode: null,
  showTaskPanel: false,
  lastDeliverableUpdate: null,
  lastStateChange: null,
  // New notification and update tracking
  notifications: [],
  recentUpdates: [],
  focusMode: false,
  lastUpdateTimestamp: null,
  // Task timeline for time machine feature
  taskUpdateHistory: [],
  isTaskPanelInHistoryMode: false,
  currentHistoricalTimestamp: null,
  hiddenAgentIds: new Set<string>(),

  // Multi-agent actions
  setAgentTaskList: (agentId, todoList, agentName) => set((state) => {
    const newMap = new Map(state.agentTaskLists)
    const isUpdate = state.agentTaskLists.has(agentId)
    newMap.set(agentId, { ...todoList, agentName })

    console.log(`[TaskPanel] ${isUpdate ? 'Updated' : 'Added'} task list for agent "${agentName || agentId}"`)

    return {
      agentTaskLists: newMap,
      showTaskPanel: true,
      // Set first agent as legacy todoList for backward compat
      todoList: state.todoList || todoList
    }
  }),

  removeAgentTaskList: (agentId) => set((state) => {
    const newMap = new Map(state.agentTaskLists)
    newMap.delete(agentId)
    return {
      agentTaskLists: newMap,
      showTaskPanel: newMap.size > 0
    }
  }),

  hideAgentTaskList: (agentId) => set((state) => {
    const newHidden = new Set(state.hiddenAgentIds)
    newHidden.add(agentId)
    const newMap = new Map(state.agentTaskLists)
    newMap.delete(agentId)
    return {
      hiddenAgentIds: newHidden,
      agentTaskLists: newMap,
      showTaskPanel: newMap.size > 0
    }
  }),

  unhideAgentTaskList: (agentId) => set((state) => {
    const newHidden = new Set(state.hiddenAgentIds)
    newHidden.delete(agentId)

    // Re-add the agent's latest data from taskUpdateHistory
    const newMap = new Map(state.agentTaskLists)
    const agentUpdates = state.taskUpdateHistory.filter(u => u.agentId === agentId)
    if (agentUpdates.length > 0) {
      const latest = agentUpdates[agentUpdates.length - 1]
      newMap.set(agentId, { ...latest.todoList, agentName: latest.agentName })
    }

    return {
      hiddenAgentIds: newHidden,
      agentTaskLists: newMap,
      showTaskPanel: true
    }
  }),

  removeAgentFromTimeline: (agentId) => set((state) => {
    const newTimeline = state.taskUpdateHistory.filter(u => u.agentId !== agentId)
    const newMap = new Map(state.agentTaskLists)
    newMap.delete(agentId)
    const newHidden = new Set(state.hiddenAgentIds)
    newHidden.delete(agentId)
    return {
      taskUpdateHistory: newTimeline,
      agentTaskLists: newMap,
      hiddenAgentIds: newHidden,
      showTaskPanel: newMap.size > 0
    }
  }),

  addLiveTaskUpdate: (agentId, todoList, agentName) => {
    const timestamp = Date.now()
    const messageId = `live-${timestamp}`

    // Add to timeline for time travel (with deduplication)
    set((state) => {
      // Check if this update is already in timeline (from history)
      // Avoid duplicates by checking if a similar update exists within 1 second
      const exists = state.taskUpdateHistory.some(u =>
        u.agentId === agentId &&
        Math.abs(u.timestamp - timestamp) < 1000
      )

      if (exists) {
        console.log('[TaskTimeline] Skipping duplicate live update in timeline')
        return {}
      }

      // Add to timeline
      const newTimeline = [
        ...state.taskUpdateHistory,
        {
          timestamp,
          messageId,
          agentId,
          agentName,
          todoList
        }
      ].sort((a, b) => a.timestamp - b.timestamp)

      console.log('[TaskTimeline] Added live update to timeline, total:', newTimeline.length)
      return { taskUpdateHistory: newTimeline }
    })

    // Update current display (this will UPDATE existing agent if exists, not create duplicate)
    // Map.set() replaces the value if the key already exists
    get().setAgentTaskList(agentId, todoList, agentName)
  },

  setTodoList: (todoList) => set({
    todoList,
    showTaskPanel: true,
    planProgress: todoList.progress_percentage,
    currentStateId: todoList.current_state?.id || null,
    currentTaskId: todoList.current_task?.id || null,
    processingMode: todoList.current_state?.type || null
  }),
  setAllDeliverableStates: (states) => set({ allDeliverableStates: states }),
  updateDeliverable: (key, value, stateId, confidence, sourceMessage, reasoning, acceptanceCriteria) => set((state) => {
    const deliverableUpdate = {
      value,
      collected_at: new Date().toISOString(),
      state_id: stateId,
      confidence: confidence || 1.0,
      source_message: sourceMessage,
      reasoning,
      acceptance_criteria: acceptanceCriteria,
      status: value ? DeliverableStatus.COMPLETED : DeliverableStatus.PENDING
    }

    // Update the corresponding state's deliverable if state is found
    let updatedTodoList = state.todoList
    if (updatedTodoList && stateId && updatedTodoList.states) {
      const updatedStates = updatedTodoList.states.map(stateDef => {
        if (stateDef.id === stateId && stateDef.tasks) {
          const updatedTasks = stateDef.tasks.map(task => {
            if (task.deliverables) {
              const updatedDeliverables = task.deliverables.map(deliverable =>
                deliverable.key === key
                  ? { ...deliverable, ...deliverableUpdate }
                  : deliverable
              )

              // Check if all required deliverables are completed
              // Handle both enum and string comparison for status
              const isCompleted = (status: any) =>
                status === DeliverableStatus.COMPLETED || status === 'completed'

              const requiredDeliverables = updatedDeliverables.filter(d => d.required)
              const allRequiredDeliverablesCompleted = requiredDeliverables.length === 0
                ? updatedDeliverables.every(d => isCompleted(d.status))
                : requiredDeliverables.every(d => isCompleted(d.status))

              // Auto-complete task if all required deliverables are collected
              // Keep existing status if task is already completed or if not all deliverables are done
              const taskStatus = allRequiredDeliverablesCompleted
                ? TaskStatus.COMPLETED
                : (task.status || TaskStatus.PENDING)

              return { ...task, deliverables: updatedDeliverables, status: taskStatus }
            }
            return task
          })
          return { ...stateDef, tasks: updatedTasks }
        }
        return stateDef
      })
      updatedTodoList = { ...updatedTodoList, states: updatedStates }
    }


    // Create notification for deliverable collection
    const newNotification: UpdateNotification = {
      id: generateUUID(),
      type: 'deliverable_collected',
      title: 'Information Collected',
      message: `${key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}: ${String(value)}`,
      timestamp: new Date().toISOString(),
      read: false,
      importance: 'medium',
      data: { key, value, confidence, reasoning, stateId }
    }

    // Create recent update
    const newUpdate: RecentUpdate = {
      id: generateUUID(),
      type: 'deliverable',
      description: `Collected "${key.replace(/_/g, ' ')}" with ${Math.round((confidence || 1) * 100)}% confidence`,
      timestamp: new Date().toISOString(),
      data: deliverableUpdate
    }

    return {
      deliverables: { ...state.deliverables, [key]: deliverableUpdate },
      todoList: updatedTodoList,
      lastDeliverableUpdate: {
        key,
        value,
        confidence: confidence || 1.0,
        reasoning,
        acceptance_criteria: acceptanceCriteria,
        state_id: stateId,
        timestamp: new Date().toISOString()
      },
      notifications: [newNotification, ...state.notifications].slice(0, 50),
      recentUpdates: [newUpdate, ...state.recentUpdates].slice(0, 20),
      lastUpdateTimestamp: new Date().toISOString()
    }
  }),
  setProgress: (progress) => set({ planProgress: progress }),

  updateStateStatus: (stateId, status) => set((state) => {
    if (!state.todoList || !state.todoList.states) return state
    const updatedStates = state.todoList.states.map(stateDef =>
      stateDef.id === stateId ? { ...stateDef, status } : stateDef
    )
    return {
      todoList: { ...state.todoList, states: updatedStates }
    }
  }),

  updateTaskStatus: (stateId, taskId, status) => set((state) => {
    if (!state.todoList || !state.todoList.states) return state
    const updatedStates = state.todoList.states.map(stateDef => {
      if (stateDef.id === stateId && stateDef.tasks) {
        const updatedTasks = stateDef.tasks.map(task =>
          task.id === taskId ? { ...task, status } : task
        )
        return { ...stateDef, tasks: updatedTasks }
      }
      return stateDef
    })
    return {
      todoList: { ...state.todoList, states: updatedStates }
    }
  }),

  setCurrentState: (stateId, taskId) => set({
    currentStateId: stateId,
    currentTaskId: taskId || null
  }),

  setProcessingMode: (mode) => set({ processingMode: mode }),

  handleStateChange: (data) => set((state) => {
    // Create notification for state change
    const newNotification: UpdateNotification = {
      id: generateUUID(),
      type: 'state_changed',
      title: 'State Changed',
      message: `Moved to: ${data.state_title}`,
      timestamp: new Date().toISOString(),
      read: false,
      importance: 'high',
      data: data
    }

    // Create recent update
    const newUpdate: RecentUpdate = {
      id: generateUUID(),
      type: 'state',
      description: `Advanced to "${data.state_title}"`,
      timestamp: new Date().toISOString(),
      data: data
    }

    return {
      lastStateChange: {
        previous_state: data.previous_state,
        current_state: data.current_state,
        state_title: data.state_title,
        timestamp: data.timestamp
      },
      currentStateId: data.current_state,
      notifications: [newNotification, ...state.notifications].slice(0, 50),
      recentUpdates: [newUpdate, ...state.recentUpdates].slice(0, 20),
      lastUpdateTimestamp: new Date().toISOString()
    }
  }),

  setShowTaskPanel: (show) => set({ showTaskPanel: show }),

  clearTasks: () => set({
    agentTaskLists: new Map(),
    todoList: null,
    deliverables: {},
    allDeliverableStates: {},
    planProgress: 0,
    currentStateId: null,
    currentTaskId: null,
    processingMode: null,
    showTaskPanel: false,
    lastDeliverableUpdate: null,
    lastStateChange: null,
    notifications: [],
    recentUpdates: [],
    focusMode: false,
    lastUpdateTimestamp: null,
    hiddenAgentIds: new Set<string>()
  }),

  // New notification and update actions
  addNotification: (notification) => set((state) => {
    const newNotification: UpdateNotification = {
      ...notification,
      id: generateUUID(),
      timestamp: new Date().toISOString(),
      read: false
    }

    return {
      notifications: [newNotification, ...state.notifications].slice(0, 50), // Keep last 50
      lastUpdateTimestamp: new Date().toISOString()
    }
  }),

  markNotificationRead: (id) => set((state) => ({
    notifications: state.notifications.map(n =>
      n.id === id ? { ...n, read: true } : n
    )
  })),

  clearNotifications: () => set({ notifications: [] }),

  addRecentUpdate: (update) => set((state) => {
    const newUpdate: RecentUpdate = {
      ...update,
      id: generateUUID(),
      timestamp: new Date().toISOString()
    }

    return {
      recentUpdates: [newUpdate, ...state.recentUpdates].slice(0, 20), // Keep last 20
      lastUpdateTimestamp: new Date().toISOString()
    }
  }),

  setFocusMode: (enabled) => set({ focusMode: enabled }),

  updateLastTimestamp: () => set({ lastUpdateTimestamp: new Date().toISOString() }),

  // Task timeline actions for time machine feature
  buildTaskUpdateTimeline: (messages) => {
    // Extract all task update messages and build chronological timeline.
    // Handles both stella-v1 (complete_todo_list) and stella-v2 (progress_update) formats.
    const taskUpdates = messages
      .filter(msg => {
        if (!msg.metadata) return false
        const envelope = msg.metadata?.envelope
        if (envelope?.type === 'complete_todo_list') return true
        if (envelope?.type === 'progress_update') return true
        if (msg.messageType === 'progress_update') return true
        if (msg.messageType === 'complete_todo_list') return true
        return false
      })
      .map(msg => {
        const envelope = msg.metadata.envelope || { type: msg.messageType, data: msg.metadata }
        const data = envelope.data || envelope

        const envelopeTs = typeof data.timestamp === 'string' ? data.timestamp
          : typeof envelope.timestamp === 'string' ? envelope.timestamp
          : null
        const ts = envelopeTs ? new Date(envelopeTs).getTime() : new Date(msg.timestamp).getTime()
        const timestamp = isNaN(ts) ? new Date(msg.timestamp).getTime() : ts

        if (envelope.type === 'progress_update') {
          return {
            timestamp,
            messageId: msg.id,
            agentId: msg.metadata.participant_id || data.metadata?.agent_id || 'unknown',
            agentName: data.metadata?.agent_name,
            todoList: progressUpdateToTodoList(data),
          }
        }

        return {
          timestamp,
          messageId: msg.id,
          agentId: envelope.participant_id || data.participant_id || 'unknown',
          agentName: msg.metadata?.participant_name,
          todoList: data.todo_list
        }
      })
      .sort((a, b) => a.timestamp - b.timestamp)

    console.log('[TaskTimeline] Built timeline with', taskUpdates.length, 'updates')
    set({ taskUpdateHistory: taskUpdates })
  },

  applyLatestTaskState: () => {
    const { taskUpdateHistory, hiddenAgentIds } = get()

    if (taskUpdateHistory.length === 0) {
      console.log('[TaskTimeline] No task updates in history')
      return
    }

    // Group updates by agentId and get the latest update for each agent
    const agentLatestUpdates = new Map<string, typeof taskUpdateHistory[0]>()

    taskUpdateHistory.forEach(update => {
      const existing = agentLatestUpdates.get(update.agentId)
      if (!existing || update.timestamp > existing.timestamp) {
        agentLatestUpdates.set(update.agentId, update)
      }
    })

    console.log('[TaskTimeline] Applying latest task state for', agentLatestUpdates.size, 'agent(s)')

    // Apply latest state for ALL agents, filtering out hidden ones
    set((state) => {
      const newMap = new Map<string, TodoList & { agentName?: string }>()

      agentLatestUpdates.forEach((update, agentId) => {
        if (!hiddenAgentIds.has(agentId)) {
          newMap.set(agentId, {
            ...update.todoList,
            agentName: update.agentName
          })
        }
      })

      // Get the most recent update overall for legacy todoList
      const mostRecentUpdate = taskUpdateHistory[taskUpdateHistory.length - 1]

      return {
        agentTaskLists: newMap,
        showTaskPanel: newMap.size > 0,
        isTaskPanelInHistoryMode: false, // Latest state is not history mode
        currentHistoricalTimestamp: null,
        todoList: state.todoList || mostRecentUpdate.todoList // Legacy compat
      }
    })
  },

  applyTaskStateAtTime: (timestamp) => {
    const { taskUpdateHistory, hiddenAgentIds } = get()

    // Find all updates at or before the given timestamp
    const updatesAtTime = taskUpdateHistory.filter(update => update.timestamp <= timestamp)

    if (updatesAtTime.length === 0) {
      console.log('[TaskTimeline] No task update found at timestamp', timestamp)
      return
    }

    // Group by agentId and get the most recent update for each agent at this time
    const agentUpdatesAtTime = new Map<string, typeof taskUpdateHistory[0]>()

    updatesAtTime.forEach(update => {
      const existing = agentUpdatesAtTime.get(update.agentId)
      if (!existing || update.timestamp > existing.timestamp) {
        agentUpdatesAtTime.set(update.agentId, update)
      }
    })

    console.log('[TaskTimeline] Applying task state for', agentUpdatesAtTime.size, 'agent(s) at', new Date(timestamp).toLocaleTimeString())

    // Apply the historical state for ALL agents, filtering out hidden ones
    set((state) => {
      const newMap = new Map<string, TodoList & { agentName?: string }>()

      agentUpdatesAtTime.forEach((update, agentId) => {
        if (!hiddenAgentIds.has(agentId)) {
          newMap.set(agentId, {
            ...update.todoList,
            agentName: update.agentName
          })
        }
      })

      // Get the most recent update overall for legacy todoList
      const mostRecentAtTime = updatesAtTime[updatesAtTime.length - 1]

      return {
        agentTaskLists: newMap,
        showTaskPanel: newMap.size > 0,
        isTaskPanelInHistoryMode: true,
        currentHistoricalTimestamp: timestamp,
        todoList: state.todoList || mostRecentAtTime.todoList // Legacy compat
      }
    })
  },

  setTaskHistoryMode: (enabled, timestamp = null) => {
    set({
      isTaskPanelInHistoryMode: enabled,
      currentHistoricalTimestamp: timestamp
    })
  },

  clearTaskTimeline: () => {
    set({
      taskUpdateHistory: [],
      isTaskPanelInHistoryMode: false,
      currentHistoricalTimestamp: null,
      hiddenAgentIds: new Set<string>()
    })
  },

}))
