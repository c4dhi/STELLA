import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { apiClient } from '../../services/ApiClient'
import type { AgentType, CustomAgentType, AgentBuildStatus } from '../../lib/api-types'
import { defaultLabel, settingsFromSchema } from '../../lib/agentSettings'

interface AgentDetailModalProps {
  isOpen: boolean
  agent: AgentType | CustomAgentType | null
  onClose: () => void
  onBuildTriggered?: () => void
}

export default function AgentDetailModal({
  isOpen,
  agent,
  onClose,
  onBuildTriggered,
}: AgentDetailModalProps) {
  const navigate = useNavigate()
  const { resolvedTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const isDark = resolvedTheme === 'dark'

  const [activeTab, setActiveTab] = useState<'overview' | 'config' | 'build'>('overview')
  const [buildStatus, setBuildStatus] = useState<AgentBuildStatus | null>(null)
  const [buildLogs, setBuildLogs] = useState<string[]>([])
  const [isBuilding, setIsBuilding] = useState(false)

  const isCustomAgent = agent && !agent.isBuiltIn
  const customAgent = agent as CustomAgentType

  // Load build status for custom agents
  useEffect(() => {
    if (isOpen && agent && isCustomAgent) {
      loadBuildStatus()
    }
  }, [isOpen, agent?.id])

  const loadBuildStatus = async () => {
    if (!agent) return
    try {
      const status = await apiClient.getAgentBuildStatus(agent.id)
      setBuildStatus(status)
    } catch (err) {
      console.error('Failed to load build status:', err)
    }
  }

  // Subscribe to build logs when building
  useEffect(() => {
    if (!isBuilding || !agent) return

    const cleanup = apiClient.subscribeToBuildLogs(
      agent.id,
      (data) => {
        if (data.output) {
          setBuildLogs((prev) => [...prev, data.output!])
        }
        if (data.status === 'success' || data.status === 'failed') {
          setIsBuilding(false)
          loadBuildStatus()
          if (data.status === 'success') {
            addToast({ message: 'Agent built successfully', type: 'success' })
            onBuildTriggered?.()
          } else {
            addToast({ message: data.errorMessage || 'Build failed', type: 'error' })
          }
        }
      },
      (error) => {
        console.error('Build logs error:', error)
        setIsBuilding(false)
      }
    )

    return cleanup
  }, [isBuilding, agent?.id])

  const handleTriggerBuild = async () => {
    if (!agent) return
    try {
      setIsBuilding(true)
      setBuildLogs([])
      await apiClient.triggerAgentBuild(agent.id)
      addToast({ message: 'Build started', type: 'success' })
    } catch (err) {
      setIsBuilding(false)
      addToast({
        message: err instanceof Error ? err.message : 'Failed to start build',
        type: 'error',
      })
    }
  }

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setActiveTab('overview')
      setBuildStatus(null)
      setBuildLogs([])
      setIsBuilding(false)
    }
  }, [isOpen])

  if (!agent) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className={`
              backdrop-blur-xl rounded-[20px] w-full max-w-2xl overflow-hidden
              ${isDark
                ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
                : 'bg-white border border-neutral-200 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
              }
            `}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`px-6 pt-6 pb-4 border-b ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
              <div className="relative">
                <button
                  onClick={onClose}
                  className={`
                    absolute -top-1 -right-1 p-2 rounded-lg transition-all duration-200
                    ${isDark
                      ? 'text-zinc-400 hover:text-zinc-200 hover:bg-white/10'
                      : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                    }
                  `}
                  title="Close"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>

                <div className="flex items-start gap-4">
                  {/* Agent Icon */}
                  <div className={`
                    w-14 h-14 rounded-xl flex items-center justify-center
                    bg-gradient-to-br from-violet-500/20 to-purple-500/20
                  `}>
                    {agent.icon ? (
                      <span className="text-3xl">{agent.icon}</span>
                    ) : (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-violet-500">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <circle cx="15.5" cy="8.5" r="1.5" />
                        <path d="M9 15h6" />
                      </svg>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h2 className={`text-xl font-semibold ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                        {agent.name}
                      </h2>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                        agent.isBuiltIn
                          ? isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-700'
                          : isDark ? 'bg-purple-500/20 text-purple-400' : 'bg-purple-100 text-purple-700'
                      }`}>
                        {agent.isBuiltIn ? 'Built-in' : 'Custom'}
                      </span>
                    </div>
                    <p className={`text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                      {agent.description || 'No description available'}
                    </p>
                    <div className={`flex items-center gap-3 mt-2 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                      <span>v{agent.version}</span>
                      {agent.authorName && (
                        <>
                          <span>by {agent.authorName}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mt-5">
                {(['overview', 'config', ...(isCustomAgent ? ['build'] : [])] as ('overview' | 'config' | 'build')[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`
                      px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
                      ${activeTab === tab
                        ? isDark
                          ? 'bg-zinc-700 text-zinc-100'
                          : 'bg-neutral-100 text-neutral-900'
                        : isDark
                          ? 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
                          : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-50'
                      }
                    `}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Content */}
            <div className="p-6 max-h-[60vh] overflow-y-auto">
              <AnimatePresence mode="wait">
                {activeTab === 'overview' && (
                  <motion.div
                    key="overview"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    {/* Capabilities */}
                    <div>
                      <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        Capabilities
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {agent.capabilities?.map((cap) => (
                          <div
                            key={cap}
                            className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl ${isDark
                              ? 'bg-zinc-700/50 text-zinc-300'
                              : 'bg-neutral-100 text-neutral-700'
                            }`}
                          >
                            <CapabilityIcon capability={cap} />
                            <span className="text-sm font-medium capitalize">{cap}</span>
                          </div>
                        ))}
                        {(!agent.capabilities || agent.capabilities.length === 0) && (
                          <p className={`text-sm italic ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                            No capabilities defined
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Tags */}
                    {agent.tags && agent.tags.length > 0 && (
                      <div>
                        <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                          Tags
                        </h3>
                        <div className="flex flex-wrap gap-2">
                          {agent.tags.map((tag) => (
                            <span
                              key={tag}
                              className={`px-3 py-1.5 rounded-lg text-sm ${isDark
                                ? 'bg-zinc-700/50 text-zinc-400'
                                : 'bg-neutral-100 text-neutral-500'
                              }`}
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Resource Requirements */}
                    {agent.resourceGpu !== undefined && (
                      <div>
                        <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                          Resources
                        </h3>
                        <div className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl ${isDark
                          ? 'bg-zinc-700/50 text-zinc-300'
                          : 'bg-neutral-100 text-neutral-700'
                        }`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                            <rect x="9" y="9" width="6" height="6" />
                            <line x1="9" y1="1" x2="9" y2="4" />
                            <line x1="15" y1="1" x2="15" y2="4" />
                            <line x1="9" y1="20" x2="9" y2="23" />
                            <line x1="15" y1="20" x2="15" y2="23" />
                            <line x1="20" y1="9" x2="23" y2="9" />
                            <line x1="20" y1="14" x2="23" y2="14" />
                            <line x1="1" y1="9" x2="4" y2="9" />
                            <line x1="1" y1="14" x2="4" y2="14" />
                          </svg>
                          <span className="text-sm font-medium">
                            {agent.resourceGpu ? 'GPU Required' : 'CPU Only'}
                          </span>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {activeTab === 'config' && (
                  <motion.div
                    key="config"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    {/* Config Schema */}
                    {agent.configSchema ? (
                      <ConfigSchemaViewer
                        schema={agent.configSchema}
                        pipelineSchema={'pipelineSchema' in agent ? agent.pipelineSchema : undefined}
                        isDark={isDark}
                        onNavigateToConfigs={() => {
                          onClose()
                          navigate('/settings/agent-configs')
                        }}
                      />
                    ) : (
                      <div className={`text-center py-12 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mx-auto mb-4 opacity-50">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <p className="text-sm">No configuration schema defined</p>
                        <p className="text-xs mt-1 opacity-75">This agent uses default settings</p>
                      </div>
                    )}

                    {/* Default Config */}
                    {agent.defaultConfig && Object.keys(agent.defaultConfig).length > 0 && (
                      <div>
                        <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                          Default Configuration
                        </h3>
                        <pre className={`p-4 rounded-xl text-xs overflow-x-auto ${isDark
                          ? 'bg-zinc-900 text-zinc-300'
                          : 'bg-neutral-50 text-neutral-700'
                        }`}>
                          {JSON.stringify(agent.defaultConfig, null, 2)}
                        </pre>
                      </div>
                    )}
                  </motion.div>
                )}

                {activeTab === 'build' && isCustomAgent && (
                  <motion.div
                    key="build"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-6"
                  >
                    {/* Build Status */}
                    <div>
                      <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        Build Status
                      </h3>
                      {buildStatus ? (
                        <div className={`p-4 rounded-xl ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}`}>
                          <div className="flex items-center justify-between mb-3">
                            <BuildStatusBadge status={buildStatus.status} isDark={isDark} />
                            <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                              {new Date(buildStatus.startedAt).toLocaleString()}
                            </span>
                          </div>
                          {buildStatus.imageName && (
                            <p className={`text-xs font-mono ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                              Image: {buildStatus.imageName}
                            </p>
                          )}
                          {buildStatus.errorMessage && (
                            <p className={`text-xs mt-2 ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                              Error: {buildStatus.errorMessage}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                          No build history
                        </p>
                      )}
                    </div>

                    {/* Build Logs */}
                    {buildLogs.length > 0 && (
                      <div>
                        <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                          Build Logs
                        </h3>
                        <pre className={`p-4 rounded-xl text-xs max-h-48 overflow-y-auto font-mono ${isDark
                          ? 'bg-zinc-900 text-zinc-400'
                          : 'bg-neutral-900 text-neutral-300'
                        }`}>
                          {buildLogs.join('\n')}
                        </pre>
                      </div>
                    )}

                    {/* Build Button */}
                    <button
                      onClick={handleTriggerBuild}
                      disabled={isBuilding}
                      className={`
                        w-full py-3 px-4 rounded-xl text-sm font-medium flex items-center justify-center gap-2
                        transition-all duration-200 disabled:opacity-60
                        ${isDark
                          ? 'bg-primary-500 text-white hover:bg-primary-400'
                          : 'bg-neutral-900 text-white hover:bg-neutral-800'
                        }
                      `}
                    >
                      {isBuilding ? (
                        <>
                          <motion.svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                          >
                            <path d="M21 12a9 9 0 11-6.219-8.56" />
                          </motion.svg>
                          Building...
                        </>
                      ) : (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                          </svg>
                          Trigger Build
                        </>
                      )}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className={`px-6 py-4 border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
              <button
                onClick={onClose}
                className={`
                  w-full py-2.5 px-4 rounded-xl text-sm font-medium
                  transition-all duration-200
                  ${isDark
                    ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  }
                `}
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function CapabilityIcon({ capability }: { capability: string }) {
  const iconMap: Record<string, React.ReactNode> = {
    voice: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
      </svg>
    ),
    text: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    plans: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
    experts: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  }

  return iconMap[capability] || (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
    </svg>
  )
}

function BuildStatusBadge({ status, isDark }: { status: string; isDark: boolean }) {
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    pending: {
      bg: isDark ? 'bg-yellow-500/20' : 'bg-yellow-100',
      text: isDark ? 'text-yellow-400' : 'text-yellow-700',
      label: 'Pending',
    },
    building: {
      bg: isDark ? 'bg-blue-500/20' : 'bg-blue-100',
      text: isDark ? 'text-blue-400' : 'text-blue-700',
      label: 'Building',
    },
    success: {
      bg: isDark ? 'bg-green-500/20' : 'bg-green-100',
      text: isDark ? 'text-green-400' : 'text-green-700',
      label: 'Success',
    },
    failed: {
      bg: isDark ? 'bg-red-500/20' : 'bg-red-100',
      text: isDark ? 'text-red-400' : 'text-red-700',
      label: 'Failed',
    },
  }

  const config = statusConfig[status] || statusConfig.pending

  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  )
}

function ConfigSchemaViewer({ schema, pipelineSchema, isDark, onNavigateToConfigs }: { schema: Record<string, unknown>; pipelineSchema?: import('../../lib/api-types').PipelineSchema | null; isDark: boolean; onNavigateToConfigs?: () => void }) {
  const properties = (schema.properties as Record<string, any>) || {}
  const requiredEnvVars = (schema['x-stella-env-vars'] as string[]) || []
  const optionalEnvVars = settingsFromSchema(schema).filter((s) => !s.required)
  const supportsConfigurator = schema['x-stella-supports-configurator'] === true

  return (
    <div className="space-y-4">
      {/* Pipeline Configurator notice for agents with pipelineSchema */}
      {supportsConfigurator && pipelineSchema ? (
        <div>
          <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
            Pipeline Configuration
          </h3>
          <button
            onClick={onNavigateToConfigs}
            className={`w-full p-4 rounded-xl text-left transition-all duration-200 group ${isDark
              ? 'bg-zinc-700/50 hover:bg-zinc-700/80 hover:border-zinc-500'
              : 'bg-neutral-50 hover:bg-neutral-100 hover:border-neutral-300'
            } border ${isDark ? 'border-zinc-700/50' : 'border-transparent'}`}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'bg-primary-500/10' : 'bg-primary-50'}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isDark ? 'text-primary-400' : 'text-primary-600'}>
                  <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
              </div>
              <div className="flex-1">
                <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`}>
                  This agent uses the Pipeline Configurator
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                  Create and manage configurations in Agent Configs
                </p>
              </div>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className={`transition-transform duration-200 group-hover:translate-x-0.5 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
            {/* Pipeline nodes summary */}
            <div className="flex flex-wrap gap-2 mt-3">
              {pipelineSchema.nodes.map((node) => (
                <span
                  key={node.id}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${isDark
                    ? 'bg-zinc-600/50 text-zinc-300'
                    : 'bg-neutral-100 text-neutral-600'
                  }`}
                >
                  {node.icon && <span>{node.icon}</span>}
                  {node.label}
                  <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                    {node.slots.length} slot{node.slots.length !== 1 ? 's' : ''}
                  </span>
                </span>
              ))}
            </div>
            {pipelineSchema.thresholds.length > 0 && (
              <p className={`text-xs mt-2 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                + {pipelineSchema.thresholds.length} global threshold{pipelineSchema.thresholds.length !== 1 ? 's' : ''}
              </p>
            )}
          </button>
        </div>
      ) : Object.keys(properties).length > 0 ? (
        /* Fallback: Raw config properties for agents without pipeline configurator */
        <div>
          <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
            Configuration Options
          </h3>
          <div className="space-y-3">
            {Object.entries(properties).map(([key, prop]: [string, any]) => (
              <div
                key={key}
                className={`p-4 rounded-xl ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`}>
                      {key}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase ${isDark
                      ? 'bg-zinc-600 text-zinc-300'
                      : 'bg-neutral-200 text-neutral-600'
                    }`}>
                      {prop.type || 'any'}
                    </span>
                    {prop['x-stella-requires-plan'] && (
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase ${isDark
                        ? 'bg-purple-500/20 text-purple-400'
                        : 'bg-purple-100 text-purple-700'
                      }`}>
                        Plan
                      </span>
                    )}
                  </div>
                </div>
                {prop.description && (
                  <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    {prop.description}
                  </p>
                )}
                {prop.properties && (
                  <div className={`mt-3 pl-4 border-l-2 ${isDark ? 'border-zinc-600' : 'border-neutral-200'}`}>
                    {Object.entries(prop.properties).map(([subKey, subProp]: [string, any]) => (
                      <div key={subKey} className="py-1">
                        <span className={`font-mono text-xs ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
                          {subKey}
                        </span>
                        {subProp.default !== undefined && (
                          <span className={`ml-2 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                            default: {JSON.stringify(subProp.default)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Required Environment Variables */}
      {requiredEnvVars.length > 0 && (
        <div>
          <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
            Required Environment Variables
          </h3>
          <div className="flex flex-wrap gap-2">
            {requiredEnvVars.map((envVar) => (
              <span
                key={envVar}
                className={`px-3 py-1.5 rounded-lg font-mono text-sm ${isDark
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  : 'bg-amber-50 text-amber-700 border border-amber-200'
                }`}
              >
                {envVar}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Optional Environment Variables */}
      {optionalEnvVars.length > 0 && (
        <div>
          <h3 className={`text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
            Optional Environment Variables
          </h3>
          <div className="space-y-2">
            {optionalEnvVars.map((envVar) => (
              <div
                key={envVar.name}
                className={`px-3 py-2 rounded-lg ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {envVar.label && (
                    <span className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`}>{envVar.label}</span>
                  )}
                  <span className={`font-mono ${envVar.label ? 'text-xs' : 'text-sm font-medium'} ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                    {envVar.name}
                  </span>
                  <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                    {[envVar.type ?? 'string', envVar.group, envVar.advanced && 'advanced'].filter(Boolean).join(' · ')}
                    {' · default: '}{defaultLabel(envVar)}
                  </span>
                </div>
                {envVar.description && (
                  <p className={`text-xs mt-1 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    {envVar.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
