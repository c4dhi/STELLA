import { BadRequestException } from '@nestjs/common'
import { deepmergeCustom } from 'deepmerge-ts'
import { compareVersions } from '../agent-configurations/configuration-compat.util.js'
import { CURRENT_SDK_VERSION } from '../agent-package/manifest-defaults.js'
import { validateAgainstSchema } from '../agent-package/schemas/agent-manifest.schema.js'
import type { AgentRequirements } from './agent-requirements.js'

/**
 * Checks a deployment against what its agent type declares. Pure functions of
 * the requirements and the request: deploy, restart, wake and public projects
 * all run them, so no path can deploy what the manifest does not allow.
 */

/**
 * Keys of an agent config that STELLA sets itself. Everything else is a user
 * setting, which configSchema describes and defaultConfig fills in.
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

function envProblems({ env }: AgentRequirements, provided: Record<string, string>): string[] {
  // An empty value never reaches the pod (see buildSecretStringData), so it counts as missing.
  const missing = env.required.filter((name) => !provided[name]?.trim())
  return missing.length > 0 ? [`missing required environment variables: ${missing.join(', ')}`] : []
}

function sdkProblems({ sdkMinVersion }: AgentRequirements): string[] {
  return sdkMinVersion && compareVersions(sdkMinVersion, CURRENT_SDK_VERSION) > 0
    ? [`it needs stella-ai-agent-sdk ${sdkMinVersion}, newer than this STELLA supports (${CURRENT_SDK_VERSION})`]
    : []
}

/** Arrays in a user setting replace the default instead of being appended to it. */
const mergeSettings = deepmergeCustom({ mergeArrays: false })

/**
 * The config a pod receives: the user's settings deep-merged over the agent's
 * defaultConfig and checked against its configSchema, plus the platform keys
 * untouched. Idempotent, so a restart or wake can pass a saved config again.
 */
export function withUserSettings(
  slug: string,
  requirements: AgentRequirements,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const platform: Record<string, unknown> = {}
  const settings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if ((PLATFORM_CONFIG_KEYS as readonly string[]).includes(key)) platform[key] = value
    else settings[key] = value
  }

  const merged = mergeSettings(requirements.defaultConfig, settings) as Record<string, unknown>
  if (requirements.configSchema) {
    const errors = validateAgainstSchema(requirements.configSchema, merged)
    if (errors.length > 0) {
      throw new BadRequestException(`Cannot deploy ${slug}: its settings do not fit configSchema: ${errors.join('; ')}`)
    }
  }
  return { ...merged, ...platform }
}
