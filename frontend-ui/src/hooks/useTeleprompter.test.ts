/**
 * Scheduling arithmetic for the teleprompter (#241).
 *
 * The SDK now streams a progress tick every ~200ms rather than one envelope per
 * sentence, so these ticks have to chain into a continuous timeline without
 * overlapping, without gapping, and without accumulating drift over a long
 * reply. That is all `planSegment` does, and it is the part that decides
 * whether the highlight reads as in sync with the voice.
 */
import { describe, it, expect } from 'vitest'
import { planSegment } from './useTeleprompter'

// Mirrors the constants in the hook.
const LAG = 60
const TOLERANCE = 600

describe('planSegment', () => {
  it('starts a first tick when its audio becomes audible, not immediately', () => {
    // The data channel outruns the audio: 300ms of it is still queued.
    const seg = planSegment({ now: 1000, delayMs: 300, durationMs: 200, scheduledUntil: 0 })
    expect(seg.startAt).toBe(1000 + 300 + LAG)
    expect(seg.endAt).toBe(seg.startAt + 200)
    expect(seg.rebase).toBe(false)
  })

  it('chains consecutive ticks so they neither overlap nor gap', () => {
    // A tick arrives while the previous segment is still animating. Playing it
    // at its own audible time would rewind the highlight over audio already
    // scheduled, so it must butt onto the end of the chain instead.
    const first = planSegment({ now: 1000, delayMs: 800, durationMs: 200, scheduledUntil: 0 })
    const second = planSegment({
      now: 1100,
      delayMs: 700,
      durationMs: 200,
      scheduledUntil: first.endAt,
    })
    expect(second.startAt).toBe(first.endAt)
    expect(second.rebase).toBe(false)
  })

  it('holds the chain when a tick lands only slightly early', () => {
    // Sub-tolerance disagreement is ordinary jitter, not drift — chaining wins,
    // otherwise every tick would nudge the timeline and the highlight jitter.
    // audibleAt = 1150; the chain reaches 1600, i.e. 450ms ahead (< 600).
    const seg = planSegment({ now: 1000, delayMs: 0, durationMs: 200, scheduledUntil: 1600 })
    expect(seg.rebase).toBe(false)
    expect(seg.startAt).toBe(1600)
  })

  it('rebases onto the fresh measurement once the chain has drifted', () => {
    // Long reply: per-segment slop has pushed the chain a second past the audio
    // the SDK says is queued. Chaining further would leave the highlight
    // permanently behind the voice, so the fresh measurement wins.
    const now = 5000
    const seg = planSegment({ now, delayMs: 100, durationMs: 200, scheduledUntil: now + 2000 })
    expect(seg.rebase).toBe(true)
    expect(seg.startAt).toBe(now + 100 + LAG)
    expect(seg.endAt).toBe(seg.startAt + 200)
  })

  it('never produces a zero-length segment', () => {
    // A zero-width span makes the rAF loop divide by zero when interpolating.
    const seg = planSegment({ now: 1000, delayMs: 0, durationMs: 0, scheduledUntil: 0 })
    expect(seg.endAt).toBeGreaterThan(seg.startAt)
  })

  it('drift tolerance is wide enough to leave genuine lookahead chained', () => {
    // When synthesis outruns playback the SDK legitimately buffers ahead, and
    // delay_ms reports it — so audibleAt tracks the chain and nothing rebases.
    let scheduledUntil = 0
    let now = 1000
    for (let i = 0; i < 20; i++) {
      const queued = i === 0 ? 0 : scheduledUntil - now - LAG
      const seg = planSegment({ now, delayMs: Math.max(0, queued), durationMs: 200, scheduledUntil })
      expect(seg.rebase).toBe(false)
      scheduledUntil = seg.endAt
      now += 200
    }
    expect(scheduledUntil - now).toBeLessThan(TOLERANCE + LAG + 200)
  })
})
