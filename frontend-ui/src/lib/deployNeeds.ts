/**
 * What a deploy dialog must ask for, from the `requirements` the server
 * resolved from the agent's agent.yaml (GET /agent-types). Shared by the
 * session deploy dialog and the public-project setup, so both ask for the
 * same things. A type without `requirements` (its manifest could not be read)
 * asks for nothing; deploying it is refused by the server with the reason.
 */
import type { DeployRequirements } from './api-types'
import type { EnvVarSetting } from './agentSettings'

export type AgentMode = 'plan' | 'companion'

/** An `env.optional` entry, with its typed-setting fields (#585). */
export type OptionalEnvVar = EnvVarSetting

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
  type: { requirements?: DeployRequirements | null } | null | undefined,
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
  return NONE
}

/** Ask which mode only when the agent can run in more than one. */
export function asksForMode(needs: DeployNeeds): boolean {
  return needs.modes.length > 1
}

/** The mode to use: the picked one when the agent supports it, else its only one. */
export function effectiveMode(needs: DeployNeeds, picked: AgentMode): AgentMode {
  return needs.modes.includes(picked) || needs.modes.length === 0 ? picked : needs.modes[0]
}

/** The line shown under an env-var row: what it does, and its default. */
export function envVarHints(vars: OptionalEnvVar[]): Record<string, string> {
  const hints: Record<string, string> = {}
  for (const v of vars) {
    const parts = [v.description?.trim(), v.default !== undefined && v.default !== '' ? `Default ${v.default}.` : '']
      .filter(Boolean)
      .map((p) => (p!.endsWith('.') ? p : `${p}.`))
    if (parts.length > 0) hints[v.name] = parts.join(' ')
  }
  return hints
}
