import {
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  clampCpuLimit,
  clampMemoryLimit,
  resolveResourceRequests,
  parseCpuMillicores,
  parseMemoryBytes,
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

describe('resolveResourceRequests', () => {
  it('uses the default requests when the limits are above them', () => {
    expect(resolveResourceRequests('2000m', '2Gi')).toEqual({ cpu: '250m', memory: '512Mi' })
  })

  it('keeps the default requests when the limits equal them', () => {
    expect(resolveResourceRequests('250m', '512Mi')).toEqual({ cpu: '250m', memory: '512Mi' })
  })

  it('lowers the requests to limits below the defaults, so Kubernetes accepts the pod', () => {
    // An agent that declared 256Mi used to fail with a 422 (request 512Mi above limit 256Mi).
    expect(resolveResourceRequests('100m', '256Mi')).toEqual({ cpu: '100m', memory: '256Mi' })
    expect(resolveResourceRequests('2000m', '262144Ki')).toEqual({ cpu: '250m', memory: '262144Ki' })
  })

  it('compares across units', () => {
    expect(resolveResourceRequests('1', '1Gi')).toEqual({ cpu: '250m', memory: '512Mi' })
  })

  it('never returns a request above the limit for any clamped limit', () => {
    for (const limit of ['1Mi', '128Mi', '256Mi', '511Mi', '512Mi', '1Gi', '4Gi']) {
      expect(parseMemoryBytes(resolveResourceRequests('2000m', limit).memory)!).toBeLessThanOrEqual(parseMemoryBytes(limit)!)
    }
    for (const limit of ['1m', '100m', '249m', '250m', '1', '2000m']) {
      expect(parseCpuMillicores(resolveResourceRequests(limit, '2Gi').cpu)!).toBeLessThanOrEqual(parseCpuMillicores(limit)!)
    }
  })
})
