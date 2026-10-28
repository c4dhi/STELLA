/**
 * Typed agent settings (#585): the variables an agent type declares, read from
 * its configSchema (`x-stella-env-vars` required, `x-stella-optional-env-vars`
 * optional) and shown as one control each, in tabs.
 *
 * `checkEnvVarValue` is a copy of the backend's in
 * `src/agent-package/env-var-settings.ts`, which has the final say on save and
 * deploy; change both together.
 */

export type EnvVarSettingType = 'string' | 'secret' | 'boolean' | 'integer' | 'number' | 'enum'

export interface EnvVarSetting {
  name: string
  type?: EnvVarSettingType
  label?: string
  description?: string
  default?: string
  agentDefault?: string
  unsetLabel?: string
  group?: string
  advanced?: boolean
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label?: string }[]
  pattern?: string
  required?: boolean
}

export interface SettingsTab {
  id: string
  label: string
  settings: EnvVarSetting[]
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

/** Every variable the agent type declares, required keys (as secrets) first. */
export function settingsFromSchema(configSchema: Record<string, unknown> | null | undefined): EnvVarSetting[] {
  if (!configSchema) return []
  const required = configSchema['x-stella-env-vars']
  const optional = configSchema['x-stella-optional-env-vars']
  const settings: EnvVarSetting[] = []
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === 'string') settings.push({ name, type: 'secret', required: true, group: 'Keys' })
    }
  }
  if (Array.isArray(optional)) {
    for (const entry of optional) {
      if (entry && typeof entry === 'object' && typeof (entry as EnvVarSetting).name === 'string') {
        settings.push(entry as EnvVarSetting)
      }
    }
  }
  return settings
}

/**
 * One tab per group, in the order the manifest first uses each: required keys
 * first, settings without a group under "General", and everything marked
 * advanced together in a last "Advanced" tab.
 */
export function settingsTabs(settings: EnvVarSetting[]): SettingsTab[] {
  const tabs: SettingsTab[] = []
  const tab = (id: string) => {
    let t = tabs.find((x) => x.id === id)
    if (!t) {
      t = { id, label: id, settings: [] }
      tabs.push(t)
    }
    return t
  }
  for (const s of settings) {
    if (s.required) tab('Keys').settings.push(s)
  }
  for (const s of settings) {
    if (!s.required && !s.advanced) tab(s.group || 'General').settings.push(s)
  }
  for (const s of settings) {
    if (!s.required && s.advanced) tab('Advanced').settings.push(s)
  }
  return tabs
}

/** What the setting is when nobody sets it, in words. */
export function defaultLabel(setting: EnvVarSetting): string {
  const value = setting.default ?? setting.agentDefault
  if (value === undefined) return setting.unsetLabel ?? 'not set'
  if (setting.type === 'boolean') return value === 'true' ? 'On' : 'Off'
  if (setting.type === 'enum') return setting.options?.find((o) => o.value === value)?.label ?? value
  return setting.unit ? `${value} ${setting.unit}` : value
}

/** Split a set of variables into declared settings and custom ones. */
export function splitVariables(
  settings: EnvVarSetting[],
  variables: Record<string, string>,
): { settings: Record<string, string>; custom: Record<string, string> } {
  const declared = new Set(settings.map((s) => s.name))
  const out = { settings: {} as Record<string, string>, custom: {} as Record<string, string> }
  for (const [key, value] of Object.entries(variables)) {
    if (declared.has(key)) out.settings[key] = value
    else out.custom[key] = value
  }
  return out
}

/** The declared settings whose (non-empty) value does not fit. */
export function invalidSettings(settings: EnvVarSetting[], values: Record<string, string>): Record<string, string> {
  const invalid: Record<string, string> = {}
  for (const s of settings) {
    const value = values[s.name]
    if (value === undefined || value === '' || s.type === 'secret') continue
    const problem = checkEnvVarValue(s, value)
    if (problem) invalid[s.name] = problem
  }
  return invalid
}

/**
 * The keys a template edit takes out: settings it stored that were reset, and
 * custom keys whose row was deleted. A stored secret stays until replaced, as
 * its value never reaches the browser.
 */
export function removedTemplateKeys(
  template: { variableKeys: string[]; settings?: Record<string, string> },
  settings: EnvVarSetting[],
  values: Record<string, string>,
  customKeys: string[],
): string[] {
  const declared = new Set(settings.map((s) => s.name))
  const custom = new Set(customKeys)
  return template.variableKeys.filter((k) =>
    declared.has(k) ? template.settings?.[k] !== undefined && values[k] === undefined : !custom.has(k),
  )
}

export interface MigrationNote {
  key: string
  /** The stored value, for declared non-secret settings only. */
  value?: string
  note: string
}

/**
 * What became of each variable a template stored before settings had types:
 * a setting, a setting whose value no longer fits, a stored secret, or a
 * custom variable (naming the declared setting it was probably meant to be).
 */
export function migrationNotes(
  template: { variableKeys: string[]; settings?: Record<string, string>; invalid?: Record<string, string> },
  settings: EnvVarSetting[],
): MigrationNote[] {
  const byName = new Map(settings.map((s) => [s.name, s]))
  const bare = (k: string) => k.replace(/^STELLA_/, '')
  return template.variableKeys.map((key) => {
    const setting = byName.get(key)
    const value = template.settings?.[key]
    if (setting?.type === 'secret') return { key, note: 'stored key, kept as it is' }
    // Untyped values are never sent back, as one may be a key.
    if (setting && !setting.type) return { key, note: 'stored value, kept as it is' }
    if (setting) {
      const problem = template.invalid?.[key]
      return { key, value, note: problem ? `setting, but it ${problem}: needs a value` : `the "${setting.label ?? key}" setting` }
    }
    const near = settings.find((s) => s.name !== key && (bare(s.name).startsWith(bare(key)) || bare(key).startsWith(bare(s.name))))
    return {
      key,
      note: near
        ? `not declared (did you mean ${near.name}?): kept as a custom variable`
        : 'not declared by this agent: kept as a custom variable',
    }
  })
}
