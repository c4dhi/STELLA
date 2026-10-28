/**
 * Typed agent settings (#585): the variables an agent manifest declares under
 * `x-stella-env-vars` (required) and `x-stella-optional-env-vars` (optional),
 * read as settings with a type, and the one check every entry point uses on a
 * value. A value is still a string: what reaches the pod is unchanged.
 *
 * The frontend keeps a copy of `checkEnvVarValue` in
 * `frontend-ui/src/lib/agentSettings.ts`; change both together.
 */

export const ENV_VAR_SETTING_TYPES = ['string', 'secret', 'boolean', 'integer', 'number', 'enum'] as const
export type EnvVarSettingType = (typeof ENV_VAR_SETTING_TYPES)[number]

export interface EnvVarSettingOption {
  value: string
  label?: string
}

export interface EnvVarSetting {
  name: string
  /** Absent = free text, which is what every declared variable was before #585. */
  type?: EnvVarSettingType
  label?: string
  description?: string
  /** Injected into the pod when nothing else sets it. */
  default?: string
  /**
   * What the agent does when the variable is unset — shown, never injected.
   * For variables whose explicit value means something else than leaving them
   * unset (an explicit BARGE_IN_ENABLED locks barge-in against the agent's
   * own declaration), so they cannot carry a `default`.
   */
  agentDefault?: string
  /** How to describe "unset" when it is not a value, e.g. "Automatic". */
  unsetLabel?: string
  group?: string
  advanced?: boolean
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: EnvVarSettingOption[]
  pattern?: string
  /** Set for keys listed in `x-stella-env-vars`. */
  required?: boolean
}

const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

/** Why `value` does not fit `setting`, or null when it does. */
export function checkEnvVarValue(setting: EnvVarSetting, value: string): string | null {
  switch (setting.type) {
    case 'boolean':
      return value === 'true' || value === 'false' ? null : 'must be true or false'
    case 'integer':
    case 'number': {
      if (!NUMBER_RE.test(value.trim())) return 'must be a number'
      const n = Number(value)
      if (setting.type === 'integer' && !Number.isInteger(n)) return 'must be a whole number'
      const { min, max } = setting
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        if (min !== undefined && max !== undefined) return `must be between ${min} and ${max}`
        return min !== undefined ? `must be at least ${min}` : `must be at most ${max}`
      }
      return null
    }
    case 'enum': {
      const values = (setting.options ?? []).map((o) => o.value)
      return values.includes(value) ? null : `must be one of: ${values.join(', ')}`
    }
    default:
      if (setting.pattern && !new RegExp(setting.pattern).test(value)) return `must match ${setting.pattern}`
      return null
  }
}

/** Every variable the agent declares, required keys (as secrets) first. */
export function extractEnvVarSettings(configSchema: Record<string, unknown> | null | undefined): EnvVarSetting[] {
  if (!configSchema) return []
  const required = configSchema['x-stella-env-vars']
  const optional = configSchema['x-stella-optional-env-vars']
  const settings: EnvVarSetting[] = []
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === 'string') settings.push({ name, type: 'secret', required: true })
    }
  }
  if (Array.isArray(optional)) {
    for (const entry of optional) {
      if (typeof entry === 'object' && entry !== null && typeof (entry as EnvVarSetting).name === 'string') {
        settings.push(entry as EnvVarSetting)
      }
    }
  }
  return settings
}

/** Declared keys are settings; anything else is a custom variable. */
export function classifyEnvVars(
  configSchema: Record<string, unknown> | null | undefined,
  variables: Record<string, string>,
): { settings: Record<string, string>; custom: Record<string, string> } {
  const declared = new Set(extractEnvVarSettings(configSchema).map((s) => s.name))
  const settings: Record<string, string> = {}
  const custom: Record<string, string> = {}
  for (const [key, value] of Object.entries(variables)) {
    if (declared.has(key)) settings[key] = value
    else custom[key] = value
  }
  return { settings, custom }
}

/** The declared keys whose value does not fit, with the reason. Custom keys are not checked. */
export function invalidEnvVarValues(
  configSchema: Record<string, unknown> | null | undefined,
  variables: Record<string, string>,
): Record<string, string> {
  const invalid: Record<string, string> = {}
  for (const setting of extractEnvVarSettings(configSchema)) {
    const value = variables[setting.name]
    if (value === undefined) continue
    const problem = checkEnvVarValue(setting, value)
    if (problem) invalid[setting.name] = problem
  }
  return invalid
}
