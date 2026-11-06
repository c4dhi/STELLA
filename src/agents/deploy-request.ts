import { BadRequestException } from '@nestjs/common'
import { deepmergeCustom } from 'deepmerge-ts'
import { requestedSdkProblem } from '../agent-package/sdk-support.js'
import type { AgentRequirements } from './agent-requirements.js'

/**
 * Checks a deployment against what its agent type declares. Pure functions of
 * the requirements and the request: deploy, restart, wake and public projects
 * all run them, so no path can deploy what the manifest does not allow.
 */

/**
 * Keys of an agent config that STELLA sets itself. A deployment sets nothing
 * else: whatever an agent needs from the person deploying it is an env var.
 */
export const PLATFORM_CONFIG_KEYS = ['persona', 'mode', 'plan', 'available_plans', 'pipeline_config'] as const

/**
 * Refuse a deployment that the agent type's requirements do not allow. Every
 * problem is reported at once, so a user fixes them in one go.
 *
 * @param config the agent config after persona, plan and configuration were resolved
 * @param env    the env vars the pod will get (template and manual values merged)
 */
export function assertDeployRequest(
  slug: string,
  requirements: AgentRequirements,
  config: Record<string, unknown>,
  env: Record<string, string>,
): void {
  const problems = [
    ...planProblems(requirements, config),
    ...configuratorProblems(requirements, config),
    ...envProblems(requirements, env),
    ...sdkProblems(requirements),
  ]
  if (problems.length > 0) {
    throw new BadRequestException(`Cannot deploy ${slug}: ${problems.join('; ')}`)
  }
}

function planProblems({ plans }: AgentRequirements, config: Record<string, unknown>): string[] {
  const companion = config.mode === 'companion'
  const hasPlan = config.plan !== undefined && config.plan !== null
  if (!plans) {
    return hasPlan || companion || config.available_plans !== undefined
      ? ['it does not run plans, so a deployment cannot give it one']
      : []
  }
  const problems: string[] = []
  if (companion && !plans.modes.includes('companion')) problems.push('it cannot run as a companion')
  if (hasPlan && !plans.modes.includes('plan')) problems.push('it does not follow a single plan')
  if (plans.required && !hasPlan && !companion) {
    problems.push(plans.modes.includes('companion') ? 'it needs a plan, or to run as a companion' : 'it needs a plan')
  }
  return problems
}

function configuratorProblems({ configurator }: AgentRequirements, config: Record<string, unknown>): string[] {
  const pipelineConfig = config.pipeline_config
  if (!configurator) {
    return pipelineConfig !== undefined ? ['it takes no Configurator configuration'] : []
  }
  const present = !!pipelineConfig && typeof pipelineConfig === 'object' && !Array.isArray(pipelineConfig)
  return configurator.required && !present ? ['it needs a configuration from the Configurator'] : []
}

/**
 * The env vars a pod gets: what the deployment provides, plus the `default` of
 * every optional variable the agent declares and the deployment left out.
 * A provided value always wins. Idempotent, so restart and wake can run it again.
 */
export function withEnvDefaults(
  env: AgentRequirements['env'],
  provided: Record<string, string>,
): { env: Record<string, string>; appliedDefaults: string[] } {
  const out = { ...provided }
  const appliedDefaults: string[] = []
  for (const v of env.optional) {
    if (v.default !== undefined && !out[v.name]?.trim()) {
      out[v.name] = v.default
      appliedDefaults.push(v.name)
    }
  }
  return { env: out, appliedDefaults }
}

function envProblems({ env }: AgentRequirements, provided: Record<string, string>): string[] {
  // An empty value never reaches the pod (see buildSecretStringData), so it counts as missing.
  const missing = env.required.filter((name) => !provided[name]?.trim())
  return missing.length > 0 ? [`missing required environment variables: ${missing.join(', ')}`] : []
}

function sdkProblems({ sdkMinVersion }: AgentRequirements): string[] {
  const problem = requestedSdkProblem(sdkMinVersion)
  return problem ? [problem] : []
}

/** Arrays replace the default instead of being appended to it. */
const mergeDefaults = deepmergeCustom({ mergeArrays: false })

/**
 * The config a pod receives: the agent's own defaultConfig plus the platform
 * keys. A deployment cannot set anything else; an agent takes what a deployer
 * chooses as env vars. Keys that only repeat the defaults are accepted, so a
 * restart or wake can pass a saved config again (this is idempotent).
 */
export function withAgentDefaults(
  slug: string,
  requirements: AgentRequirements,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const platform: Record<string, unknown> = {}
  const other: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if ((PLATFORM_CONFIG_KEYS as readonly string[]).includes(key)) platform[key] = value
    else other[key] = value
  }

  const defaults = requirements.defaultConfig ?? {}
  // A key changes something when merging it over its default gives another value.
  const keys = Object.keys(other).filter(
    (key) => canonical(mergeDefaults({ v: defaults[key] }, { v: other[key] }).v) !== canonical(defaults[key]),
  )
  if (keys.length > 0) {
    throw new BadRequestException(
      `Cannot deploy ${slug}: a deployment sets no agent settings (${keys.join(', ')}); pass them as env vars`,
    )
  }
  return { ...defaults, ...platform }
}

/** JSON with sorted keys, so two equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  ) ?? 'undefined'
}
