import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import EmojiPicker from '../EmojiPicker'
import { apiClient } from '../../services/ApiClient'
import { useThemeStore } from '../../store/themeStore'
import { PlanSelectionStep, PersonaSelectionStep, ModeSelectionStep, ActivitySelectionStep, AgentPickerSections } from '../shared'
import type { AgentMode } from '../shared'
import type {
  AgentType,
  CustomAgentType,
  PlanTemplate,
  EnvVarTemplate,
  AgentConfiguration,
  TtsCapabilities,
  Persona,
} from '../../lib/api-types'
import { asksForMode, deployNeeds, effectiveMode } from '../../lib/deployNeeds'
import { settingsSteps } from '../../lib/agentSettings'
import ConfigurationSelectionStep from '../shared/ConfigurationSelectionStep'
import VoiceSelectionStep from '../shared/VoiceSelectionStep'
import { planDeclaredLanguage, showsVoiceStep, languageEnvVars } from '../../lib/sessionLanguage'
import WizardProgress from '../shared/WizardProgress'
import ConnectorsStep from '../shared/ConnectorsStep'
import type { AvailableConnector } from '../../lib/api-types'
import { assignSlots, bindingsFromChoices, initialSelection, unboundRequiredSlots } from '../../lib/connectorBindings'
import { WIZARD_CARD_GRID, WIZARD_MODAL_SIZE } from '../shared/wizardLayout'
import { choiceCardClass, SelectedBadge } from '../shared/wizardChoice'
import DeployAgentSettings, { EnvTemplatePicker, useDeploySettings } from '../shared/AgentSettings/DeployAgentSettings'

interface DeployAgentModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (name: string, icon?: string, config?: Record<string, unknown>, agentType?: string, envVarTemplateId?: string, envVars?: Record<string, string>, agentConfigurationId?: string, personaId?: string, mode?: 'plan' | 'companion', availablePlanIds?: string[], connectorBindings?: { connectorId: string; slot?: string }[]) => Promise<void>
  /** The session's project: which shared connectors the user may bind here. */
  projectId?: string
}

type Step = 'gallery' | 'configure' | 'configuration' | 'persona' | 'mode' | 'activities' | 'connectors' | 'voice' | 'plan' | 'envtemplate' | 'envvars'

