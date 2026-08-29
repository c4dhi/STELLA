import { useEffect, useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import ConnectPanel from '../components/ConnectPanel'
import ChatView from '../components/ChatView'
import Composer from '../components/Composer'
import TaskPanel from '../components/TaskPanel'
import AgentSidebar from '../components/agents/AgentSidebar'
import ParticipantSection, { type ParticipantModalData } from '../components/participants/ParticipantSection'
import EditSessionModal from '../components/modals/EditSessionModal'
// RegisterParticipantModal replaced by InviteParticipantModal in ParticipantSection
import ParticipantConnectionModal from '../components/modals/ParticipantConnectionModal'
import DeployAgentModal from '../components/modals/DeployAgentModal'
import ConfirmDialog from '../components/modals/ConfirmDialog'
import MonitorLogsModal from '../components/modals/MonitorLogsModal'
import SessionAnalyticsModal from '../components/modals/SessionAnalyticsModal'
import StellaFaceModal from '../components/face/StellaFaceModal'
import ProfileButton from '../components/layout/ProfileButton'
import { useStore } from '../store'
import { useAuthStore } from '../store/authStore'
import { useThemeStore } from '../store/themeStore'
import { usePageVisibility } from '../hooks/usePageVisibility'
import { apiClient } from '../services/ApiClient'
import { useToastStore } from '../store/toastStore'
import type { SessionDetail, Participant, ListenerStatus } from '../lib/api-types'
import type { TranscriptChunk, ProcessingMessage, ParticipantEvent, ProgressUpdateMessage, TodoList } from '../lib/types'
import { generateUUID } from '../lib/uuid'
import { isSameListenerStatus } from '../lib/sessionPollEquality'
import { progressUpdateToTodoList, resolveStateType } from '../lib/progressConversion'

export default function SessionView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const { addToast } = useToastStore()
  const { resolvedTheme, initializeTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const isPageVisible = usePageVisibility()

  // Initialize theme on mount
  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  const [session, setSession] = useState<SessionDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)

  // Participant modal states
  const [selectedParticipant, setSelectedParticipant] = useState<ParticipantModalData | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [participantRefreshTrigger, setParticipantRefreshTrigger] = useState(0)
  const [participantConfirmDialog, setParticipantConfirmDialog] = useState<{
    isOpen: boolean
    title: string
    message: string
    onConfirm: () => void
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => { },
  })

  // Presence event forwarding to ParticipantSection (avoids duplicate SSE connection)
  const [lastPresenceEvent, setLastPresenceEvent] = useState<{ type: string; identity: string } | null>(null)

  // Agent modal states
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false)

  // Listener status for recording indicator
  const [listenerStatus, setListenerStatus] = useState<ListenerStatus | null>(null)
  const [showLogsModal, setShowLogsModal] = useState(false)
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false)

  const transport = useStore(s => s.transport)
  const status = useStore(s => s.status)
  const setStatus = useStore(s => s.setStatus)
  const user = useAuthStore(s => s.user)
  const showTaskPanel = useStore(s => s.showTaskPanel)
  const addLiveTaskUpdate = useStore(s => s.addLiveTaskUpdate)
  const setTodoList = useStore(s => s.setTodoList)
  const updateDeliverable = useStore(s => s.updateDeliverable)
  const setProgress = useStore(s => s.setProgress)
  const handleStateChange = useStore(s => s.handleStateChange)
  const setAllDeliverableStates = useStore(s => s.setAllDeliverableStates)
  const setProcessingMode = useStore(s => s.setProcessingMode)
  const addNotification = useStore(s => s.addNotification)

  // Face modal state
  const isFaceModalOpen = useStore(s => s.isFaceModalOpen)
  const setFaceModalOpen = useStore(s => s.setFaceModalOpen)
  // NOTE: deliberately NOT subscribing to `audioLevel`/`isRemoteSpeaking` here.
  // Those update at up to ~30 Hz while connected; the only consumer is the Face modal,
  // which now reads them from the store directly. Subscribing here would re-render this
  // entire (~1000-line) page on every audio frame. See ticket #305.
  const setAgentReady = useStore(s => s.setAgentReady)

  // Handlers from ConnectPanel - now consolidated here
  const upsertChunk = useStore(s => s.upsertChunk)
  const setSpeechProgress = useStore(s => s.setSpeechProgress)
  const addProcessingMessage = useStore(s => s.addProcessingMessage)
  const addParticipantEvent = useStore(s => s.addParticipantEvent)
  const setTTSPlaying = useStore(s => s.setTTSPlaying)
  const setTTSPaused = useStore(s => s.setTTSPaused)
  const setLLMConfig = useStore(s => s.setLLMConfig)
  const setAudioLevel = useStore(s => s.setAudioLevel)
  const setIsRemoteSpeaking = useStore(s => s.setIsRemoteSpeaking)

  // Connection tracking ref to prevent duplicate connections
  const connectionRef = useRef<{
    isConnecting: boolean
    isDisconnecting: boolean
    connectedRoom: string | null
    connectionId: number
  }>({
    isConnecting: false,
    isDisconnecting: false,
    connectedRoom: null,
    connectionId: 0
  })

  // Load session details, then participants (serialized to avoid connection burst)
  useEffect(() => {
    const loadSession = async () => {
      if (!sessionId) return

      try {
        setIsLoading(true)
        setError(null)
        const data = await apiClient.getSession(sessionId)
        setSession(data)

        // Check if any agent is already running and set agentReady accordingly
        const hasRunningAgent = data.agents?.some(agent => agent.status === 'RUNNING')
        if (hasRunningAgent) {
          setAgentReady(true)
        }

        // Load participants after session (not in parallel) to reduce connection burst
        try {
          const participantData = await apiClient.listParticipants(sessionId)
          setParticipants(participantData)
        } catch (err) {
          console.error('Failed to load participants:', err)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session')
      } finally {
        setIsLoading(false)
      }
    }

    loadSession()
  }, [sessionId, setAgentReady])

  // Subscribe to session events (agent ready, failed, etc.)
  useEffect(() => {
    if (!sessionId) return

    const unsubscribe = apiClient.subscribeToSessionEvents(
      sessionId,
      (event) => {
        console.log('[SessionView] Session event received:', event)

        switch (event.type) {
          case 'agent.ready':
            addToast({
              message: `${event.agentName || 'Agent'} is ready!`,
              type: 'success'
            })
            // Enable audio processing now that agent is ready
            setAgentReady(true)
            // Refresh session to get updated agent status
            apiClient.getSession(sessionId).then(setSession).catch(console.error)
            break
          case 'agent.failed':
            addToast({
              message: `${event.agentName || 'Agent'} failed: ${event.error}`,
              type: 'error'
            })
            // Refresh session to get updated agent status
            apiClient.getSession(sessionId).then(setSession).catch(console.error)
            break
          case 'agent.starting':
            addToast({
              message: `${event.agentName || 'Agent'} is starting...`,
              type: 'info'
            })
            // Refresh session so AgentSidebar gets STARTING status via initialAgents prop
            apiClient.getSession(sessionId).then(setSession).catch(console.error)
            break
          case 'agent.stopped':
            addToast({
              message: `${event.agentName || 'Agent'} has stopped`,
              type: 'info'
            })
            // Disable audio processing when agent stops
            setAgentReady(false)
            // Refresh session to get updated agent status
            apiClient.getSession(sessionId).then(setSession).catch(console.error)
            break
          case 'participant.joined':
          case 'participant.left':
            if (event.participantIdentity) {
              // Forward to ParticipantSection via prop (new object ref triggers useEffect)
              setLastPresenceEvent({ type: event.type, identity: event.participantIdentity })
            }
            break
        }
      },
      (error) => {
        console.error('[SessionView] SSE error:', error)
      }
    )

    return () => {
      console.log('[SessionView] Closing SSE connection')
      unsubscribe()
    }
  }, [sessionId, addToast, setAgentReady])

  // Set user name on transport when available
  useEffect(() => {
    if (user?.name) {
      transport.setUserName(user.name)
      console.log(`[SessionView] Set user name on transport: ${user.name}`)
    }
  }, [user, transport])

  // CONSOLIDATED: All transport callbacks in one place - MUST happen BEFORE auto-connect
  // This consolidates handlers that were previously split between SessionView and ConnectPanel
  useEffect(() => {
    console.log('[SessionView] Setting up ALL transport callbacks (consolidated)')

    // === Connection handlers (from ConnectPanel) ===
    transport.onConnected = () => {
      console.log('[SessionView] Transport connected')
      setStatus('connected')
    }
    transport.onDisconnected = () => {
      console.log('[SessionView] Transport disconnected')
      setStatus('idle')
    }
    transport.onError = (e) => {
      console.error('[SessionView] Transport error:', e)
      setStatus('error')
    }

    // === Transcript handlers (from ConnectPanel) ===
    transport.onTranscript = (c: TranscriptChunk) => upsertChunk(c)
    // Teleprompter (#241): bridge speech-progress to the store; ChatView's
    // useTeleprompter consumes it to drive the word-by-word highlight.
    transport.onSpeechProgress = (data) => setSpeechProgress(data)
    transport.onProcessingMessage = (m: ProcessingMessage) => addProcessingMessage(m)

    // === TTS handlers (from ConnectPanel) ===
    transport.onTTSStart = () => {
      setTTSPlaying(true)
      setTTSPaused(false)
    }
    transport.onTTSStop = () => {
      setTTSPlaying(false)
      setTTSPaused(false)
    }

    // === Participant handlers (from ConnectPanel) ===
    transport.onParticipantJoined = (participantId: string, participantName?: string, isExisting?: boolean) => {
      // Skip adding "joined" events for participants that were already in the room
      // when we connected - we only want to show notifications for NEW joins
      if (isExisting) {
        console.log(`[SessionView] Skipping join notification for existing participant: ${participantName || participantId}`)
        return
      }

      // For agents, use the display name from LiveKit (set via AGENT_NAME env var)
      // The participantName will be the agent's configured name (e.g., "Stella", "Echo")
      const displayName = participantName || participantId
      const event: ParticipantEvent = {
        id: generateUUID(),
        type: 'joined',
        participantId,
        participantName: displayName,
        startedAt: Date.now(),
        messageType: 'participant'
      }
      addParticipantEvent(event)
    }
    transport.onParticipantLeft = (participantId: string, participantName?: string) => {
      const displayName = participantName || participantId
      const event: ParticipantEvent = {
        id: generateUUID(),
        type: 'left',
        participantId,
        participantName: displayName,
        startedAt: Date.now(),
        messageType: 'participant'
      }
      addParticipantEvent(event)
    }

    // === Audio handlers (from ConnectPanel) ===
    transport.onAudioLevel = (level: number) => setAudioLevel(level)
    transport.onRemoteSpeaking = (speaking: boolean) => setIsRemoteSpeaking(speaking)
    transport.onLLMConfig = (config: any) => {
      console.log('[SessionView] Received LLM config:', config)
      setLLMConfig(config)
    }

    // === Task handlers (original SessionView handlers) ===
    const handleTodoListUpdate = (data: any) => {
      try {
        // Validate required fields for state machine
        if (!data.todo_list || !data.conversation_id) {
          console.warn('Invalid state machine data received:', data)
          return
        }

        if (!data.todo_list.states || !Array.isArray(data.todo_list.states)) {
          console.warn('Invalid states array in todo list data:', data)
          return
        }

        // Validate current_state if it exists
        if (data.todo_list.current_state && !data.todo_list.current_state.title) {
          console.warn('Current state missing title:', data.todo_list.current_state)
        }

        // Extract agent identifier from message
        const agentId = data.participant_id || 'default-agent'

        // Try to find agent info from session agents
        // Match by: exact podName, exact id, podName starts with participant_id, or podName contains participant_id
        // E.g., participant_id="stella-light-agent", podName could be:
        //   - "stella-light-agent-abc123"
        //   - "grace-stella-light-agent-abc123"
        //   - "stella-light-agent-grace-abc123"
        const agent = session?.agents?.find(a =>
          a.podName === agentId ||
          a.id === agentId ||
          (a.podName && a.podName.startsWith(agentId + '-')) ||
          (a.podName && a.podName.includes(agentId))
        )

        // Debug: log agent lookup details
        console.log(`🔍 [TASK] Agent lookup:`, {
          participant_id: agentId,
          sessionAgents: session?.agents?.map(a => ({ id: a.id, name: a.name, podName: a.podName })),
          foundAgent: agent ? { id: agent.id, name: agent.name, podName: agent.podName } : null
        })

        const agentName = agent?.name || data.participant_id
        const agentIcon = agent?.icon || '🤖'

        console.log(`📋 [TASK] Todo list update received:`, {
          trigger: data.update_trigger,
          agentId,
          agentName,
          agentIcon,
          states: data.todo_list.states?.length || 0,
          current_state: data.todo_list.current_state?.title || 'none',
          processing_mode: data.context?.current_processing_mode,
        })

        // Add agent icon to todo list data
        const todoListWithAgent = {
          ...data.todo_list,
          agentIcon
        }

        // Route to multi-agent system with timeline tracking for live updates
        addLiveTaskUpdate(agentId, todoListWithAgent, agentName)

        // Keep legacy support for backward compatibility
        setTodoList(data.todo_list)

        if (data.all_deliverable_states) {
          setAllDeliverableStates(data.all_deliverable_states)
        }

        if (data.context?.current_processing_mode) {
          setProcessingMode(data.context.current_processing_mode)
        }
      } catch (error) {
        console.error('Error handling state machine update:', error)
      }
    }

    const handlePlanProgress = (data: any) => {
      console.log(`📊 [TASK] Plan progress update:`, {
        percentage: data.progress.percentage,
        state: data.current_state?.title,
        mode: data.current_state?.type,
      })
      setProgress(data.progress.percentage)
    }

    const handleDeliverableUpdate = (data: any) => {
      console.log(`📦 [DELIVERABLE] ${data.deliverable_key}: ${data.deliverable_value}`)
      if (data.reasoning) {
        console.log(`   Reasoning: ${data.reasoning}`)
      }

      updateDeliverable(
        data.deliverable_key,
        data.deliverable_value,
        data.state_id,
        data.confidence,
        data.source_message,
        data.reasoning,
        data.acceptance_criteria
      )

      const confidencePercent = data.confidence ? Math.round(data.confidence * 100) : 100
      addNotification({
        type: 'deliverable_collected',
        title: `Collected: ${data.deliverable_key.replace(/_/g, ' ').replace(/\b\w/g, (l: any) => l.toUpperCase())}`,
        message: `Value: ${data.deliverable_value} (${confidencePercent}% confidence)`,
        importance: 'medium',
        data: {
          key: data.deliverable_key,
          value: data.deliverable_value,
          confidence: data.confidence,
          reasoning: data.reasoning,
          stateId: data.state_id,
          acceptanceCriteria: data.acceptance_criteria,
        },
      })
    }

    const handleStateMachineStateChange = (data: any) => {
      handleStateChange(data)
    }

    // Handle generic progress updates from SDK (new format)
    const handleProgressUpdate = (data: ProgressUpdateMessage) => {
      try {
        console.log(`📋 [PROGRESS] Generic progress update received:`, {
          trigger: data.update_trigger,
          progress: data.progress_percentage,
          groups: data.groups?.length || 0,
          current_group: data.current_group_id,
        })

        // Single source of truth for SDK ProgressUpdate → TodoList. The live path
        // MUST use the same conversion as historical replay (progressConversion.ts),
        // otherwise the two drift: a prior inline copy here ignored
        // metadata.task_status, so a skip_task'd task rendered as pending (empty
        // circle, uncounted in "X/Y tasks done") even though the backend had
        // correctly marked it skipped.
        const todoList: TodoList = progressUpdateToTodoList(data)

        // Extract agent info from metadata
        const agentId = data.metadata?.agent_id || 'default-agent'
        const agentName = data.metadata?.agent_name || 'Agent'

        // Route to multi-agent system
        addLiveTaskUpdate(agentId, todoList, agentName)
        setTodoList(todoList)

        // Set processing mode based on current group's execution mode
        const currentGroup = data.groups?.find(g => g.id === data.current_group_id)
        if (currentGroup) {
          setProcessingMode(resolveStateType(currentGroup))
        }
      } catch (error) {
        console.error('Error handling progress update:', error)
      }
    }

    transport.onTodoListUpdate = handleTodoListUpdate
    transport.onProgressUpdate = handleProgressUpdate
    transport.onPlanProgress = handlePlanProgress
    transport.onDeliverableUpdate = handleDeliverableUpdate
    transport.onStateChange = handleStateMachineStateChange

    return () => {
      // Cleanup ALL callbacks
      console.log('[SessionView] Cleaning up transport callbacks')
      transport.onConnected = () => { }
      transport.onDisconnected = () => { }
      transport.onError = () => { }
      transport.onTranscript = () => { }
      transport.onSpeechProgress = () => { }
      transport.onProcessingMessage = () => { }
      transport.onTTSStart = () => { }
      transport.onTTSStop = () => { }
      transport.onParticipantJoined = () => { }
      transport.onParticipantLeft = () => { }
      transport.onAudioLevel = () => { }
      transport.onRemoteSpeaking = () => { }
      transport.onLLMConfig = () => { }
      transport.onTodoListUpdate = () => { }
      transport.onProgressUpdate = () => { }
      transport.onPlanProgress = () => { }
      transport.onDeliverableUpdate = () => { }
      transport.onStateChange = () => { }
    }
  }, [transport, session])

  // Auto-connect to LiveKit room on mount, disconnect on unmount
  // This runs AFTER callbacks are set up (effect order matters)
  // Uses connectionRef to prevent duplicate connections across React re-renders
  useEffect(() => {
    const roomName = session?.room?.livekitRoomName
    if (!roomName) return

    // Generate a unique ID for this connection attempt
    const currentConnectionId = ++connectionRef.current.connectionId

    const autoConnect = async () => {
      // Guard 1: Already connected to this room (check ref)
      if (connectionRef.current.connectedRoom === roomName) {
        console.log('[SessionView] Already connected to room (ref):', roomName)
        return
      }

      // Guard 2: Already connected to this room (check transport)
      if (transport.isConnectedToRoom(roomName)) {
        console.log('[SessionView] Already connected to room (transport):', roomName)
        connectionRef.current.connectedRoom = roomName
        return
      }

      // Guard 3: Connection already in progress
      if (connectionRef.current.isConnecting) {
        console.log('[SessionView] Connection already in progress, skipping')
        return
      }

      // Guard 4: Wait for any pending disconnect to complete
      if (connectionRef.current.isDisconnecting) {
        console.log('[SessionView] Waiting for disconnect to complete...')
        // Wait up to 500ms for disconnect to complete
        let waited = 0
        while (connectionRef.current.isDisconnecting && waited < 500) {
          await new Promise(resolve => setTimeout(resolve, 50))
          waited += 50
        }
      }

      // Mark as connecting
      connectionRef.current.isConnecting = true
      setStatus('connecting')

      try {
        console.log('[SessionView] Auto-connecting to LiveKit room:', roomName)
        await transport.connect(roomName)

        // Only update state if this is still the current connection attempt
        if (connectionRef.current.connectionId === currentConnectionId) {
          connectionRef.current.connectedRoom = roomName
          console.log('[SessionView] Successfully connected to room:', roomName)
        } else {
          console.log('[SessionView] Connection completed but superseded by newer attempt')
        }
      } catch (error) {
        console.error('[SessionView] Auto-connect failed:', error)
        // Only update error state if this is still the current connection attempt
        if (connectionRef.current.connectionId === currentConnectionId) {
          setStatus('error')
        }
      } finally {
        // Only clear connecting flag if this is still the current connection attempt
        if (connectionRef.current.connectionId === currentConnectionId) {
          connectionRef.current.isConnecting = false
        }
      }
    }

    autoConnect()

    // Cleanup: Disconnect when component unmounts or room changes
    return () => {
      console.log('[SessionView] Auto-disconnecting from LiveKit room')
      connectionRef.current.isDisconnecting = true
      connectionRef.current.connectedRoom = null

      transport.disconnect().finally(() => {
        connectionRef.current.isDisconnecting = false
      })
    }
  }, [session?.room?.livekitRoomName, transport, setStatus])

  // Handle session name update
  const handleUpdateSessionName = async (name: string | null) => {
    if (!sessionId) return

    try {
      const updatedSession = await apiClient.updateSession(sessionId, { name: name || undefined })
      setSession(updatedSession)
      addToast({
        message: name ? `Session renamed to "${name}"` : 'Session name cleared',
        type: 'success'
      })
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to update session name',
        type: 'error'
      })
      throw err
    }
  }

  // Load participants
  const loadParticipants = async () => {
    if (!sessionId) return
    try {
      const data = await apiClient.listParticipants(sessionId)
      setParticipants(data)
    } catch (err) {
      console.error('Failed to load participants:', err)
    }
  }

  // Remove participant
  const handleRemoveParticipant = (participantId: string, participantName: string) => {
    setParticipantConfirmDialog({
      isOpen: true,
      title: 'Remove Participant',
      message: `Are you sure you want to remove "${participantName}"? This will disconnect them from the session.`,
      onConfirm: async () => {
        setParticipantConfirmDialog(prev => ({ ...prev, isOpen: false }))
        try {
          await apiClient.removeParticipant(participantId)
          setParticipants(prev => prev.filter(p => p.id !== participantId))
          addToast({ message: 'Participant removed successfully', type: 'success' })
        } catch (err) {
          addToast({
            message: err instanceof Error ? err.message : 'Failed to remove participant',
            type: 'error'
          })
        }
      },
    })
  }

  // Deploy agent
  const handleDeployAgent = async (name: string, icon?: string, config?: Record<string, unknown>, agentType?: string, envVarTemplateId?: string, envVars?: Record<string, string>, agentConfigurationId?: string, personaId?: string, mode?: 'plan' | 'companion', availablePlanIds?: string[]) => {
    if (!sessionId) return

    try {
      await apiClient.createAgent(sessionId, { name, icon, config, agentType, envVarTemplateId, envVars, agentConfigurationId, personaId, mode, availablePlanIds })
      addToast({ message: 'Agent deployed successfully', type: 'success' })

      // Refresh session to get updated agents list
      const updatedSession = await apiClient.getSession(sessionId)
      setSession(updatedSession)
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to deploy agent',
        type: 'error'
      })
      throw err
    }
  }

  // Participants are loaded as part of loadSession above (serialized to reduce connection burst)

  // Poll listener status (recording indicator). Pauses while the tab is hidden, and only
  // commits when the status actually changed so an unchanged poll doesn't re-render this
  // page every 2 s. See ticket #305.
  useEffect(() => {
    if (!sessionId || !session || session.status !== 'ACTIVE' || !isPageVisible) return

    const pollStatus = async () => {
      try {
        const status = await apiClient.getListenerStatus(sessionId)
        setListenerStatus(prev => (isSameListenerStatus(prev, status) ? prev : status))
      } catch (err) {
        console.error('Failed to get listener status:', err)
      }
    }

    // Initial poll
    pollStatus()

    // Poll every 2 seconds
    const interval = setInterval(pollStatus, 2000)

    return () => clearInterval(interval)
  }, [sessionId, session?.status, isPageVisible])

  if (!sessionId) {
    return <div>Invalid session ID</div>
  }

  if (isLoading) {
    return (
      <div className={`w-full h-screen flex items-center justify-center transition-colors duration-200 ${isDark ? 'bg-surface-dark' : 'bg-surface'}`}>
        <div className={`text-body ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>Loading session...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`w-full h-screen flex items-center justify-center transition-colors duration-200 ${isDark ? 'bg-surface-dark' : 'bg-surface'}`}>
        <div className="text-center">
          <div className={`text-body mb-4 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</div>
          <button onClick={() => navigate('/dashboard')} className="btn-primary">
            Back to Dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`w-full h-screen transition-colors duration-200 ${isDark ? 'bg-surface-dark' : 'bg-surface'}`}>
      {/* Header */}
      <header className={`sticky top-0 z-40 border-b transition-colors duration-200 backdrop-blur-sm ${isDark ? 'bg-surface-dark/95 border-border-dark' : 'bg-white/95 border-border'
        }`}>
        <div className="max-w-7xl mx-auto px-6 py-3">
          <div className="flex items-center gap-3">
            {/* Back Button */}
            <Link
              to={`/project/${session?.projectId}`}
              className="btn-ghost p-1.5"
              title="Back to sessions"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>

            {/* Breadcrumb and Title */}
            <div className="flex-1">
              {/* Breadcrumb */}
              <div className={`flex items-center gap-2 text-caption mb-1 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                <Link to="/dashboard" className={`transition-colors ${isDark ? 'hover:text-content-inverse' : 'hover:text-content'}`}>
                  Projects
                </Link>
                <span>/</span>
                <Link to={`/project/${session?.projectId}`} className={`transition-colors ${isDark ? 'hover:text-content-inverse' : 'hover:text-content'}`}>
                  Sessions
                </Link>
                <span>/</span>
                <span className={`font-mono ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                  {session?.room.livekitRoomName || 'Session'}
                </span>
              </div>

              {/* Title - Editable */}
              <div className="flex items-center gap-2">
                <h1 className={`text-heading-sm ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                  {session?.name || session?.room.livekitRoomName || 'Session'}
                </h1>
                <button
                  onClick={() => setIsEditModalOpen(true)}
                  className="btn-ghost p-1"
                  title="Edit session name"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowAnalyticsModal(true)}
                  className="btn-ghost p-1"
                  title="Session analytics"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M18 20V10M12 20V4M6 20v-6" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Right side - Profile */}
            <ProfileButton />
          </div>
        </div>
      </header>

      <div className={`h-[calc(100vh-81px)] flex gap-4 px-4 py-4 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
        {/* Left Sidebar - Participants and Agents */}
        <div className="flex-shrink-0 space-y-4">
          <ParticipantSection
            sessionId={sessionId}
            participants={participants}
            onShowConnectionInfo={(data) => setSelectedParticipant(data)}
            onRemoveParticipant={handleRemoveParticipant}
            onRefresh={() => apiClient.getSession(sessionId).then(setSession).catch(console.error)}
            refreshTrigger={participantRefreshTrigger}
            lastPresenceEvent={lastPresenceEvent}
          />
          <AgentSidebar
            sessionId={sessionId}
            initialAgents={session?.agents}
            onDeployClick={() => setIsDeployModalOpen(true)}
          />
        </div>

        {/* Main Content Area */}
        <div className={`flex flex-col gap-3 transition-all duration-300 ${showTaskPanel ? 'flex-1' : 'w-full max-w-3xl mx-auto'}`}>
          <ConnectPanel roomName={session?.room.livekitRoomName} />

          <div className={`flex-1 backdrop-blur-xl rounded-xl shadow-sm flex flex-col overflow-hidden transition-colors duration-300 ${isDark
            ? 'bg-white/5 border border-white/10'
            : 'bg-white/90 border border-neutral-200/60'
            }`}>
            <ChatView
              listenerStatus={listenerStatus}
              onShowLogs={() => setShowLogsModal(true)}
              sessionId={sessionId}
              viewerIdentity="human"
              viewerName={user?.name}
            />
          </div>

          <Composer />
        </div>

        {/* Task Panel - Now displays multiple agent cards side-by-side */}
        {showTaskPanel && (
          <div className="flex-shrink-0">
            <TaskPanel />
          </div>
        )}
      </div>

      {/* Modals - All rendered at root level to avoid z-index issues */}
      {session && (
        <EditSessionModal
          isOpen={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          onSubmit={handleUpdateSessionName}
          currentName={session.name}
          sessionId={session.id}
        />
      )}

      {/* RegisterParticipantModal moved to ParticipantSection as InviteParticipantModal */}

      {selectedParticipant && (
        <ParticipantConnectionModal
          participantId={selectedParticipant.participantId}
          invitationId={selectedParticipant.invitationId}
          invitationToken={selectedParticipant.invitationToken}
          participantDetails={selectedParticipant.details}
          onRevoke={async (invitationId) => {
            await apiClient.revokeInvitation(invitationId)
            // Refresh session data and trigger ParticipantSection to refresh invitations
            apiClient.getSession(sessionId).then(setSession).catch(console.error)
            setParticipantRefreshTrigger(prev => prev + 1)
          }}
          onClose={() => setSelectedParticipant(null)}
        />
      )}

      <DeployAgentModal
        isOpen={isDeployModalOpen}
        onClose={() => setIsDeployModalOpen(false)}
        onSubmit={handleDeployAgent}
      />

      <ConfirmDialog
        isOpen={participantConfirmDialog.isOpen}
        title={participantConfirmDialog.title}
        message={participantConfirmDialog.message}
        confirmText="Remove"
        confirmVariant="danger"
        onConfirm={participantConfirmDialog.onConfirm}
        onCancel={() => setParticipantConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />

      {/* Monitor Logs Modal */}
      <MonitorLogsModal
        isOpen={showLogsModal}
        onClose={() => setShowLogsModal(false)}
        sessionId={sessionId}
      />

      {/* Session Analytics Modal */}
      <SessionAnalyticsModal
        isOpen={showAnalyticsModal}
        onClose={() => setShowAnalyticsModal(false)}
        projectId={session?.projectId || ''}
        sessionId={sessionId}
      />

      {/* STELLA Face Modal - Full Screen */}
      <StellaFaceModal
        isOpen={isFaceModalOpen}
        onClose={() => setFaceModalOpen(false)}
      />
    </div>
  )
}
