import { describe, it, expect } from 'vitest'
import { axisCeiling } from './StageTimeline'

const stage = (p95: number, max = p95, mean = p95) => ({
  p95_ms: p95, max_ms: max, mean_ms: mean,
})

describe('axisCeiling', () => {
  it('returns the largest timing across stages', () => {
    expect(axisCeiling([stage(120), stage(840), stage(35)])).toBe(840)
  })

  it('returns 0 when every stage is zero', () => {
    // The regression: a session whose turns had no analytics anchor records a
    // full set of stages, all at 0ms. This must not become the axis maximum.
    expect(axisCeiling([stage(0), stage(0), stage(0)])).toBe(0)
  })

  it('returns 0 for no stages', () => {
    expect(axisCeiling([])).toBe(0)
  })

  it('falls back through p95 → max → mean', () => {
    expect(axisCeiling([{ p95_ms: 0, max_ms: 0, mean_ms: 42 }])).toBe(42)
    expect(axisCeiling([{ p95_ms: 0, max_ms: 17, mean_ms: 42 }])).toBe(17)
  })

  it('never returns a non-finite ceiling', () => {
    expect(axisCeiling([{ p95_ms: NaN, max_ms: NaN, mean_ms: NaN }])).toBe(0)
    expect(axisCeiling([{ p95_ms: Infinity, max_ms: 0, mean_ms: 0 }])).toBe(0)
  })

  it('a zero ceiling would have produced NaN coordinates', () => {
    // Documents why the guard exists: this is the arithmetic the chart does.
    const LEFT = 140, WIDTH = 500
    const bad = LEFT + (0 / (0 * 1.1)) * WIDTH
    expect(Number.isNaN(bad)).toBe(true)

    const ceiling = axisCeiling([stage(0)])
    const good = LEFT + (0 / (ceiling > 0 ? ceiling * 1.1 : 100)) * WIDTH
    expect(good).toBe(LEFT)
  })
})
