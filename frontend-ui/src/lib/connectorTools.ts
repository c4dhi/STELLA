/**
 * What the connector detail page shows about a tool, read from the tool's
 * `inputSchema` (JSON Schema, as the MCP server sent it with tools/list), and
 * how the "Try it" form turns typed text back into the tool's arguments.
 */
import type { ConnectorTool } from './api-types'

export type ToolParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'unknown'

export interface ToolParameter {
  name: string
  type: ToolParameterType
  required: boolean
  description?: string
  /** Allowed values, when the schema lists them. */
  options?: string[]
  /** The schema's default, as text for the form. */
  defaultText?: string
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

function typeOf(schema: Record<string, unknown>): ToolParameterType {
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type
  if (typeof t === 'string' && KNOWN_TYPES.has(t)) return t as ToolParameterType
  if (Array.isArray(schema.enum)) return 'string'
  return 'unknown'
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** The tool's top-level parameters, required ones first, in schema order otherwise. */
export function toolParameters(tool: ConnectorTool): ToolParameter[] {
  const schema = tool.inputSchema ?? {}
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const params = Object.entries(properties).map(([name, prop]): ToolParameter => {
    const p = prop && typeof prop === 'object' ? prop : {}
    return {
      name,
      type: typeOf(p),
      required: required.has(name),
      description: typeof p.description === 'string' ? p.description : undefined,
      options: Array.isArray(p.enum) ? p.enum.map(asText) : undefined,
      defaultText: p.default === undefined ? undefined : asText(p.default),
    }
  })
  return [...params.filter((p) => p.required), ...params.filter((p) => !p.required)]
}

export class ArgumentError extends Error {
  constructor(readonly parameter: string, message: string) {
    super(message)
  }
}

/**
 * The tool's arguments from the form's text fields. Empty optional fields are
 * left out, so the server's defaults apply. Throws ArgumentError naming the
 * field that does not parse, or a required field left empty.
 */
export function argumentsFromForm(params: ToolParameter[], values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const p of params) {
    const raw = (values[p.name] ?? '').trim()
    if (raw === '') {
      if (p.required) throw new ArgumentError(p.name, `${p.name} is required`)
      continue
    }
    switch (p.type) {
      case 'number':
      case 'integer': {
        const n = Number(raw)
        if (!Number.isFinite(n) || (p.type === 'integer' && !Number.isInteger(n))) {
          throw new ArgumentError(p.name, `${p.name} must be ${p.type === 'integer' ? 'a whole number' : 'a number'}`)
        }
        args[p.name] = n
        break
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') throw new ArgumentError(p.name, `${p.name} must be true or false`)
        args[p.name] = raw === 'true'
        break
      case 'object':
      case 'array':
      case 'unknown': {
        // Free text is still a fine value for an untyped parameter.
        try {
          const parsed: unknown = JSON.parse(raw)
          if (p.type === 'array' && !Array.isArray(parsed)) throw new Error()
          if (p.type === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error()
          args[p.name] = parsed
        } catch {
          if (p.type === 'unknown') args[p.name] = raw
          else throw new ArgumentError(p.name, `${p.name} must be a JSON ${p.type}`)
        }
        break
      }
      default:
        args[p.name] = raw
    }
  }
  return args
}

/** JSON that a server sent as a string (`{"result": "{\\"a\\":1}"}`) unwrapped, at any depth. */
function unwrapJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const t = value.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return unwrapJson(JSON.parse(t))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(unwrapJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapJson(v)]))
  }
  return value
}

/** What the tool returned, as text for the result box: structured content if any, else the text parts. */
export function resultText(result: { structuredContent?: unknown; content: unknown[] }): string {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return JSON.stringify(unwrapJson(result.structuredContent), null, 2)
  }
  const parts = result.content.map((c) => {
    const part = c as { type?: string; text?: string }
    if (part?.type === 'text' && typeof part.text === 'string') {
      const unwrapped = unwrapJson(part.text)
      return typeof unwrapped === 'string' ? unwrapped : JSON.stringify(unwrapped, null, 2)
    }
    return JSON.stringify(c, null, 2)
  })
  return parts.join('\n\n') || '(no content)'
}
