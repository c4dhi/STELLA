import { useThemeStore } from '../../store/themeStore'
import type { TtsCapabilities } from '../../lib/api-types'

// Friendly labels for the ISO codes the TTS provider reports. Anything not
// listed falls back to the uppercased code, so a new provider language still
// renders sensibly without a code change here.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
  nl: 'Dutch',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
}

function languageLabel(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase()
}

interface VoiceSelectionStepProps {
  capabilities: TtsCapabilities | null
  loading: boolean
  /** Selected voice id. Empty string = provider default voice. */
  voice: string
  /** Pinned ISO conversation language. Empty string = Auto (detect per turn). */
  language: string
  onVoiceChange: (voice: string) => void
  onLanguageChange: (language: string) => void
}

/**
 * Lets the operator pick the voice and conversation language an agent uses.
 *
 * Choices come from the *active* TTS provider's capabilities, so we never
 * offer something it can't produce. Language defaults to "Auto" — detect the
 * participant's language per turn, so the voice follows it turn-by-turn (the
 * core #311 behavior), falling back to English when nothing is detectable.
 *
 * Pinning a language fixes the whole deployment to it (STELLA_LANGUAGE):
 * transcription, the written reply, and the voice. That is the point of the
 * pin — auto-detect needs a long enough utterance to be confident, so a short
 * or garbled first turn would otherwise be answered in the default language.
 */
export default function VoiceSelectionStep({
  capabilities,
  loading,
  voice,
  language,
  onVoiceChange,
  onLanguageChange,
}: VoiceSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const selectClass = `
    w-full px-4 py-2.5 rounded-xl text-sm font-light appearance-none cursor-pointer
    border transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40
    ${isDark
      ? 'bg-zinc-900 border-zinc-700 text-zinc-100'
      : 'bg-white border-neutral-300 text-neutral-900'
    }
  `
  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-neutral-800'}`
  const hintClass = `text-xs font-light mt-1.5 ${isDark ? 'text-zinc-500' : 'text-neutral-500'}`

  if (loading) {
    return (
      <div className={`text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
        Loading voice options…
      </div>
    )
  }

  if (!capabilities || capabilities.voices.length === 0) {
    return (
      <div className={`text-sm font-light ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
        The active speech provider doesn't expose selectable voices. The agent will use the
        deployment's default voice.
      </div>
    )
  }

  const voices = capabilities.voices
  const languages = capabilities.languages

  return (
    <div className="space-y-5">
      {capabilities.supportsVoiceSelection && (
        <div>
          <label className={labelClass}>Voice</label>
          <select
            className={selectClass}
            value={voice}
            onChange={(e) => onVoiceChange(e.target.value)}
          >
            <option value="">Default{capabilities.defaultVoice ? ` (${voiceName(voices, capabilities.defaultVoice)})` : ''}</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
                {v.languages.length > 0 ? ` — ${v.languages.map(languageLabel).join(', ')}` : ''}
              </option>
            ))}
          </select>
          <p className={hintClass}>The cloned voice this agent speaks with.</p>
        </div>
      )}

      {languages.length > 0 && (
        <div>
          <label className={labelClass}>Language</label>
          <select
            className={selectClass}
            value={language}
            onChange={(e) => onLanguageChange(e.target.value)}
          >
            <option value="">Auto (follow conversation)</option>
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
          <p className={hintClass}>
            Auto detects the participant's language each turn and picks the matching reference
            clip, falling back to English when it can't tell. Choose a language to fix this
            agent to it — transcription, replies, and voice — even on a short or unclear first
            message.
          </p>
        </div>
      )}
    </div>
  )
}

function voiceName(voices: TtsCapabilities['voices'], id: string): string {
  return voices.find((v) => v.id === id)?.displayName ?? id
}
