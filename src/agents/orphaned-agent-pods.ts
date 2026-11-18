/**
 * Which agent pods and rows have lost each other (#188). Pure: the reconciler
 * (agent-reconciler.service.ts) fetches pods and rows, asks this, and acts.
 *
 * - A pod whose agent row is gone, or whose agent stopped or failed more than
 *   `stoppedGraceMs` ago, is deleted with its secret.
 * - A pod whose agent is RUNNING, STARTING or STOPPING is never touched, so a
 *   live call is never ended.
 * - A RUNNING row whose pod has been missing for more than `missingGraceMs`
 *   (seen missing on two sweeps that far apart) is marked STOPPED.
 */

export interface AgentPodRef {
  name: string
  /** The pod's `agentId` label. */
  agentId: string
}

export interface AgentRowRef {
  id: string
  status: string
  stoppedAt: Date | null
}

export interface PodToDelete {
  podName: string
  secretName: string
  agentId: string
  reason: string
}

export interface OrphanActions {
  deletePods: PodToDelete[]
  /** Agent ids to mark STOPPED: RUNNING rows with no pod for too long. */
  markStopped: string[]
  /** When each RUNNING row was first seen without a pod; pass it to the next sweep. */
  missingSince: Map<string, Date>
}

export const STOPPED_GRACE_MS = 5 * 60_000
export const MISSING_GRACE_MS = 10 * 60_000

const ENDED = new Set(['STOPPED', 'FAILED'])

export function orphanAgentActions(
  pods: AgentPodRef[],
  rows: AgentRowRef[],
  previouslyMissing: Map<string, Date>,
  now: Date,
  { stoppedGraceMs = STOPPED_GRACE_MS, missingGraceMs = MISSING_GRACE_MS } = {},
): OrphanActions {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const deletePods: PodToDelete[] = []
  for (const pod of pods) {
    const row = byId.get(pod.agentId)
    const target = { podName: pod.name, secretName: `agent-secret-${pod.agentId}`, agentId: pod.agentId }
    if (!row) {
      deletePods.push({ ...target, reason: 'no agent row' })
    } else if (ENDED.has(row.status) && row.stoppedAt && now.getTime() - row.stoppedAt.getTime() > stoppedGraceMs) {
      deletePods.push({ ...target, reason: `agent ${row.status} since ${row.stoppedAt.toISOString()}` })
    }
  }

  const withPod = new Set(pods.map((p) => p.agentId))
  const missingSince = new Map<string, Date>()
  const markStopped: string[] = []
  for (const row of rows) {
    if (row.status !== 'RUNNING' || withPod.has(row.id)) continue
    const since = previouslyMissing.get(row.id) ?? now
    if (now.getTime() - since.getTime() > missingGraceMs) markStopped.push(row.id)
    else missingSince.set(row.id, since)
  }
  return { deletePods, markStopped, missingSince }
}

export type ReconcilerMode = 'off' | 'log' | 'delete'

/** `AGENT_RECONCILER_MODE`: log-only unless set to `delete` (or `off`). */
export function reconcilerMode(value: string | undefined): ReconcilerMode {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'delete' || v === 'off' ? v : 'log'
}
