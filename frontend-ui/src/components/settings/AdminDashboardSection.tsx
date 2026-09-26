import { useState, useCallback, useEffect, useRef, type ChangeEvent } from 'react'
import { motion } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useToastStore } from '../../store/toastStore'
import { useAdminDashboardStream, useUsageHistory, useAllSessions, useCapacityMeasurements } from '../../hooks/useAdminMetrics'
import { useServerMetricsStream } from '../../hooks/useServerMetrics'
import { apiClient } from '../../services/ApiClient'
import type { BackupImportReport } from '../../services/ApiClient'
import StatsCard from './admin/StatsCard'
import SessionsGrid from './admin/SessionsGrid'
import ServerPerformanceMonitor from './admin/ServerPerformanceMonitor'
import GpuMonitor from './admin/GpuMonitor'
import CapacityCard from './admin/CapacityCard'
import HistoricalUsageCharts from './admin/HistoricalUsageCharts'

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94] as const,
    },
  },
}

// Icons for stats cards
const UsersIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)

const BotIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7v4" />
    <line x1="8" y1="16" x2="8" y2="16" />
    <line x1="16" y1="16" x2="16" y2="16" />
  </svg>
)

const PauseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
)

const ClockIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
)

const LayersIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
)

const MessagesIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const ExpandIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

const CompressIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

