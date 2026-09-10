import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Globe, Lock, Check, Copy, ExternalLink, Clock, Power } from 'lucide-react'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import EmojiPicker from '../EmojiPicker'
import type { VisualizerType } from '../face/types'
import type {
  AgentType,
  PlanTemplate,
  EnvVarTemplate,
  UpdatePublicConfigDto,
  PublicAgentConfig,
  ProjectWithCounts,
  Project,
  AgentConfiguration,
  TtsCapabilities,
} from '../../lib/api-types'
import { parseAgentRequirements } from '../../lib/api-types'
import VoiceSelectionStep from '../shared/VoiceSelectionStep'
import { planDeclaredLanguage, showsVoiceStep, languageEnvVars } from '../../lib/sessionLanguage'
import {
  AgentGalleryStep,
  ConfigurationSelectionStep,
  PlanSelectionStep,
  VisualizerSelectionStep,
  ExpirationSelectionStep,
  EnvVarsSelectionStep,
  DEFAULT_EXPIRATION_OPTIONS,
  SessionDurationSelectionStep,
} from '../shared'

interface ProjectModalProps {
  isOpen: boolean
  onClose: () => void
  project?: ProjectWithCounts  // If provided = edit mode, else = create mode
  onProjectCreated?: (projectId: string) => void
  onProjectUpdated?: (project: Project) => void
}

type Step = 'basic' | 'agent' | 'configure' | 'configuration' | 'voice' | 'plan' | 'envvars' | 'visualizer' | 'duration' | 'expiration' | 'complete'
type ProjectType = 'private' | 'public'
type EnvVarsView = 'select' | 'edit'

// Predefined timeout options for auto-stop
const TIMEOUT_OPTIONS = [
  { value: null, label: 'Disabled', description: 'Agents run until manually stopped' },
  { value: 5, label: '5 minutes', description: 'Quick sessions' },
  { value: 15, label: '15 minutes', description: 'Short breaks' },
  { value: 30, label: '30 minutes', description: 'Standard timeout' },
  { value: 60, label: '1 hour', description: 'Extended sessions' },
] as const

// Step configuration for easy extension (excluding basic which has no number)
const STEPS_CONFIG: { id: Step; number: number; label: string }[] = [
  { id: 'agent', number: 1, label: 'Select Agent' },
  { id: 'configure', number: 2, label: 'Configure' },
  { id: 'configuration', number: 3, label: 'Configuration' },
  { id: 'plan', number: 4, label: 'Plan' },
  { id: 'voice', number: 5, label: 'Voice & Language' },
  { id: 'envvars', number: 6, label: 'Env Vars' },
  { id: 'visualizer', number: 7, label: 'Visualizer' },
  { id: 'duration', number: 8, label: 'Session Duration' },
  { id: 'expiration', number: 9, label: 'Expiration' },
]

