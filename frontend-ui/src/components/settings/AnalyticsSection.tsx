import { useState, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../store/themeStore'
import { useAgentMetrics } from '../../hooks/useAgentMetrics'
import { useStageDataPoints } from '../../hooks/useStageDataPoints'
import { apiClient } from '../../services/ApiClient'
import StageTimeline from './analytics/StageTimeline'
import SessionAnalyticsModal from '../modals/SessionAnalyticsModal'
import type { ProjectWithCounts, AgentType, PlanCompletionSession } from '../../lib/api-types'

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
}

const DAY_OPTIONS = [7, 30, 90] as const

export default function AnalyticsSection() {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Selector state
  const [projects, setProjects] = useState<ProjectWithCounts[]>([])
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null)
  const [days, setDays] = useState<number>(30)

  // Timeline drill-down state
  const [selectedStage, setSelectedStage] = useState<string | null>(null)

  // Session analytics modal state
  const [modalSessionId, setModalSessionId] = useState<string | null>(null)

  // Plan completion drill-down state
  const [showPlanDrillDown, setShowPlanDrillDown] = useState(false)
  const [planSessions, setPlanSessions] = useState<PlanCompletionSession[]>([])
  const [planSessionsLoading, setPlanSessionsLoading] = useState(false)
  const [planSortBy, setPlanSortBy] = useState<'rate' | 'name' | 'date'>('rate')
  const [planSortDir, setPlanSortDir] = useState<'asc' | 'desc'>('asc')

  // Fetch projects and agent types on mount
  useEffect(() => {
    apiClient.listProjects().then((p) => {
      setProjects(p)
      if (p.length > 0 && !selectedProjectId) setSelectedProjectId(p[0].id)
    }).catch(() => {})
    apiClient.getAgentTypes().then((a) => {
      setAgentTypes(a)
      if (a.length > 0 && !selectedAgentSlug) setSelectedAgentSlug(a[0].slug)
    }).catch(() => {})
  }, [])

  const { data, isLoading, error } = useAgentMetrics(selectedProjectId, selectedAgentSlug, days)

  // Date range for drill-down
  const dateRange = useMemo(() => {
    const to = new Date().toISOString()
    const from = new Date(Date.now() - days * 86400000).toISOString()
    return { from, to }
  }, [days])

  // Lazy-load raw data points when a stage is selected
  const { points: stageDataPoints } = useStageDataPoints(
    selectedProjectId,
    selectedAgentSlug,
    selectedStage,
    dateRange.from,
    dateRange.to,
  )

  // Reset selected stage and drill-down when changing agent/project/days
  useEffect(() => {
    setSelectedStage(null)
    setShowPlanDrillDown(false)
    setPlanSessions([])
  }, [selectedProjectId, selectedAgentSlug, days])

  // Lazy-load per-session plan completion data when drill-down is opened
  useEffect(() => {
    if (!showPlanDrillDown || !selectedProjectId || !selectedAgentSlug) return
    setPlanSessionsLoading(true)
    apiClient.getPlanCompletionSessions(selectedProjectId, selectedAgentSlug, dateRange.from, dateRange.to)
      .then((res) => setPlanSessions(res.sessions))
      .catch(() => setPlanSessions([]))
      .finally(() => setPlanSessionsLoading(false))
  }, [showPlanDrillDown, selectedProjectId, selectedAgentSlug, dateRange.from, dateRange.to])

  const handlePlanSort = useCallback((col: 'rate' | 'name' | 'date') => {
    if (planSortBy === col) {
      setPlanSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setPlanSortBy(col)
      setPlanSortDir(col === 'rate' ? 'asc' : col === 'date' ? 'desc' : 'asc')
    }
  }, [planSortBy])

  const sortedPlanSessions = useMemo(() => {
    const sessions = [...planSessions]
    sessions.sort((a, b) => {
      let cmp = 0
      if (planSortBy === 'rate') cmp = a.completionRate - b.completionRate
      else if (planSortBy === 'name') cmp = a.sessionName.localeCompare(b.sessionName)
      else cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      return planSortDir === 'asc' ? cmp : -cmp
    })
    return sessions
  }, [planSessions, planSortBy, planSortDir])

  // max-w-full+truncate: a project or agent-type name longer than the
  // viewport otherwise sizes the native <select> to its widest option,
  // pushing it past the screen edge on phone (#102).
  const selectClass = `max-w-full truncate rounded-lg px-3 py-2 text-sm ${
    isDark
      ? 'bg-surface-dark-tertiary text-content-inverse border border-border-dark'
      : 'bg-white text-content border border-neutral-200'
  }`

  // Plan completion data from summary
  const planCompletion = data?.summary?.planCompletion

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6 pb-12"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <h2 className={`text-heading-lg ${isDark ? 'text-content-inverse' : 'text-content'}`}>
          Analytics
        </h2>
        <p className={`mt-1 text-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
          Agent performance metrics and latency analysis
        </p>
      </motion.div>

      {/* Selectors */}
      <motion.div variants={itemVariants} className="flex flex-wrap items-center gap-3">
        <select
          value={selectedProjectId || ''}
          onChange={(e) => setSelectedProjectId(e.target.value || null)}
          className={selectClass}
        >
          <option value="">Select project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <select
          value={selectedAgentSlug || ''}
          onChange={(e) => setSelectedAgentSlug(e.target.value || null)}
          className={selectClass}
        >
          <option value="">Select agent type</option>
          {agentTypes.map((a) => (
            <option key={a.slug} value={a.slug}>{a.name}</option>
          ))}
        </select>

        <div className={`flex rounded-lg overflow-hidden text-xs ${isDark ? 'bg-surface-dark-tertiary' : 'bg-neutral-100'}`}>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 coarse:px-4 py-2 coarse:py-3 transition-colors ${
                days === d
                  ? isDark ? 'bg-purple-600 text-white' : 'bg-neutral-900 text-white'
                  : isDark ? 'text-content-inverse-secondary hover:text-content-inverse' : 'text-content-secondary hover:text-content'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        {data && (
          <span className={`text-xs tabular-nums ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
            {data.totalSessions} session{data.totalSessions !== 1 ? 's' : ''} · {data.totalTurns} turn{data.totalTurns !== 1 ? 's' : ''}
          </span>
        )}
      </motion.div>

      {/* Loading / Error */}
      {isLoading && (
        <motion.div variants={itemVariants} className={`rounded-xl p-8 text-center ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200'}`}>
          <p className={isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}>Loading metrics...</p>
        </motion.div>
      )}

      {error && (
        <motion.div variants={itemVariants} className="rounded-xl p-4 bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
          {error}
        </motion.div>
      )}

      {data && !isLoading && (
        <>
          {/* Pipeline Timeline */}
          <motion.div variants={itemVariants}>
            <StageTimeline
              stages={data.stages}
              mode="aggregate"
              selectedStage={selectedStage}
              onStageSelect={setSelectedStage}
              selectedStagePoints={stageDataPoints}
              onSessionClick={setModalSessionId}
            />
          </motion.div>

          {/* Plan Completion & Deliverable Collection */}
          {planCompletion && (
            <motion.div variants={itemVariants}>
              <div className={`rounded-xl overflow-hidden ${isDark ? 'bg-surface-dark-secondary' : 'bg-white border border-neutral-200'}`}>
                <div
                  className={`px-5 py-3 border-b cursor-pointer select-none flex items-center justify-between ${isDark ? 'border-border-dark hover:bg-surface-dark-tertiary/50' : 'border-neutral-200 hover:bg-neutral-50'} transition-colors`}
                  onClick={() => setShowPlanDrillDown(v => !v)}
                >
                  <h3 className={`text-sm font-semibold ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                    Plan Completion & Deliverable Collection
                  </h3>
                  <span className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                    {showPlanDrillDown ? 'Hide' : 'Click to view'} per-session breakdown
                    <span className="ml-1">{showPlanDrillDown ? '▲' : '▼'}</span>
                  </span>
                </div>
                <div className="p-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Plan Completion Rate */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                          Plan Completion Rate
                        </span>
                        <span className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                          {planCompletion.completedPlans}/{planCompletion.totalSessions} plans
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mb-2">
                        <span className={`text-2xl font-bold tabular-nums ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                          {planCompletion.totalSessions > 0 ? Math.round((planCompletion.completedPlans / planCompletion.totalSessions) * 100) : 0}%
                        </span>
                      </div>
                      <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-surface-dark-tertiary' : 'bg-neutral-100'}`}>
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-500"
                          style={{ width: `${planCompletion.totalSessions > 0 ? Math.round((planCompletion.completedPlans / planCompletion.totalSessions) * 100) : 0}%` }}
                        />
                      </div>
                      <p className={`text-xs mt-1.5 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                        Sessions that reached the final plan state
                      </p>
                    </div>

                    {/* Deliverable Collection Rate */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                          Deliverable Collection Rate
                        </span>
                        <span className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                          avg across {planCompletion.totalSessions} session{planCompletion.totalSessions !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mb-2">
                        <span className={`text-2xl font-bold tabular-nums ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                          {Math.round(planCompletion.avgCompletionRate * 100)}%
                        </span>
                      </div>
                      <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-surface-dark-tertiary' : 'bg-neutral-100'}`}>
                        <div
                          className="h-full rounded-full bg-green-500 transition-all duration-500"
                          style={{ width: `${Math.round(planCompletion.avgCompletionRate * 100)}%` }}
                        />
                      </div>
                      <p className={`text-xs mt-1.5 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                        Average % of required deliverables collected per session
                      </p>
                    </div>
                  </div>

                  {/* Drill-down: Per-session breakdown */}
                  <AnimatePresence>
                    {showPlanDrillDown && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className={`mt-5 pt-5 border-t ${isDark ? 'border-border-dark' : 'border-neutral-200'}`}>
                          {planSessionsLoading ? (
                            <p className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                              Loading per-session data...
                            </p>
                          ) : sortedPlanSessions.length === 0 ? (
                            <p className={`text-xs ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                              No plan completion data available
                            </p>
                          ) : (
                            <>
                              <div className="flex items-center justify-between mb-3">
                                <span className={`text-xs font-medium ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                                  {sortedPlanSessions.length} session{sortedPlanSessions.length !== 1 ? 's' : ''}
                                </span>
                                {(() => {
                                  const lowOutliers = sortedPlanSessions.filter(s => s.completionRate < 0.5)
                                  return lowOutliers.length > 0 ? (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 font-medium">
                                      {lowOutliers.length} session{lowOutliers.length !== 1 ? 's' : ''} below 50%
                                    </span>
                                  ) : null
                                })()}
                              </div>

                              {/* Distribution dots */}
                              <div className={`rounded-lg p-3 mb-3 ${isDark ? 'bg-surface-dark-tertiary' : 'bg-neutral-50'}`}>
                                <div className="relative h-8">
                                  {/* Axis labels */}
                                  <span className={`absolute left-0 bottom-0 text-[10px] ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>0%</span>
                                  <span className={`absolute left-1/2 -translate-x-1/2 bottom-0 text-[10px] ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>50%</span>
                                  <span className={`absolute right-0 bottom-0 text-[10px] ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>100%</span>
                                  {/* Axis line */}
                                  <div className={`absolute left-0 right-0 top-3 h-px ${isDark ? 'bg-border-dark' : 'bg-neutral-300'}`} />
                                  {/* 50% marker */}
                                  <div className={`absolute left-1/2 top-1 h-4 w-px ${isDark ? 'bg-border-dark' : 'bg-neutral-300'}`} style={{ opacity: 0.5 }} />
                                  {/* Session dots */}
                                  {sortedPlanSessions.map((s) => {
                                    const isLow = s.completionRate < 0.5
                                    return (
                                      <div
                                        key={s.sessionId}
                                        className="absolute top-1.5 w-2 h-2 rounded-full cursor-pointer transition-transform hover:scale-150"
                                        style={{
                                          left: `${Math.round(s.completionRate * 100)}%`,
                                          transform: 'translateX(-50%)',
                                          backgroundColor: isLow ? '#F59E0B' : s.reachedEnd ? '#22C55E' : (isDark ? '#8B5CF6' : '#7C3AED'),
                                          opacity: 0.85,
                                        }}
                                        title={`${s.sessionName}: ${Math.round(s.completionRate * 100)}%${s.reachedEnd ? ' (completed)' : ''}`}
                                        onClick={() => setModalSessionId(s.sessionId)}
                                      />
                                    )
                                  })}
                                </div>
                              </div>

                              {/* Session table */}
                              <div className="max-h-64 overflow-y-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className={isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}>
                                      <th
                                        className="text-left pb-2 font-medium cursor-pointer select-none"
                                        onClick={() => handlePlanSort('name')}
                                      >
                                        Session {planSortBy === 'name' ? (planSortDir === 'asc' ? '↑' : '↓') : ''}
                                      </th>
                                      <th
                                        className="text-right pb-2 font-medium cursor-pointer select-none"
                                        onClick={() => handlePlanSort('rate')}
                                      >
                                        Deliverable Rate {planSortBy === 'rate' ? (planSortDir === 'asc' ? '↑' : '↓') : ''}
                                      </th>
                                      <th className="text-right pb-2 font-medium">Plan</th>
                                      <th
                                        className="text-right pb-2 font-medium cursor-pointer select-none"
                                        onClick={() => handlePlanSort('date')}
                                      >
                                        Date {planSortBy === 'date' ? (planSortDir === 'asc' ? '↑' : '↓') : ''}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sortedPlanSessions.map((s) => {
                                      const pct = Math.round(s.completionRate * 100)
                                      const isLow = pct < 50
                                      return (
                                        <tr
                                          key={s.sessionId}
                                          onClick={() => setModalSessionId(s.sessionId)}
                                          className={`border-t cursor-pointer ${
                                            isLow
                                              ? isDark
                                                ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10'
                                                : 'border-amber-200 bg-amber-50/50 hover:bg-amber-50'
                                              : isDark
                                                ? 'border-border-dark hover:bg-surface-dark-tertiary'
                                                : 'border-neutral-100 hover:bg-neutral-50'
                                          } transition-colors`}
                                        >
                                          <td className={`py-1.5 pr-3 truncate max-w-[200px] ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                                            {isLow && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5" />}
                                            {s.sessionName}
                                          </td>
                                          <td className={`py-1.5 text-right tabular-nums font-mono ${
                                            isLow
                                              ? 'text-amber-600 font-semibold'
                                              : isDark ? 'text-content-inverse' : 'text-content'
                                          }`}>
                                            {pct}%
                                          </td>
                                          <td className={`py-1.5 text-right ${
                                            s.reachedEnd
                                              ? 'text-green-500'
                                              : isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
                                          }`}>
                                            {s.reachedEnd ? 'Completed' : 'Incomplete'}
                                          </td>
                                          <td className={`py-1.5 text-right ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                                            {new Date(s.timestamp).toLocaleDateString()}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </>
      )}

      {/* Session Analytics Modal */}
      <SessionAnalyticsModal
        isOpen={modalSessionId != null}
        onClose={() => setModalSessionId(null)}
        projectId={selectedProjectId || ''}
        sessionId={modalSessionId || ''}
      />
    </motion.div>
  )
}
