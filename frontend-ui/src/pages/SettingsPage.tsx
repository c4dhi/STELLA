import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../store/themeStore'
import AppHeader from '../components/layout/AppHeader'
import SettingsSidebar, { type SettingsSection } from '../components/settings/SettingsSidebar'
import ProfileSection from '../components/settings/ProfileSection'
import PreferencesSection from '../components/settings/PreferencesSection'
import PlanBuilderSection from '../components/settings/PlanBuilderSection'
import PersonasSection from '../components/settings/PersonasSection'
import EnvVarBuilderSection from '../components/settings/EnvVarBuilderSection'
import AgentLibrarySection from '../components/settings/AgentLibrarySection'
import InboxSection from '../components/settings/InboxSection'
import AdminDashboardSection from '../components/settings/AdminDashboardSection'
import AgentConfigSection from '../components/settings/AgentConfigSection'
import AnalyticsSection from '../components/settings/AnalyticsSection'
import { useAuthStore } from '../store/authStore'

const validSections: SettingsSection[] = ['profile', 'preferences', 'personas', 'plan-builder', 'agent-configs', 'env-vars', 'agent-library', 'inbox', 'analytics', 'admin']

// Animation variants for page transitions
const pageVariants = {
  initial: {
    opacity: 0,
    y: 20,
    scale: 0.98
  },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.3,
      ease: [0.25, 0.46, 0.45, 0.94] as const
    }
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.98,
    transition: {
      duration: 0.2
    }
  }
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const { section } = useParams<{ section?: string }>()
  const { resolvedTheme, initializeTheme } = useThemeStore()
  const { user } = useAuthStore()
  const isDark = resolvedTheme === 'dark'
  const isSystemAdmin = user?.isSystemAdmin ?? false

  // Validate and normalize section param
  // Admin section requires system admin privileges
  const activeSection: SettingsSection = (() => {
    if (!validSections.includes(section as SettingsSection)) {
      return 'profile'
    }
    if ((section === 'admin' || section === 'analytics') && !isSystemAdmin) {
      return 'profile'
    }
    return section as SettingsSection
  })()

  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  const handleSectionChange = (newSection: SettingsSection) => {
    navigate(`/settings/${newSection}`)
  }

  const renderContent = () => {
    switch (activeSection) {
      case 'profile':
        return <ProfileSection />
      case 'preferences':
        return <PreferencesSection />
      case 'personas':
        return <PersonasSection />
      case 'plan-builder':
        return <PlanBuilderSection />
      case 'agent-configs':
        return <AgentConfigSection />
      case 'env-vars':
        return <EnvVarBuilderSection />
      case 'agent-library':
        return <AgentLibrarySection />
      case 'inbox':
        return <InboxSection />
      case 'analytics':
        return isSystemAdmin ? <AnalyticsSection /> : <ProfileSection />
      case 'admin':
        return isSystemAdmin ? <AdminDashboardSection /> : <ProfileSection />
      default:
        return <ProfileSection />
    }
  }

  return (
    <motion.div
      className={`h-screen flex flex-col transition-colors duration-200 ${
        isDark ? 'bg-surface-dark' : 'bg-surface'
      }`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <AppHeader
        showBackButton
        backPath="/dashboard"
        backLabel="Dashboard"
      />

      <div className="flex-1 flex justify-center overflow-hidden">
        <div className="w-full max-w-6xl flex">
          {/* Sidebar */}
          <SettingsSidebar
            activeSection={activeSection}
            onSectionChange={handleSectionChange}
          />

          {/* Main Content */}
          <main className={`flex-1 overflow-y-auto p-8 ${
            isDark ? 'bg-surface-dark' : 'bg-surface'
          }`}>
            <AnimatePresence mode="wait">
              <motion.div
                key={activeSection}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="h-full pb-8"
              >
                {renderContent()}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </motion.div>
  )
}
