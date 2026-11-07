/**
 * Typed agent settings (#585): the env vars an agent manifest declares under
 * `env.required` and `env.optional`, read as settings with a type, and the one
 * check every entry point uses on a value (deploy, restart and wake through
 * deploy-request.ts, and env var template saves). A value is still a string:
 * what reaches the pod is unchanged.
 *
 * Plain functions on the manifest's `env` block (AgentRequirements['env']); the
 * manifest schema declares the fields. The frontend keeps a copy of
 * `checkEnvVarValue` in `frontend-ui/src/lib/agentSettings.ts`; change both together.
 */

export const ENV_VAR_SETTING_TYPES = ['string', 'secret', 'boolean', 'integer', 'number', 'enum'] as const
export type EnvVarSettingType = (typeof ENV_VAR_SETTING_TYPES)[number]

/**
 * Fixed checks a string setting may name with `format`. Manifests may not bring
 * their own regular expression (ReDoS); these are STELLA's, and safe.
 */
const FORMAT_CHECKS = {
  /** An ISO 639-1 code, e.g. "de". */
  language: { test: (v: string) => /^[a-z]{2}$/.test(v), problem: 'must be a two-letter language code, e.g. "de"' },
  /** An ISO 639-1 code, or "auto" to detect it. */
  'language-or-auto': {
    test: (v: string) => v === 'auto' || /^[a-z]{2}$/.test(v),
    problem: 'must be "auto" or a two-letter language code, e.g. "de"',
  },
} as const
export const ENV_VAR_FORMATS = Object.keys(FORMAT_CHECKS) as [keyof typeof FORMAT_CHECKS, ...(keyof typeof FORMAT_CHECKS)[]]
export type EnvVarFormat = keyof typeof FORMAT_CHECKS

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
   * What the agent does when the variable is unset: shown, never injected.
   * For variables whose explicit value means more than leaving them unset (an
   * explicit BARGE_IN_ENABLED locks barge-in against the agent's own
   * declaration), so they cannot carry a `default`.
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
  format?: EnvVarFormat
  /** Set for keys listed in `env.required`. */
  required?: boolean
}

/** The manifest's env block, as AgentRequirements carries it. */
export interface DeclaredEnv {
  required: string[]
  optional: EnvVarSetting[]
}

// No run of digits can be split two ways, so this is linear on any input (ReDoS).
const NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/

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
    default: {
      const check = setting.format ? FORMAT_CHECKS[setting.format] : undefined
      return check && !check.test(value) ? check.problem : null
    }
  }
}

/** Every variable the agent declares, required keys (as secrets) first. */
export function extractEnvVarSettings(env: DeclaredEnv | null | undefined): EnvVarSetting[] {
  if (!env) return []
  return [
    ...env.required.map((name): EnvVarSetting => ({ name, type: 'secret', required: true })),
    ...env.optional,
  ]
}

/** Declared keys are settings; anything else is a custom variable. */
export function classifyEnvVars(
  env: DeclaredEnv | null | undefined,
  variables: Record<string, string>,
): { settings: Record<string, string>; custom: Record<string, string> } {
  const declared = new Set(extractEnvVarSettings(env).map((s) => s.name))
  const settings: Record<string, string> = {}
  const custom: Record<string, string> = {}
  for (const [key, value] of Object.entries(variables)) {
    if (declared.has(key)) settings[key] = value
    else custom[key] = value
  }
  return { settings, custom }
}

/**
 * The declared keys whose value does not fit, with the reason. Custom keys are
 * not checked, and neither is an empty value: templates may hold one, and the
 * agent reads it as unset.
 */
export function invalidEnvVarValues(
  env: DeclaredEnv | null | undefined,
  variables: Record<string, string>,
): Record<string, string> {
  const invalid: Record<string, string> = {}
  for (const setting of extractEnvVarSettings(env)) {
    const value = variables[setting.name]
    if (value === undefined || value === '') continue
    const problem = checkEnvVarValue(setting, value)
    if (problem) invalid[setting.name] = problem
  }
  return invalid
}
