import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { VISUALIZER_CONFIGS, type VisualizerType } from '../face/types'
import VisualizerPreview from '../face/VisualizerPreview'
import { choiceCardClass, SelectedBadge } from './wizardChoice'

interface VisualizerSelectionStepProps {
  visualizerType: VisualizerType | undefined
  visualizerLocked: boolean
  onVisualizerTypeChange: (type: VisualizerType | undefined) => void
  onVisualizerLockedChange: (locked: boolean) => void
}

export default function VisualizerSelectionStep({
  visualizerType,
  visualizerLocked,
  onVisualizerTypeChange,
  onVisualizerLockedChange,
}: VisualizerSelectionStepProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  return (
    <div>
      <div role="radiogroup" aria-label="Visualizer" className="grid grid-cols-4 gap-3">
        <FaceTile
          label="Their choice"
          selected={!visualizerType}
          isDark={isDark}
          onSelect={() => {
            onVisualizerTypeChange(undefined)
            onVisualizerLockedChange(false)
          }}
        >
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-zinc-600' : 'bg-neutral-200'}`}>
            <span className="text-xl">🎨</span>
          </div>
        </FaceTile>

        {VISUALIZER_CONFIGS.map((config) => (
          <FaceTile
            key={config.id}
            label={config.name}
            selected={visualizerType === config.id}
            isDark={isDark}
            onSelect={() => onVisualizerTypeChange(config.id)}
          >
            <div className={`relative w-10 h-10 rounded-full flex items-center justify-center overflow-hidden ${config.previewBg}`}>
              <VisualizerPreview type={config.id} size="sm" />
            </div>
          </FaceTile>
        ))}
      </div>

      {/* Lock option */}
      {visualizerType && (
        <label className={`flex items-center gap-3 p-4 rounded-xl cursor-pointer mt-4 ${isDark ? 'bg-zinc-700/50' : 'bg-neutral-50'}`}>
          <input
            type="checkbox"
            checked={visualizerLocked}
            onChange={(e) => onVisualizerLockedChange(e.target.checked)}
            className="sr-only"
          />
          <div className={`
            w-10 h-6 rounded-full p-0.5 transition-colors
            ${visualizerLocked
              ? isDark ? 'bg-primary-500' : 'bg-neutral-900'
              : isDark ? 'bg-zinc-600' : 'bg-neutral-300'
            }
          `}>
            <motion.div
              className="w-5 h-5 rounded-full bg-white shadow"
              animate={{ x: visualizerLocked ? 16 : 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          </div>
          <div>
            <p className={`text-sm ${isDark ? 'text-zinc-200' : 'text-neutral-700'}`}>Lock visualizer</p>
            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-neutral-500'}`}>
              Participant won't be able to change it
            </p>
          </div>
        </label>
      )}
    </div>
  )
}

interface FaceTileProps {
  label: string
  selected: boolean
  isDark: boolean
  onSelect: () => void
  children: ReactNode
}

/** One choice in the face grid, in the shared wizard card style. */
function FaceTile({ label, selected, isDark, onSelect, children }: FaceTileProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onSelect}
      className={`relative p-4 rounded-xl flex flex-col items-center gap-2 transition-all duration-200 ${choiceCardClass(selected, isDark)}`}
    >
      {selected && <SelectedBadge isDark={isDark} className="absolute top-2 right-2" />}
      {children}
      <span
        className={`text-xs ${
          selected
            ? `font-medium ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`
            : `font-light ${isDark ? 'text-zinc-300' : 'text-neutral-600'}`
        }`}
      >
        {label}
      </span>
    </button>
  )
}
