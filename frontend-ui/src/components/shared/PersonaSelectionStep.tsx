import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import type { Persona } from '../../lib/api-types'

interface PersonaSelectionStepProps {
  selectedPersona: Persona | null
  onSelectPersona: (persona: Persona | null) => void
  personas?: Persona[]
  onPersonasChange?: (personas: Persona[]) => void
}

const CARD_STYLES = [
  { gradient: 'from-rose-500/20 to-orange-500/20', iconColor: 'text-rose-500' },
  { gradient: 'from-violet-500/20 to-fuchsia-500/20', iconColor: 'text-violet-500' },
  { gradient: 'from-sky-500/20 to-cyan-500/20', iconColor: 'text-sky-500' },
  { gradient: 'from-emerald-500/20 to-lime-500/20', iconColor: 'text-emerald-500' },
  { gradient: 'from-amber-500/20 to-yellow-500/20', iconColor: 'text-amber-500' },
]

type Draft = {
  name: string
  icon: string
  systemPrompt: string
  voice: string
  language: string
}

const EMPTY_DRAFT: Draft = { name: '', icon: '🎭', systemPrompt: '', voice: '', language: '' }

/**
 * Pick the identity the agent speaks with.
 *
 * A persona is deliberately not tied to an agent type, so unlike the pipeline
 * Configurator this step never has to reason about versions or compatibility —
 * every persona is selectable for every agent.
 */
