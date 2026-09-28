import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import type { Persona } from '../../lib/api-types'

interface PersonaEditorModalProps {
  isOpen: boolean
  persona: Persona | null
  onClose: () => void
  onSaved: (persona: Persona) => void
}

type VariableRow = { key: string; value: string }

// Mirrors the server-side rule. Keys are matched with \w+ inside a
// {{persona.<key>}} token, so anything else could never be referenced and would
// look silently broken to whoever wrote the prompt.
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export default function PersonaEditorModal({
  isOpen,
  persona,
  onClose,
  onSaved,
}: PersonaEditorModalProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const [name, setName] = useState('')
  const [icon, setIcon] = useState('🎭')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [voice, setVoice] = useState('')
  const [language, setLanguage] = useState('')
  const [variables, setVariables] = useState<VariableRow[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    setName(persona?.name ?? '')
    setIcon(persona?.icon ?? '🎭')
    setDescription(persona?.description ?? '')
    setSystemPrompt(persona?.systemPrompt ?? '')
    setVoice(persona?.voice ?? '')
    setLanguage(persona?.language ?? '')
    setVariables(
      Object.entries(persona?.variables ?? {}).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    )
  }, [isOpen, persona])

  const inputClass = `
    w-full px-3 py-2 rounded-lg text-sm font-light
    focus:outline-none transition-all duration-200
    ${isDark
      ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600'
      : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
    }
  `
  const labelClass = `block text-xs font-medium mb-1.5 ${isDark ? 'text-zinc-300' : 'text-neutral-700'}`
  const hintClass = `mt-1.5 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`

  const setRow = (index: number, patch: Partial<VariableRow>) =>
    setVariables((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  const badKeys = variables
    .filter((r) => r.key.trim() && !KEY_PATTERN.test(r.key.trim()))
    .map((r) => r.key.trim())

  const handleSave = async () => {
    if (!name.trim() || !systemPrompt.trim()) {
      setError('A persona needs a name and a prompt.')
      return
    }
    if (badKeys.length > 0) {
      setError(
        `Unusable variable name${badKeys.length > 1 ? 's' : ''}: ${badKeys.join(', ')}. ` +
          'Use letters, digits and underscores only.',
      )
      return
    }

    const variableMap: Record<string, string> = {}
    for (const row of variables) {
      const key = row.key.trim()
      if (key) variableMap[key] = row.value
    }

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      icon: icon.trim() || undefined,
      systemPrompt: systemPrompt.trim(),
      voice: voice.trim() || undefined,
      language: language.trim().toLowerCase() || undefined,
      variables: variableMap,
    }

    setIsSaving(true)
    setError(null)
    try {
      const saved = persona
        ? await apiClient.updatePersona(persona.id, payload)
        : await apiClient.createPersona(payload)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save persona')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className={`w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl shadow-2xl ${
              isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-white border border-neutral-200'
            }`}
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 space-y-5">
              <div>
                <h2 className={`text-lg font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                  {persona ? 'Edit persona' : 'New persona'}
                </h2>
                <p className={hintClass}>
                  Identity only. What the agent does belongs in a plan; how it runs belongs
                  in an agent configuration.
                </p>
              </div>

              <div className="flex gap-3">
                <div className="w-20">
                  <label className={labelClass}>Icon</label>
                  <input
                    type="text"
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    maxLength={8}
                    className={`${inputClass} text-center`}
                  />
                </div>
                <div className="flex-1">
                  <label className={labelClass}>Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Grace — clinical"
                    maxLength={255}
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Shown when picking a persona at deploy time"
                  maxLength={2000}
                  className={inputClass}
                />
              </div>

              <div>
                <label className={labelClass}>Prompt</label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Who is this agent? Character, tone, boundaries — not the steps."
                  rows={10}
                  className={`${inputClass} resize-none font-mono text-xs leading-relaxed`}
                />
                <p className={hintClass}>
                  Used word for word. A {'{{placeholder}}'} written here is spoken as
                  written, not filled in — this is the one place that stays literal.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Voice</label>
                  <input
                    type="text"
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    placeholder="Voice id"
                    maxLength={128}
                    className={inputClass}
                  />
                  <p className={hintClass}>Empty = provider default.</p>
                </div>
                <div>
                  <label className={labelClass}>Language</label>
                  <input
                    type="text"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    placeholder="e.g. de"
                    maxLength={16}
                    className={inputClass}
                  />
                  <p className={hintClass}>Only used when the plan declares none.</p>
                </div>
              </div>

              {/* Variables — the "define once, reference everywhere" half. */}
              <div>
                <label className={labelClass}>Variables</label>
                <p className={`${hintClass} !mt-0 mb-2.5`}>
                  Values you can insert into plans and agent configurations as{' '}
                  <code>{'{{persona.key}}'}</code>, so a fact about this agent is written
                  down once.
                </p>

                <div className="space-y-2">
                  {variables.map((row, index) => {
                    const invalid = row.key.trim() !== '' && !KEY_PATTERN.test(row.key.trim())
                    return (
                      <div key={index} className="flex gap-2 items-start">
                        <div className="w-1/3">
                          <input
                            type="text"
                            value={row.key}
                            onChange={(e) => setRow(index, { key: e.target.value })}
                            placeholder="role"
                            className={`${inputClass} ${invalid ? '!border-red-500' : ''}`}
                          />
                          {row.key.trim() && !invalid && (
                            <p className={`${hintClass} font-mono`}>
                              {`{{persona.${row.key.trim()}}}`}
                            </p>
                          )}
                        </div>
                        <input
                          type="text"
                          value={row.value}
                          onChange={(e) => setRow(index, { value: e.target.value })}
                          placeholder="wellbeing companion"
                          maxLength={2000}
                          className={`${inputClass} flex-1`}
                        />
                        <button
                          type="button"
                          onClick={() => setVariables((rows) => rows.filter((_, i) => i !== index))}
                          title="Remove"
                          className={`p-2 rounded-lg shrink-0 ${isDark ? 'hover:bg-zinc-700 text-zinc-500' : 'hover:bg-neutral-100 text-neutral-400'}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => setVariables((rows) => [...rows, { key: '', value: '' }])}
                  className={`mt-2 text-xs font-medium ${isDark ? 'text-primary-400 hover:text-primary-300' : 'text-neutral-700 hover:text-neutral-900'}`}
                >
                  + Add variable
                </button>
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <div className="flex items-center gap-2 pt-1">
                <motion.button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  whileTap={{ scale: 0.98 }}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 disabled:opacity-50 ${
                    isDark ? 'bg-primary-500 text-white hover:bg-primary-400' : 'bg-neutral-900 text-white hover:bg-neutral-800'
                  }`}
                >
                  {isSaving ? 'Saving…' : 'Save persona'}
                </motion.button>
                <button
                  type="button"
                  onClick={onClose}
                  className={`px-4 py-2 rounded-xl text-sm font-light ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-800'}`}
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
