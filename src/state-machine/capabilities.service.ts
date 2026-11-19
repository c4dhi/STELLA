import { Injectable, Logger } from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import type { PlanMode } from '../agent-package/manifest-defaults.js';
import {
  AGENT_TYPE_MANIFEST_SELECT,
  manifestOfAgentType,
} from '../agents/agent-requirements.js';
import { readBindings } from '../connectors/connector-bindings.util.js';
import { ConnectorGatewayService } from '../connectors/connector-gateway.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  sessionCapabilities,
  type CapabilitiesProvider,
  type CapabilityInput,
  type SessionCapabilities,
} from './capabilities.js';
import { StateMachineService, type PlanData } from './state-machine.service.js';

const LIVE: AgentStatus[] = [AgentStatus.STARTING, AgentStatus.RUNNING];

interface Activity {
  id: string;
  title: string;
  description?: string;
}

/**
 * Fetches what {@link sessionCapabilities} needs: the session's plan, the
 * agent's deployment (mode, activities, bound connectors) and its agent type's
 * manifest. It decides nothing itself.
 */
@Injectable()
export class CapabilitiesService implements CapabilitiesProvider {
  private readonly logger = new Logger(CapabilitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: StateMachineService,
    private readonly gateway: ConnectorGatewayService,
  ) {}

  /**
   * @param agentId the asking agent. Left out, the session's newest live agent
   *   answers, which is the only one in every session STELLA deploys today.
   */
  async getCapabilities(
    sessionId: string,
    agentId?: string,
  ): Promise<SessionCapabilities> {
    const [state, instance] = await Promise.all([
      this.stateMachine.getState(sessionId),
      this.instance(sessionId, agentId),
    ]);

    const config = (instance?.agentConfig ?? {}) as Record<string, unknown>;
    const deploymentMode: PlanMode =
      config.mode === 'companion' ? 'companion' : 'plan';
    const connectorToolModes = this.connectorToolModes(instance);

    const plan = state
      ? await this.planInput(
          sessionId,
          state.planData as unknown as PlanData,
          state.currentStateId,
        )
      : null;
    const inMode =
      deploymentMode === 'companion' ? (plan ? null : 'companion') : 'plan';
    const connectors =
      instance && inMode && connectorToolModes.includes(inMode)
        ? await this.connectors(instance)
        : [];

    return sessionCapabilities({
      deploymentMode,
      plan,
      activities: deploymentMode === 'companion' ? activitiesOf(config) : [],
      connectors,
      connectorToolModes,
    });
  }

  private instance(sessionId: string, agentId?: string) {
    return this.prisma.agentInstance.findFirst({
      where: agentId
        ? { id: agentId, sessionId }
        : { sessionId, status: { in: LIVE } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        sessionId: true,
        agentConfig: true,
        connectorBindings: true,
        deployedByUserId: true,
        session: { select: { projectId: true } },
        agentTypeRef: { select: AGENT_TYPE_MANIFEST_SELECT },
      },
    });
  }

  private connectorToolModes(
    instance: Awaited<ReturnType<CapabilitiesService['instance']>>,
  ): PlanMode[] {
    if (!instance?.agentTypeRef) return [];
    try {
      return [
        ...(manifestOfAgentType(instance.agentTypeRef).features.connectorTools
          ?.modes ?? []),
      ];
    } catch (error) {
      // Deploying such a type fails with the reason; here it only means no tools.
      this.logger.warn(
        `Capabilities without connector tools: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async planInput(
    sessionId: string,
    plan: PlanData,
    currentStateId: string | null,
  ): Promise<CapabilityInput['plan']> {
    const current = plan.states.find((s) => s.id === currentStateId);
    const pending = await this.stateMachine.getPendingTasks(sessionId);
    return {
      title: plan.title || 'The plan',
      currentStateTitle: current?.title,
      openItems: pending.map((t) => t.description).filter(Boolean),
    };
  }

  private async connectors(
    instance: NonNullable<Awaited<ReturnType<CapabilitiesService['instance']>>>,
  ): Promise<CapabilityInput['connectors']> {
    const bound = await this.gateway.listConnectors({
      agentId: instance.id,
      sessionId: instance.sessionId,
      projectId: instance.session.projectId,
      deployedByUserId: instance.deployedByUserId,
      bindings: readBindings(instance.connectorBindings),
    });
    return bound.map((c) => ({
      handle: c.handle,
      name: c.name,
      tools: c.tools.map((t) => ({ name: t.name, description: t.description })),
    }));
  }
}

/** The activities snapshotted into a companion's config at deploy (agents.service). */
function activitiesOf(config: Record<string, unknown>): Activity[] {
  const list = Array.isArray(config.available_plans)
    ? config.available_plans
    : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, title, description } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string') return [];
    return [
      {
        id,
        title,
        description: typeof description === 'string' ? description : undefined,
      },
    ];
  });
}
