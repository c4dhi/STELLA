import {
  RESOURCE_DEFAULTS,
  parseCpuMillicores,
  parseMemoryBytes,
} from '../../agent-package/manifest-defaults.js'

// Defaults, maxima and parsers come from the manifest's single source, so a pod
// can never be clamped to a different default than the one an agent type was stored with.
export { parseCpuMillicores, parseMemoryBytes }
export const MAX_CPU_MILLICORES = parseCpuMillicores(RESOURCE_DEFAULTS.cpu.max)!
export const MAX_MEMORY_BYTES = parseMemoryBytes(RESOURCE_DEFAULTS.memory.max)!
export const DEFAULT_CPU_LIMIT = RESOURCE_DEFAULTS.cpu.limit
export const DEFAULT_MEMORY_LIMIT = RESOURCE_DEFAULTS.memory.limit

/**
 * Clamp a resource limit to a safe default when the value is invalid or exceeds maximum.
 * Returns both value and reason so callers can produce accurate warnings.
 */
export function clampResourceLimit(
  value: string | undefined,
  defaultValue: string,
  maxValue: number,
  parser: (v: string) => number | null,
): { value: string; reason: 'missing' | 'invalid' | 'exceeds_max' | 'ok' } {
  if (!value) {
    return { value: defaultValue, reason: 'missing' }
  }

  const parsed = parser(value)
  if (parsed === null) {
    return { value: defaultValue, reason: 'invalid' }
  }

  if (parsed > maxValue) {
    return { value: defaultValue, reason: 'exceeds_max' }
  }

  return { value, reason: 'ok' }
}

export function clampCpuLimit(value: string | undefined): { value: string; reason: 'missing' | 'invalid' | 'exceeds_max' | 'ok' } {
  return clampResourceLimit(value, DEFAULT_CPU_LIMIT, MAX_CPU_MILLICORES, parseCpuMillicores)
}

export function clampMemoryLimit(value: string | undefined): { value: string; reason: 'missing' | 'invalid' | 'exceeds_max' | 'ok' } {
  return clampResourceLimit(value, DEFAULT_MEMORY_LIMIT, MAX_MEMORY_BYTES, parseMemoryBytes)
}
