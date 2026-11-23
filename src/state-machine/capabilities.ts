import type { PlanMode } from '../agent-package/manifest-defaults.js';

/**
 * What the agent can do for the person in this session, right now (#992).
 *
 * Worked out from what the session really has (its plan, the activities a
 * companion offers, the connectors bound to the agent), never written by hand,
 * so the agent can say plainly what it can and cannot do. The service only
 * fetches the inputs; everything else happens here.
 *
 * - `plan`: a plan-mode session. It follows its plan, nothing else.
 * - `activity`: a companion inside one of its activities. It follows that plan
 *   and can leave it.
 * - `companion`: a companion between activities. It can start an activity, go
 *   to sleep, and use the connector tools it calls in that mode.
 */
export type CapabilityMode = 'plan' | 'activity' | 'companion';

export type CapabilityKind = 'plan' | 'activity' | 'action' | 'tool';

export interface Capability {
  /** Stable within a session: `follow_plan`, `leave_activity`, `go_to_sleep`, `activity.<id>`, `<handle>.<tool>`. */
  id: string;
  kind: CapabilityKind;
  title: string;
  description: string;
}

export interface SessionCapabilities {
  mode: CapabilityMode;
  capabilities: Capability[];
}

/**
 * Injection token for whatever answers GetCapabilities (CapabilitiesService in
 * the server). A token, so the gRPC controller does not import the connectors
 * module and the in-memory state machine (scripts/) can stand in its own.
 */
export const CAPABILITIES_PROVIDER = Symbol('CAPABILITIES_PROVIDER');

export interface CapabilitiesProvider {
  getCapabilities(
    sessionId: string,
    agentId?: string,
  ): Promise<SessionCapabilities>;
}

export interface CapabilityInput {
  /** How the session was deployed. A companion with a plan loaded is in an activity. */
  deploymentMode: PlanMode;
  /** The plan the session is following, or null when none is loaded. */
  plan: {
    title: string;
    /** Title of the current state, if any. */
    currentStateTitle?: string;
    /** What is still open in the current state, in the plan's own words. */
    openItems: string[];
  } | null;
  /** The activities a companion offers (empty in plan mode). */
  activities: Array<{ id: string; title: string; description?: string }>;
  /** Connectors bound to the agent that it may still use, with their known tools. */
  connectors: Array<{
    handle: string;
    name: string;
    tools: Array<{ name: string; description?: string }>;
  }>;
  /** The modes in which the agent type declares it calls connector tools. */
  connectorToolModes: readonly PlanMode[];
}

/** Longest description taken from outside text (plan, connector), in characters. */
export const CAPABILITY_DESCRIPTION_MAX = 240;

/** At most this many open items describe the plan. */
export const PLAN_OPEN_ITEMS_MAX = 3;

export function sessionCapabilities(
  input: CapabilityInput,
): SessionCapabilities {
  const companion = input.deploymentMode === 'companion';
  const mode: CapabilityMode = companion
    ? input.plan
      ? 'activity'
      : 'companion'
    : 'plan';
  const capabilities: Capability[] = [];

  if (mode === 'plan' || mode === 'activity') {
    if (input.plan) capabilities.push(followPlan(input.plan));
    if (mode === 'activity') {
      capabilities.push({
        id: 'leave_activity',
        kind: 'action',
        title: 'Leave the activity',
        description: `Stop "${clip(input.plan!.title)}" and go back to the open conversation.`,
      });
    }
    if (mode === 'plan' && input.connectorToolModes.includes('plan')) {
      capabilities.push(...connectorTools(input.connectors));
    }
    return { mode, capabilities };
  }

  for (const activity of input.activities) {
    capabilities.push({
      id: `activity.${activity.id}`,
      kind: 'activity',
      title: clip(activity.title),
      description: clip(activity.description ?? ''),
    });
  }
  capabilities.push({
    id: 'go_to_sleep',
    kind: 'action',
    title: 'Go to sleep',
    description: 'Say goodbye and go to sleep until woken again.',
  });
  if (input.connectorToolModes.includes('companion')) {
    capabilities.push(...connectorTools(input.connectors));
  }
  return { mode, capabilities };
}

function followPlan(plan: NonNullable<CapabilityInput['plan']>): Capability {
  const now = plan.currentStateTitle ? `Now: ${plan.currentStateTitle}.` : '';
  const open = plan.openItems
    .slice(0, PLAN_OPEN_ITEMS_MAX)
    .map((item) => clip(item, 120));
  const openText = open.length > 0 ? ` Still open: ${open.join('; ')}.` : '';
  return {
    id: 'follow_plan',
    kind: 'plan',
    title: clip(plan.title),
    description: clip(
      `${now}${openText}`.trim(),
      CAPABILITY_DESCRIPTION_MAX * 2,
    ),
  };
}

function connectorTools(
  connectors: CapabilityInput['connectors'],
): Capability[] {
  return connectors.flatMap((connector) =>
    connector.tools.map((tool) => ({
      id: `${connector.handle}.${tool.name}`,
      kind: 'tool' as const,
      title: clip(`${connector.name}: ${tool.name}`),
      description: clip(tool.description ?? ''),
    })),
  );
}

/** One line, at most `max` characters: outside text never brings its own layout. */
function clip(text: string, max = CAPABILITY_DESCRIPTION_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
