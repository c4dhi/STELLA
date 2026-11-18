import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Interval } from '@nestjs/schedule'
import { AgentStatus } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'
import { KubernetesService } from '../kubernetes/kubernetes.service.js'
import { orphanAgentActions, reconcilerMode, type ReconcilerMode } from './orphaned-agent-pods.js'

export const RECONCILE_INTERVAL_MS = 10 * 60_000

/**
 * Every 10 minutes, compares the agent pods in the namespace with the agent
 * rows (#188), and removes what has lost its other half: a pod whose agent is
 * gone or long stopped, and a RUNNING row whose pod has been gone for over 10
 * minutes. The decision is `orphanAgentActions`; this only fetches and acts.
 *
 * `AGENT_RECONCILER_MODE`: `log` (the default) only logs what it would do;
 * `delete` does it; `off` skips the sweep.
 */
@Injectable()
export class AgentReconcilerService {
  private readonly logger = new Logger(AgentReconcilerService.name)
  private missingSince = new Map<string, Date>()
  private running = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: KubernetesService,
    private readonly config: ConfigService,
  ) {}

  get mode(): ReconcilerMode {
    return reconcilerMode(this.config.get<string>('AGENT_RECONCILER_MODE'))
  }

  @Interval(RECONCILE_INTERVAL_MS)
  async sweep(now = new Date()): Promise<void> {
    const mode = this.mode
    if (mode === 'off' || this.running) return
    this.running = true
    try {
      const pods = await this.k8s.listAgentPods()
      const ids = pods.map((p) => p.agentId)
      const rows = await this.prisma.agentInstance.findMany({
        where: { OR: [{ id: { in: ids } }, { status: AgentStatus.RUNNING }] },
        select: { id: true, status: true, stoppedAt: true },
      })
      const actions = orphanAgentActions(pods, rows, this.missingSince, now)
      this.missingSince = actions.missingSince
      const act = mode === 'delete'
      const verb = act ? 'Deleting' : 'Would delete (log-only)'

      for (const pod of actions.deletePods) {
        this.logger.warn(`${verb} orphaned agent pod ${pod.podName}: ${pod.reason}`)
        if (!act) continue
        await this.k8s.deletePod(pod.podName).catch((e) => this.logger.error(`Failed to delete pod ${pod.podName}: ${e.message}`))
        await this.k8s.deleteSecret(pod.secretName)
      }
      for (const agentId of actions.markStopped) {
        this.logger.warn(`${act ? 'Marking' : 'Would mark (log-only)'} agent ${agentId} STOPPED: RUNNING, and its pod was missing on two sweeps in a row`)
        if (!act) continue
        // Only if it is still RUNNING: a wake may have restarted it meanwhile.
        await this.prisma.agentInstance.updateMany({
          where: { id: agentId, status: AgentStatus.RUNNING },
          data: { status: AgentStatus.STOPPED, stoppedAt: now, podName: null, connectorTokenHash: null, healthState: null },
        })
        await this.k8s.deleteSecret(`agent-secret-${agentId}`)
      }
    } catch (error) {
      this.logger.error(`Agent reconciler sweep failed: ${(error as Error).message}`)
    } finally {
      this.running = false
    }
  }
}
