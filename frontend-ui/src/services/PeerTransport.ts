import type {
  Envelope,
  Transport,
  TranscriptChunk,
  AgentSpeechProgress,
  ProcessingMessage,
  ProcessingMessageType,
  DecisionStreamData,
  PromptExecutionData,
  ExpertStatusData,
  SafetyCheckData,
  CompleteTodoListMessage,
  PlanProgressUpdate,
  PlanDeliverableUpdate,
  StateChangeNotification,
  ProgressUpdateMessage,
} from '../lib/types'
import { Room, RoomEvent, Track, RemoteTrack, RemoteAudioTrack, RemoteParticipant, DataPacket_Kind, RoomConnectOptions, ConnectionState } from 'livekit-client'
import { getRuntimeConfig } from '../config/runtime'
import { applyAgentAudioSilencing } from '../lib/agentAudio'
import { generateUUID } from '../lib/uuid'
import { determineMessageRole } from '../lib/messageUtils'

export class PeerTransport implements Transport {
  room?: Room
  remoteAudio?: HTMLAudioElement
  micStream?: MediaStream
  publishedAudioTrack?: any
  pausedAudioTime?: number
  isStreamingPaused: boolean = false
  private userName: string = 'User'  // Default fallback name
  private audioLevelInterval?: number
  private remoteAudioTrack?: RemoteAudioTrack

  // Connection state tracking to prevent duplicate connections
  private connectionState: 'idle' | 'connecting' | 'connected' | 'disconnecting' = 'idle'
  private connectionPromise?: Promise<void>
  private currentRoomName?: string

  // Audio track state tracking to prevent duplicate audio tracks
  private isPublishingAudio: boolean = false
  private isUnpublishingAudio: boolean = false

  // Track if audio playback is enabled (requires user interaction due to browser autoplay policy)
  private audioEnabled: boolean = false

  // Web Audio API for accurate speech detection
  private audioContext?: AudioContext
  private audioAnalyser?: AnalyserNode
  private audioAnalysisFrame?: number
  // Audio-level analysis only runs while a consumer (the Face modal) wants it.
  // Gating the loop on this flag keeps the page near-idle when nothing renders the level.
  private audioAnalysisActive: boolean = false

  // Set the user's actual name for proper message attribution
  setUserName(name: string) {
    this.userName = name
  }

