import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import type { AgentType, CustomAgentType, AgentValidationStatus } from '../../lib/api-types'

interface AgentTypeCardProps {
  agent: AgentType | CustomAgentType
  index: number
  onView: () => void
  onDelete?: () => void
  onBuild?: () => void
  /** Only the owner shares an upload with projects. */
  onShare?: () => void
}

export default function AgentTypeCard({
  agent,
  index,
  onView,
  onDelete,
  onBuild,
  onShare,
}: AgentTypeCardProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  const isCustomAgent = !agent.isBuiltIn
  const customAgent = agent as CustomAgentType
  const hasBuildInfo = isCustomAgent && 'lastBuild' in customAgent
  // Someone else's upload can only be deployed in the projects it is shared with.
  const sharedIn = ('sharedInProjects' in agent ? agent.sharedInProjects ?? [] : []).map(p => p.name).join(', ')

  // Generate gradient colors based on agent name
  const colorIndex = agent.name.charCodeAt(0) % 5
  const gradients = [
    'from-violet-500/20 to-purple-500/20',
    'from-cyan-500/20 to-blue-500/20',
    'from-emerald-500/20 to-teal-500/20',
    'from-rose-500/20 to-pink-500/20',
    'from-amber-500/20 to-orange-500/20',
  ]
  const iconColors = [
    'text-violet-500',
    'text-cyan-500',
    'text-emerald-500',
    'text-rose-500',
    'text-amber-500',
  ]

  const getStatusBadge = () => {
    if (!isCustomAgent) return null

    const status = agent.validationStatus
    if (!status) return null

    const statusConfig: Record<AgentValidationStatus, { bg: string; text: string; label: string }> = {
      PENDING: {
        bg: isDark ? 'bg-yellow-500/20' : 'bg-yellow-100',
        text: isDark ? 'text-yellow-400' : 'text-yellow-700',
        label: 'Pending',
      },
      APPROVED: {
        bg: isDark ? 'bg-green-500/20' : 'bg-green-100',
        text: isDark ? 'text-green-400' : 'text-green-700',
        label: 'Ready',
      },
      REJECTED: {
        bg: isDark ? 'bg-red-500/20' : 'bg-red-100',
        text: isDark ? 'text-red-400' : 'text-red-700',
        label: 'Failed',
      },
    }

    const config = statusConfig[status]
    return (
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${config.bg} ${config.text}`}>
        {config.label}
      </span>
    )
  }

  const getBuildStatusIndicator = () => {
    if (!hasBuildInfo || !customAgent.lastBuild) return null

    const buildStatus = customAgent.lastBuild.status
    const statusColors: Record<string, string> = {
      pending: isDark ? 'bg-yellow-400' : 'bg-yellow-500',
      building: isDark ? 'bg-blue-400' : 'bg-blue-500',
      success: isDark ? 'bg-green-400' : 'bg-green-500',
      failed: isDark ? 'bg-red-400' : 'bg-red-500',
    }

    return (
      <motion.div
        className={`w-2 h-2 rounded-full ${statusColors[buildStatus] || statusColors.pending}`}
        animate={buildStatus === 'building' ? { scale: [1, 1.2, 1] } : {}}
        transition={{ repeat: Infinity, duration: 1 }}
        title={`Build: ${buildStatus}`}
      />
    )
  }

  // The build status, visible on the card face (not just the corner dot), so
  // an upload's progress is readable without opening it. Clicking it opens
  // the detail view, which jumps straight to the build log.
  const getBuildStatusLabel = () => {
    if (!hasBuildInfo || !customAgent.lastBuild) return null

    const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
      pending: {
        bg: isDark ? 'bg-yellow-500/20' : 'bg-yellow-100',
        text: isDark ? 'text-yellow-400' : 'text-yellow-700',
        label: 'Queued',
      },
      building: {
        bg: isDark ? 'bg-blue-500/20' : 'bg-blue-100',
        text: isDark ? 'text-blue-400' : 'text-blue-700',
        label: 'Building',
      },
      success: {
        bg: isDark ? 'bg-green-500/20' : 'bg-green-100',
        text: isDark ? 'text-green-400' : 'text-green-700',
        label: 'Built',
      },
      failed: {
        bg: isDark ? 'bg-red-500/20' : 'bg-red-100',
        text: isDark ? 'text-red-400' : 'text-red-700',
        label: 'Build failed',
      },
    }
    const status = customAgent.lastBuild.status
    const config = statusConfig[status] ?? statusConfig.pending

    return (
      <motion.button
        onClick={(e) => {
          e.stopPropagation()
          onView()
        }}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${config.bg} ${config.text}`}
        title="View build log"
        whileHover={{ scale: 1.05 }}
      >
        {status === 'building' && (
          <motion.span
            className="w-1.5 h-1.5 rounded-full bg-current"
            animate={{ scale: [1, 1.4, 1] }}
            transition={{ repeat: Infinity, duration: 1 }}
          />
        )}
        {config.label}
      </motion.button>
    )
  }

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    onView()
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
            className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${gradients[colorIndex]} relative`}
          >
            {agent.icon ? (
              <span className="text-2xl">{agent.icon}</span>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={iconColors[colorIndex]}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <circle cx="15.5" cy="8.5" r="1.5" />
                <path d="M9 15h6" />
              </svg>
            )}
            {/* Build status indicator */}
            {getBuildStatusIndicator() && (
              <div className="absolute -top-1 -right-1">
                {getBuildStatusIndicator()}
              </div>
            )}
          </motion.div>

          {/* Title & Description */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className={`text-heading-sm font-semibold truncate ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                {agent.name}
              </h3>
              {getStatusBadge()}
              {getBuildStatusLabel()}
            </div>
            {agent.description ? (
              <p className={`text-body-sm line-clamp-2 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                {agent.description}
              </p>
            ) : (
              <p className={`text-body-sm italic ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                No description
              </p>
            )}
          </div>
        </div>

        {/* Capabilities & Tags */}
        <div className="flex flex-wrap gap-2 mb-5">
          {agent.capabilities?.slice(0, 4).map((capability) => (
            <motion.div
              key={capability}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-caption font-medium ${isDark
                ? 'bg-surface-dark-tertiary text-content-inverse-secondary'
                : 'bg-surface-secondary text-content-secondary'
              }`}
            >
              <CapabilityIcon capability={capability} />
              {capability}
            </motion.div>
          ))}
          {agent.capabilities && agent.capabilities.length > 4 && (
            <span className={`px-2 py-1.5 text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
              +{agent.capabilities.length - 4} more
            </span>
          )}
        </div>

        {/* Tags */}
        {agent.tags && agent.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {agent.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className={`px-2 py-1 rounded-md text-xs ${isDark
                  ? 'bg-zinc-700/50 text-zinc-400'
                  : 'bg-neutral-100 text-neutral-500'
                }`}
              >
                #{tag}
              </span>
            ))}
            {agent.tags.length > 3 && (
              <span className={`px-2 py-1 text-xs ${isDark ? 'text-zinc-500' : 'text-neutral-400'}`}>
                +{agent.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Footer */}
        <div className={`flex items-center justify-between pt-4 border-t ${isDark ? 'border-border-dark/50' : 'border-border/50'}`}>
          <div className="flex items-center gap-2 min-w-0">
            {agent.isBuiltIn ? (
              <span className={`inline-flex items-center gap-1 text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Built-in
              </span>
            ) : (
              <span
                className={`inline-flex items-center gap-1 min-w-0 text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}
                title={sharedIn ? `Deployable in ${sharedIn}` : undefined}
              >
                <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span className="truncate">
                  {agent.sharedWithYou && agent.ownerName
                    ? `Shared by ${agent.ownerName}${sharedIn ? ` · in ${sharedIn}` : ''}`
                    : 'Custom'}
                </span>
              </span>
            )}
            <span className={`text-caption ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
              v{agent.version}
            </span>
          </div>

          {/* Actions */}
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <motion.button
              onClick={onView}
              className={`p-2 rounded-lg transition-colors ${isDark
                ? 'text-content-inverse-secondary hover:text-content-inverse hover:bg-surface-dark-tertiary'
                : 'text-content-secondary hover:text-content hover:bg-surface-secondary'
              }`}
              title="View Details"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </motion.button>
            {isCustomAgent && onBuild && (
              <motion.button
                onClick={onBuild}
                className={`p-2 rounded-lg transition-colors ${isDark
                  ? 'text-content-inverse-secondary hover:text-primary hover:bg-primary/10'
                  : 'text-content-secondary hover:text-primary hover:bg-primary/10'
                }`}
                title="Rebuild Agent"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </motion.button>
            )}
            {isCustomAgent && onShare && (
              <motion.button
                onClick={onShare}
                className={`p-2 rounded-lg transition-colors ${isDark
                  ? 'text-content-inverse-secondary hover:text-primary hover:bg-primary/10'
                  : 'text-content-secondary hover:text-primary hover:bg-primary/10'
                }`}
                title="Share with projects"
                aria-label="Share with projects"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                  <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
                </svg>
              </motion.button>
            )}
            {isCustomAgent && onDelete && (
              <motion.button
                onClick={onDelete}
                className={`p-2 rounded-lg transition-colors ${isDark
                  ? 'text-content-inverse-secondary hover:text-red-400 hover:bg-red-500/10'
                  : 'text-content-secondary hover:text-red-600 hover:bg-red-50'
                }`}
                title="Delete Agent"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </motion.button>
            )}
          </div>
        </div>
      </div>

      {/* Hover overlay */}
      <motion.div
        className={`absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${isDark
          ? 'bg-gradient-to-t from-violet-500/5 to-transparent'
          : 'bg-gradient-to-t from-violet-500/5 to-transparent'
        }`}
      />
    </motion.div>
  )
}

function CapabilityIcon({ capability }: { capability: string }) {
  const iconMap: Record<string, React.ReactNode> = {
    voice: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
      </svg>
    ),
    text: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    plans: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
    experts: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  }

  return iconMap[capability] || (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
    </svg>
  )
}
