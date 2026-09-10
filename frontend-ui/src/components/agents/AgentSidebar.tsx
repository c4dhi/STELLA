import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { apiClient } from '../../services/ApiClient'
import ConfirmDialog from '../modals/ConfirmDialog'
import { useToastStore } from '../../store/toastStore'
import { useThemeStore } from '../../store/themeStore'
import { useStore } from '../../store'
import type { AgentInstance, AgentWithPodStatus } from '../../lib/api-types'
import { AgentStatus, POLL_INTERVALS } from '../../lib/api-types'
import { getRuntimeConfig } from '../../config/runtime'
import { usePageVisibility } from '../../hooks/usePageVisibility'
import { areAgentListsEqual } from '../../lib/sessionPollEquality'

interface AgentSidebarProps {
  sessionId: string
  initialAgents?: AgentInstance[]
  onDeployClick: () => void
}

export default function AgentSidebar({ sessionId, initialAgents = [], onDeployClick }: AgentSidebarProps) {
  const { addToast } = useToastStore()
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'
  const isPageVisible = usePageVisibility()
  const removeAgentFromTimeline = useStore(s => s.removeAgentFromTimeline)
  const agentTaskLists = useStore(s => s.agentTaskLists)
  const taskUpdateHistory = useStore(s => s.taskUpdateHistory)
  const [agents, setAgents] = useState<AgentInstance[]>(initialAgents)
  const [selectedAgent, setSelectedAgent] = useState<AgentWithPodStatus | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<string>('')
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [liveLogsMap, setLiveLogsMap] = useState<Map<string, string>>(new Map())
  const [eventSourcesMap] = useState<Map<string, EventSource>>(new Map())
  const [maximizedLogAgent, setMaximizedLogAgent] = useState<string | null>(null)

  // Auto-scroll state: track if each agent's logs should auto-scroll
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<Map<string, boolean>>(new Map())

  // Refs for log containers
  const inlineLogRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const maximizedLogRef = useRef<HTMLDivElement | null>(null)

  // Confirmation dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean
    title: string
    message: string
    onConfirm: () => void
    confirmText?: string
    variant?: 'danger' | 'primary'
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  })

  // Track previous agent statuses to detect STARTING -> RUNNING transitions
  const prevAgentStatusesRef = useRef<Map<string, string>>(new Map())

  /** The live progress state for an agent, if it has published one yet.
   *
   * Progress updates are keyed by whatever the agent reported as its id, which
   * is not always the DB id — hence the same pod-name fuzzy match the delete
   * path uses. Keep the two in step: a mismatch here shows a stale plan, a
   * mismatch there leaks a deleted agent's timeline. */
  const findLiveTaskList = (agent: AgentInstance) => {
    const direct = agentTaskLists.get(agent.id)
    if (direct) return direct
    const podName = (agent as AgentWithPodStatus).podName
    if (!podName) return undefined
    for (const [taskAgentId, list] of agentTaskLists.entries()) {
      if (
        taskAgentId === podName ||
        podName.startsWith(taskAgentId + '-') ||
        podName.includes(taskAgentId)
      ) {
        return list
      }
    }
    return undefined
  }

  // Sync agents when initialAgents prop changes (immediate update from parent)
  useEffect(() => {
    setAgents(initialAgents)
  }, [initialAgents])

  // Auto-expand logs when agent transitions to RUNNING
  useEffect(() => {
    agents.forEach(agent => {
      const prevStatus = prevAgentStatusesRef.current.get(agent.id)
      const currentStatus = agent.status

      // Detect STARTING -> RUNNING transition
      if (prevStatus === 'STARTING' && currentStatus === 'RUNNING') {
        console.log(`[AgentSidebar] Agent ${agent.name} is now RUNNING, auto-expanding logs`)

        // Auto-expand logs for this agent
        if (!expandedLogs.has(agent.id) && agent.podName) {
          const newExpanded = new Set(expandedLogs)
          newExpanded.add(agent.id)
          setExpandedLogs(newExpanded)

          // Enable auto-scroll for this agent
          const newAutoScroll = new Map(autoScrollEnabled)
          newAutoScroll.set(agent.id, true)
          setAutoScrollEnabled(newAutoScroll)

          // Start log stream
          startLogStream(agent.id)
        }
      }

      // Update previous status
      prevAgentStatusesRef.current.set(agent.id, currentStatus)
    })
  }, [agents])

  // Poll for agents as a fallback — SSE in SessionView is the primary signal (it refreshes
  // initialAgents on agent.*), the server stays source of truth. Pauses while the tab is
  // hidden, and only commits when the list actually changed so an unchanged poll doesn't
  // churn a new array ref and re-render the list every 2 s. See ticket #305.
  useEffect(() => {
    if (!isPageVisible) return

    const interval = setInterval(async () => {
      try {
        const session = await apiClient.getSession(sessionId)
        setAgents(prev => (areAgentListsEqual(prev, session.agents) ? prev : session.agents))
      } catch (err) {
        console.error('Failed to refresh agents:', err)
      }
    }, POLL_INTERVALS.AGENTS)

    return () => clearInterval(interval)
  }, [sessionId, isPageVisible])

  // Deploy new agent
  const handleDeployAgent = async (
    name: string,
    icon?: string,
    config?: Record<string, unknown>,
    agentType?: string,
    // Optional saved template selected during deploy (backend resolves encrypted values).
    envVarTemplateId?: string,
    // Optional one-time manual env vars entered in the deploy flow.
    envVars?: Record<string, string>,
    // Optional saved pipeline configuration selected during deploy (resolved by ID server-side).
    agentConfigurationId?: string,
    // Optional persona (agent identity), resolved and snapshotted by ID server-side.
    personaId?: string
  ) => {
    // Keep payload shape aligned with SessionView/DeployAgentModal so this helper
    // does not silently drop env var inputs if it becomes active again.
    const newAgent = await apiClient.createAgent(sessionId, { name, icon, config, agentType, envVarTemplateId, envVars, agentConfigurationId, personaId })
    setAgents(prev => [...prev, newAgent])

    // Auto-expand console to show deployment progress
    setExpandedLogs(prev => new Set([...prev, newAgent.id]))

    // Start log stream after a short delay for pod to be created
    setTimeout(() => {
      startLogStream(newAgent.id)
    }, 2000)
  }

  // Stop agent
  const handleStopAgent = (agentId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Stop Agent',
      message: 'Are you sure you want to stop this agent? It will disconnect from the session.',
      confirmText: 'Stop Agent',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }))
        try {
          await apiClient.stopAgent(agentId)
          setAgents(prev =>
            prev.map(a => (a.id === agentId ? { ...a, status: 'STOPPING' as AgentStatus } : a))
          )
          addToast({ message: 'Agent stopped successfully', type: 'success' })
        } catch (err) {
          addToast({
            message: err instanceof Error ? err.message : 'Failed to stop agent',
            type: 'error'
          })
        }
      },
    })
  }

  // Restart agent
  const handleRestartAgent = (agentId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Restart Agent',
      message: 'Restart this agent? This will create a new pod with updated configuration.',
      confirmText: 'Restart Agent',
      variant: 'primary',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }))

        // Close existing log stream if active
        const existingEventSource = eventSourcesMap.get(agentId)
        if (existingEventSource) {
          existingEventSource.close()
          eventSourcesMap.delete(agentId)
        }

        // Clear old logs
        const newLogsMap = new Map(liveLogsMap)
        newLogsMap.delete(agentId)
        setLiveLogsMap(newLogsMap)

        try {
          await apiClient.restartAgent(agentId)
          setAgents(prev =>
            prev.map(a => (a.id === agentId ? { ...a, status: 'STARTING' as AgentStatus } : a))
          )

          // Restart log stream if logs were expanded
          if (expandedLogs.has(agentId)) {
            // Small delay to allow pod to be created
            setTimeout(() => {
              startLogStream(agentId)
            }, 2000)
          }

          addToast({ message: 'Agent restarted successfully', type: 'success' })
        } catch (err) {
          addToast({
            message: err instanceof Error ? err.message : 'Failed to restart agent',
            type: 'error'
          })
        }
      },
    })
  }

  // Delete agent permanently
  const handleDeleteAgent = (agentId: string) => {
    // Capture agent info before deletion for todo data matching
    const agentToDelete = agents.find(a => a.id === agentId)

    setConfirmDialog({
      isOpen: true,
      title: 'Delete Agent',
      message: 'Permanently delete this agent? This will remove all data and cannot be undone.',
      confirmText: 'Delete Permanently',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }))
        try {
          await apiClient.deleteAgent(agentId)
          setAgents(prev => prev.filter(a => a.id !== agentId))

          // Purge todo data for this agent from the timeline
          // Match agentTaskLists keys using same fuzzy logic as SessionView
          const keysToRemove = new Set<string>()

          // Check agentTaskLists keys
          for (const taskAgentId of agentTaskLists.keys()) {
            if (
              taskAgentId === agentId ||
              (agentToDelete?.podName && (
                taskAgentId === agentToDelete.podName ||
                agentToDelete.podName.startsWith(taskAgentId + '-') ||
                agentToDelete.podName.includes(taskAgentId)
              ))
            ) {
              keysToRemove.add(taskAgentId)
            }
          }

          // Also check taskUpdateHistory for matching agentIds
          for (const entry of taskUpdateHistory) {
            if (
              entry.agentId === agentId ||
              (agentToDelete?.podName && (
                entry.agentId === agentToDelete.podName ||
                agentToDelete.podName.startsWith(entry.agentId + '-') ||
                agentToDelete.podName.includes(entry.agentId)
              ))
            ) {
              keysToRemove.add(entry.agentId)
            }
          }

          // Remove all matched keys from timeline
          keysToRemove.forEach(key => removeAgentFromTimeline(key))

          addToast({ message: 'Agent deleted successfully', type: 'success' })
        } catch (err) {
          addToast({
            message: err instanceof Error ? err.message : 'Failed to delete agent',
            type: 'error'
          })
        }
      },
    })
  }

  // View agent details
  const handleViewAgent = async (agentId: string) => {
    try {
      const agent = await apiClient.getAgent(agentId)
      setSelectedAgent(agent)
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to load agent details',
        type: 'error'
      })
    }
  }

  // View agent logs
  const handleViewLogs = async (agentId: string) => {
    try {
      const logsData = await apiClient.getAgentLogs(agentId)
      setLogs(logsData)
      setShowLogs(true)
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to load agent logs',
        type: 'error'
      })
    }
  }

  // Toggle live logs
  const toggleLiveLogs = (agentId: string) => {
    const newExpanded = new Set(expandedLogs)

    if (expandedLogs.has(agentId)) {
      // Collapse and close EventSource
      newExpanded.delete(agentId)
      const eventSource = eventSourcesMap.get(agentId)
      if (eventSource) {
        eventSource.close()
        eventSourcesMap.delete(agentId)
      }
      const newLogsMap = new Map(liveLogsMap)
      newLogsMap.delete(agentId)
      setLiveLogsMap(newLogsMap)

      // Disable auto-scroll
      const newAutoScroll = new Map(autoScrollEnabled)
      newAutoScroll.delete(agentId)
      setAutoScrollEnabled(newAutoScroll)
    } else {
      // Expand and start streaming
      newExpanded.add(agentId)
      startLogStream(agentId)

      // Enable auto-scroll by default
      const newAutoScroll = new Map(autoScrollEnabled)
      newAutoScroll.set(agentId, true)
      setAutoScrollEnabled(newAutoScroll)
    }

    setExpandedLogs(newExpanded)
  }

  // Start log streaming for an agent
  const startLogStream = (agentId: string) => {
    const apiUrl = getRuntimeConfig().apiUrl
    const token = localStorage.getItem('stella_auth_token') || localStorage.getItem('grace_auth_token')

    // Include JWT token as query parameter for EventSource authentication
    const url = token
      ? `${apiUrl}/agents/${agentId}/logs/stream?token=${encodeURIComponent(token)}`
      : `${apiUrl}/agents/${agentId}/logs/stream`

    console.log(`[AgentSidebar] Starting log stream for agent ${agentId} at ${url}`)

    const eventSource = new EventSource(url)

    eventSource.onmessage = (event) => {
      // Use functional update to avoid stale closure issue
      setLiveLogsMap(prevMap => {
        const newMap = new Map(prevMap)
        newMap.set(agentId, event.data)
        return newMap
      })
    }

    eventSource.onerror = (error) => {
      console.error('[AgentSidebar] EventSource error:', error)
      eventSource.close()
      eventSourcesMap.delete(agentId)

      // Set error message in logs - pod might not exist
      setLiveLogsMap(prevMap => {
        const newMap = new Map(prevMap)
        const existingLogs = prevMap.get(agentId) || ''
        if (!existingLogs) {
          newMap.set(agentId, '[Console unavailable - agent pod may have been terminated]\n\nThe agent pod no longer exists in the cluster.\nThis can happen if:\n  - The agent crashed or was stopped\n  - The cluster was restarted\n  - The pod was manually deleted\n\nTry restarting the agent to view logs.')
        }
        return newMap
      })
    }

    eventSource.onopen = () => {
      console.log(`[AgentSidebar] Log stream connected for agent ${agentId}`)
    }

    eventSourcesMap.set(agentId, eventSource)
  }

  // Cleanup EventSources on unmount
  useEffect(() => {
    return () => {
      eventSourcesMap.forEach(eventSource => eventSource.close())
      eventSourcesMap.clear()
    }
  }, [])

  // Handle scroll detection: disable auto-scroll if user scrolls up
  const handleLogScroll = (agentId: string, event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const isAtBottom = Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) < 50

    const currentAutoScroll = autoScrollEnabled.get(agentId)
    if (isAtBottom && !currentAutoScroll) {
      // User scrolled back to bottom, re-enable auto-scroll
      const newAutoScroll = new Map(autoScrollEnabled)
      newAutoScroll.set(agentId, true)
      setAutoScrollEnabled(newAutoScroll)
    } else if (!isAtBottom && currentAutoScroll) {
      // User scrolled up, disable auto-scroll
      const newAutoScroll = new Map(autoScrollEnabled)
      newAutoScroll.set(agentId, false)
      setAutoScrollEnabled(newAutoScroll)
    }
  }

  // Auto-scroll logs when new data arrives (if enabled)
  useEffect(() => {
    liveLogsMap.forEach((_, agentId) => {
      const shouldAutoScroll = autoScrollEnabled.get(agentId)
      if (!shouldAutoScroll) return

      // Scroll inline logs if expanded
      if (expandedLogs.has(agentId)) {
        const inlineLogElement = inlineLogRefs.current.get(agentId)
        if (inlineLogElement) {
          inlineLogElement.scrollTop = inlineLogElement.scrollHeight
        }
      }

      // Scroll maximized logs if this agent is maximized
      if (maximizedLogAgent === agentId && maximizedLogRef.current) {
        maximizedLogRef.current.scrollTop = maximizedLogRef.current.scrollHeight
      }
    })
  }, [liveLogsMap, autoScrollEnabled, expandedLogs, maximizedLogAgent])

  // Enable auto-scroll when maximizing logs
  useEffect(() => {
    if (maximizedLogAgent) {
      const newAutoScroll = new Map(autoScrollEnabled)
      newAutoScroll.set(maximizedLogAgent, true)
      setAutoScrollEnabled(newAutoScroll)
    }
  }, [maximizedLogAgent])

  const getStatusColor = (status: AgentStatus) => {
    switch (status) {
      case 'RUNNING':
        return isDark
          ? 'bg-green-500/20 text-green-400 border-green-500/30'
          : 'bg-green-50 text-green-700 border-green-200'
      case 'STARTING':
        return isDark
          ? 'bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse'
          : 'bg-blue-50 text-blue-700 border-blue-200 animate-pulse'
      case 'STOPPING':
        return isDark
          ? 'bg-orange-500/20 text-orange-400 border-orange-500/30 animate-pulse'
          : 'bg-amber-50 text-amber-700 border-amber-200 animate-pulse'
      case 'STOPPED':
        return isDark
          ? 'bg-white/10 text-content-inverse-secondary border-white/10'
          : 'bg-surface-tertiary text-content-secondary border-border'
      case 'FAILED':
        return isDark
          ? 'bg-red-500/20 text-red-400 border-red-500/30'
          : 'bg-red-50 text-red-600 border-red-200'
      default:
        return isDark
          ? 'bg-white/10 text-content-inverse-secondary border-white/10'
          : 'bg-surface-tertiary text-content-secondary border-border'
    }
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="w-80 flex flex-col"
      >
        {/* Agents Panel */}
        <div
          className={`
            backdrop-blur-xl rounded-[16px] h-full flex flex-col overflow-hidden
            ${isDark
              ? 'bg-white/5 border border-white/10'
              : 'bg-white border border-border shadow-sm'
            }
          `}
        >
          {/* Header */}
          <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-border'}`}>
            <h2 className={`text-lg font-thin tracking-wider mb-1 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              Agents
            </h2>
            <p className={`text-[10px] font-light tracking-wider uppercase ${isDark ? 'text-content-inverse-secondary' : 'text-content-tertiary'}`}>
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'} deployed
            </p>
          </div>

          {/* Deploy Button */}
          <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-border'}`}>
            <button
              onClick={onDeployClick}
              className={`
                w-full py-2.5 px-4 rounded-xl text-sm font-light tracking-wider
                transition-all duration-200 flex items-center justify-center gap-2
                ${isDark
                  ? 'bg-primary-500 text-white hover:bg-primary-400 hover:shadow-primary border border-primary-400/30'
                  : 'bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm'
                }
              `}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Deploy Agent
            </button>
          </div>

          {/* Agents List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {agents.length === 0 ? (
              <div className={`text-center py-8 text-sm font-light ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                No agents deployed yet
              </div>
            ) : (
              agents.map(agent => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`
                    p-4 rounded-xl transition-[color,background-color,border-color,box-shadow] duration-200
                    ${isDark
                      ? 'bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20'
                      : 'bg-white border border-neutral-200 hover:border-neutral-300 shadow-sm'
                    }
                  `}
                >
                  {/* Agent Name */}
                  <div className="flex items-start justify-between mb-2">
                    <div className={`text-sm font-light flex items-center gap-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                      <span>{agent.icon || '🤖'}</span>
                      <span>{agent.name}</span>
                    </div>
                    <div
                      className={`
                        px-2 py-0.5 rounded text-[10px] font-light tracking-wider uppercase border
                        ${getStatusColor(agent.status)}
                      `}
                    >
                      {agent.status}
                    </div>
                  </div>

                  {/* What this agent was deployed WITH — its identity and its plan.
                      This used to be JSON.stringify(agent.agentConfig) in a truncate
                      div, which rendered as a bare "..." because the config is many
                      thousands of characters (pipeline config, prompts, and now the
                      persona snapshot). It read as a menu and carried no information. */}
                  {(() => {
                    const cfg = (agent.agentConfig || {}) as {
                      persona?: { name?: string; icon?: string }
                      plan?: { title?: string }
                      mode?: string
                      available_plans?: Array<{ title?: string }>
                    }
                    const personaName = cfg.persona?.name

                    // A companion has no plan at deploy time and picks one up (or
                    // drops it) mid-session, so the deploy snapshot cannot answer
                    // "what is running right now" — only the live progress stream can.
                    const companion = findLiveTaskList(agent)?.companion
                    const isCompanion = !!companion || cfg.mode === 'companion'
                    const activePlan = isCompanion
                      ? companion?.active_activity || null
                      : cfg.plan?.title || null

                    // Nothing running: show what the user can actually pick. Falls
                    // back to the deploy snapshot for the window between deploy and
                    // the agent's first progress update, when there is no live state.
                    const options = isCompanion && !activePlan
                      ? (companion?.activities ?? cfg.available_plans ?? [])
                          .map(a => a.title)
                          .filter((t): t is string => !!t)
                      : []

                    if (!personaName && !activePlan && options.length === 0) return null
                    return (
                      <div className={`text-xs font-light mb-3 min-w-0 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {personaName && (
                            <span className="truncate" title={`Persona: ${personaName}`}>
                              {cfg.persona?.icon || '🎭'} {personaName}
                            </span>
                          )}
                          {personaName && activePlan && <span className="opacity-40">·</span>}
                          {activePlan && (
                            <span className="truncate" title={`Running: ${activePlan}`}>
                              {isCompanion && '▶️ '}{activePlan}
                            </span>
                          )}
                          {personaName && !activePlan && isCompanion && (
                            <>
                              <span className="opacity-40">·</span>
                              <span className="truncate opacity-70">Free conversation</span>
                            </>
                          )}
                        </div>
                        {options.length > 0 && (
                          <div className="mt-1.5">
                            <div className={`text-[10px] tracking-wider uppercase mb-1 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                              Can offer
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {options.map(title => (
                                <span
                                  key={title}
                                  className={`px-1.5 py-0.5 rounded border max-w-full truncate ${isDark ? 'border-zinc-700 bg-zinc-800/60' : 'border-border bg-surface-secondary'}`}
                                  title={title}
                                >
                                  {title}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* Created Date */}
                  <div className={`text-[10px] font-light tracking-wider uppercase mb-3 ${isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'}`}>
                    Started {new Date(agent.createdAt).toLocaleTimeString()}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleViewAgent(agent.id)}
                      className={`
                        flex-1 py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                        ${isDark
                          ? 'bg-white/10 border border-white/10 text-content-inverse-secondary hover:text-content-inverse hover:border-white/20'
                          : 'bg-white border border-border text-content-secondary hover:text-content hover:border-border-secondary'
                        }
                      `}
                    >
                      Details
                    </button>
                    {(agent.status === 'RUNNING' || agent.status === 'STARTING') && (
                      <button
                        onClick={() => toggleLiveLogs(agent.id)}
                        className={`
                          flex-1 py-1.5 px-2 rounded-lg text-xs font-light
                          border transition-all duration-200
                          flex items-center justify-center gap-1
                          ${expandedLogs.has(agent.id)
                            ? isDark
                              ? 'bg-white/20 border-white/20 text-content-inverse'
                              : 'bg-content border-content text-white'
                            : isDark
                              ? 'bg-white/10 border-white/10 text-content-inverse-secondary hover:text-content-inverse hover:border-white/20'
                              : 'bg-white border-border text-content-secondary hover:text-content hover:border-border-secondary'
                          }
                        `}
                      >
                        {expandedLogs.has(agent.id) ? (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            Console
                          </>
                        ) : (
                          <>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <polyline points="4 17 10 11 4 5" />
                              <line x1="12" y1="19" x2="20" y2="19" />
                            </svg>
                            Console
                          </>
                        )}
                      </button>
                    )}
                    {(agent.status === 'STOPPED' || agent.status === 'FAILED') && (
                      <>
                        <button
                          onClick={() => handleRestartAgent(agent.id)}
                          className={`
                            py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                            ${isDark
                              ? 'text-green-400 hover:bg-green-500/20'
                              : 'text-green-600 hover:bg-green-50'
                            }
                          `}
                          title="Restart agent"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteAgent(agent.id)}
                          className={`
                            py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                            ${isDark
                              ? 'text-red-400 hover:bg-red-500/20'
                              : 'text-red-500 hover:bg-red-50'
                            }
                          `}
                          title="Delete agent permanently"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </>
                    )}
                    {(agent.status === 'RUNNING' || agent.status === 'STARTING' || agent.status === 'STOPPING') && (
                      <button
                        onClick={() => agent.status !== 'STOPPING' && handleStopAgent(agent.id)}
                        disabled={agent.status === 'STOPPING'}
                        className={`
                          py-1.5 px-2 rounded-lg text-xs font-light transition-all duration-200
                          ${agent.status === 'STOPPING'
                            ? isDark
                              ? 'text-content-inverse-tertiary cursor-not-allowed opacity-50'
                              : 'text-content-tertiary cursor-not-allowed opacity-50'
                            : isDark
                              ? 'text-red-400 hover:bg-red-500/20 cursor-pointer'
                              : 'text-red-500 hover:bg-red-50 cursor-pointer'
                          }
                        `}
                        title={agent.status === 'STOPPING' ? 'Stopping...' : 'Stop agent'}
                      >
                        {agent.status === 'STOPPING' ? (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="animate-spin"
                          >
                            <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                          </svg>
                        ) : (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <rect x="6" y="6" width="12" height="12" rx="1" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Console Logs Panel */}
                  <AnimatePresence>
                    {expandedLogs.has(agent.id) && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="mt-3 overflow-hidden"
                      >
                        {/* Console Container with integrated header */}
                        <div className="relative bg-neutral-900 rounded-lg border border-neutral-700 overflow-hidden">
                          {/* Console Header */}
                          <div className="flex items-center justify-between px-3 py-2 bg-neutral-800/50 border-b border-neutral-700">
                            <div className="flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                              <span className="text-[10px] text-neutral-400 font-light tracking-wider uppercase">
                                Console Output
                              </span>
                            </div>
                            <button
                              onClick={() => setMaximizedLogAgent(agent.id)}
                              className="
                                p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-700
                                transition-all duration-200 flex items-center gap-1
                              "
                              title="Open in fullscreen"
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                              >
                                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                              </svg>
                            </button>
                          </div>
                          {/* Console Content */}
                          <div
                            ref={(el) => inlineLogRefs.current.set(agent.id, el)}
                            onScroll={(e) => handleLogScroll(agent.id, e)}
                            className="
                              text-neutral-100 p-3
                              font-mono text-[10px] leading-relaxed
                              h-32 overflow-y-auto
                            "
                          >
                            {liveLogsMap.get(agent.id) ? (
                              <pre className="whitespace-pre-wrap break-words">
                                {liveLogsMap.get(agent.id)}
                              </pre>
                            ) : (
                              <div className="text-neutral-500 italic flex items-center gap-2">
                                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                                Connecting to log stream...
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              ))
            )}
          </div>
        </div>
      </motion.div>

      {/* Agent Details Modal */}
      <AnimatePresence>
        {selectedAgent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => setSelectedAgent(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`
                backdrop-blur-xl rounded-[20px] w-full max-w-2xl p-6 max-h-[80vh] overflow-y-auto
                ${isDark
                  ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
                  : 'bg-white/95 border border-neutral-200/60 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
                }
              `}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className={`text-2xl font-light ${isDark ? 'text-content-inverse' : 'text-neutral-900'}`}>
                  Agent Details
                </h2>
                <button
                  onClick={() => setSelectedAgent(null)}
                  className={`
                    p-2 rounded-lg transition-all duration-200
                    ${isDark
                      ? 'text-content-inverse-tertiary hover:text-content-inverse hover:bg-white/10'
                      : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                    }
                  `}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <pre className={`text-xs font-mono p-4 rounded-xl whitespace-pre-wrap break-words ${
                isDark
                  ? 'bg-white/5 border border-white/10 text-content-inverse'
                  : 'bg-neutral-50/50 border border-neutral-200/60 text-neutral-900'
              }`}>
                {JSON.stringify(selectedAgent, null, 2)}
              </pre>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Logs Modal */}
      <AnimatePresence>
        {showLogs && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowLogs(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`
                backdrop-blur-xl rounded-[20px] w-full max-w-3xl p-6 max-h-[80vh] overflow-y-auto
                ${isDark
                  ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
                  : 'bg-white/95 border border-neutral-200/60 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
                }
              `}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className={`text-2xl font-light mb-4 ${isDark ? 'text-zinc-100' : 'text-neutral-900'}`}>
                Agent Logs
              </h2>
              <pre className="text-xs font-mono bg-neutral-900 text-neutral-100 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap border border-neutral-700">
                {logs || 'No logs available'}
              </pre>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen Log Viewer */}
      <AnimatePresence>
        {maximizedLogAgent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => setMaximizedLogAgent(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`
                backdrop-blur-xl rounded-[20px] w-full h-full max-w-6xl max-h-[90vh]
                flex flex-col overflow-hidden
                ${isDark
                  ? 'bg-zinc-800 border border-zinc-700 shadow-[0_8px_40px_rgba(0,0,0,0.5)]'
                  : 'bg-white/95 border border-neutral-200/60 shadow-[0_1px_40px_rgba(0,0,0,0.12)]'
                }
              `}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className={`flex items-center justify-between p-6 border-b ${isDark ? 'border-zinc-700' : 'border-neutral-200/60'}`}>
                <div>
                  <h2 className={`text-xl font-light tracking-wide ${isDark ? 'text-content-inverse' : 'text-neutral-900'}`}>
                    Agent Logs
                  </h2>
                  <p className={`text-xs font-light mt-1 ${isDark ? 'text-content-inverse-secondary' : 'text-neutral-500'}`}>
                    {agents.find(a => a.id === maximizedLogAgent)?.name || 'Agent'}
                  </p>
                </div>
                <button
                  onClick={() => setMaximizedLogAgent(null)}
                  className={`
                    p-2 rounded-lg transition-all duration-200
                    ${isDark
                      ? 'text-content-inverse-tertiary hover:text-content-inverse hover:bg-white/10'
                      : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100'
                    }
                  `}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Log Content */}
              <div className="flex-1 overflow-hidden p-6">
                <div
                  ref={maximizedLogRef}
                  onScroll={(e) => maximizedLogAgent && handleLogScroll(maximizedLogAgent, e)}
                  className="
                    h-full
                    bg-neutral-900 text-neutral-100 rounded-xl p-6
                    font-mono text-sm leading-relaxed
                    overflow-y-auto
                    border border-neutral-700
                  "
                >
                  {liveLogsMap.get(maximizedLogAgent) ? (
                    <pre className="whitespace-pre-wrap break-words">
                      {liveLogsMap.get(maximizedLogAgent)}
                    </pre>
                  ) : (
                    <div className="text-neutral-500 italic">
                      Connecting to log stream...
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmation Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText={confirmDialog.confirmText}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />
    </>
  )
}
