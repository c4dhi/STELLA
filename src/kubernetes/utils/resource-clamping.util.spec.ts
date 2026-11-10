import {
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  clampCpuLimit,
  clampMemoryLimit,
  parseCpuMillicores,
  parseMemoryBytes,
  requestWithinLimit,
} from './resource-clamping.util.js'

describe('resource-clamping util', () => {
  it('accepts valid CPU limits up to 2000m', () => {
    // CPU values at or under max should pass through unchanged.
    expect(clampCpuLimit('2000m')).toEqual({ value: '2000m', reason: 'ok' })
    expect(clampCpuLimit('2')).toEqual({ value: '2', reason: 'ok' })
  })

  it('clamps invalid or over-max CPU limits to default', () => {
    // Invalid format and over-max values should be safely downgraded.
    expect(clampCpuLimit('2500m')).toEqual({ value: DEFAULT_CPU_LIMIT, reason: 'exceeds_max' })
    expect(clampCpuLimit('abc')).toEqual({ value: DEFAULT_CPU_LIMIT, reason: 'invalid' })
    expect(clampCpuLimit(undefined)).toEqual({ value: DEFAULT_CPU_LIMIT, reason: 'missing' })
  })

  it('accepts valid memory limits up to 4Gi', () => {
    // Memory values at or under max should pass through unchanged.
    expect(clampMemoryLimit('4Gi')).toEqual({ value: '4Gi', reason: 'ok' })
    expect(clampMemoryLimit('512Mi')).toEqual({ value: '512Mi', reason: 'ok' })
  })

  it('clamps invalid or over-max memory limits to default', () => {
    // Invalid format and over-max values should be safely downgraded.
    expect(clampMemoryLimit('5Gi')).toEqual({ value: DEFAULT_MEMORY_LIMIT, reason: 'exceeds_max' })
    expect(clampMemoryLimit('ten')).toEqual({ value: DEFAULT_MEMORY_LIMIT, reason: 'invalid' })
    expect(clampMemoryLimit(undefined)).toEqual({ value: DEFAULT_MEMORY_LIMIT, reason: 'missing' })
  })
})

describe('requestWithinLimit', () => {
  it('keeps a valid request at or below the limit', () => {
    expect(requestWithinLimit('50m', '250m', '250m', parseCpuMillicores)).toBe('50m')
    expect(requestWithinLimit('256Mi', '256Mi', '512Mi', parseMemoryBytes)).toBe('256Mi')
  })

  it('lowers a request above the limit to the limit, since Kubernetes refuses that pod', () => {
    expect(requestWithinLimit('1Gi', '256Mi', '512Mi', parseMemoryBytes)).toBe('256Mi')
    expect(requestWithinLimit(undefined, '256Mi', '512Mi', parseMemoryBytes)).toBe('256Mi')
  })

  it('uses the default for a missing or invalid request', () => {
    expect(requestWithinLimit(undefined, '2Gi', '512Mi', parseMemoryBytes)).toBe('512Mi')
    expect(requestWithinLimit('lots', '2000m', '250m', parseCpuMillicores)).toBe('250m')
  })
})
