import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Copy, Link2 } from 'lucide-react'
import { useThemeStore } from '../../store/themeStore'
import { apiClient } from '../../services/ApiClient'
import type { CreateInvitationDto, CreateInvitationResponse } from '../../lib/api-types'
import type { VisualizerType } from '../face/types'
import { VisualizerSelectionStep, ExpirationSelectionStep, INVITATION_EXPIRATION_OPTIONS, SessionDurationSelectionStep } from '../shared'
import { choiceCardClass, SelectedBadge } from '../shared/wizardChoice'
import WizardProgress from '../shared/WizardProgress'

interface InviteParticipantModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: string
  onSuccess?: (response: CreateInvitationResponse) => void
}

type Step = 'type' | 'message' | 'visualizer' | 'duration' | 'expiration' | 'complete'
type InvitationType = 'web' | 'mobile'

interface InvitationTypeConfig {
  id: InvitationType
  name: string
  description: string
  icon: React.ReactNode
  available: boolean
  comingSoon?: boolean
}

const INVITATION_TYPES: InvitationTypeConfig[] = [
  {
    id: 'web',
    name: 'Web Session',
    description: 'Participant joins via browser link',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    available: true,
  },
  {
    id: 'mobile',
    name: 'Mobile App',
    description: 'Participant joins via STELLA app',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M12 18h.01" />
      </svg>
    ),
    available: false,
    comingSoon: true,
  },
]


// Step configuration for easy extension
const STEPS: { id: Step; number: number; label: string }[] = [
  { id: 'type', number: 1, label: 'Invitation Type' },
  { id: 'message', number: 2, label: 'Welcome Message' },
  { id: 'visualizer', number: 3, label: 'Visualizer' },
  { id: 'duration', number: 4, label: 'Session Duration' },
  { id: 'expiration', number: 5, label: 'Expiration' },
]

