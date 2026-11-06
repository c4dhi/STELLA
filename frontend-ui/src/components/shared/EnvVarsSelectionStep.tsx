import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import type { EnvVarTemplate } from '../../lib/api-types'
import { useEnvVarListEditor } from './EnvVarListEditor/useEnvVarListEditor'
import EnvVarListEditor from './EnvVarListEditor/EnvVarListEditor'
import EnvVarNeedsSummary from './EnvVarNeedsSummary'
import { envVarHints, type OptionalEnvVar } from '../../lib/deployNeeds'
import { WIZARD_CARD_GRID } from './wizardLayout'

type EnvVarsView = 'select' | 'edit'

// Generate gradient colors for env var template cards
const getEnvVarCardStyle = (index: number) => {
  const gradients = [
    'from-amber-500/20 to-orange-500/20',
    'from-green-500/20 to-emerald-500/20',
    'from-violet-500/20 to-purple-500/20',
    'from-rose-500/20 to-pink-500/20',
    'from-sky-500/20 to-cyan-500/20',
  ]
  const iconColors = [
    'text-amber-500',
    'text-green-500',
    'text-violet-500',
    'text-rose-500',
    'text-sky-500',
  ]
  const colorIndex = index % 5
  return { gradient: gradients[colorIndex], iconColor: iconColors[colorIndex] }
}

interface EnvVarsSelectionStepProps {
  // Required: strict scoping means the agent type must always be supplied so the
  // template list is filtered server-side. Fail fast at the boundary if missing.
  agentTypeId: string
  requiredEnvVars: string[]
  /** Env vars the agent reads when set; offered as rows that may stay empty. */
  optionalEnvVars?: OptionalEnvVar[]
  selectedEnvVarTemplate: EnvVarTemplate | null
  onSelectEnvVarTemplate: (template: EnvVarTemplate | null) => void
  envVars: Record<string, string>
  onEnvVarsChange: (vars: Record<string, string>) => void
  envVarsView: EnvVarsView
  onEnvVarsViewChange: (view: EnvVarsView) => void
}