export default function AdminDashboardSection() {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenRef = useRef<HTMLDivElement>(null)

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      fullscreenRef.current?.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }, [])

  useEffect(() => {
    const handleChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleChange)
    return () => document.removeEventListener('fullscreenchange', handleChange)
  }, [])

  // Real-time dashboard metrics
  const { metrics, isConnected, error: dashboardError } = useAdminDashboardStream()

  // Server performance metrics
  const {
    currentMetrics: serverMetrics,
    metricsHistory,
    isConnected: serverConnected,
  } = useServerMetricsStream()

  // Measured voice capacity (load test results)
  const { data: capacity, isLoading: capacityLoading } = useCapacityMeasurements()

  // All sessions data
  const { sessions, isLoading: sessionsLoading, refetch: refetchSessions } = useAllSessions()
  const { addToast } = useToastStore()

  const handleCloseSession = useCallback(async (sessionId: string) => {
    try {
      await apiClient.closeSession(sessionId)
      addToast({ message: 'Session closed successfully', type: 'success' })
      refetchSessions()
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to close session',
        type: 'error',
      })
    }
  }, [addToast, refetchSessions])

  // Historical usage data
  const [historyDays, setHistoryDays] = useState(30)
  const {
    data: historyData,
    isLoading: historyLoading,
  } = useUsageHistory(historyDays)

  const handleRangeChange = useCallback((days: number) => {
    setHistoryDays(days)
  }, [])

  // Full-system backup import (#378) — restore a bundle (database + agent
  // packages) produced by the wizard export. Export itself is a wizard/deploy
  // script, not a dashboard action, so it can also capture deployment config.
  // Import is destructive, so a file selection opens a confirmation dialog
  // before anything is uploaded.
  const importInputRef = useRef<HTMLInputElement>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [importPassphrase, setImportPassphrase] = useState('')
  const [isImporting, setIsImporting] = useState(false)

  const handleImportFileChosen = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null
      // Reset the input so re-selecting the same file fires onChange again.
      e.target.value = ''
      if (file) setPendingImportFile(file)
    },
    [],
  )

  const summariseReport = useCallback((report: BackupImportReport): string => {
    const tableMismatches = report.tables.filter((t) => !t.match).length
    const parts = [
      `${report.tables.length} tables restored`,
      `${report.packages.restored}/${report.packages.expected} packages`,
    ]
    if (tableMismatches > 0) parts.push(`${tableMismatches} row-count mismatches`)
    if (report.orphanPackagePaths.length > 0)
      parts.push(`${report.orphanPackagePaths.length} missing package files`)
    if (report.keyStatus === 'mismatch-overridden')
      parts.push('encryption-key mismatch — secrets will not decrypt')
    return parts.join(' · ')
  }, [])

  const handleConfirmImport = useCallback(async () => {
    if (!pendingImportFile) return
    const file = pendingImportFile
    const passphrase = importPassphrase
    setPendingImportFile(null)
    setImportPassphrase('')
    setIsImporting(true)
    try {
      const report = await apiClient.importBackup(file, {
        passphrase: passphrase || undefined,
      })
      const hasIssues =
        report.tables.some((t) => !t.match) ||
        report.orphanPackagePaths.length > 0 ||
        report.keyStatus !== 'match' ||
        report.warnings.length > 0
      addToast({
        message: `Import complete — ${summariseReport(report)}`,
        type: hasIssues ? 'info' : 'success',
      })
    } catch (err) {
      const blockers = (err as { blockers?: string[] })?.blockers
      addToast({
        message: blockers?.length
          ? `Import rejected: ${blockers.join(' ')}`
          : err instanceof Error
            ? err.message
            : (err as { message?: string })?.message ?? 'Backup import failed',
        type: 'error',
      })
    } finally {
      setIsImporting(false)
    }
  }, [pendingImportFile, importPassphrase, addToast, summariseReport])

  const connectionIndicator = (
    <div className="flex items-center gap-2">
      <div
        className={`w-2 h-2 rounded-full ${
          isConnected ? 'bg-green-500' : 'bg-red-500'
        }`}
      />
      <span
        className={`text-caption ${
          isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
        }`}
      >
        {isConnected ? 'Connected' : 'Reconnecting...'}
      </span>
    </div>
  )

  const fullscreenButton = (
    <button
      onClick={toggleFullscreen}
      title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      className={`p-1.5 rounded-lg transition-colors ${
        isDark
          ? 'hover:bg-white/10 text-content-inverse-secondary'
          : 'hover:bg-black/5 text-content-secondary'
      }`}
    >
      {isFullscreen ? <CompressIcon /> : <ExpandIcon />}
    </button>
  )

  const dashboardContent = (
    <>
      {/* Stats Cards - Row 1: Core Metrics */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Active Participants"
          value={metrics?.activeParticipants ?? 0}
          subtitle={`of ${metrics?.totalParticipants ?? 0} total`}
          icon={<UsersIcon />}
          color="blue"
        />
        <StatsCard
          title="Active Agents"
          value={(metrics?.runningAgents ?? 0) + (metrics?.startingAgents ?? 0)}
          subtitle={
            metrics?.startingAgents
              ? `${metrics.runningAgents} running, ${metrics.startingAgents} starting`
              : `${metrics?.runningAgents ?? 0} running`
          }
          icon={<BotIcon />}
          color="green"
        />
        <StatsCard
          title="Active Sessions"
          value={metrics?.activeSessions ?? 0}
          subtitle={`of ${metrics?.totalSessions ?? 0} total`}
          icon={<LayersIcon />}
          color="purple"
        />
        <StatsCard
          title="Messages Today"
          value={metrics?.messagesToday ?? 0}
          subtitle={`${(metrics?.totalMessages ?? 0).toLocaleString()} total`}
          icon={<MessagesIcon />}
          color="orange"
        />
      </motion.div>

      {/* Stats Cards - Row 2: Agent Auto-Stop Metrics */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatsCard
          title="Paused Agents"
          value={metrics?.pausedAgents ?? 0}
          subtitle="Stopped due to inactivity"
          icon={<PauseIcon />}
          color="yellow"
        />
        <StatsCard
          title="Stopped Agents"
          value={metrics?.stoppedAgents ?? 0}
          subtitle={`${metrics?.failedAgents ?? 0} failed`}
          icon={<BotIcon />}
          color="gray"
        />
        <StatsCard
          title="Auto-Stop Enabled"
          value={metrics?.sessionsWithTimeout ?? 0}
          subtitle="Active sessions with timeout"
          icon={<ClockIcon />}
          color="cyan"
        />
      </motion.div>

      {/* Server Performance Monitor - Full Width */}
      <motion.div variants={itemVariants}>
        <ServerPerformanceMonitor
          currentMetrics={serverMetrics}
          metricsHistory={metricsHistory}
          isConnected={serverConnected}
        />
      </motion.div>

      {/* GPU Performance Monitor - Full Width (hidden if no GPUs) */}
      <motion.div variants={itemVariants}>
        <GpuMonitor
          currentMetrics={serverMetrics}
          metricsHistory={metricsHistory}
          isConnected={serverConnected}
        />
      </motion.div>

      {/* Measured voice capacity per GPU */}
      <motion.div variants={itemVariants}>
        <CapacityCard measurements={capacity} isLoading={capacityLoading} />
      </motion.div>

      {/* Sessions Grid */}
      <motion.div variants={itemVariants}>
        <SessionsGrid sessions={sessions} isLoading={sessionsLoading} onCloseSession={handleCloseSession} />
      </motion.div>

      {/* Historical Usage Charts */}
      <motion.div variants={itemVariants}>
        <HistoricalUsageCharts
          data={historyData}
          isLoading={historyLoading}
          onRangeChange={handleRangeChange}
        />
      </motion.div>

      {/* Failed Agents Warning */}
      {metrics && metrics.failedAgents > 0 && (
        <motion.div
          variants={itemVariants}
          className={`p-4 rounded-xl border ${
            isDark
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-red-50 border-red-200 text-red-600'
          }`}
        >
          <div className="flex items-center gap-3">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <p className="font-medium">
                {metrics.failedAgents} agent{metrics.failedAgents > 1 ? 's' : ''} failed
              </p>
              <p
                className={`text-caption ${
                  isDark ? 'text-red-400/70' : 'text-red-500'
                }`}
              >
                Check agent logs for deployment errors
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Full-system backup (#378) */}
      <motion.div
        variants={itemVariants}
        className={`p-5 rounded-xl border ${
          isDark ? 'bg-white/5 border-white/10' : 'bg-black/[0.02] border-black/5'
        }`}
      >
        <h3
          className={`text-body font-medium mb-1 ${
            isDark ? 'text-content-inverse' : 'text-content'
          }`}
        >
          Restore from backup
        </h3>
        <p
          className={`text-caption mb-4 ${
            isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
          }`}
        >
          Import a full-system backup bundle (database + agent packages) produced
          by the deployment&apos;s export script. This replaces all current data.
          If the bundle was encrypted at export, you&apos;ll be asked for its
          passphrase.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,.enc"
            className="hidden"
            onChange={handleImportFileChosen}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={isImporting}
            className={`px-4 py-2 rounded-lg text-body-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isDark
                ? 'bg-red-500/15 hover:bg-red-500/25 text-red-300'
                : 'bg-red-50 hover:bg-red-100 text-red-600'
            }`}
          >
            {isImporting ? 'Importing…' : 'Import backup…'}
          </button>
        </div>
      </motion.div>
    </>
  )

  return (
    <div ref={fullscreenRef}>
      {/* Backup import confirmation (#378) — destructive, requires explicit OK. */}
      {pendingImportFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
              isDark
                ? 'bg-surface-dark border-white/10'
                : 'bg-surface border-black/10'
            }`}
          >
            <h3
              className={`text-heading-sm mb-2 ${
                isDark ? 'text-content-inverse' : 'text-content'
              }`}
            >
              Overwrite everything?
            </h3>
            <p
              className={`text-body-sm mb-3 ${
                isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
              }`}
            >
              Importing{' '}
              <span className="font-medium break-all">
                {pendingImportFile.name}
              </span>{' '}
              will <strong>permanently replace ALL current data</strong> —
              users, projects, sessions, messages and agent packages. This cannot
              be undone. Export a backup first if you may need the current state.
            </p>
            <p
              className={`text-caption mb-4 ${
                isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
              }`}
            >
              The import is rejected automatically if the bundle's schema or
              encryption key does not match this server.
            </p>
            <input
              type="password"
              value={importPassphrase}
              onChange={(e) => setImportPassphrase(e.target.value)}
              placeholder="Passphrase (only if the backup is encrypted)"
              autoComplete="off"
              className={`w-full mb-5 px-3 py-2 rounded-lg text-body-sm border outline-none ${
                isDark
                  ? 'bg-white/5 border-white/10 text-content-inverse placeholder:text-content-inverse-tertiary'
                  : 'bg-black/[0.02] border-black/10 text-content placeholder:text-content-tertiary'
              }`}
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setPendingImportFile(null)
                  setImportPassphrase('')
                }}
                className={`px-4 py-2 rounded-lg text-body-sm font-medium transition-colors ${
                  isDark
                    ? 'bg-white/10 hover:bg-white/15 text-content-inverse'
                    : 'bg-black/5 hover:bg-black/10 text-content'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmImport}
                className="px-4 py-2 rounded-lg text-body-sm font-medium transition-colors bg-red-600 hover:bg-red-700 text-white"
              >
                Overwrite &amp; import
              </button>
            </div>
          </div>
        </div>
      )}
      {isFullscreen ? (
        /* Fullscreen layout — fills the entire screen */
        <div
          className={`h-screen flex flex-col ${
            isDark ? 'bg-surface-dark' : 'bg-surface'
          }`}
        >
          {/* Top bar */}
          <div
            className={`flex-shrink-0 border-b px-6 py-3 flex items-center justify-between ${
              isDark ? 'border-white/10' : 'border-black/5'
            }`}
          >
            <div className="flex items-center gap-4">
              <h2
                className={`text-heading-lg ${
                  isDark ? 'text-content-inverse' : 'text-content'
                }`}
              >
                Resource Dashboard
              </h2>
              {connectionIndicator}
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`text-caption ${
                  isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                }`}
              >
                ESC to exit
              </span>
              {fullscreenButton}
            </div>
          </div>

          {/* Scrollable dashboard content */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-[1400px] mx-auto px-6 py-6">
              {dashboardError && (
                <p className="text-caption text-red-500 mb-4">{dashboardError}</p>
              )}
              <motion.div
                className="space-y-6"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
              >
                {dashboardContent}
              </motion.div>
            </div>
          </div>
        </div>
      ) : (
        /* Inline layout — embedded in settings page */
        <motion.div
          className="max-w-6xl space-y-6 pb-12"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {/* Header */}
          <motion.div variants={itemVariants}>
            <h2
              className={`text-heading-lg mb-2 ${
                isDark ? 'text-content-inverse' : 'text-content'
              }`}
            >
              Resource Dashboard
            </h2>
            <div className="flex items-center gap-4">
              <p
                className={`text-body-sm ${
                  isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                }`}
              >
                Real-time platform monitoring and metrics
              </p>
              {connectionIndicator}
              {fullscreenButton}
            </div>
            {dashboardError && (
              <p className="text-caption text-red-500 mt-1">{dashboardError}</p>
            )}
          </motion.div>

          {dashboardContent}
        </motion.div>
      )}
    </div>
  )
}
