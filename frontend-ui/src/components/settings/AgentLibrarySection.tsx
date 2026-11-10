import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { apiClient } from '../../services/ApiClient'
import type { AgentType, CustomAgentType } from '../../lib/api-types'
import AgentTypeCard from './AgentTypeCard'
import AgentDetailModal from './AgentDetailModal'
import ConfirmDialog from '../modals/ConfirmDialog'
import ShareAgentDialog from '../modals/ShareAgentDialog'
import { apiErrorMessage } from '../../lib/apiErrorMessage'

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08
    }
  }
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94] as const
    }
  }
}

export default function AgentLibrarySection() {
  const { resolvedTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const isDark = resolvedTheme === 'dark'
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [allAgents, setAllAgents] = useState<AgentType[]>([])
  const [customAgents, setCustomAgents] = useState<CustomAgentType[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // Modal states
  const [selectedAgent, setSelectedAgent] = useState<AgentType | CustomAgentType | null>(null)
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [agentToDelete, setAgentToDelete] = useState<AgentType | null>(null)
  const [agentToShare, setAgentToShare] = useState<AgentType | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)

  const loadAgents = async () => {
    try {
      setIsLoading(true)
      setError(null)

      const [builtIn, custom] = await Promise.all([
        apiClient.getAgentTypes(),
        apiClient.getMyAgents().catch(() => [] as CustomAgentType[]),
      ])

      setAllAgents(builtIn)
      setCustomAgents(custom)
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load agents'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadAgents()
  }, [])

  // Two sections: custom (uploaded) agents first, then the built-in ones. The
  // custom list is the user's own uploads, whatever their state, plus the ones
  // others shared with a project the user is in.
  const matches = (a: AgentType | CustomAgentType) => {
    const query = searchQuery.trim().toLowerCase()
    return !query ||
      a.name.toLowerCase().includes(query) ||
      !!a.description?.toLowerCase().includes(query) ||
      !!a.capabilities?.some(c => c.toLowerCase().includes(query)) ||
      !!a.tags?.some(t => t.toLowerCase().includes(query))
  }
  const ownIds = new Set(customAgents.map(a => a.id))
  const allCustom: (AgentType | CustomAgentType)[] = [
    ...customAgents,
    ...allAgents.filter(a => !a.isBuiltIn && !ownIds.has(a.id)),
  ]
  const allBuiltIn = allAgents.filter(a => a.isBuiltIn)
  const sections = [
    { id: 'custom', title: 'Custom', total: allCustom.length, agents: allCustom.filter(matches) },
    { id: 'built-in', title: 'Built-in', total: allBuiltIn.length, agents: allBuiltIn.filter(matches) },
  ]
  const filteredAgents = sections.flatMap(sec => sec.agents)

  const handleView = (agent: AgentType | CustomAgentType) => {
    setSelectedAgent(agent)
    setIsDetailModalOpen(true)
  }

  const handleDelete = (agent: AgentType) => {
    setAgentToDelete(agent)
    setDeleteConfirmOpen(true)
  }

  const confirmDeleteAgent = async () => {
    if (!agentToDelete) return
    try {
      const { stoppedAgents } = await apiClient.deleteCustomAgent(agentToDelete.id)
      setCustomAgents(prev => prev.filter(a => a.id !== agentToDelete.id))
      setAllAgents(prev => prev.filter(a => a.id !== agentToDelete.id))
      const stopped = stoppedAgents ? ` and ${stoppedAgents} agent${stoppedAgents === 1 ? '' : 's'} stopped` : ''
      addToast({ message: `"${agentToDelete.name}" deleted${stopped}`, type: 'success' })
    } catch (err) {
      addToast({
        message: apiErrorMessage(err, 'Failed to delete agent'),
        type: 'error',
      })
    } finally {
      setDeleteConfirmOpen(false)
      setAgentToDelete(null)
    }
  }

  const handleBuild = async (agent: AgentType | CustomAgentType) => {
    try {
      await apiClient.triggerAgentBuild(agent.id)
      addToast({ message: `Rebuild started for "${agent.name}"`, type: 'success' })
      // Refresh to get updated build status
      loadAgents()
    } catch (err) {
      addToast({
        message: apiErrorMessage(err, 'Failed to start build'),
        type: 'error',
      })
    }
  }

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.name.endsWith('.zip')) {
      addToast({ message: 'Please upload a .zip file', type: 'error' })
      return
    }

    // Validate file size (max 100MB)
    const maxSize = 100 * 1024 * 1024
    if (file.size > maxSize) {
      addToast({ message: 'File size must be less than 100MB', type: 'error' })
      return
    }

    try {
      setIsUploading(true)
      setUploadProgress('Uploading agent package...')

      const response = await apiClient.uploadAgentPackage(file)

      if (response.warnings?.length > 0) {
        response.warnings.forEach(warning => {
          addToast({ message: warning, type: 'info' })
        })
      }

      addToast({
        message: response.replacedVersion
          ? `"${response.name}" ${response.version} replaces ${response.replacedVersion} and is building now. Its paused agents can't wake until the build finishes`
          : `"${response.name}" uploaded — building now`,
        type: 'success',
      })

      // Refresh agent list
      await loadAgents()

    } catch (err: any) {
      const message = apiErrorMessage(err, 'Failed to upload agent')
      addToast({ message, type: 'error' })
    } finally {
      setIsUploading(false)
      setUploadProgress(null)
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <>
      <motion.div
        className="max-w-5xl"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Header */}
        <motion.div
          className="flex items-start justify-between mb-8"
          variants={itemVariants}
        >
          <div>
            <h2 className={`text-heading-lg font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              Agent Library
            </h2>
            <p className={`text-body-sm mt-1.5 max-w-lg ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
              Your uploads, agents shared with your projects, and the built-in agents
            </p>
          </div>

          <motion.button
            onClick={handleUploadClick}
            disabled={isUploading}
            className="btn-primary flex items-center gap-2 shadow-lg shadow-primary/20 disabled:opacity-60"
            whileHover={{ scale: 1.02, y: -1 }}
            whileTap={{ scale: 0.98 }}
          >
            {isUploading ? (
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
                Uploading...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Upload Agent
              </>
            )}
          </motion.button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleFileChange}
            className="hidden"
          />
        </motion.div>

        {/* Filter Bar */}
        <motion.div
          className={`flex items-center gap-4 mb-6 p-4 rounded-2xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`}
          variants={itemVariants}
        >
          {/* Search */}
          <div className="flex-1 relative">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`
                w-full pl-10 pr-4 py-2.5 rounded-xl text-sm
                focus:outline-none transition-all duration-200
                ${isDark
                  ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500'
                  : 'bg-neutral-50 border border-neutral-200 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400'
                }
              `}
            />
          </div>
        </motion.div>

        {/* Upload Progress */}
        <AnimatePresence>
          {uploadProgress && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`mb-6 p-4 rounded-2xl flex items-center gap-3 ${isDark
                ? 'bg-primary/10 border border-primary/20'
                : 'bg-primary/5 border border-primary/20'
              }`}
            >
              <motion.svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-primary"
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              >
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </motion.svg>
              <span className={`text-sm font-medium ${isDark ? 'text-primary-300' : 'text-primary-700'}`}>
                {uploadProgress}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Loading State */}
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
                className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${isDark ? 'bg-surface-dark-secondary' : 'bg-surface-secondary'}`}
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <circle cx="15.5" cy="8.5" r="1.5" />
                  <path d="M9 15h6" />
                </svg>
              </motion.div>
              <p className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                Loading agents...
              </p>
            </motion.div>
          )}

          {/* Error State */}
          {error && !isLoading && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className={`p-6 rounded-2xl flex items-start gap-4 ${isDark
                ? 'bg-red-500/10 border border-red-500/20'
                : 'bg-red-50 border border-red-200'
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-red-400' : 'text-red-600'}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div>
                <h4 className={`text-body font-medium mb-1 ${isDark ? 'text-red-400' : 'text-red-700'}`}>
                  Failed to load agents
                </h4>
                <p className={`text-body-sm ${isDark ? 'text-red-400/80' : 'text-red-600'}`}>
                  {error}
                </p>
              </div>
            </motion.div>
          )}

          {/* Empty State */}
          {!isLoading && !error && filteredAgents.length === 0 && (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`text-center py-16 px-8 rounded-3xl ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'}`}
            >
              <motion.div
                className={`w-20 h-20 rounded-2xl mx-auto mb-6 flex items-center justify-center border ${isDark
                  ? 'bg-gradient-to-br from-violet-500/30 to-purple-500/10 border-violet-500/20'
                  : 'bg-gradient-to-br from-violet-500/20 to-purple-500/5 border-violet-500/20'
                }`}
                whileHover={{ scale: 1.05, rotate: 5 }}
                transition={{ type: 'spring', stiffness: 300, damping: 15 }}
              >
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-violet-500">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <circle cx="15.5" cy="8.5" r="1.5" />
                  <path d="M9 15h6" />
                </svg>
              </motion.div>
              {searchQuery ? (
                <>
                  <h3 className={`text-heading font-semibold mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                    No agents found
                  </h3>
                  <p className={`text-body mb-8 max-w-sm mx-auto ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                    No agents match "{searchQuery}". Try a different search term.
                  </p>
                  <motion.button
                    onClick={() => setSearchQuery('')}
                    className="btn-secondary inline-flex items-center gap-2"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    Clear Search
                  </motion.button>
                </>
              ) : allCustom.length === 0 ? (
                <>
                  <h3 className={`text-heading font-semibold mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                    No custom agents yet
                  </h3>
                  <p className={`text-body mb-8 max-w-sm mx-auto ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                    Upload your own agent packages to extend your AI capabilities with custom functionality
                  </p>
                  <motion.button
                    onClick={handleUploadClick}
                    className="btn-primary inline-flex items-center gap-2"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Upload Your First Agent
                  </motion.button>
                </>
              ) : (
                <>
                  <h3 className={`text-heading font-semibold mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                    No agents available
                  </h3>
                  <p className={`text-body mb-8 max-w-sm mx-auto ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                    No agents are currently available. Upload a custom agent to get started.
                  </p>
                </>
              )}
            </motion.div>
          )}

          {/* Agent sections: custom first, then built-in */}
          {!isLoading && !error && filteredAgents.length > 0 && (
            <motion.div key="agents" className="space-y-8" variants={containerVariants} initial="hidden" animate="visible">
              {sections.filter(sec => sec.agents.length > 0 || (!searchQuery.trim() && sec.id === 'custom')).map((sec) => (
                <section key={sec.id}>
                  <h3 className={`flex items-center gap-2 text-xs font-medium tracking-wider uppercase mb-3 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    {sec.title}
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold normal-case ${isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-neutral-200 text-neutral-500'}`}>
                      {searchQuery.trim() ? `${sec.agents.length} of ${sec.total}` : sec.total}
                    </span>
                  </h3>
                  {sec.agents.length === 0 ? (
                    <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                      No custom agents yet. Upload an agent package to add one.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      <AnimatePresence mode="popLayout">
                        {sec.agents.map((agent, index) => (
                          <AgentTypeCard
                            key={agent.id}
                            agent={agent}
                            index={index}
                            onView={() => handleView(agent)}
                            // Only the uploader manages an upload; others can view and deploy it.
                            onDelete={ownIds.has(agent.id) ? () => handleDelete(agent) : undefined}
                            onBuild={ownIds.has(agent.id) ? () => handleBuild(agent) : undefined}
                            onShare={ownIds.has(agent.id) ? () => setAgentToShare(agent) : undefined}
                            onBuildSettled={loadAgents}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                </section>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Agent Detail Modal */}
      <AgentDetailModal
        isOpen={isDetailModalOpen}
        agent={selectedAgent}
        onClose={() => {
          setIsDetailModalOpen(false)
          setSelectedAgent(null)
        }}
        onBuildTriggered={loadAgents}
      />

      <ShareAgentDialog
        agent={agentToShare}
        onClose={() => setAgentToShare(null)}
        onSaved={(projectIds) => {
          const shared = agentToShare
          if (!shared) return
          setCustomAgents(prev => prev.map(a => (a.id === shared.id ? { ...a, sharedProjectIds: projectIds } : a)))
          addToast({
            message: projectIds.length
              ? `"${shared.name}" is shared with ${projectIds.length} project${projectIds.length === 1 ? '' : 's'}`
              : `"${shared.name}" is no longer shared`,
            type: 'success',
          })
        }}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title="Delete Custom Agent"
        message={`Delete "${agentToDelete?.name}"? Your running agents of it are stopped, and the agent and its builds are removed. If it still runs in someone else's session, it can't be deleted yet. This cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        confirmVariant="danger"
        onConfirm={confirmDeleteAgent}
        onCancel={() => { setDeleteConfirmOpen(false); setAgentToDelete(null) }}
      />
    </>
  )
}
