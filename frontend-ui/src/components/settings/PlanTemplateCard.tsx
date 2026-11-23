import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { PlanTemplate } from '../../lib/api-types'

interface PlanTemplateCardProps {
  template: PlanTemplate
  index: number
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
}

export default function PlanTemplateCard({
  template,
  index,
  onEdit,
  onDelete,
  onDuplicate,
}: PlanTemplateCardProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const stateCount = template.content.states?.length || 0
  const taskCount = template.content.states?.reduce(
    (acc, state) => acc + (state.tasks?.length || 0),
    0
  ) || 0

  const updatedAt = new Date(template.updatedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  // Generate gradient colors based on template name
  const colorIndex = template.name.charCodeAt(0) % 5
  const gradients = [
    'from-blue-500/20 to-indigo-500/20',
    'from-purple-500/20 to-pink-500/20',
    'from-emerald-500/20 to-teal-500/20',
    'from-orange-500/20 to-amber-500/20',
    'from-cyan-500/20 to-blue-500/20',
  ]
  const iconColors = [
    'text-blue-500',
    'text-purple-500',
    'text-emerald-500',
    'text-orange-500',
    'text-cyan-500',
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
            transition={{ type: 'spring', stiffness: 300, damping: 15 }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={iconColors[colorIndex]}>
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </motion.div>

          {/* Title & Description */}
          <div className="flex-1 min-w-0">
            <h3 className={`text-heading-sm font-semibold truncate ${isDark ? 'text-content-inverse' : 'text-content'
              }`}>
              {template.name}
            </h3>
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

        {/* Stats Pills */}
        <div className="flex flex-wrap gap-2 mb-5">
          <motion.div
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-caption font-medium ${isDark
              ? 'bg-surface-dark-tertiary text-content-inverse-secondary'
              : 'bg-surface-secondary text-content-secondary'
              }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            {stateCount} {stateCount === 1 ? 'state' : 'states'}
          </motion.div>
          <motion.div
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-caption font-medium ${isDark
              ? 'bg-surface-dark-tertiary text-content-inverse-secondary'
              : 'bg-surface-secondary text-content-secondary'
              }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
          </motion.div>
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
          ? 'bg-gradient-to-t from-primary/5 to-transparent'
          : 'bg-gradient-to-t from-primary/5 to-transparent'
          }`}
      />
    </motion.div>
  )
}
