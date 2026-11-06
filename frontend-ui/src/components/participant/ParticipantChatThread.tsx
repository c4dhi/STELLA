import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { motion } from 'framer-motion'
import { Send, User, Bot, Loader2, UserPlus, UserMinus } from 'lucide-react'
import { Room } from 'livekit-client'
import { DeliveryStatusIndicator } from '../messaging'
import type { ParticipantMessage } from './ParticipantSessionView'
import { generateUUID } from '../../lib/uuid'
import SpokenMessageText from '../face/SpokenMessageText'

/**
 * The participant's conversation: the messages and the box to type in.
 *
 * Shared by the chat drawer on the voice faces (`variant="panel"`) and the
 * Text face (`variant="page"`), so both show and send messages the same way.
 */
export interface ParticipantChatThreadProps {
  variant: 'panel' | 'page'
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
  /** Shown under the input. */
  hint?: string
}

export interface ParticipantChatThreadHandle {
  /** Jump to the newest message and put the cursor in the input. */
  focus: () => void
}

const formatTime = (date: Date) =>
  date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const ParticipantChatThread = forwardRef<ParticipantChatThreadHandle, ParticipantChatThreadProps>(
  function ParticipantChatThread(
    {
      variant,
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
      hint,
    },
    ref,
  ) {
    const isPage = variant === 'page'
    const [inputText, setInputText] = useState('')
    const [isSending, setIsSending] = useState(false)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

    useImperativeHandle(ref, () => ({
      focus: () => {
        // Wait a frame so the DOM is laid out before scrolling.
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
          inputRef.current?.focus()
        })
      },
    }))

    // Follow the conversation (streamed replies included).
    useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    // Send via the data channel, showing the message straight away.
    const sendMessage = useCallback(async () => {
      if (!inputText.trim() || !room || isSending) return

      const correlationId = generateUUID()
      const trimmedText = inputText.trim()

      if (onSendOptimisticMessage) {
        onSendOptimisticMessage({
          id: generateUUID(),
          role: 'user',
          text: trimmedText,
          timestamp: new Date(),
          deliveryStatus: 'sending',
          correlationId,
        })
      }

      try {
        setIsSending(true)
        const data = new TextEncoder().encode(
          JSON.stringify({
            type: 'user_text',
            data: { text: trimmedText, correlation_id: correlationId },
            participant_id: participantName, // attribution (matches PeerTransport)
          }),
        )
        await room.localParticipant.publishData(data, { reliable: true })
        setInputText('')
      } catch (error) {
        console.error('Error sending message:', error)
      } finally {
        setIsSending(false)
        if (isPage) inputRef.current?.focus()
      }
    }, [inputText, room, isSending, onSendOptimisticMessage, participantName, isPage])

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault()
      void sendMessage()
    }

    // Text face: Enter sends, Shift+Enter starts a new line.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        void sendMessage()
      }
    }

    const textSize = isPage ? 'text-[15px]' : 'text-sm'

    return (
      <>
        {/* Messages */}
        <div className={`flex-1 overflow-y-auto ${isPage ? 'px-4 sm:px-6 py-6' : 'p-4'}`}>
          <div className={`${isPage ? 'max-w-3xl mx-auto space-y-5' : 'space-y-4'}`}>
            {isLoadingHistory && (
              <div className="text-center py-4">
                <Loader2 className="w-5 h-5 animate-spin text-violet-400 mx-auto" />
                <p className="text-white/50 text-xs mt-2">Loading message history...</p>
              </div>
            )}
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
                <p className="text-white/50 text-sm">No messages yet. Type a message below.</p>
              </div>
            ) : (
              messages.map(message =>
                message.messageType === 'participant_event' ? (
                  // Join/leave: a centered pill
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex justify-center my-3"
                  >
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/60 text-xs">
                      {message.eventType === 'joined' ? (
                        <UserPlus className="w-3 h-3" />
                      ) : (
                        <UserMinus className="w-3 h-3" />
                      )}
                      <span>
                        <span className="text-white/80 font-medium">
                          {message.participantName || 'Someone'}
                        </span>{' '}
                        {message.eventType === 'joined' ? 'joined' : 'left'}
                      </span>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        message.role === 'user'
                          ? 'bg-violet-500/20 text-violet-400'
                          : message.role === 'other_user'
                          ? 'bg-cyan-500/20 text-cyan-400'
                          : 'bg-white/10 text-white/60'
                      }`}
                    >
                      {message.role === 'assistant' ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                    </div>

                    <div className={`flex-1 max-w-[80%] ${message.role === 'user' ? 'text-right' : ''}`}>
                      {message.role === 'other_user' && (
                        <p className="text-[10px] text-cyan-400/80 mb-1 px-1">
                          {message.speakerName || message.participantName || 'Organizer'}
                        </p>
                      )}
                      <div
                        className={`inline-block px-4 py-2.5 rounded-2xl text-left ${
                          message.role === 'user'
                            ? 'bg-violet-500/25 text-white rounded-br-sm'
                            : message.role === 'other_user'
                            ? 'bg-cyan-500/10 text-white/90 rounded-bl-sm border border-cyan-500/20'
                            : 'bg-white/[0.06] text-white/90 rounded-bl-sm'
                        }`}
                      >
                        <p className={`${textSize} leading-relaxed whitespace-pre-wrap`}>
                          {/* Teleprompter (#241): the live bubble lights up
                              word-by-word as it is spoken; shared with the
                              organizer chat via SpokenMessageText. */}
                          <SpokenMessageText
                            text={message.text}
                            messageId={message.id}
                            isAgent={message.role === 'assistant'}
                            spokenChar={spokenChar}
                            spokenTranscriptId={spokenTranscriptId}
                            frozenSpoken={frozenSpoken}
                          />
                          {message.isStreaming && (
                            <span
                              aria-hidden="true"
                              className="inline-block w-0.5 h-[1em] ml-0.5 align-[-2px] bg-violet-300 animate-pulse"
                            />
                          )}
                        </p>
                        {message.role === 'user' && message.deliveryStatus && (
                          <div className="flex justify-end mt-1">
                            <DeliveryStatusIndicator status={message.deliveryStatus} className="text-white/60" />
                          </div>
                        )}
                      </div>
                      <p className="text-[10px] text-white/50 mt-1 px-1">
                        {message.isStreaming
                          ? `${message.speakerName || 'The agent'} is writing…`
                          : formatTime(message.timestamp)}
                      </p>
                    </div>
                  </motion.div>
                ),
              )
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          className={`border-t border-white/10 ${isPage ? 'px-4 sm:px-6 pt-4 pb-5' : 'p-4'}`}
        >
          <div className={isPage ? 'max-w-3xl mx-auto' : ''}>
            <div
              className={
                isPage
                  ? 'flex items-end gap-2 p-2 rounded-2xl bg-white/5 border border-white/15 focus-within:border-violet-500/50'
                  : 'flex gap-2'
              }
            >
              {isPage ? (
                <textarea
                  ref={inputRef}
                  rows={2}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your answer…"
                  aria-label="Your answer"
                  disabled={!room}
                  className="flex-1 min-w-0 resize-none bg-transparent px-2 py-2 text-white text-[15px] leading-relaxed placeholder-white/40 focus:outline-none disabled:opacity-50"
                />
              ) : (
                <input
                  ref={inputRef}
                  type="text"
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  placeholder="Type a message..."
                  aria-label="Your message"
                  disabled={!room || isSending}
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/40 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.07] transition-colors disabled:opacity-50"
                />
              )}
              <button
                type="submit"
                aria-label="Send"
                disabled={!inputText.trim() || !room || isSending}
                className={`${
                  isPage ? 'h-11 px-4 flex items-center gap-2 text-sm font-medium' : 'p-3'
                } bg-violet-600 hover:bg-violet-500 disabled:bg-white/10 disabled:text-white/40 text-white rounded-xl transition-colors disabled:cursor-not-allowed`}
              >
                {isPage ? 'Send' : <Send className="w-5 h-5" />}
              </button>
            </div>
            {hint && <p className="text-[11px] text-white/50 mt-2 text-center">{hint}</p>}
          </div>
        </form>
      </>
    )
  },
)

export default ParticipantChatThread
