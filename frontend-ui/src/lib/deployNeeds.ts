/**
 * What a deploy dialog must ask for, from the `requirements` the server
 * resolved from the agent's agent.yaml (GET /agent-types). Shared by the
 * session deploy dialog and the public-project setup, so both ask for the
 * same things. The legacy `configSchema` flags are read only for a type the
 * server sent without `requirements`.
 */
import type { DeployRequirements } from './api-types'
import { parseAgentRequirements, parseDeclaredEnvVars } from './api-types'

export type AgentMode = 'plan' | 'companion'

export interface OptionalEnvVar {
  name: string
  description?: string
  default?: string
}

export interface DeployNeeds {
  /** Ask for a persona. An agent may declare it uses none. */
  persona: boolean
  /** The modes it can run in; empty when it runs no plans. */
  modes: AgentMode[]
  /** It cannot be deployed without a plan (or as a companion, when it can be one). */
  planRequired: boolean
  /** It reads a pipeline configuration from the Configurator. */
  configurator: boolean
  requiredEnvVars: string[]
  optionalEnvVars: OptionalEnvVar[]
}

const NONE: DeployNeeds = {
  persona: true,
  modes: [],
  planRequired: false,
  configurator: false,
  requiredEnvVars: [],
  optionalEnvVars: [],
}

export function deployNeeds(
  type: { requirements?: DeployRequirements; configSchema?: Record<string, unknown> | null } | null | undefined,
): DeployNeeds {
  if (!type) return NONE
  const r = type.requirements
  if (r) {
    return {
      persona: r.persona,
      modes: r.plans ? [...r.plans.modes] : [],
      planRequired: r.plans?.required ?? false,
      configurator: !!r.configurator,
      requiredEnvVars: [...r.env.required],
      optionalEnvVars: r.env.optional.map((v) => ({ ...v })),
    }
  }
  const legacy = parseAgentRequirements(type.configSchema)
  const declared = parseDeclaredEnvVars(type.configSchema)
  return {
    ...NONE,
    modes: legacy.requiresPlan ? ['plan', 'companion'] : [],
    planRequired: legacy.requiresPlan,
    configurator: legacy.supportsConfigurator,
    requiredEnvVars: legacy.requiredEnvVars,
    optionalEnvVars: declared.optional.map((name) => ({ name })),
  }
}

/** Ask which mode only when the agent can run in more than one. */
export function asksForMode(needs: DeployNeeds): boolean {
  return needs.modes.length > 1
}

/** The mode to use: the picked one when the agent supports it, else its only one. */
export function effectiveMode(needs: DeployNeeds, picked: AgentMode): AgentMode {
  return needs.modes.includes(picked) || needs.modes.length === 0 ? picked : needs.modes[0]
}
