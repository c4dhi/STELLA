import {
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  clampCpuLimit,
  clampMemoryLimit,
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
