import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useNotificationStore } from '../../store/notificationStore'
import { useAuthStore } from '../../store/authStore'

export type SettingsSection = 'profile' | 'preferences' | 'personas' | 'plan-builder' | 'agent-configs' | 'env-vars' | 'agent-library' | 'inbox' | 'analytics' | 'admin'

interface SettingsSidebarProps {
  activeSection: SettingsSection
  onSectionChange: (section: SettingsSection) => void
}

interface SectionItem {
  id: SettingsSection
  label: string
  icon: React.ReactNode
  description: string
  hasBadge?: boolean
  adminOnly?: boolean
}

const sections: SectionItem[] = [
  {
    id: 'profile',
    label: 'Profile',
    description: 'Your account details',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: 'inbox',
    label: 'Inbox',
    description: 'Messages & invitations',
    hasBadge: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </svg>
    ),
  },
  {
    id: 'preferences',
    label: 'Preferences',
    description: 'Theme & display',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
  {
    id: 'agent-library',
    label: 'Agent Library',
    description: 'Browse & upload agents',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <circle cx="15.5" cy="8.5" r="1.5" />
        <path d="M9 15h6" />
      </svg>
    ),
  },
  {
    id: 'agent-configs',
    label: 'Agent Configs',
    description: 'Pipeline configurations',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
    ),
  },
  {
    id: 'personas',
    label: 'Personas',
    description: 'Who your agents are',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2a5 5 0 0 1 5 5v1a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
      </svg>
    ),
  },
  {
    id: 'plan-builder',
    label: 'Plan Builder',
    description: 'Create agent plans',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    id: 'env-vars',
    label: 'Environment Variables',
    description: 'Secure secrets & keys',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    id: 'analytics',
    label: 'Analytics',
    description: 'Agent performance metrics',
    adminOnly: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M18 20V10M12 20V4M6 20v-6" />
      </svg>
    ),
  },
  {
    id: 'admin',
    label: 'Resource Dashboard',
    description: 'System resources',
    adminOnly: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
  },
]

export default function SettingsSidebar({ activeSection, onSectionChange }: SettingsSidebarProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const { unreadCount } = useNotificationStore()
  const { user } = useAuthStore()
  const isSystemAdmin = user?.isSystemAdmin ?? false

  // Filter sections based on admin status
  const visibleSections = sections.filter(section => !section.adminOnly || isSystemAdmin)

  return (
    <aside
      className={`w-72 border-r flex flex-col ${
        isDark ? 'border-border-dark bg-surface-dark' : 'border-border bg-surface'
      }`}
    >
      {/* Header */}
      <div className={`px-6 py-5 border-b ${isDark ? 'border-border-dark' : 'border-border'}`}>
        <h1
          className={`text-heading-lg font-semibold ${
            isDark ? 'text-content-inverse' : 'text-content'
          }`}
        >
          Settings
        </h1>
        <p
          className={`text-body-sm mt-1 ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}
        >
          Manage your account and preferences
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {visibleSections.map((section, index) => {
          const isActive = activeSection === section.id
          return (
            <motion.button
              key={section.id}
              onClick={() => onSectionChange(section.id)}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-left transition-all duration-200 relative overflow-hidden ${
                isActive
                  ? isDark
                    ? ''
                    : ''
                  : isDark
                    ? 'hover:bg-surface-dark-secondary'
                    : 'hover:bg-surface-secondary'
              }`}
              whileHover={{ scale: isActive ? 1 : 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {/* Active Background */}
              {isActive && (
                <motion.div
                  className={`absolute inset-0 rounded-xl ${
                    isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200'
                  }`}
                  layoutId="activeSection"
                  transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
                />
              )}

              {/* Icon */}
              <span className={`relative z-10 ${
                isActive
                  ? isDark
                    ? 'text-primary'
                    : 'text-neutral-900'
                  : isDark
                    ? 'text-neutral-400'
                    : 'text-neutral-500'
              }`}>
                {section.icon}
              </span>

              {/* Text */}
              <div className="relative z-10 flex-1 min-w-0">
                <div className={`text-body-sm font-semibold flex items-center gap-2 ${
                  isActive
                    ? isDark
                      ? 'text-primary'
                      : 'text-neutral-900'
                    : isDark
                      ? 'text-neutral-400'
                      : 'text-neutral-600'
                }`}>
                  {section.label}
                  {/* Unread badge for inbox */}
                  {section.hasBadge && unreadCount > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-red-500 text-white min-w-[18px] text-center">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </div>
                <div className={`text-caption truncate ${
                  isActive
                    ? isDark
                      ? 'text-primary/60'
                      : 'text-neutral-600'
                    : isDark
                      ? 'text-neutral-500'
                      : 'text-neutral-400'
                }`}>
                  {section.description}
                </div>
              </div>

              {/* Arrow indicator */}
              <motion.svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className={`relative z-10 ${
                  isActive
                    ? isDark
                      ? 'text-primary/60'
                      : 'text-neutral-600'
                    : isDark
                      ? 'text-neutral-500'
                      : 'text-neutral-400'
                }`}
                initial={{ opacity: 0, x: -5 }}
                animate={{ opacity: isActive ? 1 : 0, x: isActive ? 0 : -5 }}
                transition={{ duration: 0.2 }}
              >
                <path d="M9 18l6-6-6-6" />
              </motion.svg>
            </motion.button>
          )
        })}
      </nav>

      {/* Footer */}
      <div
        className={`px-6 py-4 border-t ${isDark ? 'border-border-dark' : 'border-border'}`}
      >
        <div className={`text-caption ${
          isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
        }`}>
          STELLA v{__APP_VERSION__}
        </div>
      </div>
    </aside>
  )
}
