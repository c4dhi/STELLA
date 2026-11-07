import React, { useState, useEffect, useCallback } from 'react'
import { Package, Clock, CheckCircle, XCircle, AlertTriangle, Trash2, RefreshCw } from 'lucide-react'
import { apiClient } from '../../services/ApiClient'
import { useToastStore } from '../../store/toastStore'
import { AgentBuildStatus } from './AgentBuildStatus'
import ConfirmDialog from '../modals/ConfirmDialog'
import type { CustomAgentType, AgentValidationStatus } from '../../lib/api-types'
import { useFeatureFlagsStore } from '../../store/featureFlagsStore'

interface MyAgentsSectionProps {
  onSelectAgent?: (agent: CustomAgentType) => void
  /** The id selected elsewhere in the picker, so a deployable upload gets the same visible border a built-in card gets. */
  selectedId?: string | null
  refreshTrigger?: number
  /** Called with the user's uploads each time they load. */
  onAgentsLoaded?: (agents: CustomAgentType[]) => void
  /** Render nothing when the user has no uploads (the parent says so itself). */
  hideEmpty?: boolean
}

export function MyAgentsSection({ onSelectAgent, selectedId, refreshTrigger, onAgentsLoaded, hideEmpty }: MyAgentsSectionProps) {
  const { addToast } = useToastStore()
  const [agents, setAgents] = useState<CustomAgentType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [deletingAgent, setDeletingAgent] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [agentToDelete, setAgentToDelete] = useState<{ id: string; name: string } | null>(null)

  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      const data = await apiClient.getMyAgents()
      setAgents(data)
      onAgentsLoaded?.(data)
    } catch (err: any) {
      setError(err?.message || 'Failed to load custom agents')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents, refreshTrigger])

  // Without this, a row's badge is only as fresh as the last fetch: a build
  // that finishes while its card just sits in the list (not expanded) would
  // otherwise keep reading Queued/Building until something else refetches.
  const buildingIds = agents
    .filter((a) => a.lastBuild?.status === 'pending' || a.lastBuild?.status === 'building')
    .map((a) => a.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!buildingIds) return
    const cleanups = buildingIds.split(',').map((id) =>
      apiClient.subscribeToBuildLogs(id, (data) => {
        if (data.status === 'success' || data.status === 'failed') {
          fetchAgents()
        }
      }),
    )
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [buildingIds, fetchAgents])

  const handleDelete = useCallback((agentId: string, agentName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setAgentToDelete({ id: agentId, name: agentName })
    setDeleteConfirmOpen(true)
  }, [])

  const confirmDeleteAgent = useCallback(async () => {
    if (!agentToDelete) return
    setDeletingAgent(agentToDelete.id)
    try {
      await apiClient.deleteCustomAgent(agentToDelete.id)
      setAgents(prev => prev.filter(a => a.id !== agentToDelete.id))
      addToast({ message: `Agent "${agentToDelete.name}" deleted`, type: 'success' })
    } catch (err: any) {
      addToast({ message: err?.message || 'Failed to delete agent', type: 'error' })
    } finally {
      setDeletingAgent(null)
      setDeleteConfirmOpen(false)
      setAgentToDelete(null)
    }
  }, [agentToDelete, addToast])

  // Mirrors the backend rule (assertDeployableAgentType): these are the
  // user's own uploads, so an unreviewed one is theirs to deploy while review
  // is off. A rejected one never deploys.
  const agentReviewRequired = useFeatureFlagsStore(state => state.agentReviewRequired)
  const loadFeatures = useFeatureFlagsStore(state => state.load)
  // Refetched on refreshTrigger too, not just on mount: a flag flipped (or a
  // build finished) between dialog opens must not be judged against a stale
  // reading, which is what let Felix's already-built upload look undeployable.
  useEffect(() => {
    void loadFeatures()
  }, [loadFeatures, refreshTrigger])
  // Mirrors assertDeployableAgentType: allowed by review, built, and built with a supported SDK.
  const canDeploy = (agent: CustomAgentType) =>
    agent.built &&
    !agent.sdkProblem &&
    (agent.validationStatus === 'APPROVED' || (agent.validationStatus === 'PENDING' && !agentReviewRequired))

  const getStatusBadge = (status: AgentValidationStatus | undefined) => {
    switch (status) {
      case 'APPROVED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <CheckCircle className="w-3 h-3" />
            Approved
          </span>
        )
      case 'PENDING':
        // With review off nothing is waiting: the upload is simply not reviewed.
        if (!agentReviewRequired) {
          return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
              <Package className="w-3 h-3" />
              Not reviewed
            </span>
          )
        }
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
            <Clock className="w-3 h-3" />
            Pending Review
          </span>
        )
      case 'REJECTED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
            <XCircle className="w-3 h-3" />
            Rejected
          </span>
        )
      default:
        return null
    }
  }

  // The badge doubles as a link to the log: clicking it expands the row's
  // AgentBuildStatus, regardless of whether the row itself is click-to-deploy.
  const getBuildStatusBadge = (agent: CustomAgentType) => {
    const lastBuild = agent.lastBuild
    const onClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      setExpandedAgent(expandedAgent === agent.id ? null : agent.id)
    }

    if (!lastBuild) {
      return (
        <button onClick={onClick} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200" title="View build log">
          Not Built
        </button>
      )
    }

    switch (lastBuild.status) {
      case 'pending':
        return (
          <button onClick={onClick} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 hover:bg-yellow-200" title="View build log">
            <Clock className="w-3 h-3" />
            Queued
          </button>
        )
      case 'success':
        return (
          <button onClick={onClick} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200" title="View build log">
            <CheckCircle className="w-3 h-3" />
            Built
          </button>
        )
      case 'building':
        return (
          <button onClick={onClick} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 animate-pulse hover:bg-blue-200" title="View build log">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Building
          </button>
        )
      case 'failed':
        return (
          <button onClick={onClick} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200" title="View build log">
            <AlertTriangle className="w-3 h-3" />
            Build Failed
          </button>
        )
      default:
        return null
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
        <p className="text-red-700">{error}</p>
        <button
          onClick={fetchAgents}
          className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    )
  }

  if (agents.length === 0) {
    if (hideEmpty) return null
    return (
      <div className="text-center py-8 px-4">
        <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
        <p className="text-gray-500">No custom agents yet</p>
        <p className="text-sm text-gray-400 mt-1">
          Upload an agent package to get started
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {agents.map((agent) => {
          const isSelected = canDeploy(agent) && selectedId === agent.id
          const isExpanded = expandedAgent === agent.id
          return (
        <div
          key={agent.id}
          className={`
            border-2 rounded-lg overflow-hidden transition-all
            ${isSelected ? 'border-blue-600 bg-blue-50 shadow-sm' : isExpanded ? 'border-blue-300 ring-2 ring-blue-500' : 'border-gray-200 hover:border-gray-400'}
            ${canDeploy(agent) ? 'cursor-pointer' : ''}
          `}
        >
          {/* Agent header: no background of its own when selected, so the
              card's blue tint actually shows through */}
          <div
            className={`p-4 flex items-start justify-between ${isSelected ? '' : 'bg-white'}`}
            onClick={() => {
              if (canDeploy(agent)) {
                onSelectAgent?.(agent)
              } else {
                setExpandedAgent(expandedAgent === agent.id ? null : agent.id)
              }
            }}
          >
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-xl">
                {agent.icon || '📦'}
              </div>

              {/* Info */}
              <div>
                <h4 className="font-medium text-gray-900">{agent.name}</h4>
                <p className="text-sm text-gray-500 line-clamp-1">{agent.description}</p>
                <div className="flex items-center gap-2 mt-2">
                  {getStatusBadge(agent.validationStatus)}
                  {getBuildStatusBadge(agent)}
                  {agent.sdkProblem && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700"
                      title={`Cannot deploy: ${agent.sdkProblem}. Rebuild it with a supported SDK.`}
                    >
                      Needs SDK update
                    </span>
                  )}
                  <span className="text-xs text-gray-400">v{agent.version}</span>
                </div>
              </div>
            </div>

            {/* Delete button */}
            <button
              onClick={(e) => handleDelete(agent.id, agent.name, e)}
              disabled={deletingAgent === agent.id}
              className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
              title="Delete agent"
            >
              {deletingAgent === agent.id ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* Expanded build section */}
          {expandedAgent === agent.id && (
            <div className="border-t bg-gray-50 p-4">
              <AgentBuildStatus
                agentTypeId={agent.id}
                onBuildComplete={fetchAgents}
              />
            </div>
          )}
        </div>
          )
        })}
      </div>

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title="Delete Agent"
        message={`Delete "${agentToDelete?.name}"? This cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        confirmVariant="danger"
        onConfirm={confirmDeleteAgent}
        onCancel={() => { setDeleteConfirmOpen(false); setAgentToDelete(null) }}
      />
    </>
  )
}
