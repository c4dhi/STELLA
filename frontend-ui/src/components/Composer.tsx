
import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'
import { useThemeStore } from '../store/themeStore'
import { startMicWithVu } from '../services/audio/capture'
import { useMessaging } from './messaging'

export default function Composer() {
  const [text, setText] = useState('')
  const status = useStore(s => s.status)
  const transport = useStore(s => s.transport)
  const isMuted = useStore(s => s.isMuted)
  const isRecording = useStore(s => s.isRecording)
  const setIsMuted = useStore(s => s.setIsMuted)
  const setIsRecording = useStore(s => s.setIsRecording)
  const addOptimisticMessage = useStore(s => s.addOptimisticMessage)
  const vu = useStore(s => s.vu)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Get the user name from transport for message attribution
  const userName = (transport as any)?.userName
  const { createOptimisticMessage } = useMessaging({ userName })

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const send = () => {
    if (!text.trim() || !transport) return

    // Create optimistic message and add to store immediately
    const optimisticChunk = createOptimisticMessage(text.trim())
    addOptimisticMessage(optimisticChunk)

    // Send via transport with correlationId for confirmation tracking
    try {
      transport.sendUserText(text.trim(), optimisticChunk.correlationId)
    } catch (e) {
      console.error('Failed to send message:', e)
    }

    setText('')
  }

  const toggleMute = useCallback(async () => {
    if (!transport || status !== 'connected') return

    if (isMuted && transport.hasPublishedAudio()) {
      // Soft unmute: the mic and track are still there, just muted (#362)
      try {
        await transport.unmuteAudio()
        setIsMuted(false)
        setIsRecording(true)
      } catch (error) {
        console.error('Error unmuting audio:', error)
      }
    } else if (isMuted) {
      // First unmute - acquire the microphone and publish it
      try {
        // Clean up any existing stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop())
          streamRef.current = null
        }

        let audioContext = audioContextRef.current
        if (!audioContext) {
          audioContext = new AudioContext()
          audioContextRef.current = audioContext
        }

        // Get microphone stream with VU meter
        const stream = await startMicWithVu(audioContext, transport as any)
        streamRef.current = stream

        // Publish audio track to LiveKit
        await transport.publishAudioTrack(stream)

        setIsMuted(false)
        setIsRecording(true)
      } catch (error) {
        console.error('Error starting audio streaming:', error)
        setIsMuted(true)
        setIsRecording(false)
      }
    } else {
      // Soft mute: keep the connection and the track, send silence. Tearing the
      // track down made STT restart and Stella answer half-sentences (#362).
      await transport.muteAudio()

      setIsMuted(true)
      setIsRecording(false)
      useStore.getState().setVu(0) // Reset VU meter
    }
  }, [isMuted, transport, status, setIsMuted, setIsRecording])

  // Auto-start audio streaming when connected (initially muted, but ready to stream when unmuted)
  useEffect(() => {
    const initializeAudio = async () => {
      if (status === 'connected' && transport && !audioContextRef.current) {
        try {
          // Pre-initialize audio context but don't start streaming yet
          const audioContext = new AudioContext()
          audioContextRef.current = audioContext
        } catch (error) {
          console.error('Error initializing audio context:', error)
        }
      } else if (status !== 'connected' && audioContextRef.current) {
        // Clean up when disconnected
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop())
          streamRef.current = null
        }

        // Ensure audio track is unpublished when disconnecting
        if (transport) {
          await transport.unpublishAudioTrack()
        }

        audioContextRef.current.close()
        audioContextRef.current = null
        setIsRecording(false)
        setIsMuted(true) // Reset to muted state
        useStore.getState().setVu(0) // Reset VU meter
      }
    }

    initializeAudio()
  }, [status, transport, setIsRecording, setIsMuted])

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      const cleanup = async () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop())
          streamRef.current = null
        }

        // Ensure audio track is unpublished on unmount
        if (transport) {
          await transport.unpublishAudioTrack()
        }

        if (audioContextRef.current) {
          audioContextRef.current.close()
          audioContextRef.current = null
        }
        useStore.getState().setVu(0) // Reset VU meter on cleanup
      }

      cleanup()
    }
  }, [transport])

  return (
    <motion.div
      className={`px-4 py-4 backdrop-blur-sm rounded-xl border ${isDark
          ? 'bg-surface-dark-secondary/90 border-border-dark'
          : 'bg-white/90 border-border shadow-sm'
        }`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-2">
        {/* Input Field Container */}
        <div
          className={`min-h-9 flex-1 flex items-center gap-2 rounded-lg border transition-all duration-200 ${isDark
              ? 'bg-surface-dark-tertiary border-border-dark focus-within:border-border-dark-secondary'
              : 'bg-surface-secondary border-border focus-within:border-border-secondary focus-within:bg-white'
            }`}
        >
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            className={`flex-1 bg-transparent px-3 py-2 rounded-lg outline-none text-body ${isDark
                ? 'text-content-inverse placeholder:text-content-inverse-tertiary'
                : 'text-content placeholder:text-content-tertiary'
              }`}
            placeholder={status === 'connected' ? 'Type your message...' : 'Connect to start'}
            disabled={status !== 'connected'}
          />

          {/* Voice Activity Indicator */}
          <AnimatePresence>
            {isRecording && (
              <motion.div
                className="flex items-center gap-2"
                initial={{ opacity: 0, scale: 0.8, x: 20 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.8, x: 20 }}
                transition={{ duration: 0.3 }}
              >
                {/* Minimalist Waveform */}
                <div className="flex items-center gap-0.5">
                  {[...Array(4)].map((_, i) => (
                    <motion.div
                      key={i}
                      className={`w-px rounded-full ${isDark ? 'bg-content-inverse-secondary' : 'bg-content-secondary'}`}
                      animate={{
                        height: [2, 6, 2],
                        opacity: vu > 0.1 ? [0.3, 0.8, 0.3] : 0.25
                      }}
                      transition={{
                        duration: 0.8,
                        repeat: Infinity,
                        delay: i * 0.12,
                        ease: "easeInOut"
                      }}
                    />
                  ))}
                </div>

                {/* Minimal Recording Indicator */}
                <motion.div
                  className={`w-0.5 h-0.5 rounded-full ${isDark ? 'bg-content-inverse' : 'bg-content'}`}
                  animate={{ opacity: [0.3, 0.9, 0.3] }}
                  transition={{ duration: 1.8, repeat: Infinity }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1">
          {/* Microphone Button */}
          <motion.button
            onClick={toggleMute}
            disabled={status !== 'connected'}
            className={`w-9 h-9 flex justify-center items-center p-2 rounded-lg transition-all duration-200 ${status !== 'connected'
                ? isDark
                  ? 'bg-surface-dark-tertiary text-content-inverse-tertiary cursor-not-allowed'
                  : 'bg-surface-secondary text-content-tertiary cursor-not-allowed'
                : isMuted
                  ? isDark
                    ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50 border border-red-500/30'
                    : 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
                  : isDark
                    ? 'bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50 border border-emerald-500/30'
                    : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-200'
              }`}
            title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <motion.div
              animate={isRecording ? { scale: [1, 1.1, 1] } : { scale: 1 }}
              transition={{ duration: 1, repeat: isRecording ? Infinity : 0 }}
            >
              {isMuted ? (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28C16.28 17.23 19 14.41 19 11h-1.7z" />
                </svg>
              )}
            </motion.div>
          </motion.button>

          {/* Send Button */}
          <motion.button
            onClick={send}
            disabled={!text.trim() || status !== 'connected'}
            className={`h-9 px-4 py-2 rounded-lg text-ui transition-all duration-200 ${!text.trim() || status !== 'connected'
                ? isDark
                  ? 'bg-surface-dark-tertiary text-content-inverse-tertiary cursor-not-allowed'
                  : 'bg-surface-secondary text-content-tertiary cursor-not-allowed'
                : 'btn-primary'
              }`}
            whileHover={text.trim() && status === 'connected' ? { scale: 1.02 } : {}}
            whileTap={text.trim() && status === 'connected' ? { scale: 0.98 } : {}}
          >
            Send
          </motion.button>
        </div>
      </div>
    </motion.div>
  )
}
