/**
 * Share one of your custom agents with projects. Members of those projects see
 * it and can deploy it there, but cannot build, re-upload, share or delete it.
 */
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import { apiErrorMessage } from '../../lib/apiErrorMessage'
import type { AgentShares } from '../../lib/api-types'

interface ShareAgentDialogProps {
  agent: { id: string; name: string } | null
  onClose: () => void
  onSaved: (projectIds: string[]) => void
}

export default function ShareAgentDialog({ agent, onClose, onSaved }: ShareAgentDialogProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [shares, setShares] = useState<AgentShares | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!agent) return
    setShares(null)
    setError(null)
    apiClient
      .getAgentShares(agent.id)
      .then((s) => {
        setShares(s)
        setSelected(new Set(s.projectIds))
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the projects')))
  }, [agent])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const save = async () => {
    if (!agent) return
    setIsSaving(true)
    setError(null)
    try {
      const { projectIds } = await apiClient.updateAgentShares(agent.id, [...selected])
      onSaved(projectIds)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the sharing'))
    } finally {
      setIsSaving(false)
    }
  }

  const muted = isDark ? 'text-zinc-400' : 'text-neutral-600'

  return (
    <AnimatePresence>
      {agent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-label={`Share ${agent.name}`}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className={`rounded-[20px] w-full max-w-md p-6 ${isDark
              ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
              : 'bg-white border border-neutral-200 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={`text-xl font-light tracking-wide mb-2 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
              Share {agent.name}
            </h2>
            <p className={`text-sm font-light mb-4 ${muted}`}>
              Members of these projects can deploy it there. Only you can change or delete it.
            </p>

            {!shares && !error && <p className={`text-sm ${muted}`}>Loading projects…</p>}
            {shares && shares.projects.length === 0 && (
              <p className={`text-sm ${muted}`}>You are not a member of any project yet.</p>
            )}
            {shares && shares.projects.length > 0 && (
              <ul className="max-h-64 overflow-y-auto space-y-1 mb-2">
                {shares.projects.map((p) => (
                  <li key={p.id}>
                    <label className={`flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer ${isDark ? 'hover:bg-white/5 text-zinc-200' : 'hover:bg-neutral-50 text-neutral-800'}`}>
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                      <span className="text-sm">{p.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="text-sm text-red-500 mb-2">{error}</p>}

            <div className="flex gap-3 mt-4">
              <button
                type="button"
                onClick={onClose}
                className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider ${isDark
                  ? 'bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!shares || isSaving}
                className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider text-white disabled:opacity-50 ${isDark
                  ? 'bg-primary-500 hover:bg-primary-400'
                  : 'bg-neutral-900 hover:bg-neutral-800'}`}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
