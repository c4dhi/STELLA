import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Copy, ExternalLink, Globe, Users, XCircle, PlayCircle } from 'lucide-react'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'

interface PublicLinkModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
  projectName: string
  publicToken: string
  isEnabled?: boolean
  onStatusChange?: (enabled: boolean) => void
}

export default function PublicLinkModal({
  isOpen,
  onClose,
  projectId,
  projectName,
  publicToken,
  isEnabled = true,
  onStatusChange,
}: PublicLinkModalProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [copied, setCopied] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [currentEnabled, setCurrentEnabled] = useState(isEnabled)

  const publicLink = `${window.location.origin}/p/${publicToken}`

  const handleToggleStatus = async () => {
    setIsToggling(true)
    try {
      await apiClient.updateProjectPublicConfig(projectId, {
        isPublic: true,
        enabled: !currentEnabled,
      })
      setCurrentEnabled(!currentEnabled)
      onStatusChange?.(!currentEnabled)
    } catch (err) {
      console.error('Failed to toggle project status:', err)
    } finally {
      setIsToggling(false)
    }
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy link:', err)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className={`
              relative w-full max-w-md rounded-2xl overflow-hidden shadow-2xl
              ${isDark
                ? 'bg-zinc-800 border border-zinc-700'
                : 'bg-white border border-neutral-200'
              }
            `}
          >
            {/* Header */}
            <div className={`px-6 pt-6 pb-4`}>
              <div className="flex items-center gap-3 mb-2">
                <div className={`
                  w-10 h-10 rounded-xl flex items-center justify-center
                  ${isDark ? 'bg-violet-500/20' : 'bg-neutral-100'}
                `}>
                  <Globe className={`w-5 h-5 ${isDark ? 'text-violet-400' : 'text-neutral-900'}`} />
                </div>
                <div>
                  <h2 className={`text-lg font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                    Invite Participants
                  </h2>
                  <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    {projectName}
                  </p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="px-6 pb-6">
              {/* Status indicator - now interactive */}
              <div className={`
                flex items-center justify-between p-3 rounded-xl mb-4
                ${currentEnabled
                  ? isDark ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-emerald-50 border border-emerald-200'
                  : isDark ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'
                }
              `}>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${currentEnabled ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  <span className={`text-sm ${
                    currentEnabled
                      ? isDark ? 'text-emerald-400' : 'text-emerald-700'
                      : isDark ? 'text-amber-400' : 'text-amber-700'
                  }`}>
                    {currentEnabled ? 'Accepting new participants' : 'Closed to new participants'}
                  </span>
                </div>
                <button
                  onClick={handleToggleStatus}
                  disabled={isToggling}
                  className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                    disabled:opacity-50 disabled:cursor-not-allowed
                    ${currentEnabled
                      ? isDark
                        ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                        : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                      : isDark
                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                        : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                    }
                  `}
                >
                  {isToggling ? (
                    <span>...</span>
                  ) : currentEnabled ? (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      Close
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-3.5 h-3.5" />
                      Open
                    </>
                  )}
                </button>
              </div>

              <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                {currentEnabled
                  ? 'Share this link with participants. Each person who opens the link will get their own private session with the pre-configured agent.'
                  : 'New participants cannot join while the project is closed. Existing sessions remain active.'
                }
              </p>

              {/* Link display */}
              <div className={`
                flex items-center gap-2 coarse:gap-3 p-4 rounded-xl mb-4
                ${isDark ? 'bg-zinc-700/50 border border-zinc-600' : 'bg-neutral-50 border border-neutral-200'}
              `}>
                <input
                  type="text"
                  value={publicLink}
                  readOnly
                  className={`flex-1 bg-transparent text-sm font-mono truncate ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}
                />
                <button
                  onClick={handleCopyLink}
                  className={`
                    p-2 rounded-lg transition-colors flex-shrink-0
                    ${isDark
                      ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                      : 'hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700'
                    }
                  `}
                  title="Copy link"
                >
                  {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                </button>
                <a
                  href={publicLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`
                    p-2 rounded-lg transition-colors flex-shrink-0
                    ${isDark
                      ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                      : 'hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700'
                    }
                  `}
                  title="Open in new tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>

              {/* Info section */}
              <div className={`
                flex items-start gap-3 p-3 rounded-xl
                ${isDark ? 'bg-zinc-700/30' : 'bg-neutral-50'}
              `}>
                <Users className={`w-5 h-5 mt-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`} />
                <div>
                  <p className={`text-sm ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`}>
                    How it works
                  </p>
                  <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                    Participants click the link, a session is automatically created with the pre-configured agent, and they can start their conversation immediately.
                  </p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className={`px-6 py-4 border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
              <div className="flex gap-3">
                <button
                  onClick={handleCopyLink}
                  className={`
                    flex-1 py-2.5 px-4 rounded-xl text-sm font-medium transition-all
                    flex items-center justify-center gap-2
                    ${isDark
                      ? 'bg-violet-600 text-white hover:bg-violet-500'
                      : 'bg-neutral-900 text-white hover:bg-neutral-800'
                    }
                  `}
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy Link
                    </>
                  )}
                </button>
                <button
                  onClick={onClose}
                  className={`
                    px-4 py-2.5 rounded-xl text-sm font-medium transition-all
                    ${isDark
                      ? 'text-zinc-300 hover:bg-zinc-700'
                      : 'text-neutral-600 hover:bg-neutral-100'
                    }
                  `}
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
