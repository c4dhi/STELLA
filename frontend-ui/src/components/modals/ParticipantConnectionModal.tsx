import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { Link, Globe, Smartphone, Copy, Check, Ban, Calendar, Clock, Eye, Trash2 } from 'lucide-react'
import { apiClient } from '../../services/ApiClient'
import { useThemeStore } from '../../store/themeStore'
import type { ParticipantConnectionInfoResponse, InvitationStatus } from '../../lib/api-types'
import { getRuntimeConfig } from '../../config/runtime'
import JoinQrCode from '../shared/JoinQrCode'

interface ParticipantDetails {
  createdAt: string           // When invitation was created
  acceptedAt?: string | null  // When invitation was accepted
  joinedAt?: string | null    // When participant joined
  lastSeenAt?: string | null  // Last activity
  status: InvitationStatus
}

interface ParticipantConnectionModalProps {
  participantId: string
  invitationId?: string  // Required for revoke functionality
  invitationToken?: string | null  // If provided, shows web link instead of mobile info
  participantDetails?: ParticipantDetails | null  // Additional details for the modal
  onRevoke?: (invitationId: string) => Promise<void>  // Callback when revoking access
  onClose: () => void
}

export default function ParticipantConnectionModal({
  participantId,
  invitationId,
  invitationToken,
  participantDetails,
  onRevoke,
  onClose,
}: ParticipantConnectionModalProps) {
  const [connectionInfo, setConnectionInfo] = useState<ParticipantConnectionInfoResponse | null>(null)
  const [serverUrl, setServerUrl] = useState<string>(getRuntimeConfig().apiUrl)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false)
  const [currentStatus, setCurrentStatus] = useState<InvitationStatus | undefined>(participantDetails?.status)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Determine if this is a web participant (has invitation token)
  const isWebParticipant = !!invitationToken
  const isRevoked = currentStatus === 'REVOKED'

  // Format date/time helper
  const formatDateTime = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '—'
    const date = new Date(dateStr)
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Get status color
  const getStatusColor = (status: InvitationStatus | undefined) => {
    switch (status) {
      case 'ACCEPTED':
        return isDark ? 'bg-green-500/20 text-green-300' : 'bg-green-50 text-green-600'
      case 'REVOKED':
        return isDark ? 'bg-red-500/20 text-red-300' : 'bg-red-50 text-red-600'
      case 'EXPIRED':
        return isDark ? 'bg-zinc-500/20 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
      case 'PENDING':
        return isDark ? 'bg-yellow-500/20 text-yellow-300' : 'bg-yellow-50 text-yellow-600'
      default:
        return isDark ? 'bg-zinc-500/20 text-zinc-400' : 'bg-neutral-100 text-neutral-500'
    }
  }

  // Handle revoke
  const handleRevoke = async () => {
    if (!invitationId || !onRevoke) return

    setIsRevoking(true)
    try {
      await onRevoke(invitationId)
      setCurrentStatus('REVOKED' as InvitationStatus)
    } catch (err) {
      console.error('Failed to revoke:', err)
    } finally {
      setIsRevoking(false)
    }
  }

  useEffect(() => {
    loadConnectionInfo()
  }, [participantId])

  const loadConnectionInfo = async () => {
    try {
      setIsLoading(true)
      setError(null)

      // Fetch both connection info and network info in parallel
      const [connectionData, networkData] = await Promise.all([
        apiClient.getParticipantConnectionInfo(participantId),
        apiClient.getNetworkInfo(),
      ])

      setConnectionInfo(connectionData)
      setServerUrl(networkData.serverUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connection info')
    } finally {
      setIsLoading(false)
    }
  }

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  // Generate the web join URL
  const webJoinUrl = invitationToken ? `${window.location.origin}/join/${invitationToken}` : ''

  // Generate QR code data - contains JWT token for authentication
  // Mobile app will use token to authenticate and fetch connection info
  const qrCodeData = connectionInfo?.token ? JSON.stringify({
    serverUrl: serverUrl,
    token: connectionInfo.token, // JWT token for participant authentication
  }) : ''

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className={`
            backdrop-blur-xl rounded-[20px] w-full max-w-4xl overflow-hidden
            flex flex-col max-h-[calc(100dvh-2rem)]
            ${isDark
              ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
              : 'bg-white border border-neutral-200 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
            }
          `}
          onClick={(e) => e.stopPropagation()}
        >
          {isLoading ? (
            <div className="text-center p-8">
              <div className={`text-sm font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>Loading connection info...</div>
            </div>
          ) : error ? (
            <div className="text-center p-8">
              <div className={`text-sm font-light ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</div>
              <button
                onClick={onClose}
                className={`
                  mt-4 px-4 py-2 rounded-xl text-sm font-light tracking-wider
                  transition-all duration-200
                  ${isDark
                    ? 'bg-white/10 text-white hover:bg-white/20 border border-white/10'
                    : 'bg-neutral-900 text-white hover:bg-neutral-800'
                  }
                `}
              >
                Close
              </button>
            </div>
          ) : connectionInfo ? (
            <>
              <div className="shrink-0 flex items-start justify-between px-5 md:px-8 pt-5 md:pt-8 mb-6">
                <div>
                  <h2 className={`text-2xl font-light mb-2 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                    Connection Information
                  </h2>
                  <div className="flex items-center gap-2">
                    <p className={`text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                      {connectionInfo.participantName}
                    </p>
                    <span className={`
                      inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-light uppercase tracking-wider
                      ${isWebParticipant
                        ? isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-600'
                        : isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-50 text-violet-600'
                      }
                    `}>
                      {isWebParticipant ? <Globe className="w-3 h-3" /> : <Smartphone className="w-3 h-3" />}
                      {isWebParticipant ? 'Web' : 'Mobile'}
                    </span>
                    {currentStatus && (
                      <span className={`
                        inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-light uppercase tracking-wider
                        ${getStatusColor(currentStatus)}
                      `}>
                        {currentStatus}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className={`
                    p-2 rounded-lg transition-all duration-200
                    ${isDark
                      ? 'text-zinc-400 hover:text-zinc-200 hover:bg-white/10'
                      : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                    }
                  `}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 pb-6">
              {isWebParticipant ? (
                /* Web Participant View - Show invitation link or revoked status */
                <div className="space-y-6">
                  {/* Status Banner, with the QR beside it so this doesn't cost the modal an extra row. */}
                  {/* flex-col-reverse: on mobile the QR (second in DOM) renders above the banner, per Felix's request. */}
                  <div className="flex flex-col-reverse sm:flex-row gap-4 items-stretch">
                    {isRevoked ? (
                      <div className={`
                        flex-1 p-6 rounded-xl text-center flex flex-col justify-center
                        ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-100'}
                      `}>
                        <Ban className={`w-10 h-10 mx-auto mb-3 ${isDark ? 'text-red-400' : 'text-red-500'}`} />
                        <p className={`text-sm font-light mb-1 ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`}>
                          Access has been revoked
                        </p>
                        <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                          This participant can no longer access the session
                        </p>
                      </div>
                    ) : (
                      <div className={`
                        flex-1 p-6 rounded-xl text-center flex flex-col justify-center
                        ${isDark ? 'bg-cyan-500/10 border border-cyan-500/20' : 'bg-cyan-50 border border-cyan-100'}
                      `}>
                        <Globe className={`w-10 h-10 mx-auto mb-3 ${isDark ? 'text-cyan-400' : 'text-cyan-500'}`} />
                        <p className={`text-sm font-light mb-1 ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`}>
                          This participant joined via web browser
                        </p>
                        <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                          Share the link below if they need to reconnect
                        </p>
                      </div>
                    )}

                    <div className="flex-shrink-0 flex items-center justify-center">
                      <JoinQrCode
                        value={webJoinUrl}
                        isDark={isDark}
                        revoked={isRevoked}
                        participantName={connectionInfo.participantName}
                        size={112}
                      />
                    </div>
                  </div>

                  {/* Invitation Link - Always show, but disable copy when revoked */}
                  <div>
                    <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                      Invitation Link {isRevoked && <span className={isDark ? 'text-red-400' : 'text-red-500'}>(Disabled)</span>}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={webJoinUrl}
                        readOnly
                        className={`
                          flex-1 px-4 py-2.5 rounded-xl text-sm font-mono font-light focus:outline-none
                          ${isRevoked
                            ? isDark
                              ? 'bg-zinc-800/50 border border-zinc-700/50 text-zinc-500'
                              : 'bg-neutral-100 border border-neutral-200/60 text-neutral-400'
                            : isDark
                              ? 'bg-zinc-800 border border-zinc-700 text-zinc-100'
                              : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
                          }
                        `}
                      />
                      <button
                        onClick={() => !isRevoked && copyToClipboard(webJoinUrl, 'link')}
                        disabled={isRevoked}
                        className={`
                          px-4 py-2.5 rounded-xl text-sm font-light
                          transition-all duration-200 flex items-center gap-2
                          ${isRevoked
                            ? isDark
                              ? 'bg-zinc-800/50 border border-zinc-700/50 text-zinc-600 cursor-not-allowed'
                              : 'bg-neutral-100 border border-neutral-200 text-neutral-400 cursor-not-allowed'
                            : copiedField === 'link'
                              ? isDark ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-green-50 text-green-600 border border-green-200'
                              : isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                          }
                        `}
                      >
                        {copiedField === 'link' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copiedField === 'link' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  {/* Participant Details */}
                  {participantDetails && (
                    <div className={`
                      p-4 rounded-xl
                      ${isDark ? 'bg-zinc-900/50 border border-zinc-700/50' : 'bg-neutral-50 border border-neutral-200/60'}
                    `}>
                      <h3 className={`text-xs font-light tracking-wider uppercase mb-4 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                        Participant Details
                      </h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="flex items-start gap-2">
                          <Calendar className={`w-4 h-4 mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`} />
                          <div>
                            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>Invited</p>
                            <p className={`text-sm font-light ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
                              {formatDateTime(participantDetails.createdAt)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-start gap-2">
                          <Clock className={`w-4 h-4 mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`} />
                          <div>
                            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>Joined</p>
                            <p className={`text-sm font-light ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
                              {formatDateTime(participantDetails.joinedAt || participantDetails.acceptedAt)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-start gap-2 col-span-2">
                          <Eye className={`w-4 h-4 mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`} />
                          <div>
                            <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>Last Seen</p>
                            <p className={`text-sm font-light ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
                              {formatDateTime(participantDetails.lastSeenAt)}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* Mobile Participant View - Show QR code and tokens */
                <div className="flex gap-8">
                  {/* Connection Details */}
                  <div className="flex-1 space-y-5">
                    {/* Session Server URL */}
                    <div>
                      <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        Session Server URL
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={serverUrl}
                          readOnly
                          className={`
                            flex-1 px-4 py-2.5 rounded-xl text-sm font-mono font-light focus:outline-none
                            ${isDark
                              ? 'bg-zinc-800 border border-zinc-700 text-zinc-100'
                              : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
                            }
                          `}
                        />
                        <button
                          onClick={() => copyToClipboard(serverUrl, 'serverUrl')}
                          className={`
                            px-3 py-2.5 rounded-lg text-xs font-light
                            transition-all duration-200 flex-shrink-0
                            ${copiedField === 'serverUrl'
                              ? isDark ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-green-50 text-green-600 border border-green-200'
                              : isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                            }
                          `}
                          title="Copy to clipboard"
                        >
                          {copiedField === 'serverUrl' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* JWT Token */}
                    <div>
                      <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        Authentication Token
                      </label>
                      <div className="flex gap-2">
                        <textarea
                          rows={5}
                          value={connectionInfo?.token || ''}
                          readOnly
                          className={`
                            flex-1 px-4 py-2.5 rounded-xl text-sm font-mono font-light
                            focus:outline-none resize-none break-all
                            ${isDark
                              ? 'bg-zinc-800 border border-zinc-700 text-zinc-100'
                              : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
                            }
                          `}
                        />
                        <button
                          onClick={() => copyToClipboard(connectionInfo?.token || '', 'token')}
                          className={`
                            px-3 py-2.5 rounded-lg text-xs font-light
                            transition-all duration-200 flex-shrink-0 self-start
                            ${copiedField === 'token'
                              ? isDark ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-green-50 text-green-600 border border-green-200'
                              : isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                            }
                          `}
                          title="Copy to clipboard"
                        >
                          {copiedField === 'token' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* QR Code */}
                  <div className="flex-shrink-0 flex flex-col items-center gap-4">
                    <div className={`
                      p-6 rounded-xl shadow-sm
                      ${isDark
                        ? 'bg-white'
                        : 'bg-white border border-neutral-200/60'
                      }
                    `}>
                      <QRCodeSVG
                        value={qrCodeData}
                        size={300}
                        level="H"
                        includeMargin={false}
                      />
                    </div>
                    <p className={`text-xs font-light tracking-wider uppercase text-center ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                      Scan to connect
                    </p>
                  </div>
                </div>
              )}
              </div>

              <div className={`shrink-0 px-5 md:px-8 pb-5 md:pb-8 pt-6 border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200/60'}`}>
                <div className="flex gap-3">
                  {/* Revoke button - only show when ACCEPTED and onRevoke is available */}
                  {currentStatus === 'ACCEPTED' && invitationId && onRevoke && (
                    <button
                      onClick={() => setShowRevokeConfirm(true)}
                      disabled={isRevoking}
                      className={`
                        flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                        transition-all duration-200 flex items-center justify-center gap-2
                        ${isDark
                          ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30'
                          : 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
                        }
                        ${isRevoking ? 'opacity-50 cursor-not-allowed' : ''}
                      `}
                    >
                      <Ban className="w-4 h-4" />
                      {isRevoking ? 'Revoking...' : 'Revoke Access'}
                    </button>
                  )}

                  <button
                    onClick={onClose}
                    className={`
                      ${currentStatus === 'ACCEPTED' && invitationId && onRevoke ? 'flex-1' : 'w-full'}
                      py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                      transition-all duration-200
                      ${isDark
                        ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                        : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-[0_1px_20px_rgba(0,0,0,0.12)]'
                      }
                    `}
                  >
                    Close
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </motion.div>

        {/* Revoke Confirmation Modal */}
        {showRevokeConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowRevokeConfirm(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`
                w-full max-w-sm p-6 rounded-2xl
                ${isDark
                  ? 'bg-zinc-800 border border-zinc-700'
                  : 'bg-white border border-neutral-200 shadow-xl'
                }
              `}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Warning Icon */}
              <div className="flex justify-center mb-4">
                <div className={`
                  w-12 h-12 rounded-full flex items-center justify-center
                  ${isDark ? 'bg-red-500/20' : 'bg-red-50'}
                `}>
                  <Ban className={`w-6 h-6 ${isDark ? 'text-red-400' : 'text-red-500'}`} />
                </div>
              </div>

              {/* Title */}
              <h3 className={`text-lg font-medium text-center mb-2 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                Revoke Access?
              </h3>

              {/* Description */}
              <p className={`text-sm text-center mb-6 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                Are you sure you want to revoke access for <span className="font-medium">{connectionInfo?.participantName}</span>?
              </p>

              {/* What happens */}
              <div className={`
                text-xs p-3 rounded-lg mb-6
                ${isDark ? 'bg-zinc-900/50 text-zinc-400' : 'bg-neutral-50 text-neutral-500'}
              `}>
                <p className="font-medium mb-1">What happens when you revoke:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>The participant will be disconnected</li>
                  <li>They won't be able to rejoin using this link</li>
                  <li>You can re-invite them with a new invitation</li>
                </ul>
              </div>

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={() => setShowRevokeConfirm(false)}
                  className={`
                    flex-1 py-2.5 px-4 rounded-xl text-sm font-light
                    transition-all duration-200
                    ${isDark
                      ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                    }
                  `}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    setShowRevokeConfirm(false)
                    await handleRevoke()
                  }}
                  disabled={isRevoking}
                  className={`
                    flex-1 py-2.5 px-4 rounded-xl text-sm font-light
                    transition-all duration-200 flex items-center justify-center gap-2
                    ${isDark
                      ? 'bg-red-500 text-white hover:bg-red-400'
                      : 'bg-red-500 text-white hover:bg-red-600'
                    }
                    ${isRevoking ? 'opacity-50 cursor-not-allowed' : ''}
                  `}
                >
                  <Ban className="w-4 h-4" />
                  {isRevoking ? 'Revoking...' : 'Revoke Access'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
