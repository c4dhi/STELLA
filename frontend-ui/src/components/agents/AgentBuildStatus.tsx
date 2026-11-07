import React, { useState, useEffect, useCallback } from 'react'
import { Play, CheckCircle, XCircle, Loader2, Clock, ChevronDown, ChevronUp } from 'lucide-react'
import { apiClient } from '../../services/ApiClient'
import type { AgentBuildStatus as BuildStatus } from '../../lib/api-types'

interface AgentBuildStatusProps {
  agentTypeId: string
  onBuildComplete?: () => void
}

export function AgentBuildStatus({ agentTypeId, onBuildComplete }: AgentBuildStatusProps) {
  const [buildStatus, setBuildStatus] = useState<BuildStatus | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const [buildOutput, setBuildOutput] = useState<string>('')
  const [showLogs, setShowLogs] = useState(false)
  const [error, setError] = useState<string>('')

  // Fetch initial build status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await apiClient.getAgentBuildStatus(agentTypeId)
        setBuildStatus(status)
        // Queued behind another build, or already running: either way, stream its log live.
        if (status?.status === 'pending' || status?.status === 'building') {
          setIsBuilding(true)
        }
      } catch (err) {
        console.error('Failed to fetch build status:', err)
      }
    }
    fetchStatus()
  }, [agentTypeId])

  // Subscribe to build logs when building
  useEffect(() => {
    if (!isBuilding) return

    const cleanup = apiClient.subscribeToBuildLogs(
      agentTypeId,
      (data) => {
        if (data.output) {
          setBuildOutput(data.output)
        }
        if (data.status === 'success' || data.status === 'failed') {
          setIsBuilding(false)
          setBuildStatus(prev => prev ? { ...prev, status: data.status as any, errorMessage: data.errorMessage } : null)
          if (data.status === 'success') {
            onBuildComplete?.()
          }
        }
      },
      (err) => {
        console.error('Build log SSE error:', err)
      }
    )

    return cleanup
  }, [isBuilding, agentTypeId, onBuildComplete])

  const handleTriggerBuild = useCallback(async () => {
    setError('')
    setIsBuilding(true)
    setBuildOutput('')
    setShowLogs(true)

    try {
      await apiClient.triggerAgentBuild(agentTypeId)
      setBuildStatus({ id: '', status: 'building', startedAt: new Date().toISOString() })
    } catch (err: any) {
      setError(err?.message || 'Failed to start build')
      setIsBuilding(false)
    }
  }, [agentTypeId])

  const getStatusIcon = () => {
    if (!buildStatus) return <Clock className="w-5 h-5 text-gray-400" />

    switch (buildStatus.status) {
      case 'pending':
        return <Clock className="w-5 h-5 text-yellow-500" />
      case 'building':
        return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
      case 'success':
        return <CheckCircle className="w-5 h-5 text-green-500" />
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-500" />
      default:
        return <Clock className="w-5 h-5 text-gray-400" />
    }
  }

  const getStatusText = () => {
    if (!buildStatus) return 'Not built'

    switch (buildStatus.status) {
      case 'pending':
        return 'Queued'
      case 'building':
        return 'Building...'
      case 'success':
        return `Built: ${buildStatus.imageName || 'success'}`
      case 'failed':
        return 'Build failed'
      default:
        return 'Unknown'
    }
  }

  const getStatusColor = () => {
    if (!buildStatus) return 'text-gray-500'

    switch (buildStatus.status) {
      case 'pending':
        return 'text-yellow-600'
      case 'building':
        return 'text-blue-600'
      case 'success':
        return 'text-green-600'
      case 'failed':
        return 'text-red-600'
      default:
        return 'text-gray-500'
    }
  }

  return (
    <div className="space-y-3">
      {/* Status row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <span className={`text-sm font-medium ${getStatusColor()}`}>
            {getStatusText()}
          </span>
        </div>

        {/* Rebuild: the first build already started on upload, so this button
            is always a rebuild, never the first one. */}
        {!isBuilding && (
          <button
            onClick={handleTriggerBuild}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            <Play className="w-4 h-4" />
            Rebuild
          </button>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Build failure message */}
      {buildStatus?.status === 'failed' && buildStatus.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-700">{buildStatus.errorMessage}</p>
        </div>
      )}

      {/* Build logs toggle */}
      {(buildOutput || isBuilding) && (
        <div className="border rounded overflow-hidden">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors"
          >
            <span className="text-sm font-medium text-gray-700">Build Logs</span>
            {showLogs ? (
              <ChevronUp className="w-4 h-4 text-gray-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-500" />
            )}
          </button>

          {showLogs && (
            <div className="bg-gray-900 p-3 max-h-64 overflow-y-auto">
              <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono">
                {buildOutput || 'Waiting for build output...'}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Build time */}
      {buildStatus?.startedAt && (
        <p className="text-xs text-gray-500">
          Started: {new Date(buildStatus.startedAt).toLocaleString()}
          {buildStatus.completedAt && (
            <> | Completed: {new Date(buildStatus.completedAt).toLocaleString()}</>
          )}
        </p>
      )}
    </div>
  )
}
