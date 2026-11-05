export const MAX_CPU_MILLICORES = 2000 // 2 cores
export const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024 // 4Gi
export const DEFAULT_CPU_LIMIT = '2000m'
export const DEFAULT_MEMORY_LIMIT = '2Gi'

/**
 * Parse a CPU string (e.g. "250m", "2") to millicores.
 * Returns null for invalid formats.
 */
export function parseCpuMillicores(value: string): number | null {
  const match = value.match(/^(\d+)(m?)$/)
  if (!match) return null
  const num = parseInt(match[1], 10)
  return match[2] === 'm' ? num : num * 1000
}

/**
 * Parse a memory string (e.g. "512Mi", "2Gi") to bytes.
 * Returns null for invalid formats.
 */
export function parseMemoryBytes(value: string): number | null {
  const match = value.match(/^(\d+)(Ki|Mi|Gi)?$/)
  if (!match) return null
  const num = parseInt(match[1], 10)

  switch (match[2]) {
    case 'Gi':
      return num * 1024 * 1024 * 1024
    case 'Mi':
      return num * 1024 * 1024
    case 'Ki':
      return num * 1024
    default:
      return num
  }
}

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

export const DEFAULT_CPU_REQUEST = '250m'
export const DEFAULT_MEMORY_REQUEST = '512Mi'

/**
 * Pod resource requests for an agent. Kubernetes refuses a pod whose request is
 * above its limit, so an agent that declares a limit below the default request
 * (say 256Mi) is given its limit as the request instead of failing to start.
 * Pass the clamped limits, which always parse.
 */
export function resolveResourceRequests(
  cpuLimit: string,
  memoryLimit: string,
): { cpu: string; memory: string } {
  const cpuLimitMillicores = parseCpuMillicores(cpuLimit)
  const memoryLimitBytes = parseMemoryBytes(memoryLimit)
  const defaultCpu = parseCpuMillicores(DEFAULT_CPU_REQUEST)!
  const defaultMemory = parseMemoryBytes(DEFAULT_MEMORY_REQUEST)!

  return {
    cpu: cpuLimitMillicores !== null && cpuLimitMillicores < defaultCpu ? cpuLimit : DEFAULT_CPU_REQUEST,
    memory: memoryLimitBytes !== null && memoryLimitBytes < defaultMemory ? memoryLimit : DEFAULT_MEMORY_REQUEST,
  }
}
