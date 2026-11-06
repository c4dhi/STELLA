import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Send, User, Bot, Loader2, UserPlus, UserMinus } from 'lucide-react'
import { Room } from 'livekit-client'
import { DeliveryStatusIndicator } from '../messaging'
import type { ParticipantMessage } from './ParticipantSessionView'
import { generateUUID } from '../../lib/uuid'
import SpokenMessageText from '../face/SpokenMessageText'

interface ParticipantChatPanelProps {
  isOpen: boolean
  onClose: () => void
  messages: ParticipantMessage[]
  room: Room | null
  participantName: string
  onSendOptimisticMessage?: (message: ParticipantMessage) => void
  isLoadingHistory?: boolean
  hasMoreMessages?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
  // Teleprompter (#241): the agent message currently being spoken and how far
  // the word cursor has advanced. That bubble lights up word-by-word; the rest
  // render normally.
  spokenTranscriptId?: string
  spokenChar?: number
  // Transcripts frozen by a committed barge-in → keep a partial highlight.
  frozenSpoken?: Record<string, number>
}

export default function ParticipantChatPanel({
  isOpen,
  onClose,
  messages,
  room,
  participantName,
  onSendOptimisticMessage,
  isLoadingHistory = false,
  hasMoreMessages = false,
  isLoadingMore = false,
  onLoadMore,
  spokenTranscriptId,
  spokenChar = 0,
  frozenSpoken,
}: ParticipantChatPanelProps) {
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Scroll to bottom and focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      // Instantly scroll to bottom so chat appears at the bottom immediately
      // Use requestAnimationFrame to ensure DOM is rendered before scrolling
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
        inputRef.current?.focus()
      })
    }
  }, [isOpen])

  // Handle ESC key to close
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onClose])

  // Send message via data channel with optimistic update
  const sendMessage = useCallback(async () => {
    if (!inputText.trim() || !room || isSending) return

    const correlationId = generateUUID()
    const trimmedText = inputText.trim()

    // Create and add optimistic message immediately
    if (onSendOptimisticMessage) {
      const optimisticMessage: ParticipantMessage = {
        id: generateUUID(),
        role: 'user',
        text: trimmedText,
        timestamp: new Date(),
        deliveryStatus: 'sending',
        correlationId,
      }
      onSendOptimisticMessage(optimisticMessage)
    }

    try {
      setIsSending(true)

      const encoder = new TextEncoder()
      const data = encoder.encode(
        JSON.stringify({
          type: 'user_text',
          data: {
            text: trimmedText,
            correlation_id: correlationId,
          },
          participant_id: participantName,  // Include for proper attribution (matches PeerTransport format)
        })
      )

      await room.localParticipant.publishData(data, {
        reliable: true,
      })

      setInputText('')
    } catch (error) {
      console.error('Error sending message:', error)
    } finally {
      setIsSending(false)
    }
  }, [inputText, room, isSending, onSendOptimisticMessage])

  // Handle form submit
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage()
  }

  // Format timestamp
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#0a0a12]/95 backdrop-blur-xl border-l border-white/10 z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <h2 className="text-white font-light text-lg">Chat</h2>
              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Loading indicator for message history */}
              {isLoadingHistory && (
                <div className="text-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-violet-400 mx-auto" />
                  <p className="text-white/30 text-xs mt-2">Loading message history...</p>
                </div>
              )}
              {/* Load More button at top */}
              {hasMoreMessages && !isLoadingHistory && (
                <div className="text-center py-2">
                  <button
                    onClick={onLoadMore}
                    disabled={isLoadingMore}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs text-white/60 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      'Load older messages'
                    )}
                  </button>
                </div>
              )}
              {messages.length === 0 && !isLoadingHistory ? (
                <div className="text-center py-12">
                  <p className="text-white/30 text-sm">
                    No messages yet. Type a message below.
                  </p>
                </div>
              ) : (
                messages.map(message => (
                  message.messageType === 'participant_event' ? (
                    // Participant join/leave notification - centered pill style
                    <motion.div
                      key={message.id}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex justify-center my-3"
                    >
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/50 text-xs">
                        {message.eventType === 'joined' ? (
                          <UserPlus className="w-3 h-3" />
                        ) : (
                          <UserMinus className="w-3 h-3" />
                        )}
                        <span>
                          <span className="text-white/70 font-medium">
                            {message.participantName || 'Someone'}
                          </span>
                          {' '}
                          {message.eventType === 'joined' ? 'joined' : 'left'}
                        </span>
                      </div>
                    </motion.div>
                  ) : (
                    // Regular message bubble
                    <motion.div
                      key={message.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex gap-3 ${
                        message.role === 'user' ? 'flex-row-reverse' : ''
                      }`}
                    >
                      {/* Avatar */}
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                          message.role === 'user'
                            ? 'bg-violet-500/20 text-violet-400'
                            : message.role === 'other_user'
                            ? 'bg-cyan-500/20 text-cyan-400'
                            : 'bg-white/10 text-white/50'
                        }`}
                      >
                        {message.role === 'user' ? (
                          <User className="w-4 h-4" />
                        ) : message.role === 'other_user' ? (
                          <User className="w-4 h-4" />
                        ) : (
                          <Bot className="w-4 h-4" />
                        )}
                      </div>

                      {/* Message bubble */}
                      <div
                        className={`flex-1 max-w-[80%] ${
                          message.role === 'user' ? 'text-right' : ''
                        }`}
                      >
                        {/* Speaker name for other_user messages */}
                        {message.role === 'other_user' && (
                          <p className="text-[10px] text-cyan-400/70 mb-1 px-1">
                            {message.speakerName || message.participantName || 'Organizer'}
                          </p>
                        )}
                        <div
                          className={`inline-block px-4 py-2.5 rounded-2xl ${
                            message.role === 'user'
                              ? 'bg-violet-500/20 text-white rounded-br-sm'
                              : message.role === 'other_user'
                              ? 'bg-cyan-500/10 text-white/90 rounded-bl-sm border border-cyan-500/20'
                              : 'bg-white/5 text-white/90 rounded-bl-sm'
                          }`}
                        >
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">
                            {/* Teleprompter (#241): the live bubble lights up
                                word-by-word as it is spoken; a barge-in-frozen
                                bubble keeps its partial highlight; everything
                                else renders normally. Shared with the organizer
                                chat via SpokenMessageText. */}
                            <SpokenMessageText
                              text={message.text}
                              messageId={message.id}
                              isAgent={message.role === 'assistant'}
                              spokenChar={spokenChar}
                              spokenTranscriptId={spokenTranscriptId}
                              frozenSpoken={frozenSpoken}
                            />
                          </p>
                          {/* Delivery status indicator for user messages */}
                          {message.role === 'user' && message.deliveryStatus && (
                            <div className="flex justify-end mt-1">
                              <DeliveryStatusIndicator
                                status={message.deliveryStatus}
                                className="text-white/60"
                              />
                            </div>
                          )}
                        </div>
                        <p className="text-[10px] text-white/30 mt-1 px-1">
                          {formatTime(message.timestamp)}
                        </p>
                      </div>
                    </motion.div>
                  )
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="p-4 border-t border-white/10">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  placeholder="Type a message..."
                  disabled={!room || isSending}
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.07] transition-colors disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!inputText.trim() || !room || isSending}
                  className="p-3 bg-violet-500 hover:bg-violet-400 disabled:bg-white/10 disabled:text-white/30 text-white rounded-xl transition-colors disabled:cursor-not-allowed"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
              <p className="text-[10px] text-white/30 mt-2 text-center">
                Press Enter to send • ESC to close
              </p>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
