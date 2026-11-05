/**
 * The deploy wizard's "Settings" step: turns an agent's `configSchema` (from the
 * server's `requirements`, so the browser never reads agent.yaml) into form
 * fields, and the filled-in form back into the settings object sent as
 * `config`. The server merges `defaultConfig` and validates against the schema
 * again, so this is presentation; it only refuses an empty required field.
 *
 * Supported: nested objects, string, number, integer, boolean, and `enum` of
 * any of those. A property of another shape (arrays, free-form objects) has no
 * field; its default still applies on the server.
 */

type Schema = Record<string, unknown>

export type SettingKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum'

export interface SettingField {
  /** Dotted path into the settings object, e.g. `elias.project_id`. */
  path: string
  label: string
  description?: string
  kind: SettingKind
  options?: Array<string | number | boolean>
  required: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

/** Form values by field path. Booleans are booleans; everything else is text as typed. */
export type SettingValues = Record<string, string | boolean>

const SCALARS = new Set(['string', 'number', 'integer', 'boolean'])

function isObject(value: unknown): value is Schema {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function getAt(source: unknown, path: string[]): unknown {
  let node = source
  for (const key of path) {
    if (!isObject(node)) return undefined
    node = node[key]
  }
  return node
}

/**
 * The fields a schema offers, required ones first. A nested field counts as
 * required when its parent object will exist: the parent is required itself, or
 * the agent's defaults already fill it in (so the server checks its `required`).
 */
export function settingFields(schema: Schema | null | undefined, defaults: Schema = {}): SettingField[] {
  const fields: SettingField[] = []
  const walk = (node: Schema, path: string[], parentPresent: boolean, labels: string[]) => {
    const properties = isObject(node.properties) ? node.properties : {}
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
    for (const [key, raw] of Object.entries(properties)) {
      if (!isObject(raw) || key.startsWith('x-stella-')) continue
      const childPath = [...path, key]
      const isRequired = parentPresent && required.has(key)
      const label = typeof raw.title === 'string' ? raw.title : humanize(key)
      const type = raw.type
      if (type === 'object' || (!type && isObject(raw.properties))) {
        const present = isRequired || isObject(getAt(defaults, childPath))
        walk(raw, childPath, present, [...labels, label])
        continue
      }
      const options = Array.isArray(raw.enum) ? (raw.enum as Array<string | number | boolean>) : undefined
      if (!options && !(typeof type === 'string' && SCALARS.has(type))) continue
      fields.push({
        path: childPath.join('.'),
        label: [...labels, label].join(' › '),
        description: typeof raw.description === 'string' ? raw.description : undefined,
        kind: options ? 'enum' : (type as SettingKind),
        options,
        required: isRequired,
        minimum: typeof raw.minimum === 'number' ? raw.minimum : undefined,
        maximum: typeof raw.maximum === 'number' ? raw.maximum : undefined,
        minLength: typeof raw.minLength === 'number' ? raw.minLength : undefined,
        maxLength: typeof raw.maxLength === 'number' ? raw.maxLength : undefined,
      })
    }
  }
  if (isObject(schema)) walk(schema, [], true, [])
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)]
}

/** Starting values: the agent's defaults, then the schema's own `default`s. */
export function initialSettingValues(fields: SettingField[], schema: Schema | null | undefined, defaults: Schema = {}): SettingValues {
  const values: SettingValues = {}
  for (const field of fields) {
    const path = field.path.split('.')
    let value = getAt(defaults, path)
    if (value === undefined) {
      const node = getAt(schema, path.flatMap((key) => ['properties', key]))
      value = isObject(node) ? node.default : undefined
    }
    if (field.kind === 'boolean') values[field.path] = value === true
    else values[field.path] = value === undefined || value === null ? '' : String(value)
  }
  return values
}

/** Required fields still left empty. */
export function missingSettings(fields: SettingField[], values: SettingValues): SettingField[] {
  return fields.filter((f) => f.required && f.kind !== 'boolean' && !String(values[f.path] ?? '').trim())
}

function typed(field: SettingField, raw: string | boolean): unknown {
  if (field.kind === 'boolean') return raw === true
  const text = String(raw).trim()
  if (field.kind === 'number' || field.kind === 'integer') {
    const n = Number(text)
    return Number.isFinite(n) ? n : text // let the server report a bad number
  }
  if (field.kind === 'enum') {
    return field.options?.find((option) => String(option) === text) ?? text
  }
  return text
}

/**
 * The settings object to send: every filled-in field, nested by its path. Empty
 * text fields are left out, so the agent's default applies to them.
 */
export function settingsFromValues(fields: SettingField[], values: SettingValues): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.path]
    if (raw === undefined || (field.kind !== 'boolean' && !String(raw).trim())) continue
    const path = field.path.split('.')
    let node = settings
    for (const key of path.slice(0, -1)) {
      if (!isObject(node[key])) node[key] = {}
      node = node[key] as Record<string, unknown>
    }
    node[path[path.length - 1]] = typed(field, raw)
  }
  return settings
}
