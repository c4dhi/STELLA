import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'

export type AgentMode = 'plan' | 'companion'

interface ModeSelectionStepProps {
  mode: AgentMode
  onSelectMode: (mode: AgentMode) => void
}

const MODES: Array<{
  id: AgentMode
  title: string
  blurb: string
  detail: string
  icon: string
}> = [
  {
    id: 'plan',
    title: 'Plan following',
    blurb: 'Runs one plan from start to finish',
    detail:
      'The agent loads a single plan when it starts and works through its states and tasks. The session ends when the plan does.',
    icon: '📋',
  },
  {
    id: 'companion',
    title: 'Companion',
    blurb: 'Talks freely, and can run activities on request',
    detail:
      'The agent starts with no plan and just talks. When the user asks what they can do, it offers the plans you pick here — and can stop one at any point and go back to talking.',
    icon: '💬',
  },
]

export default function ModeSelectionStep({ mode, onSelectMode }: ModeSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  return (
    <div className="grid grid-cols-2 gap-3">
      {MODES.map((option) => {
        const selected = mode === option.id
        return (
          <motion.button
            key={option.id}
            type="button"
            onClick={() => onSelectMode(option.id)}
            whileHover={{ y: -2 }}
            className={`
              relative p-5 rounded-xl text-left transition-all duration-200
              ${selected
                ? isDark
                  ? 'bg-primary-500/20 border-2 border-primary-500 shadow-lg shadow-primary-500/20'
                  : 'bg-neutral-100 border-2 border-neutral-900 shadow-lg shadow-neutral-900/10'
                : isDark
                  ? 'bg-zinc-700/50 border border-zinc-600 hover:border-zinc-500'
                  : 'bg-white border border-neutral-200 hover:border-neutral-300 hover:shadow-md'
              }
            `}
          >
            {selected && (
              <svg
                className={`absolute top-3 right-3 w-5 h-5 ${isDark ? 'text-primary-400' : 'text-neutral-900'}`}
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            <div className="text-2xl mb-2">{option.icon}</div>
            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
              {option.title}
            </p>
            <p className={`text-xs mb-2 ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`}>
              {option.blurb}
            </p>
            <p className={`text-[11px] leading-relaxed ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
              {option.detail}
            </p>
          </motion.button>
        )
      })}
    </div>
  )
}