  // Resume audio analysis - call this after user interaction (e.g., opening face modal)
  async resumeAudioAnalysis(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume()
        console.log('🎙️ [AUDIO] AudioContext resumed via resumeAudioAnalysis(), state:', this.audioContext.state)
      } catch (err) {
        console.warn('⚠️ [AUDIO] Could not resume AudioContext:', err)
      }
    }
  }

  // Enable/disable the audio-level analysis loop. Only the Face modal consumes the
  // emitted level, so the live session view toggles this on modal open/close to avoid
  // running 60 fps RMS analysis (and re-rendering subscribers) while nothing renders it.
  setAudioAnalysisActive(active: boolean): void {
    if (this.audioAnalysisActive === active) return
    this.audioAnalysisActive = active

    if (active) {
      // Opening the modal is a user interaction, so the AudioContext can resume.
      this.resumeAudioAnalysis()
      if (this.remoteAudioTrack) {
        this.startAudioLevelMonitoring()
      }
    } else {
      this.stopAudioLevelMonitoring()
      // Reset so the mouth/visualizer starts from rest next time the modal opens
      // rather than re-mounting against a stale frozen level.
      this.onAudioLevel(0)
      this.onRemoteSpeaking(false)
    }
  }

  // Check if connected to a specific room
  isConnectedToRoom(roomName: string): boolean {
    return this.connectionState === 'connected' && this.currentRoomName === roomName
  }

  // Get current connection state
  getConnectionState(): 'idle' | 'connecting' | 'connected' | 'disconnecting' {
    return this.connectionState
  }

  // Get current room name
  getCurrentRoomName(): string | undefined {
    return this.currentRoomName
  }

  onConnected = () => {}
  onDisconnected = (_reason?: string) => {}
  onError = (_err: Error) => {}
  onRemoteAudioTrack = (_track: MediaStreamTrack) => {}
  onTranscript = (_chunk: TranscriptChunk) => {}
  onSpeechProgress = (_data: AgentSpeechProgress) => {}
  onProcessingMessage = (_message: ProcessingMessage) => {}
  onServerMessage = (_msg: unknown) => {}
  onTTSStart = () => {}
  onTTSStop = () => {}
  onTodoListUpdate = (_data: CompleteTodoListMessage) => {}
  onPlanProgress = (_data: PlanProgressUpdate) => {}
  onDeliverableUpdate = (_data: PlanDeliverableUpdate) => {}
  onStateChange = (_data: StateChangeNotification) => {}
  onParticipantJoined = (_participantId: string, _participantName?: string, _isExisting?: boolean) => {}
  onParticipantLeft = (_participantId: string, _participantName?: string) => {}
  onLLMConfig = (_config: any) => {}
  onAudioLevel = (_level: number) => {}
  onRemoteSpeaking = (_speaking: boolean) => {}
  onProgressUpdate = (_data: ProgressUpdateMessage) => {}

  async connect(roomName?: string) {
    console.log(`[PeerTransport] connect() called - state=${this.connectionState}, room=${roomName}`)

    // Guard: If already connecting, wait for that connection to complete
    if (this.connectionState === 'connecting' && this.connectionPromise) {
      console.log('[PeerTransport] Already connecting, waiting for existing connection')
      return this.connectionPromise
    }

    // Guard: If already connected to the same room, skip
    if (this.connectionState === 'connected' && this.currentRoomName === roomName) {
      console.log('[PeerTransport] Already connected to room:', roomName)
      return
    }

    // Guard: If connected to a different room, disconnect first
    if (this.connectionState === 'connected') {
      console.log('[PeerTransport] Disconnecting from previous room before connecting to:', roomName)
      await this.disconnect()
    }

    // Guard: If currently disconnecting, wait for it to complete with polling
    if (this.connectionState === 'disconnecting') {
      console.log('[PeerTransport] Waiting for disconnect to complete before connecting')
      // Wait with exponential backoff, max 500ms total
      let waitTime = 50
      let totalWaited = 0
      while (this.connectionState === 'disconnecting' && totalWaited < 500) {
        await new Promise(resolve => setTimeout(resolve, waitTime))
        totalWaited += waitTime
        waitTime = Math.min(waitTime * 2, 200)
      }
      if (this.connectionState === 'disconnecting') {
        console.warn('[PeerTransport] Disconnect still in progress after 500ms, proceeding anyway')
      }
    }

    // Set state and create connection promise
    this.connectionState = 'connecting'
    this.currentRoomName = roomName

    this.connectionPromise = this._doConnect(roomName)

    try {
      await this.connectionPromise
      this.connectionState = 'connected'
      console.log(`[PeerTransport] Successfully connected to room: ${roomName}`)
    } catch (error) {
      this.connectionState = 'idle'
      this.currentRoomName = undefined
      throw error
    } finally {
      this.connectionPromise = undefined
    }
  }

  private async _doConnect(roomName?: string) {
    try {
      // Create LiveKit room
      const room = new Room()
      this.room = room

      // Set up event listeners
      room.on(RoomEvent.Connected, () => {
        console.log('🔗 [LIVEKIT] RoomEvent.Connected')
        this.onConnected()
      })

      room.on(RoomEvent.Reconnecting, () => {
        // Log but don't change status - keep UI stable during transient reconnects
        console.log('🔗 [LIVEKIT] RoomEvent.Reconnecting - keeping UI stable')
      })

      room.on(RoomEvent.Reconnected, () => {
        // Reconnection successful - ensure status stays connected
        console.log('🔗 [LIVEKIT] RoomEvent.Reconnected - connection restored')
        // Fire onConnected again to ensure UI is in correct state
        this.onConnected()
      })

      room.on(RoomEvent.Disconnected, (reason) => {
        console.log(`🔗 [LIVEKIT] RoomEvent.Disconnected: ${reason}`)
        this.onDisconnected(reason?.toString())
      })

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const audioTrack = track as RemoteAudioTrack
          const audioEl = audioTrack.attach()
          audioEl.autoplay = true
          audioEl.volume = 1.0
          audioEl.muted = false

          // Add to DOM - required by some browsers for audio playback
          audioEl.style.display = 'none'
          document.body.appendChild(audioEl)

          this.remoteAudio = audioEl
          this.remoteAudioTrack = audioTrack
          this.setupAudioEventListeners(audioEl)
          this.onRemoteAudioTrack(audioTrack.mediaStreamTrack)

          // Set up Web Audio API for accurate speech detection
          this.setupWebAudioAnalysis(audioTrack)

          // Start monitoring audio levels for face animation — but only if a consumer
          // (the Face modal) is currently active. Otherwise the loop stays parked until
          // setAudioAnalysisActive(true) is called, keeping the page idle.
          if (this.audioAnalysisActive) {
            this.startAudioLevelMonitoring()
          }

          // Debug: Log audio element state
          console.log('🔊 [AUDIO] Remote audio track attached:', {
            inDOM: audioEl.parentNode !== null,
            autoplay: audioEl.autoplay,
            volume: audioEl.volume,
            muted: audioEl.muted,
            paused: audioEl.paused,
            readyState: audioEl.readyState,
            srcObject: audioEl.srcObject ? 'MediaStream' : 'null',
          })

          // Explicitly try to play
          audioEl.play().then(() => {
            console.log('🔊 [AUDIO] play() succeeded')
          }).catch((err) => {
            console.error('🔊 [AUDIO] play() failed:', err.message)
          })
        }
      })

      room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const decoder = new TextDecoder()
          const message = decoder.decode(payload)

          const env: Envelope<any> = JSON.parse(message)

          // console.log('🔍 [DEBUG] Parsed message envelope:', {
          //   type: env.type,
          //   data: env.data
          // })

          // Barge-in (#15): silence/un-silence the agent track on its own
          // teleprompter-independent signal, synchronously on packet receipt so
          // it never waits on a React re-render. Kept off agent_speech_progress
          // so it still works when the teleprompter is disabled.
          if (env.type === 'agent_playback') {
            applyAgentAudioSilencing((env.data || {}).state, this.remoteAudio)
            return
          }

          // Teleprompter (#241): word-by-word highlight progress for agent speech.
          if (env.type === 'agent_speech_progress') {
            this.onSpeechProgress(env.data || {})
            return
          }

          if (env.type === 'transcript' || env.type === 'transcript_chunk' || env.type === 'agent_text') {
            // Transform server transcript/agent_text format to frontend format
            const serverData = env.data

            // WORKAROUND: Server timestamps are unreliable (2 hours behind)
            // Use client time for consistent timestamps with participant events
            // TODO: Fix server to send proper UTC timestamps with 'Z' suffix
            const startedAtMs = Date.now()

            // Keep diagnostic logging to monitor server timestamp issues
            if (serverData.timestamp) {
              try {
                const serverParsedMs = new Date(serverData.timestamp).getTime()
                const timeDiffMs = startedAtMs - serverParsedMs
                const timeDiffHours = timeDiffMs / (1000 * 60 * 60)

                // Log if server timestamp differs significantly from client time
                if (Math.abs(timeDiffHours) > 0.5) {
                  console.warn(`⏰ [TIMESTAMP] Server timestamp is ${timeDiffHours.toFixed(2)} hours behind client time - using client time`)
                  console.log(`   Server sent: ${serverData.timestamp} → ${new Date(serverParsedMs).toISOString()}`)
                  console.log(`   Using client: ${new Date(startedAtMs).toISOString()}`)
                }
              } catch (e) {
                // Ignore parse errors - we're using client time anyway
              }
            }

            // Determine role by comparing speaker identity against current user
            // Uses shared utility for consistent role determination
            const source = serverData.source as string | undefined
            const speakerId = serverData.speaker_id || serverData.participant_id || env.participant_id
            const speakerName = serverData.speaker_name || speakerId

            // Use shared utility - organizer identity is always 'human'
            const role = determineMessageRole(
              speakerId,
              source,
              env.type,
              'human',  // Organizer identity
              speakerName,
              this.userName
            )

            // Determine display name based on role
            let displayName: string
            if (role === 'assistant') {
              displayName = serverData.agent_name || 'Agent'
            } else if (role === 'user') {
              displayName = this.userName
            } else {
              displayName = speakerName || 'Participant'
            }

            const transcriptChunk: TranscriptChunk = {
              id: serverData.transcript_id || generateUUID(),
              role,
              text: serverData.text,
              status: serverData.is_final ? 'final' : 'partial',
              startedAt: startedAtMs,
              finalizedAt: serverData.is_final ? startedAtMs : undefined,
              // Attribution fields
              participant_id: serverData.participant_id,
              speaker_id: serverData.speaker_id,
              speaker_name: displayName,
              agent_id: serverData.agent_id,
              agent_name: serverData.agent_name,
              source: serverData.source,
              // Heard and shown, but not treated as a turn (see TranscriptChunk).
              discarded: serverData.discarded === true,
              // Delivery tracking - correlationId from agent echo
              correlationId: serverData.correlation_id,
            }

            this.onTranscript(transcriptChunk)
          } else if (this.isProcessingMessage(env.type)) {
            // Handle new processing messages
            const processingMessage = this.transformProcessingMessage(env)
            this.onProcessingMessage(processingMessage)
          } else if (env.type === 'tts_start') {
            // Handle TTS start event from backend
            this.onTTSStart()
          } else if (env.type === 'tts_stop' || env.type === 'tts_end') {
            // Handle TTS stop/end event from backend
            this.onTTSStop()
          } else if (env.type === 'tts_paused') {
            // Handle TTS pause confirmation from backend
            this.isStreamingPaused = true
          } else if (env.type === 'tts_resumed') {
            // Handle TTS resume confirmation from backend
            this.isStreamingPaused = false
          } else if (env.type === 'complete_todo_list') {
            // Handle complete todo list update with state machine architecture
            const todoData = env.data as CompleteTodoListMessage
            console.log(`🔄 [STATE MACHINE] Todo list update - Trigger: ${todoData.update_trigger}`)
            this.onTodoListUpdate(todoData)
          } else if (env.type === 'plan_progress_update') {
            // Handle plan progress update with state tracking
            const progressData = env.data as PlanProgressUpdate
            console.log(`📈 [PROGRESS] ${progressData.progress.percentage.toFixed(1)}% - State: ${progressData.current_state?.title || 'unknown'}`)
            this.onPlanProgress(progressData)
          } else if (env.type === 'plan_deliverable_update') {
            // Handle enhanced deliverable update with reasoning
            const deliverableData = env.data as PlanDeliverableUpdate
            console.log(`✅ [DELIVERABLE] ${deliverableData.deliverable_key} = ${deliverableData.deliverable_value} (${Math.round(deliverableData.confidence * 100)}% confidence)`)
            this.onDeliverableUpdate(deliverableData)
          } else if (env.type === 'state_change_notification') {
            // Handle state change in state machine
            const stateChangeData = env.data as StateChangeNotification
            console.log(`🔀 [STATE CHANGE] ${stateChangeData.previous_state} → ${stateChangeData.current_state}: ${stateChangeData.state_title || 'unknown'}`)
            this.onStateChange(stateChangeData)
          } else if (env.type === 'task_progress_update') {
            // Handle task progress update (backward compatibility)
            console.log(`📝 [TASK UPDATE] Legacy task progress update received`)
            this.onServerMessage(env)
          } else if (env.type === 'llm_config') {
            // Handle LLM configuration from backend
            const llmConfig = env.data
            console.log(`🤖 [LLM CONFIG] Provider: ${llmConfig.provider}, Model: ${llmConfig.model}`)
            this.onLLMConfig(llmConfig)
          } else if (env.type === 'progress_update') {
            // Handle generic progress update from SDK
            const progressData = env.data as ProgressUpdateMessage
            console.log(`📋 [PROGRESS UPDATE] ${progressData.progress_percentage?.toFixed(1) || 0}% - Trigger: ${progressData.update_trigger}`)
            this.onProgressUpdate(progressData)
          } else {
            // console.log('🔍 [DEBUG] Other message type:', env.type)
            this.onServerMessage(env)
          }
        } catch (error) {
          console.error('❌ [ERROR] Error parsing data message:', error)
        }
      })

      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        // Log all connection state changes for debugging
        console.log(`🔗 [LIVEKIT] ConnectionStateChanged: ${state}`)

        // Handle reconnection states gracefully - don't flicker the UI
        // ConnectionState enum values: Disconnected, Connecting, Connected, Reconnecting
        switch (state) {
          case ConnectionState.Reconnecting:
            // Don't change UI status during reconnection - it's transient
            console.log('🔗 [LIVEKIT] Reconnecting... (keeping UI stable)')
            break
          case ConnectionState.Connected:
            // Successfully reconnected
            if (this.connectionState === 'connected') {
              console.log('🔗 [LIVEKIT] Reconnection successful')
            }
            break
          case ConnectionState.Disconnected:
            // Only log - let RoomEvent.Disconnected handle the actual status change
            if (this.connectionState === 'connected') {
              console.warn('🔗 [LIVEKIT] Unexpected disconnection detected')
            }
            break
        }
      })

      // Listen for participant join/leave events
      room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        console.log(`👤 [JOIN] Participant connected: ${participant.identity} (${participant.name})`)
        this.onParticipantJoined(participant.identity, participant.name)
      })

      room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        console.log(`👤 [LEAVE] Participant disconnected: ${participant.identity} (${participant.name})`)
        this.onParticipantLeft(participant.identity, participant.name)
      })

      // Generate a simple access token (in production, this should come from your server)
      const token = await this.generateAccessToken(roomName)

      // Connect to room
      const connectOptions: RoomConnectOptions = {
        autoSubscribe: true
      }

      const config = getRuntimeConfig()
      await room.connect(config.livekitUrl, token, connectOptions)

      // Enable audio playback (required for browser autoplay policy)
      // Must be called after user interaction (connect button click satisfies this)
      // On page refresh/auto-connect, this may fail - we handle it gracefully
      try {
        await room.startAudio()
        this.audioEnabled = true
      } catch (audioErr) {
        console.warn('[PeerTransport] startAudio() failed (no user interaction yet):', (audioErr as Error).message)
        console.log('[PeerTransport] Audio will be enabled on first user interaction')
        this.audioEnabled = false
        // Set up a one-time click handler to enable audio
        const enableAudio = async () => {
          try {
            await room.startAudio()
            this.audioEnabled = true
            console.log('[PeerTransport] Audio enabled after user interaction')
          } catch (e) {
            console.warn('[PeerTransport] Failed to enable audio:', e)
          }
          document.removeEventListener('click', enableAudio)
          document.removeEventListener('keydown', enableAudio)
        }
        document.addEventListener('click', enableAudio, { once: true })
        document.addEventListener('keydown', enableAudio, { once: true })
      }

      console.log(`👤 [USER] Connected as: ${room.localParticipant.identity}`)

      // Notify about participants already in the room
      // (ParticipantConnected only fires for joins AFTER we connect)
      // Mark these as "existing" so we don't show "joined" notifications
      for (const participant of room.remoteParticipants.values()) {
        console.log(`👤 [EXISTING] Participant already in room: ${participant.identity} (${participant.name})`)
        this.onParticipantJoined(participant.identity, participant.name, true /* isExisting */)
      }

      // Publish microphone if available
      if (this.micStream) {
        const audioTrack = this.micStream.getAudioTracks()[0]
        if (audioTrack) {
          this.publishedAudioTrack = await room.localParticipant.publishTrack(audioTrack)
        }
      }

    } catch (error) {
      console.error('[PeerTransport] Failed to connect to LiveKit:', error)
      this.onError(error as Error)
      throw error  // Re-throw so the outer connect() can catch it
    }
  }

  async disconnect() {
    console.log(`[PeerTransport] disconnect() called - state=${this.connectionState}`)

    // Guard: If already disconnecting or idle, skip
    if (this.connectionState === 'disconnecting') {
      console.log('[PeerTransport] Already disconnecting')
      return
    }

    if (this.connectionState === 'idle') {
      console.log('[PeerTransport] Already disconnected')
      return
    }

    this.connectionState = 'disconnecting'
    // Stop audio level monitoring
    this.stopAudioLevelMonitoring()

    // Clean up Web Audio resources
    if (this.audioAnalyser) {
      this.audioAnalyser.disconnect()
      this.audioAnalyser = undefined
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close()
      this.audioContext = undefined
    }

    if (this.room) {
      await this.room.disconnect()
      this.room = undefined
    }

    // Clean up audio element from DOM
    if (this.remoteAudio) {
      this.remoteAudio.pause()
      if (this.remoteAudio.parentNode) {
        this.remoteAudio.parentNode.removeChild(this.remoteAudio)
      }
    }
    this.remoteAudio = undefined
    this.remoteAudioTrack = undefined
    this.publishedAudioTrack = undefined

    // Reset audio publishing state
    this.isPublishingAudio = false
    this.isUnpublishingAudio = false

    // Reset connection state
    this.connectionState = 'idle'
    this.currentRoomName = undefined

    console.log('[PeerTransport] Disconnected successfully')
    this.onDisconnected('client disconnect')
  }

  sendUserText(text: string, correlationId?: string) {
    if (!this.room) {
      console.error('[PeerTransport] Cannot send message: Room not initialized')
      return
    }

    // More detailed state checking
    const roomState = this.room.state
    if (roomState !== 'connected') {
      console.error(`[PeerTransport] Cannot send message: Room not connected (current state: ${roomState})`)
      console.log('[PeerTransport] Waiting for connection... Please try again once connected.')
      return
    }

    // Additional check for local participant
    if (!this.room.localParticipant) {
      console.error('[PeerTransport] Cannot send message: Local participant not available')
      return
    }

    // Envelope with optional correlationId for optimistic UI updates
    const env: Envelope<{ text: string; correlation_id?: string }> = {
      type: 'user_text',
      data: {
        text: text,
        correlation_id: correlationId,
      },
      participant_id: this.userName  // Use actual user name for proper attribution
    }
    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(env))
    try {
      this.room.localParticipant.publishData(data, { reliable: true })
      console.log(`[PeerTransport] ✓ Message sent: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${correlationId ? ` (correlationId: ${correlationId.substring(0, 8)}...)` : ''}`)
    } catch (error) {
      console.error('[PeerTransport] Error sending data:', error)
    }
  }


  sendControl(kind: string, payload?: unknown) {
    if (!this.room || this.room.state !== 'connected' || !this.room.localParticipant) {
      console.warn(`[PeerTransport] Cannot send control message '${kind}': Room not ready`)
      return
    }

    const env: Envelope<any> = { type: kind as any, data: payload }
    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(env))
    try {
      this.room.localParticipant.publishData(data, { reliable: true })
      console.log(`[PeerTransport] ✓ Control message sent: ${kind}`)
    } catch (error) {
      console.error(`[PeerTransport] Error sending control message '${kind}':`, error)
    }
  }

  // Send PCM16 audio frame data for real-time transcription
  sendAudioFrame(pcmData: ArrayBuffer, format: string = 'pcm16') {
    if (!this.room || this.room.state !== 'connected') {
      console.warn('Cannot send audio frame - room not connected')
      return
    }

    const audioArray = Array.from(new Uint8Array(pcmData))
    const env: Envelope<any> = {
      type: 'audio_stream_chunk',
      participant_id: this.userName,
      data: {
        audio: audioArray,
        format: format,
        chunkIndex: Date.now(),
        timestamp: Date.now(),
        isLastChunk: false
      }
    }
    
    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(env))
    
    try {
      this.room.localParticipant.publishData(data, { reliable: true })
    } catch (error) {
      console.error('Error sending audio frame:', error)
    }
  }

  // Start audio streaming session
  startAudioStream(sessionId?: string, format: string = 'pcm16', sampleRate: number = 16000) {
    if (!this.room || this.room.state !== 'connected') {
      console.warn('Cannot start audio stream - room not connected')
      return
    }

    const env: Envelope<any> = {
      type: 'audio_stream_start',
      participant_id: this.userName,
      data: {
        sessionId: sessionId || `session_${Date.now()}`,
        format: format,
        sampleRate: sampleRate,
        timestamp: Date.now()
      }
    }
    
    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(env))
    
    try {
      this.room.localParticipant.publishData(data, { reliable: true })
    } catch (error) {
      console.error('Error starting audio stream:', error)
    }
  }

  // Stop audio streaming session
  stopAudioStream() {
    if (!this.room || this.room.state !== 'connected') {
      console.warn('Cannot stop audio stream - room not connected')
      return
    }

    const env: Envelope<any> = {
      type: 'audio_stream_stop',
      participant_id: this.userName,
      data: {
        timestamp: Date.now()
      }
    }

    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(env))

    try {
      this.room.localParticipant.publishData(data, { reliable: true })
    } catch (error) {
      console.error('Error stopping audio stream:', error)
    }
  }

  // Send mute signal to trigger VAD endpoint
  sendMuteSignal() {
    if (!this.room || this.room.state !== 'connected') {
      console.warn('Cannot send mute signal - room not connected')
      return
    }

    const env: Envelope<any> = {
      //@ts-ignore
      type: 'audio_stream_mute',
      data: {
        timestamp: Date.now(),
        reason: 'user_muted'
      }
    }

    const encoder = new TextEncoder()
    const data = encoder.encode(JSON.stringify(env))

    try {
      this.room.localParticipant.publishData(data, { reliable: true })
    } catch (error) {
      console.error('Error sending mute signal:', error)
    }
  }

  async attachMicStream(stream: MediaStream) {
    this.micStream = stream
    if (this.room && this.room.state === 'connected') {
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        this.publishedAudioTrack = await this.room.localParticipant.publishTrack(audioTrack)
      }
    }
  }

  // Publish microphone audio track to LiveKit
  async publishAudioTrack(stream: MediaStream) {
    if (!this.room || this.room.state !== 'connected') {
      console.warn('Cannot publish audio track - room not connected')
      return false
    }

    // Guard: Prevent multiple simultaneous publish operations
    if (this.isPublishingAudio) {
      console.warn('[AUDIO] Already publishing audio track, ignoring duplicate request')
      return false
    }

    // Guard: Wait for any pending unpublish to complete
    if (this.isUnpublishingAudio) {
      console.log('[AUDIO] Waiting for unpublish to complete before publishing')
      let waitTime = 0
      while (this.isUnpublishingAudio && waitTime < 500) {
        await new Promise(resolve => setTimeout(resolve, 50))
        waitTime += 50
      }
      if (this.isUnpublishingAudio) {
        console.warn('[AUDIO] Unpublish still in progress after 500ms, proceeding anyway')
      }
    }

    // Guard: If there's already a published track, unpublish it first
    if (this.publishedAudioTrack) {
      console.log('[AUDIO] Existing track found, unpublishing before new publish')
      await this.unpublishAudioTrack()
    }

    this.isPublishingAudio = true

    try {
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        console.log('🔊 [AUDIO] Publishing audio track')
        this.publishedAudioTrack = await this.room.localParticipant.publishTrack(audioTrack)
        this.micStream = stream
        console.log('✓ [AUDIO] Audio track published successfully')
        return true
      }
    } catch (error) {
      console.error('Error publishing audio track:', error)
      return false
    } finally {
      this.isPublishingAudio = false
    }
    return false
  }

  // Unpublish and stop microphone audio track
  async unpublishAudioTrack() {
    if (!this.room) {
      return
    }

    // Guard: Prevent multiple simultaneous unpublish operations
    if (this.isUnpublishingAudio) {
      console.warn('[AUDIO] Already unpublishing audio track, ignoring duplicate request')
      return
    }

    // Guard: Nothing to unpublish
    if (!this.publishedAudioTrack) {
      console.log('[AUDIO] No audio track to unpublish')
      return
    }

    this.isUnpublishingAudio = true

    try {
      console.log('🔇 [AUDIO] Unpublishing audio track')

      // Send mute signal to trigger VAD endpoint
      this.sendMuteSignal()

      // Unpublish the track from LiveKit
      if (this.publishedAudioTrack.track) {
        await this.room.localParticipant.unpublishTrack(this.publishedAudioTrack.track)
      }

      // Stop the media track
      if (this.micStream) {
        this.micStream.getTracks().forEach(track => track.stop())
        this.micStream = undefined
      }

      this.publishedAudioTrack = undefined
      console.log('✓ [AUDIO] Audio track unpublished successfully')
    } catch (error) {
      console.error('Error unpublishing audio track:', error)
      // Reset state even on error to prevent deadlock
      this.publishedAudioTrack = undefined
    } finally {
      this.isUnpublishingAudio = false
    }
  }

  // Mute the microphone by disabling the audio track (deprecated - use unpublishAudioTrack instead)
  async muteAudio() {
    if (this.publishedAudioTrack) {
      console.log('🔇 [AUDIO] Muting audio track')
      await this.publishedAudioTrack.mute()
      this.sendMuteSignal()
    }
  }

  // Unmute the microphone by enabling the audio track (deprecated - use publishAudioTrack instead)
  async unmuteAudio() {
    if (this.publishedAudioTrack) {
      console.log('🔊 [AUDIO] Unmuting audio track')
      await this.publishedAudioTrack.unmute()
    }
  }

  // Check if audio is currently muted
  isAudioMuted(): boolean {
    return this.publishedAudioTrack ? this.publishedAudioTrack.isMuted : true
  }

  // Generate a development token for LiveKit dev mode
  private async generateAccessToken(roomName?: string): Promise<string> {
    // Fetch token from backend API (secure - API secret never exposed to browser)
    const identity = 'human'
    const actualRoomName = roomName || 'voice-ai-room'
    const config = getRuntimeConfig()

    console.log(`🔗 Chat connecting to LiveKit room: "${actualRoomName}" at ${config.livekitUrl}`)

    try {
      console.log(`🔑 [TOKEN] Requesting token from backend: ${config.apiUrl}/livekit/token`)
      const response = await fetch(`${config.apiUrl}/livekit/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          roomName: actualRoomName,
          identity: identity,
          name: this.userName,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        console.log('✓ [TOKEN] Successfully obtained token from backend')
        return data.token
      } else {
        const errorText = await response.text()
        console.error(`[TOKEN] Backend token endpoint returned ${response.status}:`, errorText)
        throw new Error(`Failed to get token from backend: ${response.status} ${errorText}`)
      }
    } catch (e) {
      console.error('[TOKEN] Failed to fetch token from backend:', e)
      throw e
    }
  }

  private isProcessingMessage(type: string): boolean {
    return ['decision_stream', 'prompt_execution', 'expert_status', 'safety_check', 'debug'].includes(type)
  }

  private transformProcessingMessage(env: Envelope<any>): ProcessingMessage {
    const serverData = env.data
    const messageType = this.mapToProcessingMessageType(env.type)

    // Use client timestamp for consistency (server timestamps are unreliable)
    const timestamp = Date.now()

    // Handle debug messages specially - transform to DebugData format
    if (env.type === 'debug') {
      return {
        id: generateUUID(),
        type: 'debug',
        role: 'system',
        status: 'final',
        startedAt: timestamp,
        finalizedAt: timestamp,
        streamId: generateUUID(),
        data: {
          component: serverData.component || 'agent',
          level: serverData.level || 'info',
          message: serverData.content || serverData.message || '',
          metadata: serverData.metadata || serverData
        }
      }
    }

    return {
      id: generateUUID(),
      type: messageType,
      role: 'system',
      status: 'final',
      startedAt: timestamp,
      finalizedAt: timestamp,
      streamId: serverData.stream_id,
      data: serverData
    }
  }

  private mapToProcessingMessageType(serverType: string): ProcessingMessageType {
    switch (serverType) {
      case 'decision_stream':
        return 'decision'
      case 'prompt_execution':
        return 'prompt_execution'
      case 'expert_status':
        return 'expert_status'
      case 'safety_check':
        return 'safety_check'
      case 'debug':
        return 'debug'
      default:
        return 'decision'
    }
  }

  pauseTTSPlayback() {
    if (this.remoteAudio && !this.isStreamingPaused) {
      this.isStreamingPaused = true
      console.log('⏸️ [TTS] Sending pause/barge-in signal to backend')

      // Send multiple signals to ensure backend responds
      // 1. Explicit pause signal
      this.sendControl('tts_pause', {
        action: 'pause_stream',
        timestamp: Date.now(),
        message: 'User requested TTS pause'
      })

      // 2. Barge-in signal (might be what backend expects)
      this.sendControl('barge_in', {
        action: 'pause',
        reason: 'user_pause_request',
        timestamp: Date.now()
      })
    }
  }

  resumeTTSPlayback() {
    if (this.remoteAudio && this.isStreamingPaused) {
      this.isStreamingPaused = false
      console.log('▶️ [TTS] Sending resume signal to backend')

      // Send clear resume signal to backend to continue TTS streaming
      this.sendControl('tts_resume', {
        action: 'resume_stream',
        timestamp: Date.now(),
        message: 'User requested TTS resume'
      })
    }
  }

  private setupAudioEventListeners(audioEl: HTMLAudioElement) {
    // Detect when audio starts playing (TTS begins)
    audioEl.addEventListener('play', () => {
      if (!this.isStreamingPaused) {
        console.log('🔊 [TTS] Audio playback started (detected)')
        this.onTTSStart()
      }
    })

    // Detect when audio ends (TTS completes)
    audioEl.addEventListener('ended', () => {
      console.log('🔇 [TTS] Audio playback ended (detected)')
      this.isStreamingPaused = false
      this.onTTSStop()
    })

    // Detect when audio has data and is ready to play
    audioEl.addEventListener('canplay', () => {
      console.log('🔊 [TTS] Audio ready to play (detected)')
      // Only trigger TTS start if it's not already paused by user
      if (!this.isStreamingPaused) {
        this.onTTSStart()
      }
    })

    // Handle when streaming stops naturally (no more data)
    audioEl.addEventListener('pause', () => {
      // Only trigger stop if it's not user-initiated pause
      if (!this.isStreamingPaused) {
        console.log('🔇 [TTS] Audio stream paused naturally')
        this.onTTSStop()
      }
    })
  }

  // Set up Web Audio API for accurate speech detection from remote audio
  private async setupWebAudioAnalysis(audioTrack: RemoteAudioTrack) {
    try {
      // Create AudioContext if not exists
      if (!this.audioContext) {
        this.audioContext = new AudioContext()
      }

      // Resume AudioContext if suspended (browsers require user interaction)
      if (this.audioContext.state === 'suspended') {
        console.log('🎙️ [AUDIO] AudioContext is suspended, attempting to resume...')
        await this.audioContext.resume()
        console.log('🎙️ [AUDIO] AudioContext resumed successfully, state:', this.audioContext.state)
      }

      // Create source from remote track's MediaStreamTrack
      const mediaStream = new MediaStream([audioTrack.mediaStreamTrack])
      const source = this.audioContext.createMediaStreamSource(mediaStream)

      // Create analyser for audio content analysis
      const analyser = this.audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.8

      // Connect source to analyser (no need to connect to destination - audio already playing)
      source.connect(analyser)

      this.audioAnalyser = analyser
      console.log('🎙️ [AUDIO] Web Audio API setup complete for speech detection')
    } catch (error) {
      console.error('❌ [AUDIO] Failed to setup Web Audio API:', error)
      // Will fall back to basic volume detection in startAudioLevelMonitoring
    }
  }

  // Calculate RMS (Root Mean Square) amplitude from audio samples
  private calculateRMS(timeData: Uint8Array): number {
    let sumSquares = 0
    for (let i = 0; i < timeData.length; i++) {
      // Normalize to -1 to 1 range (Uint8Array is 0-255, center at 128)
      const normalized = (timeData[i] - 128) / 128
      sumSquares += normalized * normalized
    }
    return Math.sqrt(sumSquares / timeData.length)
  }

  // Start monitoring audio levels for face animation with RMS analysis.
  // The rAF loop is throttled to ~30 Hz and only emits the level when it changes
  // meaningfully, so silence produces no store writes (and no subscriber re-renders).
  private startAudioLevelMonitoring() {
    // Idempotent: never run two concurrent loops.
    if (this.audioAnalysisFrame !== undefined) return

    let lastSpeakingState = false
    let resumeAttempted = false
    // Throttle the RMS math + emits to ~30 Hz — plenty for a mouth visualizer, and a
    // fraction of the per-frame work the old unconditional 60 fps loop did.
    const MIN_INTERVAL_MS = 33
    // Only emit when the level moves by at least this much, so a steady value (e.g. silence)
    // stops re-rendering the Face modal entirely.
    const LEVEL_EPSILON = 0.01
    let lastProcessTime = 0
    let lastEmittedLevel = -1

    const analyzeAudio = async (now: number) => {
      if (!this.remoteAudioTrack) {
        this.audioAnalysisFrame = undefined
        return
      }

      // Throttle: skip this frame's work until the interval has elapsed.
      if (now - lastProcessTime < MIN_INTERVAL_MS) {
        this.audioAnalysisFrame = requestAnimationFrame(analyzeAudio)
        return
      }
      lastProcessTime = now

      let audioLevel = 0
      let isSpeaking = false

      // Try to resume AudioContext if it's suspended (user interaction may have happened)
      if (this.audioContext && this.audioContext.state === 'suspended' && !resumeAttempted) {
        resumeAttempted = true
        try {
          await this.audioContext.resume()
          console.log('🎙️ [AUDIO] AudioContext resumed during monitoring, state:', this.audioContext.state)
        } catch (err) {
          console.warn('⚠️ [AUDIO] Could not resume AudioContext:', err)
        }
      }

      if (this.audioAnalyser && this.audioContext?.state === 'running') {
        // Use Web Audio API for accurate audio content analysis
        const bufferLength = this.audioAnalyser.frequencyBinCount
        const dataArray = new Uint8Array(bufferLength)

        // Get time-domain audio data (waveform)
        this.audioAnalyser.getByteTimeDomainData(dataArray)

        // Calculate RMS amplitude (accurate loudness)
        const rms = this.calculateRMS(dataArray)

        // Normalize to 0.0-1.0 range and amplify for visible mouth animation
        audioLevel = Math.min(1.0, rms * 8.0)  // Increased from 3.0 to 8.0 for more visible movement

        // Speech detection: RMS threshold of 0.02 (empirically tuned)
        isSpeaking = rms > 0.02
      } else {
        // Fallback: use basic volume detection if Web Audio failed or not running
        audioLevel = this.remoteAudioTrack.getVolume() || 0
        isSpeaking = audioLevel > 0.05
      }

      // Emit audio level only on a meaningful change (or the very first frame).
      if (lastEmittedLevel < 0 || Math.abs(audioLevel - lastEmittedLevel) >= LEVEL_EPSILON) {
        this.onAudioLevel(audioLevel)
        lastEmittedLevel = audioLevel
      }

      // Only emit speaking state change if it actually changed
      if (isSpeaking !== lastSpeakingState) {
        this.onRemoteSpeaking(isSpeaking)
        lastSpeakingState = isSpeaking
      }

      // Bail before rescheduling if the loop was torn down while we were awaiting
      // (e.g. the modal closed during audioContext.resume()). Without this the awaited
      // continuation would resurrect a loop stopAudioLevelMonitoring() already cancelled,
      // reintroducing the idle burn this is meant to remove.
      if (!this.audioAnalysisActive || !this.remoteAudioTrack) {
        this.audioAnalysisFrame = undefined
        return
      }

      // Continue the loop (throttled above to ~30 Hz of actual work)
      this.audioAnalysisFrame = requestAnimationFrame(analyzeAudio)
    }

    // Start the analysis loop
    this.audioAnalysisFrame = requestAnimationFrame(analyzeAudio)
    console.log('🎙️ [AUDIO] Started audio level monitoring (Web Audio RMS analysis, ~30 Hz, delta-gated)')
  }

  // Stop monitoring audio levels
  private stopAudioLevelMonitoring() {
    // Cancel animation frame
    if (this.audioAnalysisFrame !== undefined) {
      cancelAnimationFrame(this.audioAnalysisFrame)
      this.audioAnalysisFrame = undefined
    }

    // Clear legacy interval if exists
    if (this.audioLevelInterval) {
      clearInterval(this.audioLevelInterval)
      this.audioLevelInterval = undefined
    }

    console.log('🎙️ [AUDIO] Stopped audio level monitoring')
  }

}
