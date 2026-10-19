import { useState } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'

export type TtsPlaybackMode = 'auto' | 'stream' | 'sentence'

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1
    }
  }
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94] as const
    }
  }
}

const playbackOptions: { value: TtsPlaybackMode; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Automatic',
    description: 'Starts streaming and switches to sentence by sentence if the voice can’t keep up.',
  },
  {
    value: 'stream',
    label: 'Streaming',
    description: 'Speaks each sentence while it is generated. Fastest, but a slow voice can break off mid-word.',
  },
  {
    value: 'sentence',
    label: 'Sentence by sentence',
    description: 'Generates the whole sentence first, then plays it. A short pause before each sentence.',
  },
]

interface PinnedDeployment {
  name: string
  project: string
  mode: TtsPlaybackMode
}

interface PlatformSettingsSectionProps {
  // Mockup data for #89; the build replaces these with GET /admin/platform-settings.
  initialMode?: TtsPlaybackMode
  updatedBy?: string
  updatedAt?: string
  pinned?: PinnedDeployment[]
}

export default function PlatformSettingsSection({
  initialMode = 'auto',
  updatedBy,
  updatedAt,
  pinned = [],
}: PlatformSettingsSectionProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [savedMode, setSavedMode] = useState<TtsPlaybackMode>(initialMode)
  const [mode, setMode] = useState<TtsPlaybackMode>(initialMode)
  const [showPinned, setShowPinned] = useState(false)
  const dirty = mode !== savedMode
  const labelOf = (m: TtsPlaybackMode) => playbackOptions.find(o => o.value === m)?.label ?? m

  return (
    <motion.div
      className="max-w-2xl"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={itemVariants} className="mb-6">
        <h2 className={`text-heading-lg mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
          Platform Defaults
        </h2>
        <p className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
          Apply to every deployment that doesn’t set its own value. Only system admins see this page.
        </p>
      </motion.div>

      <motion.div
        className={`p-6 rounded-2xl ${
          isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200/60'
        }`}
        variants={itemVariants}
      >
        <h3 className={`text-heading-sm font-semibold mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
          Voice playback
        </h3>
        <p className={`text-body-sm mb-6 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
          How Stella plays her speech. Takes effect from the next session; conversations already running keep their mode.
        </p>

        <div role="radiogroup" aria-label="Voice playback" className="space-y-3">
          {playbackOptions.map(option => {
            const isSelected = mode === option.value
            return (
              <button
                key={option.value}
                role="radio"
                aria-checked={isSelected}
                onClick={() => setMode(option.value)}
                className={`w-full flex items-start gap-4 p-4 rounded-xl text-left transition-all duration-200 ${
                  isSelected
                    ? isDark
                      ? 'ring-2 ring-primary-400 bg-primary-500/10'
                      : 'ring-2 ring-primary-500 bg-primary-50'
                    : isDark
                      ? 'bg-surface-dark-tertiary hover:bg-surface-dark-tertiary/70'
                      : 'bg-surface-secondary hover:bg-surface-tertiary'
                }`}
              >
                <span
                  className={`mt-0.5 w-5 h-5 flex-shrink-0 rounded-full border-2 flex items-center justify-center ${
                    isSelected ? 'border-primary-500' : isDark ? 'border-neutral-500' : 'border-neutral-300'
                  }`}
                >
                  {isSelected && <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`flex items-center gap-2 text-body-sm font-semibold ${
                    isSelected ? (isDark ? 'text-primary-300' : 'text-primary-700') : isDark ? 'text-content-inverse' : 'text-content'
                  }`}>
                    {option.label}
                    {option.value === 'auto' && (
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        isDark ? 'bg-surface-dark text-content-inverse-tertiary' : 'bg-white text-content-tertiary border border-neutral-200'
                      }`}>
                        Built-in default
                      </span>
                    )}
                  </span>
                  <span className={`block text-caption mt-0.5 ${
                    isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                  }`}>
                    {option.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {/* Deployments that pin their own mode */}
        <div className={`mt-6 pt-5 border-t ${isDark ? 'border-border-dark/50' : 'border-border/50'}`}>
          <button
            onClick={() => setShowPinned(v => !v)}
            disabled={pinned.length === 0}
            className={`w-full flex items-center justify-between text-left text-body-sm ${
              isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
            }`}
          >
            <span>
              {pinned.length === 0
                ? 'No deployment sets its own mode, so this applies to all of them.'
                : `${pinned.length} deployment${pinned.length === 1 ? ' sets its own mode and keeps it' : 's set their own mode and keep it'}`}
            </span>
            {pinned.length > 0 && (
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                className={`transition-transform ${showPinned ? 'rotate-180' : ''}`}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            )}
          </button>
          {showPinned && pinned.length > 0 && (
            <ul className="mt-3 space-y-2">
              {pinned.map(d => (
                <li
                  key={`${d.project}/${d.name}`}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-caption ${
                    isDark ? 'bg-surface-dark-tertiary' : 'bg-surface-secondary'
                  }`}
                >
                  <span className="min-w-0 truncate">
                    <span className={isDark ? 'text-content-inverse' : 'text-content'}>{d.name}</span>
                    <span className={isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}> · {d.project}</span>
                  </span>
                  <span className={`flex-shrink-0 font-medium ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                    {labelOf(d.mode)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Save */}
        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
          <span className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
            {dirty
              ? `Unsaved: ${labelOf(savedMode)} → ${labelOf(mode)}`
              : updatedBy
                ? `Last changed by ${updatedBy}${updatedAt ? `, ${updatedAt}` : ''}`
                : 'Never changed: using the built-in default'}
          </span>
          <div className="flex gap-2">
            {dirty && (
              <button
                onClick={() => setMode(savedMode)}
                className={`px-4 py-2 rounded-xl text-body-sm font-medium ${
                  isDark ? 'text-content-inverse-secondary hover:bg-surface-dark-tertiary' : 'text-content-secondary hover:bg-surface-secondary'
                }`}
              >
                Cancel
              </button>
            )}
            <button
              onClick={() => setSavedMode(mode)}
              disabled={!dirty}
              className={`btn-primary ${dirty ? '' : 'opacity-40 cursor-not-allowed'}`}
            >
              Save
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
