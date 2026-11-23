import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Mail, Users, AlertTriangle, Check, X, Trash2, FolderOpen } from 'lucide-react'
import { apiClient } from '../../services/ApiClient'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { useNotificationStore } from '../../store/notificationStore'
import type { UserMessage, UserMessageType } from '../../lib/api-types'

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1
    }
  }
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94] as const
    }
  }
}

export default function InboxSection() {
  const { resolvedTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const isDark = resolvedTheme === 'dark'

  // Use notification store for real-time updates
  const {
    messages,
    isLoading,
    fetchMessages,
    markAsRead,
    deleteMessage: deleteMessageFromStore,
    removeMessageFromState
  } = useNotificationStore()
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())

  // Fetch messages on mount
  useEffect(() => {
    fetchMessages(1, 50)
  }, [])

  const handleAcceptInvitation = async (message: UserMessage) => {
    if (!message.metadata?.invitationId) return

    setProcessingIds(prev => new Set(prev).add(message.id))
    try {
      await apiClient.acceptProjectInvitation(message.metadata.invitationId)
      // Remove message from local state (backend already deletes it)
      removeMessageFromState(message.id)
      addToast({
        message: `You're now a collaborator on "${message.metadata.projectName}"`,
        type: 'success'
      })
    } catch (err: any) {
      addToast({
        message: err.message || 'Failed to accept invitation',
        type: 'error'
      })
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev)
        next.delete(message.id)
        return next
      })
    }
  }

  const handleDeclineInvitation = async (message: UserMessage) => {
    if (!message.metadata?.invitationId) return

    setProcessingIds(prev => new Set(prev).add(message.id))
    try {
      await apiClient.declineProjectInvitation(message.metadata.invitationId)
      // Remove message from local state (backend already deletes it)
      removeMessageFromState(message.id)
      addToast({ message: 'Invitation declined', type: 'info' })
    } catch (err: any) {
      addToast({
        message: err.message || 'Failed to decline invitation',
        type: 'error'
      })
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev)
        next.delete(message.id)
        return next
      })
    }
  }

  const handleDeleteMessage = async (messageId: string) => {
    setProcessingIds(prev => new Set(prev).add(messageId))
    try {
      await deleteMessageFromStore(messageId)
    } catch (err: any) {
      addToast({
        message: err.message || 'Failed to delete message',
        type: 'error'
      })
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev)
        next.delete(messageId)
        return next
      })
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    } else if (diffDays === 1) {
      return 'Yesterday'
    } else if (diffDays < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'short' })
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
  }

  const getMessageIcon = (type: UserMessageType) => {
    switch (type) {
      case 'PROJECT_INVITATION':
        return <Users className="w-5 h-5" />
      case 'AGENT_BUILD_FAILED':
        return <AlertTriangle className="w-5 h-5" />
      default:
        return <Mail className="w-5 h-5" />
    }
  }

  return (
    <motion.div
      className="max-w-2xl"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.h2
        className={`text-heading-lg mb-6 ${isDark ? 'text-content-inverse' : 'text-content'}`}
        variants={itemVariants}
      >
        Inbox
      </motion.h2>

      {/* Loading State */}
      {isLoading && (
        <motion.div
          className={`p-6 rounded-2xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`}
          variants={itemVariants}
        >
          <div className="flex items-center justify-center py-8">
            <div className={`text-body ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
              Loading messages...
            </div>
          </div>
        </motion.div>
      )}

      {/* Empty State */}
      {!isLoading && messages.length === 0 && (
        <motion.div
          className={`p-6 rounded-2xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`}
          variants={itemVariants}
        >
          <div className="flex flex-col items-center justify-center py-12">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 border ${
              isDark ? 'bg-surface-dark-tertiary border-transparent' : 'bg-neutral-50 border-neutral-200/60'
            }`}>
              <FolderOpen className={`w-8 h-8 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`} />
            </div>
            <h3 className={`text-heading-sm font-medium mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              No messages
            </h3>
            <p className={`text-body-sm text-center ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
              You'll see project invitations and other notifications here.
            </p>
          </div>
        </motion.div>
      )}

      {/* Messages List */}
      {!isLoading && messages.length > 0 && (
        <motion.div
          className={`rounded-2xl overflow-hidden ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`}
          variants={itemVariants}
        >
          <AnimatePresence>
            {messages.map((message, index) => {
              const isProcessing = processingIds.has(message.id)
              const isProjectInvitation = message.type === 'PROJECT_INVITATION'
              const isBuildFailure = message.type === 'AGENT_BUILD_FAILED'

              return (
                <motion.div
                  key={message.id}
                  layout
                  initial={false}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20, height: 0 }}
                  transition={{ duration: 0.3 }}
                  className={`p-4 ${
                    index !== messages.length - 1
                      ? `border-b ${isDark ? 'border-border-dark/50' : 'border-border/50'}`
                      : ''
                  } ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                      isDark
                        ? 'bg-primary/20 text-primary'
                        : 'bg-primary/10 text-primary'
                    }`}>
                      {getMessageIcon(message.type as UserMessageType)}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h4 className={`text-body-sm font-medium truncate ${
                            isDark ? 'text-content-inverse' : 'text-content'
                          }`}>
                            {message.title}
                          </h4>
                          {message.body && (
                            <p className={`text-body-sm mt-0.5 ${
                              isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                            }`}>
                              {message.body}
                            </p>
                          )}
                          {isProjectInvitation && message.metadata?.inviterEmail && (
                            <p className={`text-caption mt-1 ${
                              isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                            }`}>
                              From: {message.metadata.inviterName || message.metadata.inviterEmail}
                            </p>
                          )}
                        </div>
                        <span className={`text-caption flex-shrink-0 ${
                          isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                        }`}>
                          {formatDate(message.createdAt)}
                        </span>
                      </div>

                      {/* Action Buttons for Project Invitations */}
                      {isProjectInvitation && (
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            onClick={() => handleAcceptInvitation(message)}
                            disabled={isProcessing}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                              isDark
                                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                : 'bg-green-50 text-green-700 hover:bg-green-100'
                            }`}
                          >
                            <Check className="w-3.5 h-3.5" />
                            Accept
                          </button>
                          <button
                            onClick={() => handleDeclineInvitation(message)}
                            disabled={isProcessing}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                              isDark
                                ? 'bg-surface-dark-tertiary text-content-inverse-secondary hover:bg-red-500/20 hover:text-red-400'
                                : 'bg-surface-tertiary text-content-secondary hover:bg-red-50 hover:text-red-600'
                            }`}
                          >
                            <X className="w-3.5 h-3.5" />
                            Decline
                          </button>
                        </div>
                      )}

                      {/* View build log + Delete for a build failure */}
                      {isBuildFailure && (
                        <div className="flex items-center gap-2 mt-3">
                          {message.relatedEntityId && (
                            <Link
                              to={`/settings/agent-library?agent=${message.relatedEntityId}`}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                                isDark
                                  ? 'bg-primary/20 text-primary hover:bg-primary/30'
                                  : 'bg-primary/10 text-primary hover:bg-primary/20'
                              }`}
                            >
                              View build log
                            </Link>
                          )}
                          <button
                            onClick={() => handleDeleteMessage(message.id)}
                            disabled={isProcessing}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                              isDark
                                ? 'bg-surface-dark-tertiary text-content-inverse-secondary hover:bg-red-500/20 hover:text-red-400'
                                : 'bg-surface-tertiary text-content-secondary hover:bg-red-50 hover:text-red-600'
                            }`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                          </button>
                        </div>
                      )}

                      {/* Delete button for other non-actionable messages */}
                      {!isProjectInvitation && !isBuildFailure && (
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            onClick={() => handleDeleteMessage(message.id)}
                            disabled={isProcessing}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-medium transition-colors ${
                              isDark
                                ? 'bg-surface-dark-tertiary text-content-inverse-secondary hover:bg-red-500/20 hover:text-red-400'
                                : 'bg-surface-tertiary text-content-secondary hover:bg-red-50 hover:text-red-600'
                            }`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Unread indicator */}
                    {!message.read && (
                      <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0 mt-2" />
                    )}
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </motion.div>
  )
}
