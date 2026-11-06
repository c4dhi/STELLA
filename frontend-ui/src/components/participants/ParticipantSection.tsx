import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Globe, Ban, Check } from 'lucide-react'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import type { Participant, Invitation, InvitationStatus } from '../../lib/api-types'
import PresenceIndicator from './PresenceIndicator'
import InviteParticipantModal from '../modals/InviteParticipantModal'

// Details to pass to the connection modal
export interface ParticipantModalData {
  participantId: string
  invitationId: string
  invitationToken?: string | null
  details: {
    createdAt: string
    acceptedAt?: string | null
    joinedAt?: string | null
    lastSeenAt?: string | null
    status: InvitationStatus
  }
}

interface ParticipantSectionProps {
  sessionId: string
  participants: Participant[]
  onShowConnectionInfo: (data: ParticipantModalData) => void
  onRemoveParticipant: (participantId: string, participantName: string) => void
  onRefresh?: () => void
  refreshTrigger?: number  // Increment to force refresh of invitations
  lastPresenceEvent?: { type: string; identity: string } | null  // Forwarded from parent SSE
}

// Track online status by identity
interface PresenceState {
  [identity: string]: boolean
}

export default function ParticipantSection({
  sessionId,
  participants,
  onShowConnectionInfo,
  onRemoveParticipant,
  onRefresh,
  refreshTrigger,
  lastPresenceEvent,
}: ParticipantSectionProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Local state
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [isLoadingInvitations, setIsLoadingInvitations] = useState(false)
  const [presenceState, setPresenceState] = useState<PresenceState>({})
  const [revokeConfirm, setRevokeConfirm] = useState<{ isOpen: boolean; invitationId: string; participantName: string }>({
    isOpen: false,
    invitationId: '',
    participantName: '',
  })
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(null)

  // Check if we already have an active invitation (PENDING or ACCEPTED) - only one at a time
  const hasActiveInvitation = invitations.some(inv => inv.status === 'PENDING' || inv.status === 'ACCEPTED')

  // Fetch invitations
  const fetchInvitations = useCallback(async () => {
    try {
      setIsLoadingInvitations(true)
      const data = await apiClient.listInvitations(sessionId)
      setInvitations(data)

      // Initialize presence state from invitations with participants
      const newPresence: PresenceState = {}
      data.forEach(inv => {
        if (inv.participant) {
          // If lastSeenAt is recent (within 30 seconds) and leftAt is null, consider online
          const isOnline = !inv.participant.leftAt && inv.participant.lastSeenAt
            ? Date.now() - new Date(inv.participant.lastSeenAt).getTime() < 30000
            : !inv.participant.leftAt
          newPresence[inv.participant.identity] = isOnline
        }
      })
      setPresenceState(prev => ({ ...prev, ...newPresence }))
    } catch (err) {
      console.error('Failed to fetch invitations:', err)
    } finally {
      setIsLoadingInvitations(false)
    }
  }, [sessionId])

  // Load invitations on mount (deferred to avoid competing with critical page-load requests)
  useEffect(() => {
    const timer = setTimeout(fetchInvitations, 500)
    return () => clearTimeout(timer)
  }, [fetchInvitations])

  // Refresh invitations when refreshTrigger changes (e.g., after revoke from modal)
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      fetchInvitations()
    }
  }, [refreshTrigger, fetchInvitations])

  // React to presence events forwarded from SessionView's SSE connection
  useEffect(() => {
    if (!lastPresenceEvent) return
    const { type, identity } = lastPresenceEvent
    if (type === 'participant.joined') {
      setPresenceState(prev => ({
        ...prev,
        [identity]: true,
      }))
      // Refresh invitations to get updated participant data
      fetchInvitations()
    } else if (type === 'participant.left') {
      setPresenceState(prev => ({
        ...prev,
        [identity]: false,
      }))
    }
  }, [lastPresenceEvent, fetchInvitations])

  // Poll for presence updates (checks lastSeenAt staleness)
  useEffect(() => {
    const POLL_INTERVAL = 20000 // 20 seconds

    const intervalId = setInterval(() => {
      fetchInvitations()
    }, POLL_INTERVAL)

    return () => {
      clearInterval(intervalId)
    }
  }, [fetchInvitations])

  // Handle invitation created
  const handleInvitationCreated = () => {
    fetchInvitations()
    onRefresh?.()
  }

  // Show revoke confirmation modal
  const showRevokeConfirmation = (invitationId: string, participantName: string) => {
    setRevokeConfirm({ isOpen: true, invitationId, participantName })
  }

  // Handle confirmed revoke invitation
  const handleConfirmRevoke = async () => {
    if (!revokeConfirm.invitationId) return
    try {
      await apiClient.revokeInvitation(revokeConfirm.invitationId)
      fetchInvitations()
    } catch (err) {
      console.error('Failed to revoke invitation:', err)
    } finally {
      setRevokeConfirm({ isOpen: false, invitationId: '', participantName: '' })
    }
  }

  // Cancel revoke
  const handleCancelRevoke = () => {
    setRevokeConfirm({ isOpen: false, invitationId: '', participantName: '' })
  }

  // Handle delete invitation
  const handleDeleteInvitation = async (invitationId: string) => {
    try {
      await apiClient.deleteInvitation(invitationId)
      fetchInvitations()
    } catch (err) {
      console.error('Failed to delete invitation:', err)
    }
  }

  // Get presence status for a participant
  const isParticipantOnline = (identity: string): boolean => {
    return presenceState[identity] ?? false
  }

  // Format expiration time
  const formatExpiration = (expiresAt: string | null | undefined): string => {
    if (!expiresAt) return 'Never expires'
    const date = new Date(expiresAt)
    const now = new Date()
    const diff = date.getTime() - now.getTime()

    if (diff < 0) return 'Expired'
    if (diff < 3600000) return `${Math.ceil(diff / 60000)}m left`
    if (diff < 86400000) return `${Math.ceil(diff / 3600000)}h left`
    return `${Math.ceil(diff / 86400000)}d left`
  }

  // Get status badge color
  const getStatusColor = (status: InvitationStatus): string => {
    switch (status) {
      case 'PENDING':
        return isDark ? 'bg-yellow-500/20 text-yellow-300' : 'bg-yellow-50 text-yellow-600'
      case 'ACCEPTED':
        return isDark ? 'bg-green-500/20 text-green-300' : 'bg-green-50 text-green-600'
      case 'EXPIRED':
        return isDark ? 'bg-zinc-500/20 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
      case 'REVOKED':
        return isDark ? 'bg-red-500/20 text-red-300' : 'bg-red-50 text-red-600'
      default:
        return isDark ? 'bg-zinc-500/20 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
    }
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="w-64 xl:w-80 flex flex-col"
      >
        {/* Participants Panel */}
        <div
          className={`
            backdrop-blur-xl rounded-[16px] flex flex-col overflow-hidden
            ${isDark
              ? 'bg-white/5 border border-white/10'
              : 'bg-white border border-border shadow-sm'
            }
          `}
        >
          {/* Header */}
          <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-border'}`}>
            <h2 className={`text-lg font-thin tracking-wider mb-1 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              Participants
            </h2>
            <p className={`text-[10px] font-light tracking-wider uppercase ${isDark ? 'text-content-inverse-secondary' : 'text-content-tertiary'}`}>
              {participants.filter(p => !p.leftAt).length} active
              {invitations.filter(i => i.status === 'PENDING').length > 0 && (
                <span className="ml-2">
                  · {invitations.filter(i => i.status === 'PENDING').length} pending
                </span>
              )}
            </p>
          </div>

          {/* Invite Button */}
          <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-border'}`}>
            <button
              onClick={() => setIsInviteModalOpen(true)}
              disabled={hasActiveInvitation}
              className={`
                w-full py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                transition-all duration-200 flex items-center justify-center gap-2
                disabled:opacity-50 disabled:cursor-not-allowed
                ${isDark
                  ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                  : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm'
                }
              `}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Invite Participant
            </button>
            {hasActiveInvitation && (
              <p className={`text-[10px] mt-2 text-center ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                Active invitation exists - revoke it first
              </p>
            )}
          </div>

          {/* Invitations & Participants List */}
          <div className="p-4 space-y-3 max-h-80 overflow-y-auto">
            {isLoadingInvitations && invitations.length === 0 ? (
              <div className={`text-center py-8 text-sm font-light ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                Loading...
              </div>
            ) : invitations.length === 0 ? (
              <div className={`text-center py-8 text-sm font-light ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                No invitations yet
              </div>
            ) : (
              <AnimatePresence>
                {invitations.map(invitation => (
                  <motion.div
                    key={invitation.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className={`
                      p-4 rounded-xl transition-all duration-200
                      ${isDark
                        ? 'bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20'
                        : 'bg-surface-secondary border border-border hover:bg-surface-tertiary hover:border-border-secondary'
                      }
                    `}
                  >
                    {/* Name & Presence */}
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {invitation.participant && (
                          <PresenceIndicator
                            isOnline={isParticipantOnline(invitation.participant.identity)}
                            size="sm"
                          />
                        )}
                        <span className={`text-sm font-light ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                          {invitation.participantName}
                        </span>
                        {/* Web participant indicator */}
                        <span
                          className={`
                            inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-light uppercase tracking-wider
                            ${isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-600'}
                          `}
                          title="Web participant"
                        >
                          <Globe className="w-2.5 h-2.5" />
                          Web
                        </span>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${getStatusColor(invitation.status as InvitationStatus)}`}>
                        {invitation.status}
                      </span>
                    </div>

                    {/* Info */}
                    <div className={`text-[10px] font-light tracking-wider uppercase mb-3 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                      {invitation.status === 'ACCEPTED' && invitation.participant ? (
                        <>
                          Joined {new Date(invitation.participant.joinedAt).toLocaleTimeString()}
                        </>
                      ) : invitation.status === 'PENDING' ? (
                        <>
                          Created {new Date(invitation.createdAt).toLocaleTimeString()}
                          <span className="ml-2">· {formatExpiration(invitation.expiresAt)}</span>
                        </>
                      ) : (
                        <>
                          {invitation.status === 'REVOKED' ? 'Revoked' : 'Expired'}
                        </>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                      {invitation.status === 'ACCEPTED' && invitation.participant && (
                        <>
                          <button
                            onClick={() => onShowConnectionInfo({
                              participantId: invitation.participant!.id,
                              invitationId: invitation.id,
                              invitationToken: invitation.token,
                              details: {
                                createdAt: invitation.createdAt,
                                acceptedAt: invitation.acceptedAt,
                                joinedAt: invitation.participant?.joinedAt,
                                lastSeenAt: invitation.participant?.lastSeenAt,
                                status: invitation.status as InvitationStatus,
                              },
                            })}
                            className={`
                              flex-1 py-1.5 px-2 rounded-lg text-xs font-light
                              transition-all duration-200 flex items-center justify-center gap-1
                              ${isDark
                                ? 'bg-white/10 border border-white/10 text-content-inverse-secondary hover:text-content-inverse hover:border-white/20'
                                : 'bg-white border border-border text-content-secondary hover:text-content hover:border-border-secondary'
                              }
                            `}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 16v-4M12 8h.01" />
                            </svg>
                            Info
                          </button>
                          <button
                            onClick={() => showRevokeConfirmation(invitation.id, invitation.participantName || 'Participant')}
                            className={`
                              py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                              ${isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-500 hover:bg-red-50'}
                            `}
                            title="Revoke access"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}

                      {invitation.status === 'PENDING' && (
                        <>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(`${window.location.origin}/join/${invitation.token}`)
                              setCopiedInvitationId(invitation.id)
                              setTimeout(() => setCopiedInvitationId(null), 2000)
                            }}
                            className={`
                              flex-1 py-1.5 px-2 rounded-lg text-xs font-light
                              transition-all duration-200 flex items-center justify-center gap-1
                              ${copiedInvitationId === invitation.id
                                ? 'bg-green-500 border border-green-500 text-white'
                                : isDark
                                  ? 'bg-white/10 border border-white/10 text-content-inverse-secondary hover:text-content-inverse hover:border-white/20'
                                  : 'bg-white border border-border text-content-secondary hover:text-content hover:border-border-secondary'
                              }
                            `}
                          >
                            {copiedInvitationId === invitation.id ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                Copied!
                              </>
                            ) : (
                              <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                  <rect x="9" y="9" width="13" height="13" rx="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                                Copy Link
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => showRevokeConfirmation(invitation.id, invitation.participantName || 'Participant')}
                            className={`
                              py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                              ${isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-500 hover:bg-red-50'}
                            `}
                            title="Revoke invitation"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}

                      {invitation.status === 'REVOKED' && invitation.participant && (
                        <>
                          <button
                            onClick={() => onShowConnectionInfo({
                              participantId: invitation.participant!.id,
                              invitationId: invitation.id,
                              invitationToken: invitation.token,
                              details: {
                                createdAt: invitation.createdAt,
                                acceptedAt: invitation.acceptedAt,
                                joinedAt: invitation.participant?.joinedAt,
                                lastSeenAt: invitation.participant?.lastSeenAt,
                                status: invitation.status as InvitationStatus,
                              },
                            })}
                            className={`
                              flex-1 py-1.5 px-2 rounded-lg text-xs font-light
                              transition-all duration-200 flex items-center justify-center gap-1
                              ${isDark
                                ? 'bg-white/10 border border-white/10 text-content-inverse-secondary hover:text-content-inverse hover:border-white/20'
                                : 'bg-white border border-border text-content-secondary hover:text-content hover:border-border-secondary'
                              }
                            `}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 16v-4M12 8h.01" />
                            </svg>
                            Info
                          </button>
                          <button
                            onClick={() => handleDeleteInvitation(invitation.id)}
                            className={`
                              py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                              ${isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-500 hover:bg-red-50'}
                            `}
                            title="Delete invitation"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        </>
                      )}

                      {(invitation.status === 'EXPIRED' || (invitation.status === 'REVOKED' && !invitation.participant)) && (
                        <button
                          onClick={() => handleDeleteInvitation(invitation.id)}
                          className={`
                            flex-1 py-1.5 px-2 rounded-lg text-xs font-light
                            transition-all duration-200 flex items-center justify-center gap-1
                            ${isDark
                              ? 'bg-white/10 border border-white/10 text-content-inverse-secondary hover:text-red-400 hover:border-red-400/30'
                              : 'bg-white border border-border text-content-secondary hover:text-red-500 hover:border-red-200'
                            }
                          `}
                          title="Delete invitation"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                          </svg>
                          Delete
                        </button>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        </div>
      </motion.div>

      {/* Invite Modal */}
      <InviteParticipantModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        sessionId={sessionId}
        onSuccess={handleInvitationCreated}
      />

      {/* Revoke Confirmation Modal */}
      <AnimatePresence>
        {revokeConfirm.isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={handleCancelRevoke}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`
                w-full max-w-sm rounded-2xl p-6
                ${isDark
                  ? 'bg-zinc-800 border border-zinc-700'
                  : 'bg-white border border-neutral-200 shadow-xl'
                }
              `}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Icon */}
              <div className={`
                w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center
                ${isDark ? 'bg-red-500/20' : 'bg-red-50'}
              `}>
                <Ban className={`w-6 h-6 ${isDark ? 'text-red-400' : 'text-red-500'}`} />
              </div>

              {/* Title */}
              <h3 className={`text-lg font-medium text-center mb-2 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                Revoke Access?
              </h3>

              {/* Description */}
              <p className={`text-sm text-center mb-6 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                Are you sure you want to revoke access for <span className="font-medium">{revokeConfirm.participantName}</span>?
              </p>

              {/* What happens */}
              <div className={`
                text-xs p-3 rounded-lg mb-6
                ${isDark ? 'bg-zinc-900/50 text-zinc-400' : 'bg-neutral-50 text-neutral-500'}
              `}>
                <p className="font-medium mb-1">What happens when you revoke:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>The participant will be disconnected</li>
                  <li>They won't be able to rejoin using this invitation</li>
                  <li>You can delete the invitation afterwards</li>
                </ul>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={handleCancelRevoke}
                  className={`
                    flex-1 py-2.5 px-4 rounded-xl text-sm font-light
                    transition-all duration-200
                    ${isDark
                      ? 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                    }
                  `}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmRevoke}
                  className={`
                    flex-1 py-2.5 px-4 rounded-xl text-sm font-light
                    transition-all duration-200
                    ${isDark
                      ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30'
                      : 'bg-red-500 text-white hover:bg-red-600'
                    }
                  `}
                >
                  Revoke Access
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
