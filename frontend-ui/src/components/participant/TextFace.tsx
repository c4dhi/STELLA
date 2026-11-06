import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Bot, HelpCircle, LayoutGrid, Maximize2, Minimize2 } from 'lucide-react'
import ParticipantChatThread, {
  type ParticipantChatThreadHandle,
  type ParticipantChatThreadProps,
} from './ParticipantChatThread'

/**
 * The Text face (#92): the whole conversation in writing. One of the faces in
 * the gallery; while it shows, the agent is in text mode (nothing spoken, the
 * microphone off) and its replies stream in.
 */
interface TextFaceProps extends Omit<ParticipantChatThreadProps, 'variant' | 'hint' | 'spokenTranscriptId' | 'spokenChar' | 'frozenSpoken'> {
  /** Open the face gallery; absent when the face is locked for this session. */
  onOpenGallery?: () => void
  onOpenSupport: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
}

const iconButton =
  'w-11 h-11 rounded-full flex items-center justify-center bg-white/[0.06] border border-white/15 text-white transition-colors hover:bg-white/15'

export default function TextFace({
  onOpenGallery,
  onOpenSupport,
  isFullscreen,
  onToggleFullscreen,
  ...thread
}: TextFaceProps) {
  const threadRef = useRef<ParticipantChatThreadHandle>(null)

  useEffect(() => {
    threadRef.current?.focus()
  }, [])

  // The agent's name from its latest message; its status while a reply streams.
  const lastAgent = [...thread.messages].reverse().find(m => m.role === 'assistant')
  const agentName = lastAgent?.speakerName || 'Assistant'
  const isWriting = thread.messages.some(m => m.role === 'assistant' && m.isStreaming)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 z-20 flex flex-col bg-[#0a0a12] text-white"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-white/10">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white/70 flex-shrink-0">
            <Bot className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-medium truncate">{agentName}</p>
            <p className="text-xs text-white/60" aria-live="polite">
              {isWriting ? 'Writing…' : 'Text · nothing is read aloud'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onOpenGallery && (
            <button
              type="button"
              onClick={onOpenGallery}
              className="h-11 px-4 rounded-full flex items-center gap-2 bg-white/[0.06] border border-white/15 text-sm transition-colors hover:bg-white/15"
            >
              <LayoutGrid className="w-[18px] h-[18px]" aria-hidden="true" />
              Faces
            </button>
          )}
          <button type="button" onClick={onOpenSupport} aria-label="Help and support" className={iconButton}>
            <HelpCircle className="w-[18px] h-[18px]" />
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className={iconButton}
          >
            {isFullscreen ? <Minimize2 className="w-[18px] h-[18px]" /> : <Maximize2 className="w-[18px] h-[18px]" />}
          </button>
        </div>
      </header>

      <ParticipantChatThread
        ref={threadRef}
        variant="page"
        hint="Enter sends · Shift + Enter starts a new line"
        {...thread}
      />
    </motion.div>
  )
}