export default function InviteParticipantModal({
  isOpen,
  onClose,
  sessionId,
  onSuccess,
}: InviteParticipantModalProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Wizard state
  const [step, setStep] = useState<Step>('type')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Form state
  const [invitationType, setInvitationType] = useState<InvitationType>('web')
  const [participantName, setParticipantName] = useState('')
  const [customMessage, setCustomMessage] = useState('')
  const [visualizerType, setVisualizerType] = useState<VisualizerType | undefined>(undefined)
  const [visualizerLocked, setVisualizerLocked] = useState(false)
  const [expiresInHours, setExpiresInHours] = useState<number | undefined>(undefined)
  const [maxSessionDurationSeconds, setMaxSessionDurationSeconds] = useState<number | null>(null)

  // Result state
  const [result, setResult] = useState<CreateInvitationResponse | null>(null)

  const resetForm = () => {
    setStep('type')
    setInvitationType('web')
    setParticipantName('')
    setCustomMessage('')
    setVisualizerType(undefined)
    setVisualizerLocked(false)
    setExpiresInHours(undefined)
    setMaxSessionDurationSeconds(null)
    setResult(null)
    setError(null)
    setCopied(false)
  }

  const handleClose = () => {
    if (!isSubmitting) {
      resetForm()
      onClose()
    }
  }

  const getStepNumber = (s: Step): number => {
    const stepConfig = STEPS.find(st => st.id === s)
    return stepConfig?.number ?? 0
  }

  const handleContinue = () => {
    const stepOrder: Step[] = ['type', 'message', 'visualizer', 'duration', 'expiration']
    const currentIndex = stepOrder.indexOf(step)
    if (currentIndex < stepOrder.length - 1) {
      setStep(stepOrder[currentIndex + 1])
    }
  }

  const handleBack = () => {
    const stepOrder: Step[] = ['type', 'message', 'visualizer', 'duration', 'expiration']
    const currentIndex = stepOrder.indexOf(step)
    if (currentIndex > 0) {
      setStep(stepOrder[currentIndex - 1])
    }
    setError(null)
  }

  const handleSubmit = async () => {
    try {
      setIsSubmitting(true)
      setError(null)

      const dto: CreateInvitationDto = {
        participantName: participantName.trim() || undefined,
        customMessage: customMessage.trim() || undefined,
        visualizerType: visualizerType || undefined,
        visualizerLocked,
        expiresInHours,
        maxSessionDurationSeconds: maxSessionDurationSeconds ?? undefined,
      }

      const response = await apiClient.createInvitation(sessionId, dto)
      setResult(response)
      setStep('complete')
      onSuccess?.(response)
    } catch (err: any) {
      setError(err.message || 'Failed to create invitation')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCopyLink = async () => {
    if (!result?.joinUrl) return
    try {
      await navigator.clipboard.writeText(result.joinUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = result.joinUrl
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const canProceed = useMemo(() => {
    switch (step) {
      case 'type':
        return invitationType === 'web'
      case 'message':
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
  }, [step, invitationType])

  const getStepTitle = (): string => {
    switch (step) {
      case 'type': return 'Invite Participant'
      case 'message': return 'Welcome Message'
      case 'visualizer': return 'Choose Visualizer'
      case 'duration': return 'Session Duration'
      case 'expiration': return 'Set Expiration'
      case 'complete': return 'Invitation Created'
    }
  }

  const getStepDescription = (): string => {
    switch (step) {
      case 'type': return 'Choose how the participant will join this session'
      case 'message': return 'Add a personal message shown when they join (optional)'
      case 'visualizer': return 'Set a default visualizer or let them choose'
      case 'duration': return 'Optionally cap how long the session runs after the agent starts speaking'
      case 'expiration': return 'Set how long the invitation link remains valid'
      case 'complete': return 'Share this link with the participant'
    }
  }

  return createPortal(
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
            {/* Header - Hidden on complete step */}
            {step !== 'complete' && (
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

                  <WizardProgress current={getStepNumber(step)} total={STEPS.length} isDark={isDark} />

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
              {/* Step 1: Invitation Type + Name */}
              {step === 'type' && (
                <motion.div
                  key="type"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  {/* Invitation Type Gallery */}
                  <div className="grid grid-cols-2 gap-3 mb-6">
                    {INVITATION_TYPES.map((type) => (
                      <button
                        key={type.id}
                        onClick={() => type.available && setInvitationType(type.id)}
                        disabled={!type.available}
                        className={`
                          relative p-4 rounded-xl text-left transition-all duration-200
                          ${!type.available ? 'opacity-60 cursor-not-allowed' : ''}
                          ${choiceCardClass(invitationType === type.id && type.available, isDark)}
                        `}
                      >
                        {type.comingSoon && (
                          <span className={`
                            absolute top-2 right-2 text-[10px] font-medium tracking-wider uppercase px-2 py-0.5 rounded
                            ${isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-neutral-200 text-neutral-500'}
                          `}>
                            Coming Soon
                          </span>
                        )}
                        <div className="flex items-start gap-3">
                          <div className={`
                            w-12 h-12 rounded-xl flex items-center justify-center
                            ${invitationType === type.id && type.available
                              ? isDark ? 'bg-primary-500 text-white' : 'bg-neutral-900 text-white'
                              : isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-neutral-100 text-neutral-500'
                            }
                          `}>
                            {type.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                              {type.name}
                            </h3>
                            <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                              {type.description}
                            </p>
                          </div>
                        </div>
                        {invitationType === type.id && type.available && (
                          <div className="absolute top-4 right-4">
                            <SelectedBadge isDark={isDark} />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>

                  {/* Participant Name */}
                  <div>
                    <label
                      htmlFor="participant-name"
                      className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}
                    >
                      Participant Name <span className={isDark ? 'text-zinc-500' : 'text-neutral-400'}>(Optional)</span>
                    </label>
                    <input
                      id="participant-name"
                      type="text"
                      value={participantName}
                      onChange={(e) => setParticipantName(e.target.value)}
                      placeholder="Leave empty to auto-generate (e.g., user-84573)"
                      className={`
                        w-full px-4 py-3 rounded-xl text-sm font-light
                        focus:outline-none transition-all duration-200
                        ${isDark
                          ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600'
                          : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
                        }
                      `}
                      autoFocus
                    />
                  </div>

                  {/* Error message */}
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`mt-4 p-3 rounded-lg text-xs font-light ${isDark
                        ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                        : 'bg-red-50/80 border border-red-200/60 text-red-600'
                      }`}
                    >
                      {error}
                    </motion.div>
                  )}
                </motion.div>
              )}

              {/* Step 2: Message */}
              {step === 'message' && (
                <motion.div
                  key="message"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  {/* Participant summary */}
                  <div className={`
                    flex items-center gap-3 p-3 rounded-xl mb-4
                    ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}
                  `}>
                    <div className={`
                      w-10 h-10 rounded-lg flex items-center justify-center
                      ${isDark ? 'bg-zinc-600 text-zinc-300' : 'bg-white border border-neutral-200 text-neutral-500'}
                    `}>
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <div>
                      <div className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                        {participantName || <span className={isDark ? 'text-zinc-400 italic' : 'text-neutral-400 italic'}>Auto-generated name</span>}
                      </div>
                      <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                        Web Session Invitation
                      </div>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="custom-message"
                      className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}
                    >
                      Welcome Message <span className={isDark ? 'text-zinc-500' : 'text-neutral-400'}>(Optional)</span>
                    </label>
                    <textarea
                      id="custom-message"
                      value={customMessage}
                      onChange={(e) => setCustomMessage(e.target.value)}
                      placeholder="Add a personal message that will be shown to the participant when they join..."
                      rows={4}
                      maxLength={500}
                      className={`
                        w-full px-4 py-3 rounded-xl text-sm font-light resize-none
                        focus:outline-none transition-all duration-200
                        ${isDark
                          ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600'
                          : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
                        }
                      `}
                      autoFocus
                    />
                    <div className={`mt-2 text-xs font-light text-right ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
                      {customMessage.length}/500
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Step 3: Visualizer */}
              {step === 'visualizer' && (
                <motion.div
                  key="visualizer"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
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

              {/* Step 4: Session Duration */}
              {step === 'duration' && (
                <motion.div
                  key="duration"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <SessionDurationSelectionStep
                    maxSessionDurationSeconds={maxSessionDurationSeconds}
                    onMaxSessionDurationSecondsChange={setMaxSessionDurationSeconds}
                  />
                </motion.div>
              )}

              {/* Step 5: Expiration */}
              {step === 'expiration' && (
                <motion.div
                  key="expiration"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.2 }}
                  className="p-6"
                >
                  <ExpirationSelectionStep
                    expiresInHours={expiresInHours}
                    onExpiresInHoursChange={setExpiresInHours}
                    options={INVITATION_EXPIRATION_OPTIONS}
                  />
                </motion.div>
              )}

              {/* Complete - Success Screen */}
              {step === 'complete' && result && (
                <motion.div
                  key="complete"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="p-8 text-center"
                >
                  {/* Close button for success screen */}
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

                  {/* Animated success icon with rings */}
                  <div className="relative w-24 h-24 mx-auto mb-6">
                    {/* Outer pulse ring */}
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1.4, opacity: 0 }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
                      className={`absolute inset-0 rounded-full ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}
                    />
                    {/* Inner pulse ring */}
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1.2, opacity: 0 }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut', delay: 0.2 }}
                      className={`absolute inset-0 rounded-full ${isDark ? 'bg-green-500/30' : 'bg-green-200'}`}
                    />
                    {/* Main circle */}
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
                      className={`absolute inset-0 rounded-full flex items-center justify-center ${isDark ? 'bg-green-500/20' : 'bg-green-50'}`}
                    >
                      <motion.div
                        initial={{ scale: 0, rotate: -45 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ type: 'spring', stiffness: 200, damping: 12, delay: 0.3 }}
                      >
                        <Check className="w-10 h-10 text-green-500" strokeWidth={2.5} />
                      </motion.div>
                    </motion.div>
                  </div>

                  {/* Success message */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="mb-6"
                  >
                    <h3 className={`text-2xl font-light tracking-wide mb-2 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                      You're all set! 🎉
                    </h3>
                    <p className={`text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                      Share this link with <span className={`font-medium ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>{result.invitation.participantName}</span> to let them join
                    </p>
                  </motion.div>

                  {/* Link card */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className={`
                      p-5 rounded-2xl text-left
                      ${isDark ? 'bg-zinc-700/50 border border-zinc-600/50' : 'bg-neutral-50 border border-neutral-200/50'}
                    `}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <div className={`p-1.5 rounded-lg ${isDark ? 'bg-zinc-600' : 'bg-white border border-neutral-200'}`}>
                        <Link2 className={`w-4 h-4 ${isDark ? 'text-zinc-300' : 'text-neutral-500'}`} />
                      </div>
                      <span className={`text-xs font-medium tracking-wider uppercase ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
                        Invitation Link
                      </span>
                    </div>

                    <div className={`
                      p-3 rounded-xl text-sm font-mono break-all mb-4
                      ${isDark ? 'bg-zinc-800/80 text-zinc-300 border border-zinc-700/50' : 'bg-white text-neutral-600 border border-neutral-200'}
                    `}>
                      {result.joinUrl}
                    </div>

                    <button
                      onClick={handleCopyLink}
                      className={`
                        w-full py-3 px-4 rounded-xl text-sm font-medium
                        flex items-center justify-center gap-2 transition-all duration-200
                        ${copied
                          ? 'bg-green-500 text-white'
                          : isDark
                            ? 'bg-primary-500 text-white hover:bg-primary-400 shadow-lg shadow-primary-500/20'
                            : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-lg shadow-neutral-900/20'
                        }
                      `}
                    >
                      {copied ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>Copied to clipboard!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" />
                          <span>Copy invitation link</span>
                        </>
                      )}
                    </button>
                  </motion.div>

                  {/* Subtle hint */}
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className={`text-xs mt-4 ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}
                  >
                    The participant will see a welcome screen when they open this link
                  </motion.p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Footer - Hidden on complete step */}
            {step !== 'complete' && (
            <div className={`px-6 py-4 border-t ${isDark ? 'border-zinc-700' : 'border-neutral-200'}`}>
              <div className="flex gap-3">
                {step === 'type' ? (
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
                      disabled={!canProceed}
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
                ) : step === 'expiration' ? (
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
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                      className={`
                        flex-1 py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                        transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed
                        ${isDark
                          ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                          : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-[0_1px_20px_rgba(0,0,0,0.12)]'
                        }
                      `}
                    >
                      {isSubmitting ? 'Creating...' : 'Create Invitation'}
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
                    <button
                      type="button"
                      onClick={handleContinue}
                      disabled={!canProceed}
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
                )}
              </div>
            </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