export default function DeployAgentModal({
  isOpen,
  onClose,
  onSubmit,
  projectId,
}: DeployAgentModalProps) {
  const [step, setStep] = useState<Step>('gallery')
  const [selectedType, setSelectedType] = useState<AgentType | null>(null)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('🤖')
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  // Bumped each time the dialog opens, so "My Agents" and the review-required
  // flag it gates on refetch instead of showing whatever they last held — a
  // build finished in Settings, or a review toggle flipped, since the last visit.
  const [myAgentsRefresh, setMyAgentsRefresh] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoadingTypes, setIsLoadingTypes] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Plan-related state (PlanSelectionStep handles its own loading/fetching)
  const [planTemplates, setPlanTemplates] = useState<PlanTemplate[]>([])
  const [selectedPlan, setSelectedPlan] = useState<PlanTemplate | null>(null)

  // Env var template state
  const [envVarTemplates, setEnvVarTemplates] = useState<EnvVarTemplate[]>([])
  const [isLoadingEnvVars, setIsLoadingEnvVars] = useState(false)

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

  // What this agent needs, as the server resolved it from its agent.yaml.
  const needs = useMemo(() => deployNeeds(selectedType), [selectedType])
  const runsPlans = needs.modes.length > 0
  // An agent that runs only one mode is not asked; it simply runs in it.
  const runMode = effectiveMode(needs, mode)

  // The agent's connector slots, as the server resolved them from its agent.yaml.
  const requirements = selectedType?.requirements
  const connectorSlots = useMemo(() => requirements?.connectors ?? [], [requirements])
  const [availableConnectors, setAvailableConnectors] = useState<AvailableConnector[]>([])
  const [connectorsLoading, setConnectorsLoading] = useState(false)
  const [connectorsError, setConnectorsError] = useState<string | null>(null)
  // Ticked connectors, in ticking order; the agent's slots are filled from them.
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([])
  // The connectors this user may bind here: their own and those shared with
  // the session's project. Loaded once per opening, for every agent type,
  // because any agent may be offered extra connectors.
  useEffect(() => {
    setAvailableConnectors([])
    setConnectorsError(null)
    if (!isOpen || !projectId) return
    let cancelled = false
    setConnectorsLoading(true)
    apiClient.listAvailableConnectors(projectId)
      .then((list) => !cancelled && setAvailableConnectors(list))
      .catch((err) => !cancelled && setConnectorsError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setConnectorsLoading(false))
    return () => { cancelled = true }
  }, [isOpen, projectId])
  // A new agent type starts from its own preselection and no extras.
  useEffect(() => {
    setSelectedConnectors(initialSelection(connectorSlots, availableConnectors))
  }, [connectorSlots, availableConnectors])
  const slotsNeedProject = connectorSlots.length > 0 && !projectId
  const slotChoices = useMemo(
    () => assignSlots(connectorSlots, availableConnectors, selectedConnectors),
    [connectorSlots, availableConnectors, selectedConnectors],
  )
  const showConnectorsStep = connectorSlots.length > 0 || availableConnectors.length > 0


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
  const planLanguage = runMode === 'companion' ? '' : planDeclaredLanguage(selectedPlan)

  const supportsVoiceSelection = useMemo(
    () => showsVoiceStep(ttsCapabilities, planLanguage),
    [ttsCapabilities, planLanguage],
  )

  // The settings draft outlives both settings screens (#892): Back to the
  // template screen and on again keeps the edits.
  const settingsDraft = useDeploySettings(
    selectedType?.requirements?.env,
    // The voice step decides these when it is shown.
    supportsVoiceSelection ? ['TTS_VOICE', 'TTS_LANGUAGE', 'STELLA_LANGUAGE'] : [],
  )
  // Only an agent with saved templates asks where to start; otherwise it starts from its defaults.

  const dynamicSteps = useMemo((): Step[] => {
    const steps: Step[] = ['gallery', 'configure']
    if (needs.configurator && selectedType?.pipelineSchema) {
      steps.push('configuration')
    }
    // Mode first: it decides which built-in persona is preselected (a companion
    // has its own default) and whether a MENU of activities or a single plan
    // is picked afterwards.
    if (asksForMode(needs)) {
      steps.push('mode')
    }
    // Persona BEFORE plan: who the agent is, then the task it carries out. Every
    // agent gets one (omitting it means the system default), so unlike the plan
    // step this is not gated on a capability.
    if (needs.persona) {
      steps.push('persona')
    }
    if (runsPlans) {
      steps.push(runMode === 'companion' ? 'activities' : 'plan')
    }
    if (showConnectorsStep) {
      steps.push('connectors')
    }
    if (supportsVoiceSelection) {
      steps.push('voice')
    }
    // Where the settings start from, then the settings themselves (#892).
    steps.push(...settingsSteps(isLoadingEnvVars, envVarTemplates.length))
    return steps
  }, [needs, runsPlans, selectedType?.pipelineSchema, supportsVoiceSelection, runMode, showConnectorsStep, isLoadingEnvVars, envVarTemplates.length])

  // Start From drops out of the steps when the templates finish loading and
  // there are none (or the fetch failed). Move on to the settings rather than
  // leave the wizard on a step it no longer has.
  useEffect(() => {
    if (step === 'envtemplate' && !dynamicSteps.includes('envtemplate')) setStep('envvars')
  }, [step, dynamicSteps])

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep('gallery')
      setSelectedType(null)
      setName('')
      setIcon('🤖')
      setError(null)
      setSelectedPlan(null)
      setSelectedPersona(null)
      setPersonaPickedByUser(false)
      setMode('plan')
      setActivityPlanIds([])
      setSelectedConfiguration(null)
      setTtsVoice('')
      setTtsLanguage('')
      setMyAgentsRefresh((n) => n + 1)

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
      apiClient.getAgentTypes(projectId)
        .then((types) => {
          setAgentTypes(types)
        })
        .catch((err) => {
          console.error('Failed to fetch agent types:', err)
          setAgentTypes([])
          setError('Could not load the agents. Close this dialog and try again.')
        })
        .finally(() => setIsLoadingTypes(false))
    }
  }, [isOpen])

  // The picked agent's env var templates, fetched when it is picked so the
  // wizard knows whether to ask where the settings start from. A new agent
  // starts its settings over.
  const selectedTypeId = selectedType?.id
  useEffect(() => {
    setEnvVarTemplates([])
    settingsDraft.clear()
    if (!selectedTypeId) return
    let cancelled = false
    setIsLoadingEnvVars(true)
    apiClient.listEnvVarTemplates(selectedTypeId)
      .then((list) => !cancelled && setEnvVarTemplates(list))
      .catch((err) => console.error('Failed to fetch env var templates:', err))
      .finally(() => !cancelled && setIsLoadingEnvVars(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTypeId, isOpen])

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
    // "My Agents" lists the user's uploads from their own endpoint, without what
    // deploying them takes. The gallery entry of the same type carries the
    // server-resolved requirements (connectors, env vars), so deploy from that.
    setSelectedType(agentTypes.find((t) => t.id === agent.id) ?? (agent as AgentType))
  }

  const handleContinue = () => {
    const currentIndex = dynamicSteps.indexOf(step)
    if (currentIndex >= 0 && currentIndex < dynamicSteps.length - 1) {
      const nextStep = dynamicSteps[currentIndex + 1]
      setStep(nextStep)
    }
  }

  const handleBack = () => {
    const currentIndex = dynamicSteps.indexOf(step)
    if (currentIndex > 0) {
      const prevStep = dynamicSteps[currentIndex - 1]
      setStep(prevStep)
    }
    setError(null)
  }

  const getCurrentStepNumber = (): number => {
    const idx = dynamicSteps.indexOf(step)
    return idx >= 0 ? idx + 1 : 1
  }

  const getTotalSteps = (): number => {
    return dynamicSteps.length
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
        return !!selectedPlan || !needs.planRequired
      case 'connectors':
        return unboundRequiredSlots(connectorSlots, slotChoices).length === 0
      case 'envtemplate':
        // Required keys block only the settings screen (#892).
        return !isLoadingEnvVars
      case 'envvars':
        // Every required key is provided and every setting fits (#585).
        return settingsDraft.state.ready
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
    if (selectedPlan && runsPlans && runMode !== 'companion') {
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
      for (const [key, value] of Object.entries(settingsDraft.state.envVars)) {
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
        settingsDraft.state.templateId,
        Object.keys(filteredEnvVars).length > 0 ? filteredEnvVars : undefined,
        selectedConfiguration?.id,
        needs.persona ? selectedPersona?.id : undefined,
        runsPlans ? runMode : undefined,
        runsPlans && runMode === 'companion' ? activityPlanIds : undefined,
        showConnectorsStep ? bindingsFromChoices(connectorSlots, slotChoices, selectedConnectors) : undefined,
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
      case 'configure': return 'Customize Agent'
      case 'configuration': return 'Pipeline Configuration'
      case 'connectors': return 'Connectors'
      case 'voice': return 'Voice & Language'
      case 'persona': return 'Choose a Persona'
      case 'mode': return 'How should it run?'
      case 'activities': return 'Available Activities'
      case 'plan': return 'Select a Plan'
      case 'envtemplate': return 'Start From'
      case 'envvars': return 'Agent Settings'
    }
  }

  const getStepDescription = (): string => {
    switch (step) {
      case 'gallery': return 'Select an agent type to deploy to this session'
      case 'configure': return `Set a name and icon for your ${selectedType?.name || 'agent'}`
      case 'configuration': return `Customize the pipeline configuration for ${selectedType?.name || 'the agent'}`
      case 'connectors': return `Which of your connectors ${selectedType?.name || 'the agent'} may use`
      case 'voice': return `Choose the voice and language for ${selectedType?.name || 'the agent'}`
      case 'persona': return 'Who the agent is — its character and voice, independent of the plan'
      case 'mode': return 'Follow one plan from the start, or talk freely and run activities on request'
      case 'activities': return 'Plans the companion can offer when the user asks what they can do'
      case 'plan': return `Choose a conversation plan for ${selectedType?.name || 'the agent'}`
      case 'envtemplate': return `Start from ${selectedType?.name || 'the agent'}'s defaults or one of your saved templates`
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
              backdrop-blur-xl rounded-[20px] w-full ${WIZARD_MODAL_SIZE} overflow-hidden
              flex flex-col max-h-[calc(100dvh-2rem)]
              ${isDark
                ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
                : 'bg-white border border-neutral-200 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
              }
            `}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`shrink-0 px-6 pt-6 pb-4 border-b ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
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

                <WizardProgress current={getCurrentStepNumber()} total={getTotalSteps()} isDark={isDark} />

                <h2 className={`text-2xl font-light tracking-wide ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                  {getStepTitle()}
                </h2>
                <p className={`text-sm font-light mt-1 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                  {getStepDescription()}
                </p>
              </div>
            </div>

            {/* Content: the only part that scrolls, so the footer stays on screen */}
            <div className="flex-1 min-h-0 overflow-y-auto">
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
                  <AgentPickerSections
                    agentTypes={agentTypes}
                    isLoading={isLoadingTypes}
                    selectedId={selectedType?.id ?? null}
                    onSelectType={handleSelectType}
                    onSelectCustom={handleSelectCustomAgent}
                    refreshTrigger={myAgentsRefresh}
                    isDark={isDark}
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
              ) : step === 'connectors' ? (
                <motion.div
                  key="connectors"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <ConnectorsStep
                    slots={connectorSlots}
                    available={availableConnectors}
                    loading={connectorsLoading}
                    loadError={slotsNeedProject ? 'this session has no project' : connectorsError}
                    selected={selectedConnectors}
                    onToggle={(connectorId, on) =>
                      setSelectedConnectors((prev) => (on ? [...prev, connectorId] : prev.filter((id) => id !== connectorId)))
                    }
                    choices={slotChoices}
                  />
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
                    mode={runsPlans ? runMode : undefined}
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
              ) : step === 'envtemplate' ? (
                <motion.div
                  key="envtemplate"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <EnvTemplatePicker
                    draft={settingsDraft}
                    templates={envVarTemplates}
                    isLoading={isLoadingEnvVars}
                    isDark={isDark}
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
                      draft={settingsDraft}
                      agentTypeId={selectedType.id}
                      templates={envVarTemplates}
                      onTemplatesChange={setEnvVarTemplates}
                      isDark={isDark}
                    />
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
            </div>

            {/* Footer */}
            <div className={`shrink-0 px-6 py-4 border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
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