export default function EnvVarsSelectionStep({
  agentTypeId,
  requiredEnvVars,
  optionalEnvVars = [],
  selectedEnvVarTemplate,
  onSelectEnvVarTemplate,
  envVars,
  onEnvVarsChange,
  envVarsView,
  onEnvVarsViewChange,
}: EnvVarsSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const optionalNames = optionalEnvVars.map((v) => v.name)

  const [envVarTemplates, setEnvVarTemplates] = useState<EnvVarTemplate[]>([])
  const [isLoadingEnvVars, setIsLoadingEnvVars] = useState(false)

  // Shared editor: required keys are declared & must be filled; user may add custom keys.
  const editor = useEnvVarListEditor({ allowEmptyValues: false, requiredKeys: requiredEnvVars })

  // Keep the parent's `envVars` map in sync with the editor rows (one source of truth
  // for the editor; parent uses the map for canContinue + submission). Null (invalid)
  // collapses to {} so the parent blocks Continue until the rows are valid.
  useEffect(() => {
    onEnvVarsChange(editor.toVariablesMap() ?? {})
  }, [editor.rows])

  // Seed the editor once if the step mounts already in edit view (e.g. returning to it).
  const didMountSeed = useRef(false)
  useEffect(() => {
    if (!didMountSeed.current) {
      didMountSeed.current = true
      if (envVarsView === 'edit') {
        // Re-derive the same split as handleGoToEdit so a previously-selected
        // template's variables reappear as editable defaults (with any saved
        // overrides), instead of collapsing into plain required rows.
        const templateKeys = selectedEnvVarTemplate?.variableKeys ?? []
        const templateKeySet = new Set(templateKeys)
        const requiredToFill = requiredEnvVars.filter((key) => !templateKeySet.has(key))
        const optionalToOffer = optionalNames.filter((key) => !templateKeySet.has(key))
        editor.reset({ requiredKeys: requiredToFill, optionalKeys: optionalToOffer, templateKeys, initial: envVars })
      }
    }
  }, [])

  // Fetch env var templates on mount
  useEffect(() => {
    setIsLoadingEnvVars(true)
    apiClient.listEnvVarTemplates(agentTypeId)
      .then(setEnvVarTemplates)
      .catch((err) => console.error('Failed to fetch env var templates:', err))
      .finally(() => setIsLoadingEnvVars(false))
  }, [agentTypeId])

  const handleSelectTemplate = (template: EnvVarTemplate | null) => {
    onSelectEnvVarTemplate(template)
  }

  // The parent's Continue on the select view also opens the editor (as the
  // deploy dialog does), so a picked template's gaps can still be filled in.
  const seededByClick = useRef(false)
  const lastView = useRef(envVarsView)
  useEffect(() => {
    if (lastView.current === 'select' && envVarsView === 'edit' && !seededByClick.current) {
      const templateKeys = selectedEnvVarTemplate?.variableKeys ?? []
      const templateKeySet = new Set(templateKeys)
      editor.reset({
        requiredKeys: requiredEnvVars.filter((key) => !templateKeySet.has(key)),
        optionalKeys: optionalNames.filter((key) => !templateKeySet.has(key)),
        templateKeys,
        initial: {},
      })
    }
    seededByClick.current = false
    lastView.current = envVarsView
  }, [envVarsView])

  const handleGoToEdit = (template: EnvVarTemplate | null) => {
    seededByClick.current = true
    onSelectEnvVarTemplate(template)
    // Surface all of the template's variables as editable default rows (blank =
    // use the template value, type to override; merged server-side). Required keys
    // the template does NOT cover are seeded as required rows the user must fill.
    const templateKeys = template?.variableKeys ?? []
    const templateKeySet = new Set(templateKeys)
    const requiredToFill = requiredEnvVars.filter((key) => !templateKeySet.has(key))
    const optionalToOffer = optionalNames.filter((key) => !templateKeySet.has(key))
    editor.reset({ requiredKeys: requiredToFill, optionalKeys: optionalToOffer, templateKeys, initial: {} })
    onEnvVarsViewChange('edit')
  }

  return (
    <div>
      {envVarsView === 'select' && (
        <EnvVarNeedsSummary required={requiredEnvVars} optional={optionalNames} isDark={isDark} />
      )}

      <AnimatePresence mode="wait">
        {envVarsView === 'select' ? (
          <motion.div
            key="env-select"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {isLoadingEnvVars ? (
              <div className={`h-32 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Loading templates...
                </div>
              </div>
            ) : (
              <div className={`${WIZARD_CARD_GRID} pr-2 pt-1 -mt-1`}>
                {/* Template cards */}
                {envVarTemplates.map((template, index) => {
                  const style = getEnvVarCardStyle(index)
                  const isSelected = selectedEnvVarTemplate?.id === template.id

                  return (
                    <motion.button
                      key={template.id}
                      type="button"
                      onClick={() => handleSelectTemplate(isSelected ? null : template)}
                      whileHover={{ y: -2 }}
                      className={`
                        relative p-4 rounded-xl text-left transition-all duration-200
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
                      {/* Selection checkmark */}
                      {isSelected && (
                        <div className="absolute top-3 right-3">
                          <svg className={`w-5 h-5 ${isDark ? 'text-primary-400' : 'text-neutral-900'}`} fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                        </div>
                      )}

                      {/* Icon */}
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 bg-gradient-to-br ${style.gradient}`}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={style.iconColor}>
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </div>

                      {/* Title */}
                      <h3 className={`text-sm font-semibold truncate mb-1 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                        {template.name}
                      </h3>

                      {/* Variables count */}
                      <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                        {template.variableKeys.length} variable{template.variableKeys.length !== 1 ? 's' : ''}
                      </div>

                      {/* Variables preview */}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {template.variableKeys.slice(0, 2).map(key => (
                          <span key={key} className={`
                            px-1.5 py-0.5 rounded text-xs font-mono truncate max-w-[80px]
                            ${isDark ? 'bg-zinc-600/50 text-zinc-300' : 'bg-neutral-100 text-neutral-600'}
                          `}>
                            {key}
                          </span>
                        ))}
                        {template.variableKeys.length > 2 && (
                          <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                            +{template.variableKeys.length - 2}
                          </span>
                        )}
                      </div>
                    </motion.button>
                  )
                })}

                {/* Enter Manually card - at the end */}
                <motion.button
                  type="button"
                  onClick={() => handleGoToEdit(null)}
                  whileHover={{ y: -2 }}
                  className={`
                    p-4 rounded-xl text-left transition-all duration-200
                    border-2 border-dashed hover:border-solid
                    ${isDark
                      ? 'border-zinc-600 hover:border-primary-500 bg-zinc-800/30 hover:bg-zinc-700/50'
                      : 'border-neutral-300 hover:border-neutral-900 bg-neutral-50/50 hover:bg-neutral-100'
                    }
                  `}
                >
                  {/* Icon */}
                  <div className={`
                    w-10 h-10 rounded-xl flex items-center justify-center mb-3
                    ${isDark ? 'bg-zinc-700' : 'bg-neutral-100'}
                  `}>
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className={isDark ? 'text-zinc-400' : 'text-neutral-500'}
                    >
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>

                  {/* Title */}
                  <h3 className={`text-sm font-semibold mb-1 ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
                    Enter Manually
                  </h3>

                  {/* Description */}
                  <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    Configure variables without a template
                  </p>
                </motion.button>
              </div>
            )}

            {/* Empty state - no templates */}
            {!isLoadingEnvVars && envVarTemplates.length === 0 && (
              <div className={`text-center py-4`}>
                <p className={`text-sm mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                  No saved templates. You can create templates in Settings.
                </p>
                <motion.button
                  type="button"
                  onClick={() => handleGoToEdit(null)}
                  whileTap={{ scale: 0.98 }}
                  className={`
                    inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
                    transition-all duration-200
                    ${isDark
                      ? 'bg-primary-500 text-white hover:bg-primary-400'
                      : 'bg-neutral-900 text-white hover:bg-neutral-800'
                    }
                  `}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Enter Variables Manually
                </motion.button>
              </div>
            )}
          </motion.div>
        ) : (
          /* Edit view - manual entry form */
          <motion.div
            key="env-edit"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
          >
            {/* Source indicator */}
            {selectedEnvVarTemplate && (
              <div className={`
                flex items-center gap-2 p-2 rounded-lg mb-4
                ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-100'}
              `}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-zinc-400' : 'text-neutral-500'}>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                  Prefilled from: <span className="font-medium">{selectedEnvVarTemplate.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onSelectEnvVarTemplate(null)
                    onEnvVarsViewChange('select')
                  }}
                  className={`ml-auto text-xs ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-neutral-400 hover:text-neutral-600'}`}
                >
                  Change
                </button>
              </div>
            )}

            <div className="pr-2">
              <EnvVarListEditor editor={editor} isDark={isDark} hints={envVarHints(optionalEnvVars)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
