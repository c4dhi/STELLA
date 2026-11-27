import { useThemeStore } from '../../store/themeStore'

/** Same limit as an invitation's welcome message (create-invitation.dto.ts). */
export const WELCOME_MESSAGE_MAX_LENGTH = 500

interface WelcomeMessageStepProps {
  value: string
  onChange: (value: string) => void
}

/**
 * The optional text a participant reads on the "Message from the Organizer"
 * screen before the session starts. On-screen only: the agent never says it.
 */
export default function WelcomeMessageStep({ value, onChange }: WelcomeMessageStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  return (
    <div>
      <label
        htmlFor="public-welcome-message"
        className={`block text-xs font-light tracking-wider uppercase mb-2 ${isDark ? 'text-zinc-400' : 'text-neutral-600'}`}
      >
        Welcome Message <span className={isDark ? 'text-zinc-500' : 'text-neutral-400'}>(Optional)</span>
      </label>
      <textarea
        id="public-welcome-message"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="A message every participant sees on screen before their session starts..."
        rows={5}
        maxLength={WELCOME_MESSAGE_MAX_LENGTH}
        className={`
          w-full px-4 py-3 rounded-xl text-base sm:text-sm font-light resize-none
          focus:outline-none transition-all duration-200
          ${isDark
            ? 'bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600'
            : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400/60 focus:bg-white'
          }
        `}
      />
      <div className={`mt-2 flex justify-between text-xs font-light ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`}>
        <span>Shown on screen only. Leave empty to skip this screen.</span>
        <span>{value.length}/{WELCOME_MESSAGE_MAX_LENGTH}</span>
      </div>
    </div>
  )
}
