import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { AgentType } from '../../lib/api-types'
import { choiceCardClass, SelectedBadge } from '../shared/wizardChoice'

interface AgentGalleryCardProps {
  agentType: AgentType
  isSelected: boolean
  onClick: () => void
}

export default function AgentGalleryCard({
  agentType,
  isSelected,
  onClick,
}: AgentGalleryCardProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  // Still selectable — deprecated means superseded, not retired, and existing
  // deployments must stay reproducible. It just reads quieter than the rest.
  const dimmed = agentType.deprecated && !isSelected

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.99 }}
      className={`
        relative w-full min-h-[160px] flex flex-col p-3 rounded-xl text-left transition-[color,background-color,border-color,box-shadow] duration-200
        ${dimmed ? 'opacity-60 hover:opacity-100' : ''}
        ${choiceCardClass(isSelected, isDark)}
      `}
    >
      {/* Selection indicator */}
      {isSelected && (
        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute top-2 right-2">
          <SelectedBadge isDark={isDark} />
        </motion.span>
      )}

      {/* Icon */}
      <div
        className={`
          w-10 h-10 rounded-lg flex items-center justify-center text-2xl mb-2
          ${isDark
            ? 'bg-zinc-700/50'
            : 'bg-neutral-100'
          }
        `}
      >
        {agentType.icon || '🤖'}
      </div>

      {/* Name */}
      <h3
        className={`
          text-sm font-medium mb-0.5
          ${isSelected
            ? isDark ? 'text-primary-300' : 'text-neutral-900'
            : isDark ? 'text-zinc-100' : 'text-neutral-900'
          }
        `}
      >
        {agentType.name}
        {agentType.deprecated && (
          <span
            className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium align-middle ${
              isDark
                ? 'bg-amber-900/40 text-amber-300'
                : 'bg-amber-100 text-amber-700'
            }`}
          >
            Deprecated
          </span>
        )}
      </h3>

      {/* Description */}
      <p
        className={`
          text-xs font-light leading-relaxed line-clamp-2
          ${isDark ? 'text-zinc-400' : 'text-neutral-500'}
        `}
      >
        {agentType.description}
      </p>

      {agentType.deprecated && agentType.deprecationNote && (
        <p
          className={`mt-1.5 text-[10px] font-light leading-snug line-clamp-2 ${
            isDark ? 'text-amber-300/80' : 'text-amber-700/90'
          }`}
        >
          {agentType.deprecationNote}
        </p>
      )}

      {agentType.sharedWithYou && agentType.ownerName && (
        <div className={`mt-2 text-[11px] ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          Shared by {agentType.ownerName}
        </div>
      )}

      {/* Capabilities and version, on one row at the bottom */}
      <div className="mt-auto pt-2 flex items-end justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {(agentType.capabilities ?? []).slice(0, 3).map((cap) => (
            <span
              key={cap}
              className={`
                px-1.5 py-0.5 rounded text-[10px] font-light
                ${isDark
                  ? 'bg-zinc-700/50 text-zinc-400'
                  : 'bg-neutral-100 text-neutral-500'
                }
              `}
            >
              {cap}
            </span>
          ))}
          {(agentType.capabilities?.length ?? 0) > 3 && (
            <span
              className={`
                px-1.5 py-0.5 text-[10px] font-light
                ${isDark ? 'text-zinc-500' : 'text-neutral-400'}
              `}
            >
              +{(agentType.capabilities?.length ?? 0) - 3}
            </span>
          )}
        </div>
        <span className={`flex-shrink-0 text-[10px] font-light ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
          v{agentType.version}
        </span>
      </div>
    </motion.button>
  )
}
