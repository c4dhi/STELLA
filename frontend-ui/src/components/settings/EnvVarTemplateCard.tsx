import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { EnvVarTemplate } from '../../lib/api-types'

interface EnvVarTemplateCardProps {
  template: EnvVarTemplate
  agentTypeName: string
  index: number
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
  // Hidden when the card is rendered inside a per-agent-type section (header carries it).
  showAgentTypeBadge?: boolean
}

export default function EnvVarTemplateCard({
  template,
  agentTypeName,
  index,
  onEdit,
  onDelete,
  onDuplicate,
  showAgentTypeBadge = true,
}: EnvVarTemplateCardProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const varCount = template.variableKeys?.length || 0

  const updatedAt = new Date(template.updatedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  // Generate gradient colors based on template name
  const colorIndex = template.name.charCodeAt(0) % 5
  const gradients = [
    'from-amber-500/20 to-orange-500/20',
    'from-green-500/20 to-emerald-500/20',
    'from-violet-500/20 to-purple-500/20',
    'from-rose-500/20 to-pink-500/20',
    'from-sky-500/20 to-cyan-500/20',
  ]
  const iconColors = [
    'text-amber-500',
    'text-green-500',
    'text-violet-500',
    'text-rose-500',
    'text-sky-500',
  ]

  const handleCardClick = (e: React.MouseEvent) => {
    // Prevent triggering edit when clicking action buttons
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    onEdit()
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      transition={{ delay: index * 0.05, type: 'spring', stiffness: 300, damping: 25 }}
      whileHover={{ y: -4, transition: { duration: 0.2 } }}
      onClick={handleCardClick}
      className={`group relative rounded-2xl overflow-hidden transition-shadow duration-300 cursor-pointer ${isDark
        ? 'bg-surface-dark-secondary hover:shadow-xl hover:shadow-black/20'
        : 'bg-white shadow-sm hover:shadow-xl hover:shadow-black/5'
        }`}
    >
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start gap-4 mb-4">
          {/* Icon */}
          <motion.div
            className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${gradients[colorIndex]}`}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={iconColors[colorIndex]}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </motion.div>

          {/* Title & Description */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className={`text-heading-sm font-semibold truncate ${isDark ? 'text-content-inverse' : 'text-content'
                }`}>
                {template.name}
              </h3>
              {showAgentTypeBadge && (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0 ${isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-neutral-100 text-neutral-500'}`}
                  title={`Scoped to ${agentTypeName}`}
                >
                  {agentTypeName}
                </span>
              )}
            </div>
            {template.description ? (
              <p className={`text-body-sm mt-1 line-clamp-2 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}>
                {template.description}
              </p>
            ) : (
              <p className={`text-body-sm mt-1 italic ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                }`}>
                No description
              </p>
            )}
          </div>
        </div>

        {/* Variable Keys */}
        <div className="mb-5">
          <div className={`flex flex-wrap gap-2`}>
            <motion.div
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-caption font-medium ${isDark
                ? 'bg-surface-dark-tertiary text-content-inverse-secondary'
                : 'bg-surface-secondary text-content-secondary'
                }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {varCount} {varCount === 1 ? 'variable' : 'variables'}
            </motion.div>
          </div>
          {varCount > 0 && (
            <div className={`mt-3 flex flex-wrap gap-1.5`}>
              {template.variableKeys.slice(0, 4).map((key) => (
                <span
                  key={key}
                  className={`px-2 py-1 rounded-md text-xs font-mono ${isDark
                      ? 'bg-zinc-700/50 text-zinc-300'
                      : 'bg-neutral-100 text-neutral-600'
                    }`}
                >
                  {key}
                </span>
              ))}
              {varCount > 4 && (
                <span className={`px-2 py-1 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'
                  }`}>
                  +{varCount - 4} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between pt-4 border-t ${isDark ? 'border-border-dark/50' : 'border-border/50'
          }`}>
          <span className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
            }`}>
            Updated {updatedAt}
          </span>

          {/* Actions */}
          <div className="flex gap-1 coarse:gap-2.5 opacity-0 group-hover:opacity-100 coarse:opacity-100 transition-opacity duration-200">
            <motion.button
              onClick={onEdit}
              className={`p-2 rounded-lg transition-colors ${isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-tertiary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
                }`}
              title="Edit"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </motion.button>
            <motion.button
              onClick={onDuplicate}
              className={`p-2 rounded-lg transition-colors ${isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-tertiary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
                }`}
              title="Duplicate"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </motion.button>
            <motion.button
              onClick={onDelete}
              className={`p-2 rounded-lg transition-colors ${isDark
                ? 'text-content-inverse-secondary hover:text-red-400 hover:bg-red-500/10'
                : 'text-content-secondary hover:text-red-600 hover:bg-red-50'
                }`}
              title="Delete"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </motion.button>
          </div>
        </div>
      </div>

      {/* Hover overlay */}
      <motion.div
        className={`absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${isDark
          ? 'bg-gradient-to-t from-amber-500/5 to-transparent'
          : 'bg-gradient-to-t from-amber-500/5 to-transparent'
          }`}
      />
    </motion.div>
  )
}
