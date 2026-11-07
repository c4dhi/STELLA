import { useState, useEffect } from 'react'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import AgentPickerSections from './AgentPickerSections'
import type { AgentType, CustomAgentType } from '../../lib/api-types'

interface AgentGalleryStepProps {
  selectedAgentType: AgentType | null
  onSelectAgentType: (type: AgentType) => void
  /**
   * The project the agent is for: lists the uploads shared with it. Null for a
   * project not created yet, where only your own uploads can be picked.
   */
  projectId?: string | null
}

export default function AgentGalleryStep({
  selectedAgentType,
  onSelectAgentType,
  projectId,
}: AgentGalleryStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [isLoadingTypes, setIsLoadingTypes] = useState(false)
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

  return (
    <AgentPickerSections
      agentTypes={agentTypes}
      isLoading={isLoadingTypes}
      loadError={loadError}
      selectedId={selectedAgentType?.id ?? null}
      onSelectType={onSelectAgentType}
      onSelectCustom={handleSelectCustomAgent}
      isDark={isDark}
    />
  )
}
