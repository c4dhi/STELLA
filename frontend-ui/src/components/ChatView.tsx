
import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useParams } from 'react-router-dom'
import { Eye } from 'lucide-react'
import { useStore } from '../store'
import { useThemeStore } from '../store/themeStore'
import { useTeleprompter } from '../hooks/useTeleprompter'
import ProcessingMessageView from './ProcessingMessageView'
import ProcessingToggle from './ProcessingToggle'
import ParticipantNotification from './ParticipantNotification'
import { MessageBubble, useMessaging } from './messaging'
import { determineMessageRole, extractSpeakerInfo } from '../lib/messageUtils'
import type { ListenerStatus } from '../lib/api-types'

interface ChatViewProps {
  listenerStatus?: ListenerStatus | null
  onShowLogs?: () => void
  sessionId?: string
  viewerIdentity?: string  // Identity of current viewer (default: 'human' for organizer)
  viewerName?: string      // Display name of current viewer
}

export default function ChatView({
  listenerStatus,
  onShowLogs,
  sessionId: propSessionId,
  viewerIdentity = 'human',  // Default to organizer identity
  viewerName
}: ChatViewProps) {
  const { sessionId: paramSessionId } = useParams<{ sessionId: string }>()
  const sessionId = propSessionId || paramSessionId
  const turns = useStore(s => s.turns)
  // Teleprompter (#241): the same shared hook the participant chat uses. The
  // discrete progress events arrive via the store (bridged from PeerTransport);
  // the 60fps word cursor lives here, local to the chat subtree.
  const lastSpeechProgress = useStore(s => s.lastSpeechProgress)
  const {
    spokenChar,
    spokenTranscriptId,
    frozenSpoken,
    applyProgress,
    noteAgentText,
  } = useTeleprompter()
  const processingMessages = useStore(s => s.processingMessages)
  const participantEvents = useStore(s => s.participantEvents)
  const showProcessingMessages = useStore(s => s.showProcessingMessages)
  const showTaskPanel = useStore(s => s.showTaskPanel)
  const agentTaskLists = useStore(s => s.agentTaskLists)
  const setShowTaskPanel = useStore(s => s.setShowTaskPanel)
  const setFaceModalOpen = useStore(s => s.setFaceModalOpen)
  const pendingMessageIds = useStore(s => s.pendingMessageIds)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Messaging utilities for delivery status
  const { getDeliveryStatus } = useMessaging()

  // Historical messages from database
  const historicalMessages = useStore(s => s.historicalMessages)
  const loadHistoricalMessages = useStore(s => s.loadHistoricalMessages)
  const loadMoreHistory = useStore(s => s.loadMoreHistory)
  const hasMoreHistory = useStore(s => s.hasMoreHistory)
  const isLoadingHistory = useStore(s => s.isLoadingHistory)
  const clearHistory = useStore(s => s.clearHistory)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [isNearBottom, setIsNearBottom] = useState(true)

  // Get task timeline actions
  const buildTaskUpdateTimeline = useStore(s => s.buildTaskUpdateTimeline)
  const applyLatestTaskState = useStore(s => s.applyLatestTaskState)
  const applyTaskStateAtTime = useStore(s => s.applyTaskStateAtTime)
  const setTaskHistoryMode = useStore(s => s.setTaskHistoryMode)
  const taskUpdateHistory = useStore(s => s.taskUpdateHistory)
  const clearTaskTimeline = useStore(s => s.clearTaskTimeline)
  const clearTasks = useStore(s => s.clearTasks)
  const clear = useStore(s => s.clear)

  // Load history on mount
  useEffect(() => {
    if (sessionId) {
      console.log('[ChatView] Loading historical messages for session', sessionId)
      loadHistoricalMessages(sessionId)
    }

    // Cleanup on unmount or session change
    return () => {
      console.log('[ChatView] Unmounting, clearing all state')
      clear()              // Clear live messages (turns, processingMessages, participantEvents)
      clearHistory()       // Clear historical DB messages
      clearTaskTimeline()  // Clear task timeline
      clearTasks()         // Clear agent task lists
    }
  }, [sessionId, loadHistoricalMessages, clear, clearHistory, clearTaskTimeline, clearTasks])

  // Build task timeline and apply latest state when historical messages load
  useEffect(() => {
    if (historicalMessages.length > 0) {
      console.log('[ChatView] Building task timeline from', historicalMessages.length, 'messages')
      buildTaskUpdateTimeline(historicalMessages)
      applyLatestTaskState()
    }
  }, [historicalMessages, buildTaskUpdateTimeline, applyLatestTaskState])

  // Convert historical DB messages to display format and merge with real-time messages
  const allMessages = useMemo(() => {
    // Helper to extract participant name from various sources
    // Priority: speaker_name > envelope fields > display_name > LiveKit participant info > role
    const getParticipantName = (msg: any) => {
      return msg.metadata?.speaker_name               // Speaker name (for transcripts)
        || msg.metadata?.envelope?.participant_id     // Logical sender from message envelope
        || msg.metadata?.envelope?.data?.speaker_name // Nested speaker name in envelope data
        || msg.metadata?.display_name                 // Stored display name (fallback)
        || msg.metadata?.participant_name             // LiveKit participant name
        || msg.metadata?.participant_identity         // LiveKit participant identity
        || msg.participant?.name                      // Legacy participant name
        || msg.participant?.identity                  // Legacy participant identity
        || msg.role                                   // Last resort: use role
    }

    // Helper to map server message type to frontend processing type
    const mapToProcessingType = (serverType: string): 'decision' | 'prompt_execution' | 'expert_status' | 'safety_check' => {
      switch (serverType) {
        case 'decision_stream': return 'decision'
        case 'expert_status': return 'expert_status'
        case 'expert_results': return 'expert_status'
        case 'prompt_execution': return 'prompt_execution'
        case 'safety_check': return 'safety_check'
        default: return 'decision'
      }
    }

    // Convert historical messages to display format
    // New approach: Parse from metadata.envelope for perfect replay
    const historical = historicalMessages.map(msg => {
      const timestamp = new Date(msg.timestamp).getTime()

      // Extract the complete envelope from metadata (new storage format)
      const envelope = msg.metadata?.envelope

      if (!envelope) {
        // Fallback for old messages without envelope - use legacy parsing
        // This ensures backward compatibility with messages stored before the refactor

        // Check if this is a participant event (stored without envelope)
        const rawMessageType = msg.messageType || ''
        if (rawMessageType === 'participant_joined' || rawMessageType === 'participant_left' || msg.metadata?.eventType) {
          const isJoined = rawMessageType === 'participant_joined' || msg.metadata?.eventType === 'joined'
          return {
            id: msg.id,
            type: (isJoined ? 'joined' : 'left') as 'joined' | 'left',
            participantId: msg.metadata?.participantIdentity || msg.metadata?.participant_identity || '',
            participantName: msg.metadata?.participantName || msg.metadata?.participant_name || msg.content?.split(' ')[0] || 'Unknown',
            startedAt: timestamp,
            messageType: 'participant' as const,
            dataSource: 'db' as const,
          }
        }

        // For legacy messages without envelope, use metadata for speaker info
        const { speakerId: legacySpeakerId, speakerName: legacySpeakerName } = extractSpeakerInfo(msg.metadata)
        const legacyRole = determineMessageRole(
          legacySpeakerId,
          undefined,
          msg.messageType,
          viewerIdentity,
          legacySpeakerName,
          viewerName
        )
        return {
          id: msg.id,
          text: msg.content,
          role: legacyRole,
          status: 'final' as const,
          startedAt: timestamp,
          messageType: 'transcript' as const,
          participant_id: getParticipantName(msg),
          speaker_name: legacySpeakerName || getParticipantName(msg),
          source: 'db' as const,
        }
      }

      // Parse based on envelope.type (same logic as live messages)
      const messageType = envelope.type || 'unknown'
      const messageData = envelope.data || envelope

      // Extract speaker info for role determination
      const { speakerId, speakerName } = extractSpeakerInfo(msg.metadata)
      const envelopeSpeakerId = messageData?.speaker_id || envelope.participant_id
      const envelopeSpeakerName = messageData?.speaker_name

      // Handle different message types
      if (messageType === 'transcript_chunk' || messageType === 'transcript') {
        // User speech transcripts (from STT)
        // Determine role by comparing speaker to current viewer
        const role = determineMessageRole(
          speakerId || envelopeSpeakerId,
          messageData?.source,
          messageType,
          viewerIdentity,
          speakerName || envelopeSpeakerName,
          viewerName
        )
        return {
          id: msg.id,
          text: typeof messageData === 'string' ? messageData : messageData.text,
          role,
          status: 'final' as const,
          startedAt: timestamp,
          finalizedAt: timestamp,
          messageType: 'transcript' as const,
          participant_id: getParticipantName(msg),
          // Include attribution fields from stored envelope
          speaker_name: messageData?.speaker_name || getParticipantName(msg),
          agent_name: messageData?.agent_name,
          source: messageData?.source,  // Message source: user_speech, user_text, agent_response
          discarded: messageData?.discarded === true,
          dataSource: 'db' as const,    // Data source: db or live
        }
      } else if (messageType === 'agent_text') {
        // Agent response messages
        return {
          id: msg.id,
          text: typeof messageData === 'string' ? messageData : messageData.text,
          role: 'assistant' as const,
          status: 'final' as const,
          startedAt: timestamp,
          finalizedAt: timestamp,
          messageType: 'transcript' as const,
          participant_id: messageData?.agent_id || getParticipantName(msg),
          speaker_name: messageData?.agent_name || 'Agent',
          agent_name: messageData?.agent_name || 'Agent',
          agent_id: messageData?.agent_id,
          source: 'agent_response' as const,
          dataSource: 'db' as const,
        }
      } else if (messageType === 'user_text') {
        // User typed text messages
        // Determine role by comparing speaker to current viewer
        const role = determineMessageRole(
          speakerId || envelopeSpeakerId,
          'user_text',
          messageType,
          viewerIdentity,
          speakerName || envelopeSpeakerName,
          viewerName
        )
        const textContent = typeof messageData === 'string' ? messageData : (messageData.text || messageData)
        return {
          id: msg.id,
          text: typeof textContent === 'string' ? textContent : JSON.stringify(textContent),
          role,
          status: 'final' as const,
          startedAt: timestamp,
          finalizedAt: timestamp,
          messageType: 'transcript' as const,
          participant_id: envelope.participant_id || getParticipantName(msg),
          speaker_name: speakerName || envelopeSpeakerName || envelope.participant_id || getParticipantName(msg),
          source: 'user_text' as const,
          dataSource: 'db' as const,
        }
      } else if (messageType === 'debug') {
        // Debug messages - display in processing view
        return {
          id: msg.id,
          type: 'debug' as const,
          role: 'system' as const,
          status: 'final' as const,
          startedAt: timestamp,
          finalizedAt: timestamp,
          streamId: messageData.stream_id || 'db-stream',
          data: {
            component: messageData.component || 'agent',
            level: messageData.level || 'info',
            message: messageData.content || messageData.message || '',
            metadata: messageData.metadata || messageData
          },
          messageType: 'processing' as const,
          dataSource: 'db' as const,
        }
      } else if (['decision_stream', 'expert_status', 'expert_results', 'prompt_execution', 'safety_check'].includes(messageType)) {
        // Processing messages
        const processingType = mapToProcessingType(messageType)
        return {
          id: msg.id,
          type: processingType,
          role: 'system' as const,
          status: 'final' as const,
          startedAt: timestamp,
          finalizedAt: timestamp,
          streamId: messageData.stream_id || 'db-stream',
          data: messageData,
          messageType: 'processing' as const,
          dataSource: 'db' as const,
        }
      } else if (['complete_todo_list', 'plan_progress_update', 'plan_deliverable_update', 'state_change_notification', 'progress_update', 'task_progress_update'].includes(messageType)) {
        // Task update messages - don't display in chat (handled by task panel)
        return null
      } else if (messageType === 'participant_event' || messageType === 'participant_joined' || messageType === 'participant_left') {
        // Participant join/leave events from database
        // Convert to the same format as live ParticipantEvent objects
        // Database stores as 'participant_joined' or 'participant_left', but also support 'participant_event'
        const eventData = messageData || {}

        // Determine event type from either the data or the messageType itself
        const isJoined = messageType === 'participant_joined' || eventData.type === 'joined' || msg.metadata?.eventType === 'joined'

        return {
          id: msg.id,
          type: (isJoined ? 'joined' : 'left') as 'joined' | 'left',
          participantId: eventData.participantId || msg.metadata?.participantIdentity || msg.metadata?.participant_identity || '',
          participantName: eventData.participantName || msg.metadata?.participantName || msg.metadata?.participant_name || msg.content?.split(' ')[0] || 'Unknown',
          startedAt: timestamp,
          messageType: 'participant' as const,
          dataSource: 'db' as const,
        }
      } else if (['voice_narration_control', 'barge_in', 'tts_pause', 'tts_resume', 'tts_start', 'tts_stop'].includes(messageType)) {
        // Control messages - don't display in chat
        return null
      } else if (messageType.startsWith('audio_stream_')) {
        // Audio streaming messages - don't display in chat
        return null
      } else {
        // Unknown message type - display as simple transcript with content
        // Determine role by comparing speaker to current viewer
        const role = determineMessageRole(
          speakerId || envelopeSpeakerId,
          messageData?.source,
          messageType,
          viewerIdentity,
          speakerName || envelopeSpeakerName,
          viewerName
        )
        return {
          id: msg.id,
          text: typeof messageData === 'string' ? messageData : JSON.stringify(messageData),
          role,
          status: 'final' as const,
          startedAt: timestamp,
          messageType: 'transcript' as const,
          participant_id: getParticipantName(msg),
          speaker_name: speakerName || envelopeSpeakerName || messageData?.speaker_name || getParticipantName(msg),
          agent_name: messageData?.agent_name,
          source: messageData?.source,
          dataSource: 'db' as const,
        }
      }
    }).filter((msg): msg is NonNullable<typeof msg> => msg !== null) // Remove nulls with type guard

    // Filter historical messages based on showProcessingMessages toggle
    // When processing/debug is disabled, hide those messages from DB as well
    const filteredHistorical = showProcessingMessages
      ? historical
      : historical.filter(msg => msg.messageType !== 'processing')

    // Combine with live messages
    const liveTranscripts = turns.map(t => ({ ...t, messageType: 'transcript' as const, dataSource: 'live' as const }))
    const processing = showProcessingMessages
      ? processingMessages.map(p => ({ ...p, messageType: 'processing' as const, dataSource: 'live' as const }))
      : []
    const events = participantEvents.map(e => ({ ...e, messageType: 'participant' as const, dataSource: 'live' as const }))

    const combined = [...filteredHistorical, ...liveTranscripts, ...processing, ...events]

    // Deduplicate by ID (prefer live version if exists)
    const unique = Array.from(
      new Map(combined.map(m => [m.id, m])).values()
    )

    return unique.sort((a, b) => a.startedAt - b.startedAt)
  }, [historicalMessages, turns, processingMessages, participantEvents, showProcessingMessages, viewerIdentity, viewerName])

  // Infinite scroll handler with time-travel support
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    const scrollTop = target.scrollTop
    const scrollHeight = target.scrollHeight
    const clientHeight = target.clientHeight

    // Check if near bottom (within 100px)
    const nearBottom = scrollHeight - scrollTop - clientHeight < 100
    setIsNearBottom(nearBottom)

    // Time travel: Apply task state based on scroll position
    if (taskUpdateHistory.length > 0 && allMessages.length > 0) {
      if (nearBottom) {
        // At bottom - show latest state (exit history mode)
        applyLatestTaskState()
        setTaskHistoryMode(false, null)
      } else {
        // Not at bottom - calculate estimated timestamp from scroll position
        const oldestMessage = allMessages[0]
        const newestMessage = allMessages[allMessages.length - 1]
        const timeRange = newestMessage.startedAt - oldestMessage.startedAt

        // Calculate scroll percentage (0 = top/oldest, 1 = bottom/newest)
        const scrollPercentage = (scrollTop + clientHeight) / scrollHeight

        // Estimate current timestamp based on scroll position
        const estimatedTime = oldestMessage.startedAt + (timeRange * scrollPercentage)

        // Apply task state at this time (throttled - only if significantly different)
        const currentHistoricalTimestamp = useStore.getState().currentHistoricalTimestamp
        if (!currentHistoricalTimestamp || Math.abs(estimatedTime - currentHistoricalTimestamp) > 5000) {
          applyTaskStateAtTime(estimatedTime)
        }
      }
    }

    // Load more when scrolling near top
    if (scrollTop < 100 && hasMoreHistory && !isLoadingHistory && sessionId) {
      // Save current scroll position
      const previousScrollHeight = scrollHeight

      loadMoreHistory(sessionId).then(() => {
        // Restore scroll position after loading (prevents jump)
        requestAnimationFrame(() => {
          if (scrollContainerRef.current) {
            const newScrollHeight = scrollContainerRef.current.scrollHeight
            scrollContainerRef.current.scrollTop = newScrollHeight - previousScrollHeight + scrollTop
          }
        })
      })
    }
  }, [hasMoreHistory, isLoadingHistory, loadMoreHistory, sessionId, taskUpdateHistory, allMessages, applyLatestTaskState, applyTaskStateAtTime, setTaskHistoryMode])

  // Auto-scroll to bottom for new messages (only if already at bottom)
  useEffect(() => {
    if (isNearBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [allMessages, isNearBottom])

  // Teleprompter (#241): apply each speech-progress envelope exactly once (the
  // store stamps a monotonic seq, so the effect fires per distinct event).
  useEffect(() => {
    if (lastSpeechProgress) applyProgress(lastSpeechProgress.data)
  }, [lastSpeechProgress, applyProgress])

  // Teleprompter (#241): bind the latest streaming agent reply so it renders
  // dimmed ahead of the voice and lights up as the audio catches up.
  useEffect(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant') {
        noteAgentText(turns[i].id, turns[i].text)
        break
      }
    }
  }, [turns, noteAgentText])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header with processing toggle and task panel toggle */}
      <motion.div
        className={`px-4 py-3 border-b backdrop-blur-sm ${
          isDark ? 'border-border-dark' : 'border-border'
        }`}
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ProcessingToggle />

            {/* Recording Indicator - Clickable Button */}
            {(() => {
              const isRecording = listenerStatus?.listener?.isConnected
              const isReconnecting = listenerStatus?.listener?.roomState === 'reconnecting'

              return (
                <button
                  onClick={onShowLogs}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 cursor-pointer ${
                    isDark
                      ? 'bg-surface-dark-tertiary border-border-dark hover:bg-surface-dark-secondary hover:border-border-dark-secondary'
                      : 'bg-surface-secondary border-border hover:bg-zinc-100 hover:border-border-secondary'
                  }`}
                  title={
                    isRecording
                      ? 'Recording active - Click to view logs'
                      : isReconnecting
                        ? 'Reconnecting to recorder - Click to view logs'
                        : 'Not recording - Click to view logs'
                  }
                >
                  <div
                    className={`status-dot ${
                      isRecording
                        ? 'status-dot-error animate-pulse'
                        : isReconnecting
                          ? 'status-dot-warning'
                          : 'status-dot-neutral'
                    }`}
                  />
                  <span className={`text-label uppercase ${
                    isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                  }`}>
                    {isRecording ? 'RECORDING' : isReconnecting ? 'RECONNECTING' : 'IDLE'}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </button>
              )
            })()}

            {/* Face Button */}
            <button
              onClick={() => setFaceModalOpen(true)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 cursor-pointer ${
                isDark
                  ? 'bg-surface-dark-tertiary border-border-dark hover:bg-surface-dark-secondary hover:border-border-dark-secondary'
                  : 'bg-surface-secondary border-border hover:bg-zinc-100 hover:border-border-secondary'
              }`}
              title="Show STELLA face interface"
            >
              <Eye className={`w-3 h-3 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`} />
              <span className={`text-label uppercase ${
                isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
              }`}>
                FACE
              </span>
            </button>
          </div>

          {/* Task Panel Toggle Button - only show when panel is hidden and agent tasks exist */}
          {!showTaskPanel && agentTaskLists.size > 0 && (
            <motion.button
              onClick={() => setShowTaskPanel(true)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-label border transition-all duration-200 ${
                isDark
                  ? 'bg-surface-dark-tertiary text-content-inverse-secondary border-border-dark hover:bg-surface-dark-secondary'
                  : 'bg-surface-secondary text-content-secondary border-border hover:bg-zinc-100'
              }`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
              Show Tasks
            </motion.button>
          )}
        </div>
      </motion.div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto p-4 space-y-2 scrollbar-thin"
        onScroll={handleScroll}
      >
        {/* Loading indicator at top - only show when there are existing messages */}
        {isLoadingHistory && historicalMessages.length > 0 && (
          <div className={`text-center text-body-sm py-2 mb-2 ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}>
            <div className="inline-flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Loading older messages...
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {allMessages.map((message, index) => {
            // Only animate container for non-transcript messages (processing messages, etc.)
            const shouldAnimate = message.messageType !== 'transcript'

            const messageContent = (
              <>
                {message.messageType === 'transcript' ? (
                  message.role === 'system' ? (
                    // System messages - centered notification
                    <motion.div className="flex justify-center my-4">
                      <div className={`px-4 py-2 rounded-full text-caption ${
                        isDark
                          ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                          : 'bg-surface-secondary text-content-secondary border border-border'
                      }`}>
                        {message.text}
                      </div>
                    </motion.div>
                  ) : (
                    <MessageBubble
                      message={message as any}
                      deliveryStatus={getDeliveryStatus(message as any, pendingMessageIds)}
                      isDark={isDark}
                      spokenChar={spokenChar}
                      spokenTranscriptId={spokenTranscriptId}
                      frozenSpoken={frozenSpoken}
                    />
                  )
              ) : message.messageType === 'participant' ? (
                <ParticipantNotification event={message} />
              ) : (
                <motion.div
                  // initial={{ opacity: 0, scale: 0.9 }}
                  // animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3, delay: 0.1 }}
                >
                  <ProcessingMessageView message={message} />
                </motion.div>
              )}
              </>
            )

            return shouldAnimate ? (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                transition={{
                  duration: 0.4,
                  delay: index * 0.02,
                  ease: [0.25, 0.46, 0.45, 0.94]
                }}
              >
                {messageContent}
              </motion.div>
            ) : (
              <div key={message.id}>
                {messageContent}
              </div>
            )
          })}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
