import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useConfiguratorStore } from '../../store/configuratorStore'
import { apiClient } from '../../services/ApiClient'
import type {
  AgentConfiguration,
  AgentConfigurationPayload,
  PipelineSchema,
  RuntimeVariable,
  ExpertDefault,
} from '../../lib/api-types'
import { WIZARD_CARD_GRID } from './wizardLayout'

interface ConfigurationSelectionStepProps {
  agentTypeId: string
  pipelineSchema: PipelineSchema
  // Manifest-declared {{placeholder}} palette for this agent type (for the editor).
  runtimeVariables?: RuntimeVariable[] | null
  // Agent-declared default experts for the Expert Module.
  expertDefaults?: ExpertDefault[] | null
  // Agent capabilities — gate task_extraction (plans) vs assessment pool (experts).
  capabilities?: string[] | null
  selectedConfiguration: AgentConfiguration | null
  onSelectConfiguration: (config: AgentConfiguration | null) => void
}

// Gradient color palette for configuration cards
const getConfigCardStyle = (id: string) => {
  const gradients = [
    'from-indigo-500/20 to-blue-500/20',
    'from-teal-500/20 to-emerald-500/20',
    'from-orange-500/20 to-amber-500/20',
    'from-rose-500/20 to-pink-500/20',
    'from-violet-500/20 to-purple-500/20',
  ]
  const iconColors = [
    'text-indigo-500',
    'text-teal-500',
    'text-orange-500',
    'text-rose-500',
    'text-violet-500',
  ]
  // Derive a stable hash from the config id so color doesn't shift on reorder
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  const colorIndex = Math.abs(hash) % 5
  return { gradient: gradients[colorIndex], iconColor: iconColors[colorIndex] }
}

const countModifiedNodes = (config: AgentConfigurationPayload) => {
  return Object.keys(config.nodes || {}).filter(
    (k) => config.nodes?.[k] && Object.keys(config.nodes[k]).length > 0,
  ).length
}

