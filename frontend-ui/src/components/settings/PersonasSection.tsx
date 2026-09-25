import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { apiClient } from '../../services/ApiClient'
import type { Persona } from '../../lib/api-types'
import PersonaEditorModal from './PersonaEditorModal'
import ConfirmDialog from '../modals/ConfirmDialog'

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
}

/**
 * Personas — who your agents are, managed in one place.
 *
 * A persona is stated once here and referenced wherever it is needed: selected at
 * deploy time, and inserted into an agent configuration's prompts or a plan's own
 * text as {{persona.<key>}}. Nothing about identity is defined a second time.
 */
export default function PersonasSection() {
  const { resolvedTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const isDark = resolvedTheme === 'dark'

  const [personas, setPersonas] = useState<Persona[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Persona | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Persona | null>(null)

  const load = async () => {
    try {
      setIsLoading(true)
      setError(null)
      setPersonas(await apiClient.listPersonas())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load personas')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }

  const handleEdit = (persona: Persona) => {
    setEditing(persona)
    setEditorOpen(true)
  }

  const handleSaved = (saved: Persona) => {
    setPersonas((prev) => {
      const exists = prev.some((p) => p.id === saved.id)
      return exists ? prev.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...prev]
    })
    setEditorOpen(false)
    addToast({ message: `"${saved.name}" saved`, type: 'success' })
  }

  const handleDuplicate = async (persona: Persona) => {
    try {
      const copy = await apiClient.duplicatePersona(persona.id)
      setPersonas((prev) => [copy, ...prev])
      addToast({ message: `"${persona.name}" duplicated`, type: 'success' })
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to duplicate persona',
        type: 'error',
      })
    }
  }

  const confirmDelete = async () => {
    if (!toDelete) return
    try {
      await apiClient.deletePersona(toDelete.id)
      setPersonas((prev) => prev.filter((p) => p.id !== toDelete.id))
      addToast({ message: `"${toDelete.name}" deleted`, type: 'success' })
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to delete persona',
        type: 'error',
      })
    } finally {
      setDeleteConfirmOpen(false)
      setToDelete(null)
    }
  }

  const cardClass = isDark
    ? 'bg-surface-dark-secondary border-border-dark'
    : 'bg-white border-border'

  return (
    <>
      <motion.div
        className="max-w-5xl"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.div className="flex items-start justify-between mb-8" variants={itemVariants}>
          <div>
            <h2
              className={`text-heading-lg font-semibold ${
                isDark ? 'text-content-inverse' : 'text-content'
              }`}
            >
              Personas
            </h2>
            <p
              className={`text-body-sm mt-1.5 max-w-lg ${
                isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
              }`}
            >
              Who your agents are — character, voice, and the values you reuse. Defined
              once here, then referenced from plans and configurations.
            </p>
          </div>

          <motion.button
            onClick={handleCreate}
            className="btn-primary flex items-center gap-2 shadow-lg shadow-primary/20"
            whileHover={{ scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Persona
          </motion.button>
        </motion.div>

        <AnimatePresence mode="wait">
          {isLoading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-20"
            >
              <motion.div
                className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${
                  isDark ? 'bg-surface-dark-secondary' : 'bg-surface-secondary'
                }`}
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                  <path d="M12 2a5 5 0 0 1 5 5v1a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z" />
                  <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
                </svg>
              </motion.div>
              <p className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                Loading personas...
              </p>
            </motion.div>
          )}

          {!isLoading && error && (
            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-10">
              <p className="text-body-sm text-red-500">{error}</p>
            </motion.div>
          )}

          {!isLoading && !error && (
            <motion.div key="list" className="grid gap-3" variants={containerVariants}>
              {personas.map((persona) => {
                const variableKeys = Object.keys(persona.variables || {})
                return (
                  <motion.div
                    key={persona.id}
                    variants={itemVariants}
                    className={`p-5 rounded-2xl border ${cardClass}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5 mb-1">
                          <span className="text-lg">{persona.icon || '🎭'}</span>
                          <h3 className={`text-body font-medium truncate ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                            {persona.name}
                          </h3>
                          {persona.isSystemDefault && (
                            <span className={`text-[11px] px-2 py-0.5 rounded-full ${isDark ? 'bg-zinc-700 text-zinc-300' : 'bg-neutral-100 text-neutral-500'}`}>
                              Default
                            </span>
                          )}
                        </div>
                        <p className={`text-body-sm line-clamp-2 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                          {persona.description || persona.systemPrompt.slice(0, 160)}
                        </p>
                        <div className={`mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                          {persona.voice && <span>Voice: {persona.voice}</span>}
                          {persona.language && <span>Language: {persona.language.toUpperCase()}</span>}
                          {variableKeys.length > 0 && (
                            <span>
                              Variables: {variableKeys.map((k) => `{{persona.${k}}}`).join(' ')}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleDuplicate(persona)}
                          title="Duplicate"
                          className={`p-2 rounded-lg ${isDark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-neutral-100 text-neutral-500'}`}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                        {/* The system default is the terminus of the resolution chain,
                            so it is read-only: duplicate it to make your own. */}
                        {!persona.isSystemDefault && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleEdit(persona)}
                              title="Edit"
                              className={`p-2 rounded-lg ${isDark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-neutral-100 text-neutral-500'}`}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setToDelete(persona)
                                setDeleteConfirmOpen(true)
                              }}
                              title="Delete"
                              className={`p-2 rounded-lg ${isDark ? 'hover:bg-red-500/10 text-zinc-400 hover:text-red-400' : 'hover:bg-red-50 text-neutral-500 hover:text-red-500'}`}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <PersonaEditorModal
        isOpen={editorOpen}
        persona={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title="Delete persona"
        message={
          toDelete
            ? `Delete "${toDelete.name}"? Agents already deployed with it keep running — they hold their own snapshot — but it can no longer be selected.`
            : ''
        }
        confirmText="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </>
  )
}
