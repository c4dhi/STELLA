import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { startMicWithVu } from '../services/audio/capture'

export default function PushToTalkButton() {
  const status = useStore(s => s.status)
  const transport = useStore(s => s.transport)
  const isPushToTalkActive = useStore(s => s.isPushToTalkActive)
  const isRecording = useStore(s => s.isRecording)
  const setPushToTalkActive = useStore(s => s.setPushToTalkActive)
  const setIsRecording = useStore(s => s.setIsRecording)
  const vu = useStore(s => s.vu)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const startRecording = useCallback(async () => {
    if (!transport || status !== 'connected') {
      console.warn('Cannot start recording: not connected or transport unavailable')
      return
    }

    try {
      // The mic is already published (muted after an earlier press): just unmute
      if (transport.hasPublishedAudio()) {
        await transport.unmuteAudio()
        setIsRecording(true)
        return
      }

      // Create new AudioContext for push-to-talk
      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      // Get microphone stream with VU meter
      const stream = await startMicWithVu(audioContext, transport as any)
      streamRef.current = stream

      // Publish audio track to LiveKit
      await transport.publishAudioTrack(stream)

      setIsRecording(true)

    } catch (error) {
      console.error('Error starting push-to-talk recording:', error)
      setIsRecording(false)
      setPushToTalkActive(false)
    }
  }, [transport, status, setIsRecording, setPushToTalkActive])

  const stopRecording = useCallback(async () => {
    if (isRecording) {
      // Soft mute: keep the connection and the track, send silence (#362)
      await transport?.muteAudio()

      // Update state
      setIsRecording(false)
      setPushToTalkActive(false)
      useStore.getState().setVu(0) // Reset VU meter
    }
  }, [isRecording, transport, setIsRecording, setPushToTalkActive])

  const handleMouseDown = useCallback(() => {
    if (!isPushToTalkActive) {
      setPushToTalkActive(true)
      startRecording()
    }
  }, [isPushToTalkActive, setPushToTalkActive, startRecording])

  const handleMouseUp = useCallback(() => {
    if (isPushToTalkActive) {
      stopRecording()
    }
  }, [isPushToTalkActive, stopRecording])

  // Keyboard event listeners removed - no more spacebar push-to-talk

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      useStore.getState().setVu(0)
    }
  }, [])


  const buttonClasses = `
    px-6 py-4 rounded-full font-semibold text-white transition-all duration-150 min-w-32
    ${isPushToTalkActive
      ? 'bg-red-500 shadow-lg transform scale-105 animate-pulse'
      : 'bg-blue-500 hover:bg-blue-600'
    }
    ${status !== 'connected' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
  `.trim()

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        className={buttonClasses}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp} // Handle mouse leave to stop recording
        disabled={status !== 'connected'}
      >
        {isRecording ? '🎤 Recording...' : '🎤 Hold to Talk'}
      </button>

      {/* Visual feedback */}
      <div className="text-sm text-gray-400 text-center">
        <div>Hold the button to record</div>
        {isRecording && (
          <div className="flex items-center gap-2 mt-2">
            <div className="w-20 h-2 bg-gray-600 rounded overflow-hidden">
              <div
                className="h-2 bg-green-400 rounded transition-all duration-100"
                style={{ width: `${Math.round(vu * 100)}%` }}
              />
            </div>
            <span className="text-xs text-green-400">Recording</span>
          </div>
        )}
      </div>
    </div>
  )
}

