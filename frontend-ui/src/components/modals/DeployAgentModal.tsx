import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import EmojiPicker from '../EmojiPicker'
import AgentGalleryCard from '../agents/AgentGalleryCard'
import { AgentUploadCard, MyAgentsSection } from '../agents'
import { apiClient } from '../../services/ApiClient'
import { useThemeStore } from '../../store/themeStore'
import { PlanSelectionStep, PersonaSelectionStep, ModeSelectionStep, ActivitySelectionStep } from '../shared'
import type { AgentMode } from '../shared'
import type {
  AgentType,
  CustomAgentType,
  AgentUploadResponse,
  PlanTemplate,
  EnvVarTemplate,
  AgentConfiguration,
  TtsCapabilities,
  Persona,
} from '../../lib/api-types'
import { parseAgentRequirements } from '../../lib/api-types'
import ConfigurationSelectionStep from '../shared/ConfigurationSelectionStep'
import VoiceSelectionStep from '../shared/VoiceSelectionStep'
import { planDeclaredLanguage, showsVoiceStep, languageEnvVars } from '../../lib/sessionLanguage'
import DeployAgentSettings, { type DeploySettingsState } from '../shared/AgentSettings/DeployAgentSettings'

interface DeployAgentModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (name: string, icon?: string, config?: Record<string, unknown>, agentType?: string, envVarTemplateId?: string, envVars?: Record<string, string>, agentConfigurationId?: string, personaId?: string, mode?: 'plan' | 'companion', availablePlanIds?: string[]) => Promise<void>
}

type Step = 'gallery' | 'upload' | 'configure' | 'configuration' | 'persona' | 'mode' | 'activities' | 'voice' | 'plan' | 'envvars'
type GalleryTab = 'builtin' | 'myagents'

