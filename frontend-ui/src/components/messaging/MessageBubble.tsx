import { motion } from 'framer-motion'
import DeliveryStatusIndicator from './DeliveryStatusIndicator'
import SpokenMessageText from '../face/SpokenMessageText'
import type { TranscriptChunk, DeliveryStatus } from '../../lib/types'

interface MessageBubbleProps {
  message: TranscriptChunk
  /** Override delivery status (useful when computed externally) */
  deliveryStatus?: DeliveryStatus
  isDark?: boolean
  showHeader?: boolean
  // Teleprompter (#241): word-by-word highlight cursor from useTeleprompter.
  // When this bubble is the transcript being spoken, its text lights up in sync
  // with the audio; all other bubbles render as plain text.
  spokenChar?: number
  spokenTranscriptId?: string
  frozenSpoken?: Record<string, number>
}

/**
 * Shared message bubble component for both session and participant screens.
 * Renders user and assistant messages with consistent styling.
 *
 * For user messages that are final, displays delivery status checkmarks.
 * For partial messages, displays a blinking cursor.
 */
export default function MessageBubble({
  message,
  deliveryStatus,
  isDark = false,
  showHeader = true,
  spokenChar,
  spokenTranscriptId,
  frozenSpoken,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isOtherUser = message.role === 'other_user'
  const isPartial = message.status === 'partial'
  const isFinal = message.status === 'final'
  const isAgent = message.role === 'assistant'

  // Teleprompter highlight for the agent reply being spoken; plain text otherwise.
  const content = (
    <SpokenMessageText
      text={message.text}
      messageId={message.id}
      isAgent={isAgent}
      spokenChar={spokenChar}
      spokenTranscriptId={spokenTranscriptId}
      frozenSpoken={frozenSpoken}
    />
  )

  // Determine the display name for the header
  const displayName = message.source === 'agent_response'
    ? (message.agent_name || 'Agent')
    : isOtherUser
      ? (message.speaker_name || message.participant_id || 'Participant')
      : (message.speaker_name || message.participant_id || message.role)

  // Determine delivery status to show
  // - For final user messages: use provided status or message's deliveryStatus
  // - For partial messages: no status shown
  // - For final speech transcripts: always confirmed (agent received the audio)
  const effectiveDeliveryStatus = (() => {
    if (!isUser || isPartial) return undefined
    if (deliveryStatus) return deliveryStatus
    if (message.deliveryStatus) return message.deliveryStatus
    // Final speech transcripts are inherently confirmed
    if (message.source === 'user_speech' && isFinal) return 'confirmed' as const
    return undefined
  })()

  const shouldShowDeliveryStatus = isUser && isFinal && effectiveDeliveryStatus

  return (
    // `w-fit` is load-bearing: without it this block-level wrapper resolves to
    // `width: auto`, so every bubble renders at exactly max-w and a one-word
    // reply is as wide as a paragraph. Sizing to content is also what makes the
    // auto margin able to push user bubbles to the right.
    <motion.div
      className={`w-fit max-w-[75%] relative group ${isUser ? 'ml-auto' : 'mr-auto'}`}
    >
      {/* Message Bubble */}
      <div
        className={`
          px-4 py-3 rounded-xl border overflow-hidden
          ${isUser
            ? isPartial
              ? isDark
                ? 'bg-violet-600/90 text-white border-violet-500/40 opacity-85'
                : 'bg-content/90 text-white border-content/70 opacity-85'
              : isDark
                ? 'bg-violet-600 text-white border-violet-500/60 shadow-md'
                : 'bg-content text-white border-content shadow-sm'
            : isOtherUser
              ? isDark
                ? 'bg-cyan-900/60 text-cyan-50 border-cyan-700/50'
                : 'bg-cyan-50 text-cyan-900 border-cyan-200 shadow-sm'
              : message.role === 'assistant'
                ? isDark
                  ? 'bg-zinc-800 text-zinc-100 border-zinc-700'
                  : 'bg-white text-content border-border shadow-sm'
                : isDark
                  ? 'bg-zinc-800/80 text-zinc-200 border-zinc-700'
                  : 'bg-white text-content-secondary border-border shadow-sm'
          }
        `}
      >
        {/* Message Header */}
        {showHeader && (
          <motion.div
            className={`text-label mb-2 flex items-center gap-2 uppercase ${
              isUser
                ? 'text-white/70'
                : isOtherUser
                  ? isDark ? 'text-cyan-400' : 'text-cyan-700'
                  : isDark ? 'text-zinc-400' : 'text-content-tertiary'
            }`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.3 }}
          >
            <span>{displayName}</span>
            <span className="opacity-50">•</span>
            <span>
              {new Date(message.startedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </motion.div>
        )}

        {/* Message Content */}
        {isPartial ? (
          // Partial messages - show blinking cursor
          <div className="text-body leading-relaxed opacity-85 break-words overflow-wrap-anywhere">
            {content}
            <motion.span
              className={`ml-1 ${
                isUser
                  ? 'text-white/50'
                  : isDark ? 'text-zinc-500' : 'text-content-tertiary'
              }`}
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 1.2, repeat: Infinity }}
            >
              |
            </motion.span>
          </div>
        ) : (
          // Final messages
          <div
            className={`text-body leading-relaxed break-words overflow-wrap-anywhere ${
              message.role !== 'user' && isDark ? 'text-zinc-100' : ''
            }`}
          >
            {content}
          </div>
        )}

        {/* Delivery Status Indicator - only for final user messages */}
        {shouldShowDeliveryStatus && (
          <div className="flex justify-end mt-1.5 -mb-1">
            <DeliveryStatusIndicator
              status={effectiveDeliveryStatus}
              className={isUser ? 'text-white/70' : isDark ? 'text-zinc-400' : 'text-content-tertiary'}
            />
          </div>
        )}
      </div>
    </motion.div>
  )
}