// Pipeline config icon used across all cards
const ConfigIcon = ({ className }: { className?: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
    <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
  </svg>
)

export default function ConfigurationSelectionStep({
  agentTypeId,
  pipelineSchema,
  runtimeVariables,
  expertDefaults,
  capabilities,
  selectedConfiguration,
  onSelectConfiguration,
}: ConfigurationSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { openModal } = useConfiguratorStore()
  const [configurations, setConfigurations] = useState<AgentConfiguration[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIsLoading(true)
    apiClient
      .listAgentConfigurations(agentTypeId)
      .then(setConfigurations)
      .catch((err) => console.error('Failed to load configurations:', err))
      .finally(() => setIsLoading(false))
  }, [agentTypeId])

  const handleCreateNew = () => {
    openModal({
      pipelineSchema,
      runtimeVariables,
      expertDefaults,
      capabilities,
      onSave: async (name, description, configuration) => {
        try {
          const created = await apiClient.createAgentConfiguration({
            name,
            description,
            agentTypeId,
            configuration,
          })
          setConfigurations((prev) => [created, ...prev])
          onSelectConfiguration(created)
        } catch (err) {
          console.error('Failed to save configuration:', err)
        }
      },
    })
  }

  const handleEditExisting = (config: AgentConfiguration, e: React.MouseEvent) => {
    e.stopPropagation()
    openModal({
      pipelineSchema,
      runtimeVariables,
      expertDefaults,
      capabilities,
      initialConfiguration: config.configuration,
      initialName: config.name,
      initialDescription: config.description || '',
      editingConfig: config,
      saveLabel: 'Save Configuration',
      onSave: async (name, description, configuration) => {
        try {
          const updated = await apiClient.updateAgentConfiguration(config.id, {
            name,
            description,
            configuration,
          })
          setConfigurations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
          onSelectConfiguration(updated)
        } catch (err) {
          console.error('Failed to save configuration:', err)
        }
      },
    })
  }

  if (isLoading) {
    return (
      <div className={`h-48 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          Loading configurations...
        </div>
      </div>
    )
  }

  return (
    <div className={`${WIZARD_CARD_GRID} pr-2 pt-1 -mt-1`}>
      {/* Saved configuration cards */}
      {configurations.map((config, index) => {
        const style = getConfigCardStyle(config.id)
        const isSelected = selectedConfiguration?.id === config.id
        const isOutdated = config.compatibility === 'OUTDATED'
        const modifiedNodes = countModifiedNodes(config.configuration)
        const modifiedThresholds = Object.keys(config.configuration.thresholds || {}).length

        return (
          <motion.button
            key={config.id}
            type="button"
            // Outdated configs can't be deployed (the backend would 400); clicking
            // opens the editor so the user can review & re-save instead of selecting.
            onClick={(e) => (isOutdated ? handleEditExisting(config, e) : onSelectConfiguration(config))}
            whileHover={{ y: -2 }}
            title={isOutdated ? (config.compatibilityNote || 'Outdated — review and re-save to use') : undefined}
            className={`
              group/card relative p-4 rounded-xl text-left transition-all duration-200
              ${isOutdated ? 'opacity-60' : ''}
              ${isSelected
                ? isDark
                  ? 'bg-primary-500/20 border-2 border-primary-500 shadow-lg shadow-primary-500/20'
                  : 'bg-neutral-100 border-2 border-neutral-900 shadow-lg shadow-neutral-900/10'
                : isOutdated
                  ? isDark
                    ? 'bg-zinc-800/40 border border-amber-500/30'
                    : 'bg-amber-50/40 border border-amber-300/50'
                : isDark
                  ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500 hover:bg-zinc-700/80'
                  : 'bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md'
              }
            `}
          >
            {/* Top-right actions */}
            <div className="absolute top-3 right-3 flex items-center gap-1.5">
              {/* Edit button on hover */}
              <motion.div
                onClick={(e) => handleEditExisting(config, e)}
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
                title="Edit configuration"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </motion.div>
              {/* Selection checkmark */}
              {isSelected && (
                <svg className={`w-5 h-5 ${isDark ? 'text-primary-400' : 'text-neutral-900'}`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              )}
            </div>

            {/* Icon */}
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 bg-gradient-to-br ${style.gradient}`}>
              <ConfigIcon className={style.iconColor} />
            </div>

            {/* Title */}
            <h3 className={`text-sm font-semibold truncate mb-1 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
              {config.name}
            </h3>

            {/* Description */}
            {config.description && (
              <p className={`text-xs line-clamp-2 mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                {config.description}
              </p>
            )}

            {/* Stats */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {isOutdated && (
                <span className={`
                  inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium
                  ${isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'}
                `}>
                  Outdated — review & re-save
                </span>
              )}
              {modifiedNodes === 0 && modifiedThresholds === 0 ? (
                <span className={`
                  inline-flex items-center px-2 py-0.5 rounded-full text-xs
                  ${isDark ? 'bg-zinc-600/50 text-zinc-300' : 'bg-neutral-100 text-neutral-600'}
                `}>
                  Default settings
                </span>
              ) : (
                <>
                  {modifiedNodes > 0 && (
                    <span className={`
                      inline-flex items-center px-2 py-0.5 rounded-full text-xs
                      ${isDark ? 'bg-zinc-600/50 text-zinc-300' : 'bg-neutral-100 text-neutral-600'}
                    `}>
                      {modifiedNodes} node{modifiedNodes !== 1 ? 's' : ''} customized
                    </span>
                  )}
                  {modifiedThresholds > 0 && (
                    <span className={`
                      inline-flex items-center px-2 py-0.5 rounded-full text-xs
                      ${isDark ? 'bg-zinc-600/50 text-zinc-300' : 'bg-neutral-100 text-neutral-600'}
                    `}>
                      {modifiedThresholds} threshold{modifiedThresholds !== 1 ? 's' : ''}
                    </span>
                  )}
                </>
              )}
            </div>
          </motion.button>
        )
      })}

      {/* Create & Save card */}
      <motion.button
        type="button"
        onClick={handleCreateNew}
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
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* Title */}
        <h3 className={`text-sm font-semibold mb-1 ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
          Create & Save
        </h3>

        {/* Description */}
        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
          Save a reusable configuration
        </p>
      </motion.button>
    </div>
  )
}
