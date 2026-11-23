import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../../store/themeStore'
import { useToastStore } from '../../../store/toastStore'
import { usePlanBuilderStore } from '../../../store/planBuilderStore'
import { apiClient } from '../../../services/ApiClient'

const EXAMPLE_PROMPTS = [
  {
    title: 'Fitness Check-in',
    prompt: 'Conduct a fitness check-in: first greet and learn their name, then ask about current exercise habits (type, frequency, duration), followed by discussing their goals and challenges, and finally provide encouragement and schedule a follow-up',
  },
  {
    title: 'Restaurant Reservation',
    prompt: 'Take a restaurant reservation: greet the caller, collect booking details (date, time, party size), ask about special requests (dietary needs, occasion, seating preference), confirm the reservation details, and thank them',
  },
  {
    title: 'Tech Support Intake',
    prompt: 'Handle a tech support call: greet and get customer info, identify the problem (device, issue description, when it started), try basic troubleshooting steps, then either resolve or escalate with a ticket number',
  },
]

interface AIGeneratorViewProps {
  onClose: () => void
}

export default function AIGeneratorView({ onClose }: AIGeneratorViewProps) {
  const { resolvedTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const { setView, setGeneratedContent, setHasUnsavedChanges } = usePlanBuilderStore()
  const isDark = resolvedTheme === 'dark'

  const [prompt, setPrompt] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Track changes when prompt is modified
  const handlePromptChange = (value: string) => {
    setPrompt(value)
    if (value.trim()) {
      setHasUnsavedChanges(true)
    }
  }

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      addToast({ message: 'Please describe your plan', type: 'error' })
      return
    }

    setIsGenerating(true)
    try {
      const response = await apiClient.generatePlanTemplate({ prompt: prompt.trim() })
      setGeneratedContent(
        response.content,
        response.suggestedName,
        response.suggestedDescription
      )
      addToast({ message: 'Plan generated successfully!', type: 'success' })
    } catch (error: unknown) {
      // Handle both Error instances and API error objects
      let errorMessage = 'Failed to generate plan'
      if (error instanceof Error) {
        errorMessage = error.message
      } else if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String((error as { message: unknown }).message)
      }
      addToast({
        message: errorMessage,
        type: 'error',
      })
    } finally {
      setIsGenerating(false)
    }
  }

  const handleSkip = () => {
    setView('builder')
  }

  const handleExampleClick = (examplePrompt: string) => {
    handlePromptChange(examplePrompt)
    textareaRef.current?.focus()
  }

  return (
    <motion.div
      className="h-full flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <div className={`px-8 py-5 border-b flex items-center justify-between ${
        isDark ? 'border-border-dark bg-surface-dark' : 'border-border bg-white'
      }`}>
        <div className="flex items-center gap-4">
          <motion.button
            onClick={onClose}
            className={`p-2 rounded-xl transition-colors ${
              isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-secondary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
            }`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </motion.button>
          <div>
            <h2 className={`text-heading font-semibold ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}>
              AI Plan Generator
            </h2>
            <p className={`text-caption ${
              isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
            }`}>
              Describe your plan and let AI structure it for you
            </p>
          </div>
        </div>

        <motion.button
          onClick={handleSkip}
          className={`px-4 py-2 rounded-xl text-body-sm font-medium transition-colors ${
            isDark
              ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-secondary'
              : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
          }`}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          Skip to Manual Builder
        </motion.button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-auto">
        <div className="w-full max-w-2xl">
          {/* AI Icon */}
          <motion.div
            className={`w-16 h-16 rounded-2xl mx-auto mb-6 flex items-center justify-center border ${
              isDark
                ? 'bg-gradient-to-br from-violet-600/30 to-violet-600/10 border-violet-500/20'
                : 'bg-gradient-to-br from-neutral-100 to-neutral-50 border-neutral-200'
            }`}
            animate={isGenerating ? { scale: [1, 1.05, 1] } : {}}
            transition={{ duration: 1.5, repeat: isGenerating ? Infinity : 0 }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={isDark ? 'text-violet-500' : 'text-neutral-600'}>
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </motion.div>

          {/* Prompt Input */}
          <div className="relative mb-6">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              placeholder="Describe the plan you want to create...

For example: 'A sales process with lead qualification, demo scheduling, proposal review, and contract signing stages'"
              disabled={isGenerating}
              rows={5}
              className={`w-full px-4 py-3 rounded-xl text-body resize-none transition-all ${
                isDark
                  ? 'bg-surface-dark-secondary border-2 border-border-dark focus:border-primary text-content-inverse placeholder:text-content-inverse-tertiary'
                  : 'bg-white border-2 border-neutral-200 focus:border-neutral-900 text-content placeholder:text-content-tertiary shadow-sm'
              } focus:outline-none disabled:opacity-50`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey && !isGenerating) {
                  handleGenerate()
                }
              }}
            />
            <div className={`absolute bottom-3 right-3 text-caption ${
              isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
            }`}>
              {prompt.length}/5000
            </div>
          </div>

          {/* Generate Button */}
          <motion.button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
            className={`w-full py-3.5 rounded-xl font-medium flex items-center justify-center gap-3 transition-all ${
              isDark
                ? 'bg-violet-600 hover:bg-violet-500 text-white disabled:bg-violet-600/50'
                : 'bg-neutral-900 hover:bg-neutral-800 text-white disabled:bg-neutral-400'
            } disabled:cursor-not-allowed shadow-lg`}
            whileHover={!isGenerating && prompt.trim() ? { scale: 1.01, y: -1 } : {}}
            whileTap={!isGenerating && prompt.trim() ? { scale: 0.99 } : {}}
          >
            <AnimatePresence mode="wait">
              {isGenerating ? (
                <motion.div
                  key="generating"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-3"
                >
                  {/* Typing indicator */}
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <motion.div
                        key={i}
                        className="w-2 h-2 bg-white rounded-full"
                        animate={{ y: [0, -6, 0] }}
                        transition={{
                          duration: 0.6,
                          repeat: Infinity,
                          delay: i * 0.15,
                        }}
                      />
                    ))}
                  </div>
                  <span>Generating your plan...</span>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                  <span>Generate Plan</span>
                  <span className={`text-body-sm ${isDark ? 'text-white/60' : 'text-white/70'}`}>
                    (Cmd + Enter)
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>

          {/* Example Prompts */}
          <div className="mt-8">
            <p className={`text-body-sm font-medium mb-3 ${
              isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
            }`}>
              Try an example:
            </p>
            <div className="flex flex-wrap gap-2 coarse:gap-3">
              {EXAMPLE_PROMPTS.map((example) => (
                <motion.button
                  key={example.title}
                  onClick={() => handleExampleClick(example.prompt)}
                  disabled={isGenerating}
                  className={`px-3 py-1.5 rounded-lg text-caption transition-colors ${
                    isDark
                      ? 'bg-surface-dark-secondary text-content-inverse-secondary hover:bg-surface-dark-tertiary hover:text-content-inverse border border-border-dark'
                      : 'bg-surface-secondary text-content-secondary hover:bg-surface-tertiary hover:text-content border border-border'
                  } disabled:opacity-50`}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {example.title}
                </motion.button>
              ))}
            </div>
          </div>

          {/* Hint */}
          <p className={`mt-6 text-center text-caption ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}>
            The AI will generate states, tasks, and deliverables based on your description.
            You can then review and customize the plan.
          </p>
        </div>
      </div>
    </motion.div>
  )
}
