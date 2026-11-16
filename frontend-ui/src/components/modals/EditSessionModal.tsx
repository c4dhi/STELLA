import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { choiceCardClass, SelectedBadge } from '../shared/wizardChoice'
import { sessionCloseChoice, sessionCloseChoices } from '../../lib/closeWhenEmpty'

interface EditSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (name: string | null, closeWhenEmpty: boolean | null) => Promise<void>
  currentName: string | null
  /** The session's own setting for when everyone has left; null follows the project (#162). */
  currentCloseWhenEmpty: boolean | null
  /** What the project does when everyone has left. */
  projectCloses: boolean
  sessionId: string
}

export default function EditSessionModal({
  isOpen,
  onClose,
  onSubmit,
  currentName,
  currentCloseWhenEmpty,
  projectCloses,
}: EditSessionModalProps) {
  const [name, setName] = useState(currentName || '')
  const [closeWhenEmpty, setCloseWhenEmpty] = useState<boolean | null>(currentCloseWhenEmpty)
  const choices = sessionCloseChoices(projectCloses)
  const picked = sessionCloseChoice(closeWhenEmpty)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Update local state when currentName prop changes
  useEffect(() => {
    setName(currentName || '')
  }, [currentName])
  useEffect(() => {
    setCloseWhenEmpty(currentCloseWhenEmpty)
  }, [currentCloseWhenEmpty])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmedName = name.trim()

    // If name is empty, set it to null (clear the name)
    const nameToSubmit = trimmedName || null

    if (nameToSubmit === currentName && closeWhenEmpty === currentCloseWhenEmpty) {
      setError('Nothing has changed')
      return
    }

    setLoading(true)
    setError(null)

    try {
      await onSubmit(nameToSubmit, closeWhenEmpty)
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to update session')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    if (!loading) {
      setName(currentName || '') // Reset to original name
      setCloseWhenEmpty(currentCloseWhenEmpty)
      setError(null)
      onClose()
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={`card-elevated w-full max-w-md p-6 ${
              isDark ? 'bg-surface-dark-secondary' : ''
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="mb-6 relative">
              <button
                onClick={handleClose}
                disabled={loading}
                className={`absolute -top-1 -right-1 p-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDark
                    ? 'text-content-inverse-tertiary hover:text-content-inverse hover:bg-surface-dark-tertiary'
                    : 'text-content-tertiary hover:text-content hover:bg-surface-secondary'
                }`}
                title="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <h2 className={`text-heading-lg ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                Edit Session
              </h2>
              <p className={`text-body mt-1 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                Update the name and settings of your session
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className={`block text-label uppercase mb-2 ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  Session Name <span className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>(Optional)</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  maxLength={255}
                  className="input-field"
                  placeholder="Enter session name (optional)"
                  disabled={loading}
                />
                <div className={`mt-2 text-caption ${
                  isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                }`}>
                  {name.length}/255 characters
                </div>
              </div>

              {/* When everyone has left (#162) */}
              <div>
                <label className={`block text-label uppercase mb-2 ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                  When everyone has left
                </label>
                <div className="space-y-2">
                  {choices.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setCloseWhenEmpty(c.closeWhenEmpty)}
                      disabled={loading}
                      aria-pressed={picked === c.value}
                      className={`relative w-full p-3 rounded-xl text-left text-sm font-medium disabled:opacity-60 ${
                        isDark ? 'text-zinc-100' : 'text-neutral-900'
                      } ${choiceCardClass(picked === c.value, isDark)}`}
                    >
                      {c.label}
                      {picked === c.value && <SelectedBadge isDark={isDark} className="absolute top-3 right-3" />}
                    </button>
                  ))}
                </div>
                <p className={`mt-2 text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                  Keep open: the participant's invitation keeps working after the agent stops. Close: it stops working.
                </p>
              </div>

              {/* Error message */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`p-3 rounded-lg text-body-sm ${
                    isDark
                      ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                      : 'bg-red-50 border border-red-200 text-red-700'
                  }`}
                >
                  {error}
                </motion.div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={loading}
                  className="btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary flex-1"
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
