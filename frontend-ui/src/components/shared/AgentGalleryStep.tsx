import { useState, useEffect } from 'react'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import { AgentUploadCard } from '../agents'
import AgentPickerSections from './AgentPickerSections'
import type { AgentType, CustomAgentType, AgentUploadResponse } from '../../lib/api-types'

interface AgentGalleryStepProps {
  selectedAgentType: AgentType | null
  onSelectAgentType: (type: AgentType) => void
  showUpload?: boolean
  onUploadComplete?: (result: AgentUploadResponse) => void
  /**
   * The project the agent is for: lists the uploads shared with it. Null for a
   * project not created yet, where only your own uploads can be picked.
   */
  projectId?: string | null
}

export default function AgentGalleryStep({
  selectedAgentType,
  onSelectAgentType,
  showUpload = true,
  projectId,
  onUploadComplete,
}: AgentGalleryStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [isLoadingTypes, setIsLoadingTypes] = useState(false)
  const [uploadRefreshTrigger, setUploadRefreshTrigger] = useState(0)
  const [showUploadView, setShowUploadView] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Fetch agent types on mount
  useEffect(() => {
    setIsLoadingTypes(true)
    apiClient.getAgentTypes(projectId ?? undefined)
      .then((types) => {
        setAgentTypes(projectId === null ? types.filter((t) => !t.sharedWithYou) : types)
      })
      .catch((err) => {
        console.error('Failed to fetch agent types:', err)
        setAgentTypes([])
        setLoadError('Could not load the agents. Close this dialog and try again.')
      })
      .finally(() => setIsLoadingTypes(false))
  }, [projectId])

  const handleSelectCustomAgent = (agent: CustomAgentType) => {
    onSelectAgentType(agent as AgentType)
  }

  const handleUploadComplete = (result: AgentUploadResponse) => {
    setUploadRefreshTrigger(prev => prev + 1)
    setShowUploadView(false)
    onUploadComplete?.(result)
  }

  // Upload view
  if (showUploadView) {
    return (
      <div>
        <AgentUploadCard
          onUploadComplete={handleUploadComplete}
          onError={(err) => setUploadError(err)}
        />
        {uploadError && (
          <div className={`mt-4 p-3 rounded-lg text-xs font-light ${isDark
            ? 'bg-red-500/10 border border-red-500/20 text-red-400'
            : 'bg-red-50/80 border border-red-200/60 text-red-600'
          }`}>
            {uploadError}
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowUploadView(false)}
          className={`
            w-full mt-4 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
            transition-all duration-200
            ${isDark
              ? 'bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10'
              : 'bg-neutral-100/80 text-neutral-600 hover:bg-neutral-200/80'
            }
          `}
        >
          <span className="flex items-center justify-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to Gallery
          </span>
        </button>
      </div>
    )
  }

  return (
    <AgentPickerSections
      agentTypes={agentTypes}
      isLoading={isLoadingTypes}
      loadError={loadError}
      selectedId={selectedAgentType?.id ?? null}
      onSelectType={onSelectAgentType}
      onSelectCustom={handleSelectCustomAgent}
      refreshTrigger={uploadRefreshTrigger}
      onUpload={showUpload ? () => setShowUploadView(true) : undefined}
      isDark={isDark}
    />
  )
}
