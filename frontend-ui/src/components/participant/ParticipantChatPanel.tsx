import { useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import ParticipantChatThread, {
  type ParticipantChatThreadHandle,
  type ParticipantChatThreadProps,
} from './ParticipantChatThread'

/**
 * The chat drawer on the voice faces: a fallback for typing next to speech.
 * The voice carries on while it is open; the Text face is the text interface.
 */
interface ParticipantChatPanelProps extends Omit<ParticipantChatThreadProps, 'variant' | 'hint'> {
  isOpen: boolean
  onClose: () => void
}

export default function ParticipantChatPanel({ isOpen, onClose, ...thread }: ParticipantChatPanelProps) {
  const threadRef = useRef<ParticipantChatThreadHandle>(null)

  // Open at the newest message, cursor in the input.
  useEffect(() => {
    if (isOpen) threadRef.current?.focus()
  }, [isOpen])

  // ESC closes.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={onClose}
          />

          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#0a0a12]/95 backdrop-blur-xl border-l border-white/10 z-50 flex flex-col"
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <h2 className="text-white font-light text-lg">Chat</h2>
              <button
                onClick={onClose}
                aria-label="Close chat"
                className="p-2 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <ParticipantChatThread
              ref={threadRef}
              variant="panel"
              hint="Press Enter to send • ESC to close"
              {...thread}
            />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
