/**
 * Configuration settings (#996): the values a saved AgentConfiguration may set
 * for an agent, each declared by the agent with a key, a type and a default.
 *
 * Where a setting is declared:
 *  - in the manifest's `settings:` section, or
 *  - as a slot on a `pipelineSchema` node (the older form): slot `x` on node
 *    `n` is the setting `n.x`.
 * `declareConfigSettings` turns both into one list. The manifest mapper stores
 * that list in the AgentType's pipelineSchema (`settings`), so validation,
 * reconciliation and the Configurator all read the same list, and a change to
 * it re-checks saved configurations like any other pipelineSchema change.
 *
 * Where a value lives: a saved configuration keeps setting `n.x` at
 * `nodes.n.x`, and the agent reads it from `pipeline_config.nodes.n.x`. Both
 * are unchanged from before the declarations existed.
 *
 * Unlike env vars, a value is JSON (a number is a number). The number, enum and
 * format checks are the env var ones (`checkEnvVarValue`), so a range means the
 * same in both places. The frontend reads the list and does not check values
 * itself; a refused save comes back as a 400 with the reason.
 */
import { checkEnvVarValue, type EnvVarFormat, type EnvVarSettingOption } from './env-var-settings.js'

export const CONFIG_SETTING_TYPES = [
  'string',
  'text',
  'boolean',
  'integer',
  'number',
  'enum',
  'string_list',
  'key_value',
  'expert_list',
  'verdict_directives',
] as const
export type ConfigSettingType = (typeof CONFIG_SETTING_TYPES)[number]

/** `<stage>.<name>`, both lowercase with underscores: the stage is a pipeline node id. */
export const CONFIG_SETTING_KEY_REGEX = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

export interface ConfigSetting {
  key: string
  type: ConfigSettingType
  label?: string
  description?: string
  default?: unknown
  group?: string
  advanced?: boolean
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: EnvVarSettingOption[]
  format?: EnvVarFormat
  maxLength?: number
  /** expert_list only: the list of the configuration's own experts, not the agent's built-in ones. */
  isCustom?: boolean
}

/** A pipelineSchema slot, as manifests 1.0 and 2.0 declare it. */
interface PipelineSlot {
  id: string
  label?: string
  type: string
  description?: string
  default?: unknown
  options?: string[]
  min?: number
  max?: number
  step?: number
  maxLength?: number
  isCustom?: boolean
}

const SLOT_TYPE_TO_SETTING_TYPE: Record<string, ConfigSettingType> = {
  text: 'text',
  number: 'number',
  select: 'enum',
  string_list: 'string_list',
  key_value: 'key_value',
  expert_list: 'expert_list',
  verdict_directives: 'verdict_directives',
}

/** Slot `x` on node `n` as the setting `n.x`. */
export function slotToConfigSetting(nodeId: string, slot: PipelineSlot): ConfigSetting {
  const setting: ConfigSetting = {
    key: `${nodeId}.${slot.id}`,
    type: SLOT_TYPE_TO_SETTING_TYPE[slot.type] ?? 'text',
  }
  if (slot.label !== undefined) setting.label = slot.label
  if (slot.description !== undefined) setting.description = slot.description
  if (slot.default !== undefined) setting.default = slot.default
  if (slot.options) setting.options = slot.options.map((value) => ({ value }))
  if (slot.min !== undefined) setting.min = slot.min
  if (slot.max !== undefined) setting.max = slot.max
  if (slot.step !== undefined) setting.step = slot.step
  if (slot.maxLength !== undefined) setting.maxLength = slot.maxLength
  if (slot.isCustom !== undefined) setting.isCustom = slot.isCustom
  return setting
}

/**
 * Every setting an agent declares: its pipeline slots first, in node order,
 * then its `settings:` section. A key declared twice is a manifest error
 * (`duplicateConfigSettingKeys`), so the order only matters for display.
 */
export function declareConfigSettings(
  pipelineSchema: Record<string, unknown> | null | undefined,
  settings: ConfigSetting[] = [],
): ConfigSetting[] {
  const nodes = (pipelineSchema?.nodes ?? []) as Array<{ id: string; slots?: PipelineSlot[] }>
  const fromSlots = nodes.flatMap((node) => (node.slots ?? []).map((slot) => slotToConfigSetting(node.id, slot)))
  return [...fromSlots, ...settings]
}

/** Keys declared more than once across the slots and the `settings:` section. */
export function duplicateConfigSettingKeys(declared: ConfigSetting[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const { key } of declared) {
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates]
}

/**
 * The settings a stored pipelineSchema declares. A schema mapped since #996
 * carries the list; an older row (an upload not re-mapped since) gets it from
 * its slots, which is all such a row can declare.
 */
export function configSettingsOf(pipelineSchema: Record<string, unknown> | null | undefined): ConfigSetting[] {
  if (!pipelineSchema) return []
  const stored = pipelineSchema.settings
  if (Array.isArray(stored)) return stored as ConfigSetting[]
  return declareConfigSettings(pipelineSchema)
}

/** The pipelineSchema with its full settings list, for storing and serving. */
export function withConfigSettings(
  pipelineSchema: Record<string, unknown> | null | undefined,
  settings: ConfigSetting[] = [],
): Record<string, unknown> | null {
  if (!pipelineSchema) return null
  return { ...pipelineSchema, settings: declareConfigSettings(pipelineSchema, settings) }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why `value` does not fit `setting`, or null when it does. null and undefined mean "unset". */
export function checkConfigSettingValue(setting: ConfigSetting, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (setting.type) {
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
      return checkEnvVarValue({ name: setting.key, type: setting.type, min: setting.min, max: setting.max }, String(value))
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false'
    case 'enum':
      if (typeof value !== 'string') return 'must be text'
      return checkEnvVarValue({ name: setting.key, type: 'enum', options: setting.options }, value)
    case 'string':
    case 'text': {
      if (typeof value !== 'string') return 'must be text'
      if (setting.maxLength !== undefined && value.length > setting.maxLength) {
        return `must be at most ${setting.maxLength} characters`
      }
      if (setting.type === 'string' && setting.format) {
        return checkEnvVarValue({ name: setting.key, type: 'string', format: setting.format }, value)
      }
      return null
    }
    case 'string_list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'must be a list of texts'
    case 'key_value':
      return isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string')
        ? null
        : 'must be pairs of names and texts'
    case 'expert_list':
    case 'verdict_directives':
      // Their structure belongs to the expert registry, which checks it.
      return isPlainObject(value) ? null : 'must be an object'
    default:
      return null
  }
}

/** Split `n.x` into node `n` and name `x`. */
export function splitConfigSettingKey(key: string): [string, string] {
  const dot = key.indexOf('.')
  return [key.slice(0, dot), key.slice(dot + 1)]
}