export default function PersonaSelectionStep({
  selectedPersona,
  onSelectPersona,
  personas: externalPersonas,
  onPersonasChange,
}: PersonaSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const [internalPersonas, setInternalPersonas] = useState<Persona[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const personas = externalPersonas ?? internalPersonas
  const setPersonas = onPersonasChange ?? setInternalPersonas

  useEffect(() => {
    if (hasFetched) return
    setHasFetched(true)
    setIsLoading(true)
    apiClient
      .listPersonas()
      .then((list) => {
        setPersonas(list)
        // Preselect the default so the step is never left in a "nothing chosen"
        // state the user has to resolve — omitting a persona already means the
        // default server-side, so this only makes that visible.
        if (!selectedPersona && list.length > 0) {
          onSelectPersona(list.find((p) => p.isSystemDefault) ?? list[0])
        }
      })
      .catch((err) => console.error('Failed to fetch personas:', err))
      .finally(() => setIsLoading(false))
  }, [hasFetched, setPersonas, selectedPersona, onSelectPersona])

  const inputClass = `
    w-full px-3 py-2 rounded-lg text-sm font-light
    focus:outline-none transition-all duration-200
    ${isDark
      ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600'
      : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
    }
  `

  const startCreate = () => {
    setError(null)
    setEditingId('new')
    setDraft({ ...EMPTY_DRAFT })
  }

  const startEdit = (persona: Persona, e: React.MouseEvent) => {
    e.stopPropagation()
    setError(null)
    setEditingId(persona.id)
    setDraft({
      name: persona.name,
      icon: persona.icon || '🎭',
      systemPrompt: persona.systemPrompt,
      voice: persona.voice || '',
      language: persona.language || '',
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
    setError(null)
  }

  const save = async () => {
    if (!draft) return
    if (!draft.name.trim() || !draft.systemPrompt.trim()) {
      setError('A persona needs a name and a prompt.')
      return
    }
    setIsSaving(true)
    setError(null)
    const payload = {
      name: draft.name.trim(),
      icon: draft.icon.trim() || undefined,
      systemPrompt: draft.systemPrompt.trim(),
      voice: draft.voice.trim() || undefined,
      language: draft.language.trim().toLowerCase() || undefined,
    }
    try {
      if (editingId === 'new') {
        const created = await apiClient.createPersona(payload)
        setPersonas([created, ...personas])
        onSelectPersona(created)
      } else if (editingId) {
        const updated = await apiClient.updatePersona(editingId, payload)
        setPersonas(personas.map((p) => (p.id === updated.id ? updated : p)))
        if (selectedPersona?.id === updated.id) onSelectPersona(updated)
      }
      cancelEdit()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save persona')
    } finally {
      setIsSaving(false)
    }
  }

  // The system default is read-only by design (the resolution chain terminates
  // there), so its affordance is "duplicate", not "edit".
  const duplicate = async (persona: Persona, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const copy = await apiClient.duplicatePersona(persona.id)
      setPersonas([copy, ...personas])
      onSelectPersona(copy)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate persona')
    }
  }

  if (isLoading) {
    return (
      <div className={`h-48 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Loading personas...
        </div>
      </div>
    )
  }

  if (editingId && draft) {
    return (
      <div className="space-y-3 max-h-[350px] overflow-y-auto pr-2">
        <div className="flex gap-3">
          <input
            type="text"
            value={draft.icon}
            onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
            maxLength={8}
            aria-label="Persona icon"
            className={`${inputClass} w-16 text-center`}
          />
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name, e.g. Grace — clinical"
            maxLength={255}
            autoFocus
            className={inputClass}
          />
        </div>

        <div>
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            placeholder="Who is this agent? Describe the character, tone and boundaries — not the steps, those belong in the plan."
            rows={8}
            className={`${inputClass} resize-none font-mono text-xs leading-relaxed`}
          />
          <p className={`mt-1.5 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
            Used word for word. A {'{{placeholder}}'} written here is spoken as written, not filled in.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <input
              type="text"
              value={draft.voice}
              onChange={(e) => setDraft({ ...draft, voice: e.target.value })}
              placeholder="Voice id (optional)"
              maxLength={128}
              className={inputClass}
            />
            <p className={`mt-1.5 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              Empty = provider default.
            </p>
          </div>
          <div>
            <input
              type="text"
              value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value })}
              placeholder="Language (optional, e.g. de)"
              maxLength={16}
              className={inputClass}
            />
            <p className={`mt-1.5 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              Only used when the plan declares none.
            </p>
          </div>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          <motion.button
            type="button"
            onClick={save}
            disabled={isSaving}
            whileTap={{ scale: 0.98 }}
            className={`
              px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 disabled:opacity-50
              ${isDark ? 'bg-primary-500 text-white hover:bg-primary-400' : 'bg-neutral-900 text-white hover:bg-neutral-800'}
            `}
          >
            {isSaving ? 'Saving…' : 'Save persona'}
          </motion.button>
          <button
            type="button"
            onClick={cancelEdit}
            className={`px-4 py-2 rounded-xl text-sm font-light ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-800'}`}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="grid grid-cols-2 gap-3 max-h-[350px] overflow-y-auto overflow-x-visible pr-2 pt-1 -mt-1">
        {personas.map((persona, index) => {
          const style = CARD_STYLES[index % CARD_STYLES.length]
          const isSelected = selectedPersona?.id === persona.id

          return (
            <motion.button
              key={persona.id}
              type="button"
              onClick={() => onSelectPersona(persona)}
              whileHover={{ y: -2 }}
              className={`
                group/card relative p-4 rounded-xl text-left transition-all duration-200
                ${isSelected
                  ? isDark
                    ? 'bg-primary-500/20 border-2 border-primary-500 shadow-lg shadow-primary-500/20'
                    : 'bg-neutral-100 border-2 border-neutral-900 shadow-lg shadow-neutral-900/10'
                  : isDark
                    ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500 hover:bg-zinc-700/80'
                    : 'bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md'
                }
              `}
            >
              <div className="absolute top-3 right-3 flex items-center gap-1.5">
                <motion.div
                  onClick={(e) =>
                    persona.isSystemDefault ? duplicate(persona, e) : startEdit(persona, e)
                  }
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className={`
                    p-1.5 rounded-lg cursor-pointer
                    opacity-0 group-hover/card:opacity-100 transition-opacity duration-200
                    ${isDark
                      ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                      : 'hover:bg-neutral-100 text-neutral-400 hover:text-neutral-600'
                    }
                  `}
                  title={persona.isSystemDefault ? 'Duplicate to customise' : 'Edit persona'}
                >
                  {persona.isSystemDefault ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  )}
                </motion.div>
                {isSelected && (
                  <svg className={`w-5 h-5 ${isDark ? 'text-primary-400' : 'text-neutral-900'}`} fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </div>

              <div className={`w-10 h-10 mb-3 rounded-lg bg-gradient-to-br ${style.gradient} flex items-center justify-center text-lg`}>
                <span className={style.iconColor}>{persona.icon || '🎭'}</span>
              </div>

              <p className={`text-sm font-medium mb-1 pr-14 truncate ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                {persona.name}
              </p>
              <p className={`text-xs line-clamp-2 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                {persona.description || persona.systemPrompt.slice(0, 120)}
              </p>

              <div className={`mt-2 flex items-center gap-2 text-[11px] ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                {persona.isSystemDefault && <span>Default</span>}
                {persona.voice && <span>Voice: {persona.voice}</span>}
                {persona.language && <span>{persona.language.toUpperCase()}</span>}
              </div>
            </motion.button>
          )
        })}

        <motion.button
          type="button"
          onClick={startCreate}
          whileHover={{ y: -2 }}
          className={`
            p-4 rounded-xl text-left border-2 border-dashed transition-all duration-200
            flex flex-col items-center justify-center gap-2 min-h-[132px]
            ${isDark
              ? 'border-zinc-600 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
              : 'border-neutral-300 text-neutral-400 hover:border-neutral-400 hover:text-neutral-600'
            }
          `}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-sm font-medium">New persona</span>
        </motion.button>
      </div>
    </div>
  )
}