export default function ProjectModal({
  isOpen,
  onClose,
  project,
  onProjectCreated,
  onProjectUpdated,
}: ProjectModalProps) {
  // Theme
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Mode detection
  const isEditMode = !!project

  // Step navigation
  const [step, setStep] = useState<Step>('basic')

  // Basic info
  const [name, setName] = useState('')
  const [projectType, setProjectType] = useState<ProjectType>('private')

  // Auto-stop timeout
  const [agentInactivityTimeout, setAgentInactivityTimeout] = useState<number | null>(5)
  const [customTimeout, setCustomTimeout] = useState('')
  const [showCustomInput, setShowCustomInput] = useState(false)

  // Agent selection (AgentGalleryStep manages its own loading/fetching)
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType | null>(null)

  // Agent config
  const [agentName, setAgentName] = useState('')
  const [agentIcon, setAgentIcon] = useState('🤖')

  // Plan selection (PlanSelectionStep manages its own loading/fetching)
  const [planTemplates, setPlanTemplates] = useState<PlanTemplate[]>([])
  const [selectedPlan, setSelectedPlan] = useState<PlanTemplate | null>(null)
  const [selectedConfiguration, setSelectedConfiguration] = useState<AgentConfiguration | null>(null)

  // Env var state (EnvVarsSelectionStep handles fetching templates)
  const [selectedEnvVarTemplate, setSelectedEnvVarTemplate] = useState<EnvVarTemplate | null>(null)
  const [envVars, setEnvVars] = useState<Record<string, string>>({})
  const [envVarsView, setEnvVarsView] = useState<EnvVarsView>('select')

  // Voice/language for the agent every participant gets. '' = provider default
  // voice / Auto language. Persisted into publicAgentConfig.envVars, the same
  // keys a normal deployment writes, so the spawn path needs no special case.
  const [ttsCapabilities, setTtsCapabilities] = useState<TtsCapabilities | null>(null)
  const [isLoadingTtsCaps, setIsLoadingTtsCaps] = useState(false)
  const [ttsVoice, setTtsVoice] = useState('')
  const [ttsLanguage, setTtsLanguage] = useState('')

  // Visualizer
  const [visualizerType, setVisualizerType] = useState<VisualizerType | undefined>(undefined)
  const [visualizerLocked, setVisualizerLocked] = useState(false)

  // Expiration
  const [expiresInHours, setExpiresInHours] = useState<number | undefined>(undefined)

  // Max session duration (seconds); null = no limit (default)
  const [maxSessionDurationSeconds, setMaxSessionDurationSeconds] = useState<number | null>(null)

  // Submission
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Created project result
  const [publicLink, setPublicLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Parse agent requirements
  const agentRequirements = useMemo(() => {
    if (!selectedAgentType) return { requiresPlan: false, requiredEnvVars: [] as string[], supportsConfigurator: false }
    return parseAgentRequirements(selectedAgentType.configSchema)
  }, [selectedAgentType])

  // The language the selected plan declares, if it declares one. A plan written
  // in German is German wherever it is deployed, so it — not the operator —
  // decides the session language, and the picker is skipped.
  const planLanguage = planDeclaredLanguage(selectedPlan)

  const supportsVoiceSelection = useMemo(
    () => showsVoiceStep(ttsCapabilities, planLanguage),
    [ttsCapabilities, planLanguage],
  )

  // Dynamic steps for public project (excluding basic)
  const publicSteps = useMemo((): Step[] => {
    const s: Step[] = ['agent', 'configure']
    if (agentRequirements.supportsConfigurator && selectedAgentType?.pipelineSchema) {
      s.push('configuration')
    }
    // Plan BEFORE voice: the plan may declare the language, and the voice step
    // needs to know that to skip the picker.
    if (agentRequirements.requiresPlan) {
      s.push('plan')
    }
    if (supportsVoiceSelection) {
      s.push('voice')
    }
    s.push('envvars', 'visualizer', 'duration', 'expiration')
    return s
  }, [agentRequirements.requiresPlan, agentRequirements.supportsConfigurator, selectedAgentType?.pipelineSchema, supportsVoiceSelection])

  // Get visible step configs (filtered based on requirements)
  const visibleStepConfigs = useMemo(() => {
    return STEPS_CONFIG.filter(s => {
      if (s.id === 'plan') return agentRequirements.requiresPlan
      if (s.id === 'configuration') return agentRequirements.supportsConfigurator && !!selectedAgentType?.pipelineSchema
      if (s.id === 'voice') return supportsVoiceSelection
      return publicSteps.includes(s.id)
    }).map((s, idx) => ({ ...s, number: idx + 1 }))
  }, [publicSteps, agentRequirements.requiresPlan, agentRequirements.supportsConfigurator, selectedAgentType?.pipelineSchema, supportsVoiceSelection])

  const getStepNumber = (s: Step): number => {
    const config = visibleStepConfigs.find(c => c.id === s)
    return config?.number ?? 0
  }

  const getTotalSteps = () => visibleStepConfigs.length

  const isPublicWizard = !isEditMode && projectType === 'public' && step !== 'basic'

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep('basic')
      setError(null)
      setPublicLink(null)
      setCopied(false)

      // Fetch TTS capabilities so the voice step (and its place in the wizard)
      // reflects what the active provider can actually produce. Failures are
      // non-fatal: the step is simply omitted.
      setIsLoadingTtsCaps(true)
      apiClient.getTtsCapabilities()
        .then(setTtsCapabilities)
        .catch((err) => {
          console.error('Failed to fetch TTS capabilities:', err)
          setTtsCapabilities(null)
        })
        .finally(() => setIsLoadingTtsCaps(false))

      if (project) {
        // Edit mode - load project values
        setName(project.name)
        const timeout = project.agentInactivityTimeoutMinutes ?? null
        setAgentInactivityTimeout(timeout)

        // Check if current timeout is a custom value
        const isPreset = TIMEOUT_OPTIONS.some(opt => opt.value === timeout)
        setShowCustomInput(!isPreset && timeout !== null)
        if (!isPreset && timeout !== null) {
          setCustomTimeout(timeout.toString())
        } else {
          setCustomTimeout('')
        }
      } else {
        // Create mode - reset to defaults
        setName('')
        setProjectType('private')
        setAgentInactivityTimeout(5)
        setCustomTimeout('')
        setShowCustomInput(false)
        setSelectedAgentType(null)
        setAgentName('')
        setAgentIcon('🤖')
        setSelectedPlan(null)
        setSelectedConfiguration(null)
        setSelectedEnvVarTemplate(null)
        setEnvVars({})
        setEnvVarsView('select')
        setTtsVoice('')
        setTtsLanguage('')
        setVisualizerType(undefined)
        setVisualizerLocked(false)
        setExpiresInHours(undefined)
        setMaxSessionDurationSeconds(null)
      }
    }
  }, [isOpen, project])

  // Update agent name/icon when agent type is selected
  useEffect(() => {
    if (selectedAgentType) {
      setAgentName(selectedAgentType.name)
      setAgentIcon(selectedAgentType.icon || '🤖')
      // Configurations are agent-type specific, reset on agent switch.
      setSelectedConfiguration(null)
    }
  }, [selectedAgentType])

  const handleClose = () => {
    if (!isSubmitting) {
      onClose()
    }
  }

  const handleBack = () => {
    if (step === 'basic') return

    const currentIndex = publicSteps.indexOf(step as any)
    if (currentIndex === 0) {
      setStep('basic')
    } else if (currentIndex > 0) {
      setStep(publicSteps[currentIndex - 1])
    }
  }

  const handleTimeoutChange = (value: number | null) => {
    setAgentInactivityTimeout(value)
    setShowCustomInput(false)
    setCustomTimeout('')
  }

  const handleCustomTimeoutChange = (value: string) => {
    setCustomTimeout(value)
    const num = parseInt(value, 10)
    if (!isNaN(num) && num >= 1 && num <= 1440) {
      setAgentInactivityTimeout(num)
    }
  }

  const handleContinue = () => {
    if (step === 'basic') {
      if (isEditMode || projectType === 'private') {
        handleSubmit()
      } else {
        setStep('agent')
      }
      return
    }

    const currentIndex = publicSteps.indexOf(step as any)
    if (currentIndex < publicSteps.length - 1) {
      setStep(publicSteps[currentIndex + 1])
    } else {
      handleSubmit()
    }
  }

  const canProceed = useMemo(() => {
    switch (step) {
      case 'basic':
        if (isEditMode) {
          // In edit mode, check if there are changes
          const hasChanges =
            name !== project?.name ||
            agentInactivityTimeout !== (project?.agentInactivityTimeoutMinutes ?? null)
          return name.trim().length > 0 && name.length <= 255 && hasChanges
        }
        return name.trim().length > 0 && name.length <= 255
      case 'agent':
        return selectedAgentType !== null
      case 'configure':
        return agentName.trim().length > 0
      case 'plan':
        return selectedPlan !== null
      case 'configuration':
        return selectedConfiguration !== null
      case 'envvars':
        // If a template is selected, we can proceed (template has the values stored securely on server)
        if (selectedEnvVarTemplate !== null) {
          return true
        }
        // If no template selected and there are required env vars, check they all have values
        if (agentRequirements.requiredEnvVars.length > 0) {
          return agentRequirements.requiredEnvVars.every(key => envVars[key]?.trim())
        }
        // No template and no required env vars - can proceed
        return true
      case 'voice':
        // Both choices are optional — Auto / provider default is a valid answer.
        return true
      case 'visualizer':
        return true
      case 'duration':
        return true
      case 'expiration':
        return true
      default:
        return false
    }
  }, [step, name, selectedAgentType, agentName, selectedPlan, selectedConfiguration, selectedEnvVarTemplate, agentRequirements.requiredEnvVars, envVars, isEditMode, project, agentInactivityTimeout])

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Project name is required')
      return
    }

    // Validate custom timeout if shown
    if (showCustomInput) {
      const num = parseInt(customTimeout, 10)
      if (isNaN(num) || num < 1 || num > 1440) {
        setError('Custom timeout must be between 1 and 1440 minutes')
        return
      }
    }

    setIsSubmitting(true)
    setError(null)

    try {
      if (isEditMode && project) {
        // Edit mode - update existing project
        const updatedProject = await apiClient.updateProject(project.id, {
          name: name !== project.name ? name : undefined,
          agentInactivityTimeoutMinutes: agentInactivityTimeout,
        })
        onProjectUpdated?.(updatedProject)
        onClose()
      } else {
        // Create mode - create new project
        const newProject = await apiClient.createProject({
          name,
          agentInactivityTimeoutMinutes: agentInactivityTimeout,
        })

        // If public, update the public config
        if (projectType === 'public' && selectedAgentType) {
          const agentConfig: PublicAgentConfig = {
            name: agentName,
            icon: agentIcon,
          }

          if (selectedPlan) {
            agentConfig.plan = selectedPlan.content as unknown as Record<string, unknown>
          }

          if (selectedConfiguration) {
            // Preferred: store the ID so the spawn resolves a type/version-checked,
            // defaults-merged config. Keep the inline snapshot as a fallback.
            agentConfig.agentConfigurationId = selectedConfiguration.id
            agentConfig.pipelineConfig = selectedConfiguration.configuration as unknown as Record<string, unknown>
          }

          if (selectedEnvVarTemplate) {
            agentConfig.envVarTemplateId = selectedEnvVarTemplate.id
          }

          // Include manual env vars / overrides for public deployment.
          // Skip masked placeholders coming from template preview.
          const filteredEnvVars: Record<string, string> = {}
          for (const [key, value] of Object.entries(envVars)) {
            if (value && value !== '••••••••' && value.trim() !== '') {
              filteredEnvVars[key] = value
            }
          }
          // Voice/language ride in as the env vars the agent SDK already reads,
          // exactly as DeployAgentModal writes them. STELLA_LANGUAGE pins the
          // conversation (STT + reply + voice); TTS_LANGUAGE makes the first
          // synthesis correct before any turn has resolved. Empty = Auto, so we
          // omit rather than pinning a value.
          if (ttsVoice) {
            filteredEnvVars['TTS_VOICE'] = ttsVoice
          }
          Object.assign(filteredEnvVars, languageEnvVars(ttsLanguage, planLanguage))
          if (Object.keys(filteredEnvVars).length > 0) {
            agentConfig.envVars = filteredEnvVars
          }

          const publicConfig: UpdatePublicConfigDto = {
            isPublic: true,
            agentTypeId: selectedAgentType.id,
            agentConfig,
            visualizerType: visualizerType || undefined,
            visualizerLocked,
            expiresAt: expiresInHours
              ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
              : undefined,
            enabled: true,
            maxSessionDurationSeconds,
          }

          await apiClient.updateProjectPublicConfig(newProject.id, publicConfig)

          // Get the public link
          const linkResponse = await apiClient.getProjectPublicLink(newProject.id)
          setPublicLink(linkResponse.publicLink)
          setStep('complete')
          onProjectCreated?.(newProject.id)
        } else {
          // Private project - just close
          onProjectCreated?.(newProject.id)
          onClose()
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : isEditMode ? 'Failed to update project' : 'Failed to create project')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCopyLink = async () => {
    if (publicLink) {
      try {
        await navigator.clipboard.writeText(publicLink)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch (err) {
        console.error('Failed to copy link:', err)
      }
    }
  }

  const getStepTitle = (): string => {
    if (isEditMode) return 'Project Settings'
    switch (step) {
      case 'basic': return 'Create Project'
      case 'agent': return 'Select Agent'
      case 'configure': return 'Configure Agent'
      case 'configuration': return 'Pipeline Configuration'
      case 'voice': return 'Voice & Language'
      case 'plan': return 'Select Plan'
      case 'envvars': return 'Environment Variables'
      case 'visualizer': return 'Choose Visualizer'
      case 'duration': return 'Session Duration'
      case 'expiration': return 'Set Expiration'
      case 'complete': return 'Project Created'
      default: return ''
    }
  }

  const getStepDescription = (): string => {
    if (isEditMode) return 'Configure project behavior'
    switch (step) {
      case 'basic': return 'Start a new project to organize your sessions'
      case 'agent': return 'Choose the agent that will be deployed for each participant'
      case 'configure': return 'Customize the agent appearance and settings'
      case 'voice': return 'Choose the voice and language every participant\'s agent uses'
      case 'plan': return 'Select a conversation plan for this agent'
      case 'envvars': return 'Configure API keys and secrets for this agent'
      case 'visualizer': return 'Set a default visualizer for participants'
      case 'duration': return 'Optionally cap how long each session runs after the agent starts speaking'
      case 'expiration': return 'Set how long the public link remains valid'
      case 'complete': return 'Share this link with participants'
      default: return ''
    }
  }

  // Determine modal size
  const modalSizeClass = (isPublicWizard || step === 'complete')
    ? 'max-w-2xl'
    : 'max-w-lg'

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm"
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            layout
            className={`
              backdrop-blur-xl rounded-[20px] w-full ${modalSizeClass} overflow-hidden
              ${isDark
                ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
                : 'bg-white border border-neutral-200 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
              }
            `}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            {step !== 'complete' && (
              <div className={`px-6 pt-6 pb-4 ${isPublicWizard ? `border-b ${isDark ? 'border-zinc-700' : 'border-neutral-200'}` : ''}`}>
                <div className="relative">
                  <button
                    onClick={handleClose}
                    disabled={isSubmitting}
                    className={`
                      absolute -top-1 -right-1 p-2 rounded-lg transition-all duration-200
                      disabled:opacity-60 disabled:cursor-not-allowed
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

                  {/* Step indicator - only for public wizard steps */}
                  {isPublicWizard && (
                    <div className="flex items-center gap-3 mb-2">
                      {visibleStepConfigs.map((s, idx) => (
                        <div key={s.id} className="flex items-center">
                          <div className={`
                            w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium
                            ${getStepNumber(step) >= s.number
                              ? isDark ? 'bg-violet-500 text-white' : 'bg-neutral-900 text-white'
                              : isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-neutral-200 text-neutral-600'
                            }
                          `}>
                            {s.number}
                          </div>
                          {idx < visibleStepConfigs.length - 1 && (
                            <div className={`w-8 h-0.5 ml-3 ${getStepNumber(step) > s.number
                              ? isDark ? 'bg-violet-500' : 'bg-neutral-900'
                              : isDark ? 'bg-zinc-600' : 'bg-neutral-200'
                            }`} />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <h2 className={`text-2xl font-light tracking-wide ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                    {getStepTitle()}
                  </h2>
                  <p className={`text-sm font-light mt-1 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    {getStepDescription()}
                  </p>
                </div>
              </div>
            )}

            {/* Content */}
            <AnimatePresence mode="wait">
              {/* Basic Step */}
              {step === 'basic' && (
                <motion.div
                  key="basic"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6 space-y-6"
                >
                  {/* Project Name */}
                  <div>
                    <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ${
                      isDark ? 'text-zinc-400' : 'text-neutral-500'
                    }`}>
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoFocus
                      required
                      maxLength={255}
                      disabled={isSubmitting}
                      className={`
                        w-full px-4 py-3 rounded-xl text-sm font-light
                        focus:outline-none transition-all duration-200
                        disabled:opacity-60 disabled:cursor-not-allowed
                        ${isDark
                          ? 'bg-zinc-700/50 border border-zinc-600 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500'
                          : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
                        }
                      `}
                      placeholder="Enter project name"
                    />
                    <div className={`mt-2 text-xs font-light text-right ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                      {name.length}/255
                    </div>
                  </div>

                  {/* Project Type Selection - Only in create mode */}
                  {!isEditMode && (
                    <div>
                      <label className={`block text-xs font-medium uppercase tracking-wider mb-3 ${
                        isDark ? 'text-zinc-400' : 'text-neutral-500'
                      }`}>
                        Project Type
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        {/* Private Option */}
                        <button
                          onClick={() => setProjectType('private')}
                          disabled={isSubmitting}
                          className={`
                            relative p-4 rounded-xl text-left transition-all duration-200
                            disabled:opacity-60 disabled:cursor-not-allowed
                            ${projectType === 'private'
                              ? isDark
                                ? 'bg-violet-500/20 border-2 border-violet-500'
                                : 'bg-neutral-100 border-2 border-neutral-900'
                              : isDark
                                ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500'
                                : 'bg-neutral-50 border border-neutral-200 hover:border-neutral-300'
                            }
                          `}
                        >
                          <div className="flex items-start gap-3">
                            <div className={`
                              w-10 h-10 rounded-xl flex items-center justify-center
                              ${projectType === 'private'
                                ? isDark ? 'bg-violet-500 text-white' : 'bg-neutral-900 text-white'
                                : isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-neutral-100 text-neutral-500'
                              }
                            `}>
                              <Lock className="w-5 h-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h3 className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                                Private
                              </h3>
                              <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                                Manual session setup
                              </p>
                            </div>
                          </div>
                        </button>

                        {/* Public Option */}
                        <button
                          onClick={() => setProjectType('public')}
                          disabled={isSubmitting}
                          className={`
                            relative p-4 rounded-xl text-left transition-all duration-200
                            disabled:opacity-60 disabled:cursor-not-allowed
                            ${projectType === 'public'
                              ? isDark
                                ? 'bg-violet-500/20 border-2 border-violet-500'
                                : 'bg-neutral-100 border-2 border-neutral-900'
                              : isDark
                                ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500'
                                : 'bg-neutral-50 border border-neutral-200 hover:border-neutral-300'
                            }
                          `}
                        >
                          <div className="flex items-start gap-3">
                            <div className={`
                              w-10 h-10 rounded-xl flex items-center justify-center
                              ${projectType === 'public'
                                ? isDark ? 'bg-violet-500 text-white' : 'bg-neutral-900 text-white'
                                : isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-neutral-100 text-neutral-500'
                              }
                            `}>
                              <Globe className="w-5 h-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h3 className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                                Public
                              </h3>
                              <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                                Shareable link access
                              </p>
                            </div>
                          </div>
                        </button>
                      </div>

                      {/* Description based on selection */}
                      <p className={`mt-3 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                        {projectType === 'private'
                          ? 'You manually create sessions and invite participants one by one.'
                          : 'Anyone with the link can start their own session with a pre-configured agent.'}
                      </p>
                    </div>
                  )}

                  {/* Agent Auto-Stop */}
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className={`w-4 h-4 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`} />
                      <label className={`text-xs font-medium uppercase tracking-wider ${
                        isDark ? 'text-zinc-400' : 'text-neutral-500'
                      }`}>
                        Agent Auto-Stop
                      </label>
                    </div>

                    <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                      Automatically stop agents when no users are present
                    </p>

                    <div className="grid grid-cols-2 gap-2">
                      {TIMEOUT_OPTIONS.map((option) => (
                        <button
                          key={option.value ?? 'disabled'}
                          onClick={() => handleTimeoutChange(option.value)}
                          disabled={isSubmitting}
                          className={`
                            p-3 rounded-xl text-left transition-all duration-200
                            disabled:opacity-60 disabled:cursor-not-allowed
                            ${agentInactivityTimeout === option.value && !showCustomInput
                              ? isDark
                                ? 'bg-violet-500/20 border-2 border-violet-500'
                                : 'bg-neutral-100 border-2 border-neutral-900'
                              : isDark
                                ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500'
                                : 'bg-neutral-50 border border-neutral-200 hover:border-neutral-300'
                            }
                          `}
                        >
                          <div className="flex items-center gap-2">
                            {option.value === null ? (
                              <Power className={`w-4 h-4 ${
                                agentInactivityTimeout === null && !showCustomInput
                                  ? isDark ? 'text-violet-400' : 'text-neutral-900'
                                  : isDark ? 'text-zinc-400' : 'text-neutral-500'
                              }`} />
                            ) : (
                              <Clock className={`w-4 h-4 ${
                                agentInactivityTimeout === option.value && !showCustomInput
                                  ? isDark ? 'text-violet-400' : 'text-neutral-900'
                                  : isDark ? 'text-zinc-400' : 'text-neutral-500'
                              }`} />
                            )}
                            <span className={`text-sm font-medium ${
                              isDark ? 'text-zinc-100' : 'text-neutral-900'
                            }`}>
                              {option.label}
                            </span>
                          </div>
                          <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                            {option.description}
                          </p>
                        </button>
                      ))}

                      {/* Custom option */}
                      <button
                        onClick={() => setShowCustomInput(true)}
                        disabled={isSubmitting}
                        className={`
                          p-3 rounded-xl text-left transition-all duration-200 col-span-2
                          disabled:opacity-60 disabled:cursor-not-allowed
                          ${showCustomInput
                            ? isDark
                              ? 'bg-violet-500/20 border-2 border-violet-500'
                              : 'bg-neutral-100 border-2 border-neutral-900'
                            : isDark
                              ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500'
                              : 'bg-neutral-50 border border-neutral-200 hover:border-neutral-300'
                          }
                        `}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Clock className={`w-4 h-4 ${
                              showCustomInput
                                ? isDark ? 'text-violet-400' : 'text-neutral-900'
                                : isDark ? 'text-zinc-400' : 'text-neutral-500'
                            }`} />
                            <span className={`text-sm font-medium ${
                              isDark ? 'text-zinc-100' : 'text-neutral-900'
                            }`}>
                              Custom
                            </span>
                          </div>
                          {showCustomInput && (
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                value={customTimeout}
                                onChange={(e) => handleCustomTimeoutChange(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                min={1}
                                max={1440}
                                disabled={isSubmitting}
                                className={`
                                  w-20 px-2 py-1 rounded-lg text-sm text-center
                                  focus:outline-none
                                  ${isDark
                                    ? 'bg-zinc-600 border border-zinc-500 text-zinc-100'
                                    : 'bg-white border border-neutral-300 text-neutral-900'
                                  }
                                `}
                                placeholder="min"
                              />
                              <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                                minutes
                              </span>
                            </div>
                          )}
                        </div>
                        {!showCustomInput && (
                          <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                            Set a custom timeout (1-1440 min)
                          </p>
                        )}
                      </button>
                    </div>

                    {/* Info note */}
                    <div className={`mt-4 p-3 rounded-xl ${
                      isDark ? 'bg-zinc-700/30' : 'bg-neutral-50'
                    }`}>
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        When enabled, agents will automatically stop after the timeout period when all users leave the session.
                        Agents will automatically restart when a user rejoins.
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Agent Selection Step */}
              {step === 'agent' && (
                <motion.div
                  key="agent"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <AgentGalleryStep
                    selectedAgentType={selectedAgentType}
                    onSelectAgentType={setSelectedAgentType}
                    showMyAgentsTab={false}
                    showUpload={false}
                  />
                </motion.div>
              )}

              {/* Configure Step - matching DeployAgentModal layout */}
              {step === 'configure' && (
                <motion.div
                  key="configure"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6 space-y-4"
                >
                  {/* Selected Agent Type info banner */}
                  {selectedAgentType && (
                    <div className={`
                      flex items-center gap-3 p-3 rounded-xl
                      ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}
                    `}>
                      <div className={`
                        w-10 h-10 rounded-lg flex items-center justify-center text-xl
                        ${isDark ? 'bg-zinc-600' : 'bg-white border border-neutral-200'}
                      `}>
                        {selectedAgentType.icon || '🤖'}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                          {selectedAgentType.name}
                        </div>
                        <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                          {selectedAgentType.description}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Icon & Name Row - matching DeployAgentModal layout */}
                  <div className="flex gap-3">
                    {/* Icon Picker */}
                    <div>
                      <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        Icon
                      </label>
                      <EmojiPicker value={agentIcon} onChange={setAgentIcon} />
                    </div>

                    {/* Name */}
                    <div className="flex-1">
                      <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                        Agent Name
                      </label>
                      <input
                        type="text"
                        value={agentName}
                        onChange={(e) => setAgentName(e.target.value)}
                        required
                        maxLength={255}
                        autoFocus
                        className={`
                          w-full px-4 py-3 rounded-xl text-sm font-light
                          focus:outline-none transition-all duration-200
                          ${isDark
                            ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600'
                            : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
                          }
                        `}
                        placeholder="e.g., Memory Coach"
                      />
                    </div>
                  </div>

                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`p-3 rounded-lg text-xs font-light ${isDark
                        ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                        : 'bg-red-50/80 border border-red-200/60 text-red-600'
                        }`}
                    >
                      {error}
                    </motion.div>
                  )}
                </motion.div>
              )}

              {/* Configuration Step */}
              {step === 'configuration' && selectedAgentType?.pipelineSchema && (
                <motion.div
                  key="configuration"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <ConfigurationSelectionStep
                    agentTypeId={selectedAgentType.id}
                    pipelineSchema={selectedAgentType.pipelineSchema}
                    runtimeVariables={selectedAgentType.runtimeVariables}
                    expertDefaults={selectedAgentType.expertDefaults}
                    capabilities={selectedAgentType.capabilities}
                    selectedConfiguration={selectedConfiguration}
                    onSelectConfiguration={setSelectedConfiguration}
                  />
                </motion.div>
              )}

              {/* Voice & Language Step */}
              {step === 'voice' && (
                <motion.div
                  key="voice"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <VoiceSelectionStep
                    capabilities={ttsCapabilities}
                    loading={isLoadingTtsCaps}
                    voice={ttsVoice}
                    language={ttsLanguage}
                    planLanguage={planLanguage}
                    onVoiceChange={setTtsVoice}
                    onLanguageChange={setTtsLanguage}
                  />
                </motion.div>
              )}

              {/* Plan Step */}
              {step === 'plan' && (
                <motion.div
                  key="plan"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <PlanSelectionStep
                    selectedPlan={selectedPlan}
                    onSelectPlan={setSelectedPlan}
                    planTemplates={planTemplates}
                    onPlanTemplatesChange={setPlanTemplates}
                  />
                </motion.div>
              )}

              {/* Environment Variables Step */}
              {step === 'envvars' && (
                <motion.div
                  key="envvars"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <EnvVarsSelectionStep
                    agentTypeId={selectedAgentType?.id ?? ''}
                    requiredEnvVars={agentRequirements.requiredEnvVars}
                    selectedEnvVarTemplate={selectedEnvVarTemplate}
                    onSelectEnvVarTemplate={setSelectedEnvVarTemplate}
                    envVars={envVars}
                    onEnvVarsChange={setEnvVars}
                    envVarsView={envVarsView}
                    onEnvVarsViewChange={setEnvVarsView}
                  />
                </motion.div>
              )}

              {/* Visualizer Step */}
              {step === 'visualizer' && (
                <motion.div
                  key="visualizer"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <VisualizerSelectionStep
                    visualizerType={visualizerType}
                    visualizerLocked={visualizerLocked}
                    onVisualizerTypeChange={setVisualizerType}
                    onVisualizerLockedChange={setVisualizerLocked}
                  />
                </motion.div>
              )}

              {/* Session Duration Step */}
              {step === 'duration' && (
                <motion.div
                  key="duration"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <SessionDurationSelectionStep
                    maxSessionDurationSeconds={maxSessionDurationSeconds}
                    onMaxSessionDurationSecondsChange={setMaxSessionDurationSeconds}
                  />
                </motion.div>
              )}

              {/* Expiration Step */}
              {step === 'expiration' && (
                <motion.div
                  key="expiration"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <ExpirationSelectionStep
                    expiresInHours={expiresInHours}
                    onExpiresInHoursChange={setExpiresInHours}
                    options={DEFAULT_EXPIRATION_OPTIONS}
                  />
                </motion.div>
              )}

              {/* Complete Step - Success Screen */}
              {step === 'complete' && publicLink && (
                <motion.div
                  key="complete"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="p-8 text-center"
                >
                  {/* Close button */}
                  <button
                    onClick={handleClose}
                    className={`
                      absolute top-4 right-4 p-2 rounded-lg transition-all duration-200
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

                  {/* Success icon */}
                  <div className="relative w-20 h-20 mx-auto mb-6">
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1.4, opacity: 0 }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
                      className={`absolute inset-0 rounded-full ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}
                    />
                    <div className={`
                      absolute inset-0 rounded-full flex items-center justify-center
                      ${isDark ? 'bg-green-500/30' : 'bg-green-100'}
                    `}>
                      <Check className="w-10 h-10 text-green-500" />
                    </div>
                  </div>

                  <h2 className={`text-2xl font-light mb-2 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                    Public Project Created!
                  </h2>
                  <p className={`text-sm mb-6 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                    Share this link with participants to let them join
                  </p>

                  {/* Link display */}
                  <div className={`
                    flex items-center gap-2 p-4 rounded-xl mb-6
                    ${isDark ? 'bg-zinc-700/50 border border-zinc-600' : 'bg-neutral-50 border border-neutral-200'}
                  `}>
                    <input
                      type="text"
                      value={publicLink}
                      readOnly
                      className={`flex-1 bg-transparent text-sm font-mono ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}
                    />
                    <button
                      onClick={handleCopyLink}
                      className={`
                        p-2 rounded-lg transition-colors
                        ${isDark
                          ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                          : 'hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700'
                        }
                      `}
                    >
                      {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <a
                      href={publicLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`
                        p-2 rounded-lg transition-colors
                        ${isDark
                          ? 'hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200'
                          : 'hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700'
                        }
                      `}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>

                  <button
                    onClick={handleClose}
                    className={`
                      w-full py-3 rounded-xl text-sm font-medium transition-all
                      ${isDark
                        ? 'bg-violet-600 text-white hover:bg-violet-500'
                        : 'bg-neutral-900 text-white hover:bg-neutral-800'
                      }
                    `}
                  >
                    Done
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error message */}
            {error && step !== 'configure' && (
              <div className={`mx-6 mb-4 p-3 rounded-xl text-sm ${
                isDark
                  ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}>
                {error}
              </div>
            )}

            {/* Footer Actions */}
            {step !== 'complete' && (
              <div className={`px-6 py-4 flex gap-3 ${isPublicWizard || isEditMode ? `border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200'}` : ''}`}>
                {isPublicWizard && (
                  <button
                    onClick={handleBack}
                    disabled={isSubmitting}
                    className={`
                      px-4 py-2.5 rounded-xl text-sm font-medium transition-all
                      disabled:opacity-60 disabled:cursor-not-allowed
                      ${isDark
                        ? 'text-zinc-300 hover:bg-zinc-700'
                        : 'text-neutral-600 hover:bg-neutral-100'
                      }
                    `}
                  >
                    Back
                  </button>
                )}
                {isEditMode && (
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={isSubmitting}
                    className={`
                      px-4 py-2.5 rounded-xl text-sm font-medium transition-all
                      disabled:opacity-60 disabled:cursor-not-allowed
                      ${isDark
                        ? 'text-zinc-300 hover:bg-zinc-700'
                        : 'text-neutral-600 hover:bg-neutral-100'
                      }
                    `}
                  >
                    Cancel
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={handleContinue}
                  disabled={isSubmitting || !canProceed}
                  className={`
                    px-6 py-2.5 rounded-xl text-sm font-medium transition-all
                    disabled:opacity-60 disabled:cursor-not-allowed
                    ${isDark
                      ? 'bg-violet-600 text-white hover:bg-violet-500'
                      : 'bg-neutral-900 text-white hover:bg-neutral-800'
                    }
                  `}
                >
                  {isSubmitting
                    ? isEditMode ? 'Saving...' : 'Creating...'
                    : isEditMode
                      ? 'Save Changes'
                      : step === 'basic' && projectType === 'private'
                        ? 'Create Project'
                        : step === 'basic'
                          ? 'Continue'
                          : publicSteps.indexOf(step as any) === publicSteps.length - 1
                            ? 'Create Project'
                            : 'Continue'}
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