export default function DeployAgentModal({
  isOpen,
  onClose,
  onSubmit,
}: DeployAgentModalProps) {
  const [step, setStep] = useState<Step>('gallery')
  const [galleryTab, setGalleryTab] = useState<GalleryTab>('builtin')
  const [selectedType, setSelectedType] = useState<AgentType | null>(null)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('🤖')
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoadingTypes, setIsLoadingTypes] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadRefreshTrigger, setUploadRefreshTrigger] = useState(0)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Plan-related state (PlanSelectionStep handles its own loading/fetching)
  const [planTemplates, setPlanTemplates] = useState<PlanTemplate[]>([])
  const [selectedPlan, setSelectedPlan] = useState<PlanTemplate | null>(null)

  // Env var template state
  const [envVarTemplates, setEnvVarTemplates] = useState<EnvVarTemplate[]>([])
  const [isLoadingEnvVars, setIsLoadingEnvVars] = useState(false)
  // The settings step's result (#585): the template it starts from and what was changed on top.
  const [deploySettings, setDeploySettings] = useState<DeploySettingsState>({ templateId: undefined, envVars: {}, ready: true })

  // Agent configuration state (pipeline configurator)
  const [mode, setMode] = useState<AgentMode>('plan')
  const [activityPlanIds, setActivityPlanIds] = useState<string[]>([])
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null)
  const [personaPickedByUser, setPersonaPickedByUser] = useState(false)
  const [personas, setPersonas] = useState<Persona[]>([])
  const [selectedConfiguration, setSelectedConfiguration] = useState<AgentConfiguration | null>(null)

  // Voice/language selection. '' = provider default voice / Auto language.
  // Surfaced from the active provider's capabilities; persisted as the
  // TTS_VOICE / TTS_LANGUAGE / STELLA_LANGUAGE env vars the agent SDK reads.
  const [ttsCapabilities, setTtsCapabilities] = useState<TtsCapabilities | null>(null)
  const [isLoadingTtsCaps, setIsLoadingTtsCaps] = useState(false)
  const [ttsVoice, setTtsVoice] = useState('')
  const [ttsLanguage, setTtsLanguage] = useState('')

  // Parse agent requirements from configSchema
  const agentRequirements = useMemo(() => {
    if (!selectedType) return { requiresPlan: false, requiredEnvVars: [] as string[], supportsConfigurator: false }
    return parseAgentRequirements(selectedType.configSchema)
  }, [selectedType])


  // Determine dynamic steps based on agent requirements
  // Flow: Gallery → Configure → (Configuration if supported) → (Plan if required) → Env Vars
  // Show the voice step only when the active TTS provider actually exposes
  // something to choose — a selectable voice or at least a language. Providers
  // that report an empty catalog (no per-agent voice support) skip the step.
  // The language the selected plan declares, if it declares one. A plan written
  // in German is German wherever it is deployed, so it — not the operator —
  // decides the session language, and the picker is skipped.
  // A companion has no plan at start, so no plan declares the language and the
  // operator's pick is the only signal. Reading it off a plan they selected
  // before switching mode would silently pin the wrong language.
  const planLanguage = mode === 'companion' ? '' : planDeclaredLanguage(selectedPlan)

  const supportsVoiceSelection = useMemo(
    () => showsVoiceStep(ttsCapabilities, planLanguage),
    [ttsCapabilities, planLanguage],
  )

  const dynamicSteps = useMemo((): Step[] => {
    const steps: Step[] = ['gallery', 'configure']
    if (agentRequirements.supportsConfigurator && selectedType?.pipelineSchema) {
      steps.push('configuration')
    }
    // Mode first: it decides which built-in persona is preselected (a companion
    // has its own default) and whether a MENU of activities or a single plan
    // is picked afterwards.
    if (agentRequirements.requiresPlan) {
      steps.push('mode')
    }
    // Persona BEFORE plan: who the agent is, then the task it carries out. Every
    // agent gets one (omitting it means the system default), so unlike the plan
    // step this is not gated on a capability.
    steps.push('persona')
    if (agentRequirements.requiresPlan) {
      steps.push(mode === 'companion' ? 'activities' : 'plan')
    }
    if (supportsVoiceSelection) {
      steps.push('voice')
    }
    // Always show env vars step (templates or manual entry)
    steps.push('envvars')
    return steps
  }, [agentRequirements, selectedType?.pipelineSchema, supportsVoiceSelection, mode])

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep('gallery')
      setGalleryTab('builtin')
      setSelectedType(null)
      setName('')
      setIcon('🤖')
      setError(null)
      setSelectedPlan(null)
      setSelectedPersona(null)
      setPersonaPickedByUser(false)
      setMode('plan')
      setActivityPlanIds([])
      setDeploySettings({ templateId: undefined, envVars: {}, ready: true })
      setSelectedConfiguration(null)
      setTtsVoice('')
      setTtsLanguage('')

      // Fetch TTS capabilities so the voice step (and its inclusion in the
      // step flow) reflects what the active provider can actually produce.
      // Failures are non-fatal: the step is simply omitted.
      setIsLoadingTtsCaps(true)
      apiClient.getTtsCapabilities()
        .then(setTtsCapabilities)
        .catch((err) => {
          console.error('Failed to fetch TTS capabilities:', err)
          setTtsCapabilities(null)
        })
        .finally(() => setIsLoadingTtsCaps(false))

      // Fetch agent types
      setIsLoadingTypes(true)
      apiClient.getAgentTypes()
        .then((types) => {
          setAgentTypes(types)
        })
        .catch((err) => {
          console.error('Failed to fetch agent types:', err)
          setAgentTypes([
            {
              id: 'stella-light-agent',
              slug: 'stella-light-agent',
              name: 'Stella Light Agent',
              description: 'Lightweight single-LLM-call agent',
              icon: '⚡',
              version: '1.0.0',
              isBuiltIn: true,
              capabilities: ['voice', 'text'],
              defaultConfig: {}
            }
          ])
        })
        .finally(() => setIsLoadingTypes(false))
    }
  }, [isOpen])

  // Fetch env var templates
  useEffect(() => {
    if (step === 'envvars' && envVarTemplates.length === 0) {
      setIsLoadingEnvVars(true)
      apiClient.listEnvVarTemplates(selectedType?.id)
        .then(setEnvVarTemplates)
        .catch((err) => console.error('Failed to fetch env var templates:', err))
        .finally(() => setIsLoadingEnvVars(false))
    }
  }, [step, envVarTemplates.length, selectedType?.id])

  // Update icon when agent type is selected
  useEffect(() => {
    if (selectedType) {
      if (selectedType.icon) {
        setIcon(selectedType.icon)
      }
    }
  }, [selectedType])

  const handleSelectType = (type: AgentType) => {
    setSelectedType(type)
  }

  const handleSelectCustomAgent = (agent: CustomAgentType) => {
    setSelectedType(agent as AgentType)
  }

  const handleUploadComplete = (_result: AgentUploadResponse) => {
    setUploadRefreshTrigger(prev => prev + 1)
    setGalleryTab('myagents')
    setStep('gallery')
  }

  const handleContinue = () => {
    const currentIndex = dynamicSteps.indexOf(step)
    if (currentIndex >= 0 && currentIndex < dynamicSteps.length - 1) {
      const nextStep = dynamicSteps[currentIndex + 1]
      setStep(nextStep)
    }
  }

  const handleBack = () => {
    if (step === 'upload') {
      setStep('gallery')
    } else {
      const currentIndex = dynamicSteps.indexOf(step)
      if (currentIndex > 0) {
        const prevStep = dynamicSteps[currentIndex - 1]
        setStep(prevStep)
      }
    }
    setError(null)
  }

  const getCurrentStepNumber = (): number => {
    if (step === 'upload') return 1
    const stepsWithoutUpload = dynamicSteps.filter((s): s is Exclude<Step, 'upload'> => s !== 'upload')
    const idx = stepsWithoutUpload.indexOf(step as Exclude<Step, 'upload'>)
    return idx >= 0 ? idx + 1 : 1
  }

  const getTotalSteps = (): number => {
    return dynamicSteps.filter(s => s !== 'upload').length
  }

  const canContinue = (): boolean => {
    switch (step) {
      case 'gallery':
        return !!selectedType
      case 'configure':
        return !!name.trim()
      case 'configuration':
        return !!selectedConfiguration
      case 'plan':
        return !!selectedPlan
      case 'envvars':
        // Every required key is provided and every setting fits (#585).
        return deploySettings.ready
      default:
        return true
    }
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()

    if (!name.trim()) {
      setError('Agent name is required')
      return
    }

    if (!selectedType) {
      setError('Please select an agent type')
      return
    }

    // Build config
    let config: Record<string, unknown> = {}

    // Merge plan content into config if a plan is selected
    // Map PlanTemplate fields to canonical SDK Plan fields
    if (selectedPlan && mode !== 'companion') {
      config = {
        ...config,
        plan: {
          id: selectedPlan.id,
          title: selectedPlan.name,                    // Map template.name → plan.title
          description: selectedPlan.description || '', // Map template.description → plan.description
          ...selectedPlan.content,
        },
      }
    }

    // A selected pipeline configuration is applied server-side by ID (see below):
    // the backend verifies its type/version and resolves the effective config, so
    // we intentionally do NOT inline pipeline_config here.

    setIsSubmitting(true)
    setError(null)

    try {
      // Filter out placeholder values (masked template values) and empty strings
      // Only send env vars that the user has actually modified or added
      const filteredEnvVars: Record<string, string> = {}
      for (const [key, value] of Object.entries(deploySettings.envVars)) {
        // Secrets must be single-line values; remove accidental Enter/newline characters.
        const singleLineValue = value.replace(/[\r\n]/g, '')
        // Skip masked placeholder values from template prefill
        if (singleLineValue && singleLineValue !== '••••••••' && singleLineValue.trim() !== '') {
          filteredEnvVars[key] = singleLineValue
        }
      }

      // Voice/language selection rides in as the env vars the agent SDK already
      // reads. Empty = provider default / Auto, so we omit them in that case to
      // preserve the deployment default rather than pinning a value.
      if (ttsVoice) {
        filteredEnvVars['TTS_VOICE'] = ttsVoice
      }
      Object.assign(filteredEnvVars, languageEnvVars(ttsLanguage, planLanguage))

      await onSubmit(
        name.trim(),
        icon,
        Object.keys(config).length > 0 ? config : undefined,
        selectedType.slug,
        deploySettings.templateId,
        Object.keys(filteredEnvVars).length > 0 ? filteredEnvVars : undefined,
        selectedConfiguration?.id,
        selectedPersona?.id,
        mode,
        mode === 'companion' ? activityPlanIds : undefined,
      )
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deploy agent')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (!isSubmitting) {
      setError(null)
      onClose()
    }
  }

  const getStepTitle = (): string => {
    switch (step) {
      case 'gallery': return 'Choose an Agent'
      case 'upload': return 'Upload Agent'
      case 'configure': return 'Customize Agent'
      case 'configuration': return 'Pipeline Configuration'
      case 'voice': return 'Voice & Language'
      case 'persona': return 'Choose a Persona'
      case 'mode': return 'How should it run?'
      case 'activities': return 'Available Activities'
      case 'plan': return 'Select a Plan'
      case 'envvars': return 'Agent Settings'
    }
  }

  const getStepDescription = (): string => {
    switch (step) {
      case 'gallery': return 'Select an agent type to deploy to this session'
      case 'upload': return 'Upload a custom agent package (.zip)'
      case 'configure': return `Set a name and icon for your ${selectedType?.name || 'agent'}`
      case 'configuration': return `Customize the pipeline configuration for ${selectedType?.name || 'the agent'}`
      case 'voice': return `Choose the voice and language for ${selectedType?.name || 'the agent'}`
      case 'persona': return 'Who the agent is — its character and voice, independent of the plan'
      case 'mode': return 'Follow one plan from the start, or talk freely and run activities on request'
      case 'activities': return 'Plans the companion can offer when the user asks what they can do'
      case 'plan': return `Choose a conversation plan for ${selectedType?.name || 'the agent'}`
      case 'envvars': return `Settings ${selectedType?.name || 'the agent'} declares, plus any custom variables`
    }
  }

  const isLastStep = (): boolean => {
    const currentIndex = dynamicSteps.indexOf(step)
    return currentIndex === dynamicSteps.length - 1
  }

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

                {/* Step indicator */}
                <div className="flex items-center gap-3 mb-2">
                  {Array.from({ length: getTotalSteps() }, (_, idx) => idx + 1).map((num, idx) => (
                    <div key={num} className="flex items-center">
                      <div className={`
                        w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium
                        ${getCurrentStepNumber() >= num
                          ? isDark ? 'bg-primary-500 text-white' : 'bg-primary-500 text-neutral-900'
                          : isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-neutral-200 text-neutral-600'
                        }
                      `}>
                        {num}
                      </div>
                      {idx < getTotalSteps() - 1 && (
                        <div className={`w-8 h-0.5 ml-3 ${getCurrentStepNumber() > num
                            ? 'bg-primary-500'
                            : isDark ? 'bg-zinc-600' : 'bg-neutral-200'
                          }`} />
                      )}
                    </div>
                  ))}
                </div>

                <h2 className={`text-2xl font-light tracking-wide ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                  {getStepTitle()}
                </h2>
                <p className={`text-sm font-light mt-1 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                  {getStepDescription()}
                </p>
              </div>
            </div>

            {/* Content */}
            <AnimatePresence mode="wait">
              {step === 'gallery' ? (
                <motion.div
                  key="gallery"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  {/* Tab bar */}
                  <div className={`flex gap-1 p-1 rounded-lg mb-4 ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-100'}`}>
                    <button
                      onClick={() => setGalleryTab('builtin')}
                      className={`
                        flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all
                        ${galleryTab === 'builtin'
                          ? isDark ? 'bg-zinc-600 text-white' : 'bg-white text-neutral-900 shadow-sm'
                          : isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-700'
                        }
                      `}
                    >
                      Built-in Agents
                    </button>
                    <button
                      onClick={() => setGalleryTab('myagents')}
                      className={`
                        flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all
                        ${galleryTab === 'myagents'
                          ? isDark ? 'bg-zinc-600 text-white' : 'bg-white text-neutral-900 shadow-sm'
                          : isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-neutral-500 hover:text-neutral-700'
                        }
                      `}
                    >
                      My Agents
                    </button>
                  </div>

                  {galleryTab === 'builtin' ? (
                    <>
                      {isLoadingTypes ? (
                        <div className={`h-48 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                          <div className="flex items-center gap-3">
                            <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            Loading agent types...
                          </div>
                        </div>
                      ) : agentTypes.length === 0 ? (
                        <div className={`h-48 flex items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                          No agent types available
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3 max-h-[350px] overflow-y-auto overflow-x-visible pr-2 pt-1 -mt-1">
                          {agentTypes.map((type) => (
                            <AgentGalleryCard
                              key={type.id}
                              agentType={type}
                              isSelected={selectedType?.id === type.id}
                              onClick={() => handleSelectType(type)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-4">
                      {/* Upload button */}
                      <button
                        type="button"
                        onClick={() => setStep('upload')}
                        className={`
                          w-full p-4 rounded-xl text-left transition-all duration-200
                          border-2 border-dashed hover:border-solid
                          ${isDark
                            ? 'border-zinc-600 hover:border-primary-500 bg-zinc-800/30 hover:bg-zinc-700/50'
                            : 'border-neutral-300 hover:border-primary-500 bg-neutral-50/50 hover:bg-primary-50'
                          }
                        `}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`
                            w-10 h-10 rounded-lg flex items-center justify-center
                            ${isDark ? 'bg-zinc-700' : 'bg-neutral-100'}
                          `}>
                            <svg
                              className={`w-5 h-5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                            >
                              <path d="M12 16V4m0 0l-4 4m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M3 20h18" strokeLinecap="round" />
                            </svg>
                          </div>
                          <div>
                            <h3 className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>
                              Upload New Agent
                            </h3>
                            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                              Upload a custom agent package (.zip)
                            </p>
                          </div>
                        </div>
                      </button>

                      <MyAgentsSection
                        onSelectAgent={handleSelectCustomAgent}
                        refreshTrigger={uploadRefreshTrigger}
                      />
                    </div>
                  )}
                </motion.div>
              ) : step === 'upload' ? (
                <motion.div
                  key="upload"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <AgentUploadCard
                    onUploadComplete={handleUploadComplete}
                    onError={(err) => setError(err)}
                  />
                </motion.div>
              ) : step === 'configure' ? (
                <motion.div
                  key="configure"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <div className="space-y-4">
                    {/* Selected agent summary */}
                    {selectedType && (
                      <div className={`
                        flex items-center gap-3 p-3 rounded-xl
                        ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}
                      `}>
                        <div className={`
                          w-10 h-10 rounded-lg flex items-center justify-center text-xl
                          ${isDark ? 'bg-zinc-600' : 'bg-white border border-neutral-200'}
                        `}>
                          {selectedType.icon || '🤖'}
                        </div>
                        <div>
                          <div className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                            {selectedType.name}
                          </div>
                          <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                            {selectedType.description}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Icon & Name Row */}
                    <div className="flex gap-3">
                      {/* Icon Picker */}
                      <div>
                        <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                          Icon
                        </label>
                        <EmojiPicker value={icon} onChange={setIcon} />
                      </div>

                      {/* Name */}
                      <div className="flex-1">
                        <label className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}>
                          Agent Name
                        </label>
                        <input
                          type="text"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
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
                  </div>
                </motion.div>
              ) : step === 'configuration' ? (
                <motion.div
                  key="configuration"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  {selectedType?.pipelineSchema && (
                    <ConfigurationSelectionStep
                      agentTypeId={selectedType.id}
                      pipelineSchema={selectedType.pipelineSchema}
                      runtimeVariables={selectedType.runtimeVariables}
                      expertDefaults={selectedType.expertDefaults}
                      capabilities={selectedType.capabilities}
                      selectedConfiguration={selectedConfiguration}
                      onSelectConfiguration={setSelectedConfiguration}
                    />
                  )}
                </motion.div>
              ) : step === 'voice' ? (
                <motion.div
                  key="voice"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
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
              ) : step === 'persona' ? (
                <motion.div
                  key="persona"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <PersonaSelectionStep
                    selectedPersona={selectedPersona}
                    pickedByUser={personaPickedByUser}
                    onSelectPersona={(persona, pickedByUser) => {
                      setSelectedPersona(persona)
                      setPersonaPickedByUser(pickedByUser)
                    }}
                    personas={personas}
                    onPersonasChange={setPersonas}
                    mode={agentRequirements.requiresPlan ? mode : undefined}
                  />
                </motion.div>
              ) : step === 'mode' ? (
                <motion.div
                  key="mode"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <ModeSelectionStep mode={mode} onSelectMode={setMode} />
                </motion.div>
              ) : step === 'activities' ? (
                <motion.div
                  key="activities"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <ActivitySelectionStep
                    selectedPlanIds={activityPlanIds}
                    onChange={setActivityPlanIds}
                  />
                </motion.div>
              ) : step === 'plan' ? (
                <motion.div
                  key="plan"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
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
              ) : step === 'envvars' ? (
                <motion.div
                  key="envvars"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  {selectedType && (
                    <DeployAgentSettings
                      agentTypeId={selectedType.id}
                      configSchema={selectedType.configSchema}
                      templates={envVarTemplates}
                      onTemplatesChange={setEnvVarTemplates}
                      isLoading={isLoadingEnvVars}
                      isDark={isDark}
                      // The voice step decides these when it is shown.
                      hiddenKeys={supportsVoiceSelection ? ['TTS_VOICE', 'TTS_LANGUAGE', 'STELLA_LANGUAGE'] : []}
                      onChange={setDeploySettings}
                    />
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* Footer */}
            <div className={`px-6 py-4 border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
              <div className="flex gap-3">
                {step === 'gallery' ? (
                  <>
                    <button
                      type="button"
                      onClick={handleClose}
                      disabled={isSubmitting}
                      className={`
                        flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                        transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed
                        ${isDark
                          ? 'bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10'
                          : 'bg-neutral-100/80 text-neutral-600 hover:bg-neutral-200/80'
                        }
                      `}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleContinue}
                      disabled={!canContinue()}
                      className={`
                        flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                        transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed
                        ${isDark
                          ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                          : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-[0_1px_20px_rgba(0,0,0,0.12)]'
                        }
                      `}
                    >
                      Continue
                    </button>
                  </>
                ) : step === 'upload' ? (
                  <button
                    type="button"
                    onClick={handleBack}
                    className={`
                      w-full py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
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
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleBack}
                      disabled={isSubmitting}
                      className={`
                        py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                        transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed
                        ${isDark
                          ? 'bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/10'
                          : 'bg-neutral-100/80 text-neutral-600 hover:bg-neutral-200/80'
                        }
                      `}
                    >
                      <span className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Back
                      </span>
                    </button>
                    {isLastStep() ? (
                      <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={isSubmitting || !canContinue()}
                        className={`
                          flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                          transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed
                          ${isDark
                            ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                            : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-[0_1px_20px_rgba(0,0,0,0.12)]'
                          }
                        `}
                      >
                        {isSubmitting ? (
                          <span className="flex items-center justify-center gap-2">
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Deploying...
                          </span>
                        ) : (
                          'Deploy Agent'
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleContinue}
                        disabled={!canContinue()}
                        className={`
                          flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                          transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed
                          ${isDark
                            ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                            : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-[0_1px_20px_rgba(0,0,0,0.12)]'
                          }
                        `}
                      >
                        Continue
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
