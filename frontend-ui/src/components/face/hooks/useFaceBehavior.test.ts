/**
 * The two rules the idle/gaze behavior turns on (#face-emotions).
 *
 * Both are pure so they can be stated and checked here rather than inferred
 * from four booleans inside a requestAnimationFrame loop — the same reason
 * `planSegment` sits outside `useTeleprompter`.
 */
import { describe, it, expect } from 'vitest'
import { resolveGazeMode, planSaccade, stepBusy } from './useFaceBehavior'

describe('resolveGazeMode', () => {
  it('holds the gaze on a detected face, however long the silence runs', () => {
    // The whole point of the lock: a face in view is looked AT, and the idle
    // look-around must never pull the eyes off it.
    expect(resolveGazeMode({ isGazeLocked: true, quietMs: 0, reducedMotion: false })).toBe('tracking')
    expect(resolveGazeMode({ isGazeLocked: true, quietMs: 60_000, reducedMotion: false })).toBe('tracking')
  })

  it('looks straight ahead with nobody there until the silence has run a beat', () => {
    // No face and mid-conversation: the eyes rest forward rather than wandering
    // off in the middle of a sentence.
    expect(resolveGazeMode({ isGazeLocked: false, quietMs: 0, reducedMotion: false })).toBe('straight')
    expect(resolveGazeMode({ isGazeLocked: false, quietMs: 2_499, reducedMotion: false })).toBe('straight')
  })

  it('starts looking around once nothing has been said for a couple of seconds', () => {
    expect(resolveGazeMode({ isGazeLocked: false, quietMs: 2_501, reducedMotion: false })).toBe('wander')
  })

  it('never wanders under reduced motion', () => {
    expect(resolveGazeMode({ isGazeLocked: false, quietMs: 60_000, reducedMotion: true })).toBe('straight')
  })
})

describe('planSaccade', () => {
  // Deterministic RNG: hands back the given values in order, then repeats the
  // last one, so a test only has to state the rolls it cares about.
  const rng = (...values: number[]) => {
    let i = 0
    return () => values[Math.min(i++, values.length - 1)]
  }

  it('mostly makes small movements — a uniform spread reads as a nervous scan', () => {
    const small = planSaccade(rng(0.1, 0.5, 0.25))
    expect(small.amplitude).toBeLessThan(0.3)
    expect(small.isLargeExcursion).toBe(false)
  })

  it('marks the rare big excursion, which is what reads as looking away', () => {
    const away = planSaccade(rng(0.99, 0.5, 0.25))
    expect(away.amplitude).toBeGreaterThanOrEqual(0.55)
    expect(away.isLargeExcursion).toBe(true)
  })

  it('takes longer over bigger jumps, so eye speed stays roughly constant', () => {
    const small = planSaccade(rng(0.1, 0, 0))
    const large = planSaccade(rng(0.99, 0.99, 0))
    expect(large.durationMs).toBeGreaterThan(small.durationMs)
  })

  it('keeps every target inside the pupil range, vertically tighter than horizontally', () => {
    for (let i = 0; i < 500; i++) {
      const s = planSaccade(Math.random)
      expect(Math.abs(s.x)).toBeLessThanOrEqual(0.9)
      expect(Math.abs(s.y)).toBeLessThanOrEqual(0.5)
      expect(s.holdMs).toBeGreaterThanOrEqual(700)
      expect(s.holdMs).toBeLessThanOrEqual(2600)
    }
  })

  it('honors a forced amplitude, so a double-take can demand a big glance', () => {
    const peek = planSaccade(rng(0.1, 0.5, 0.25), 0.8)
    expect(peek.amplitude).toBe(0.8)
    expect(peek.isLargeExcursion).toBe(true)
  })
})

describe('stepBusy — the idle countdown', () => {
  const quiet = { busySince: null, lastBusyAt: 0 }

  it('ignores a single frame of speech, which is what broke the idle animation', () => {
    // isRemoteSpeaking is an RMS threshold sampled every frame, tuned to drive
    // the mouth. It flickers over the line on room tone. Under the old rule one
    // such frame reset the countdown outright, and one per 2.5s was enough to
    // keep the face awake forever.
    const blip = stepBusy({ busySince: null, lastBusyAt: 0 }, true, 10_000)
    expect(blip.lastBusyAt).toBe(0) // countdown untouched
  })

  it('is not fooled by a blip that repeats forever', () => {
    // The actual failure: a spike every 2s, each one landing on a single frame.
    let state = { busySince: null as number | null, lastBusyAt: 0 }
    for (let t = 0; t < 60_000; t += 16) {
      const spike = t % 2000 === 0
      state = stepBusy(state, spike, t)
    }
    // A full minute of "silence with spikes" must still read as quiet.
    expect(60_000 - state.lastBusyAt).toBeGreaterThan(2500)
  })

  it('holds the face awake while someone is genuinely talking', () => {
    let state = { busySince: null as number | null, lastBusyAt: 0 }
    for (let t = 0; t < 5_000; t += 16) state = stepBusy(state, true, t)
    // Confirmed speech refreshes every frame, so no idle mid-sentence.
    expect(5_000 - state.lastBusyAt).toBeLessThan(50)
  })

  it('starts the countdown from when speech stopped, not when it started', () => {
    let state = { busySince: null as number | null, lastBusyAt: 0 }
    for (let t = 0; t < 3_000; t += 16) state = stepBusy(state, true, t)
    const stoppedAt = state.lastBusyAt
    for (let t = 3_000; t < 5_000; t += 16) state = stepBusy(state, false, t)
    expect(state.lastBusyAt).toBe(stoppedAt)
    expect(5_000 - state.lastBusyAt).toBeGreaterThan(1900)
  })

  it('needs sustained speech, not just a long gap between blips', () => {
    let state = { busySince: null as number | null, lastBusyAt: 0 }
    // 299ms of continuous signal — one frame short of confirmation.
    for (let t = 0; t < 299; t += 16) state = stepBusy(state, true, t)
    expect(state.lastBusyAt).toBe(0)
    // One more frame past the threshold and it counts.
    state = stepBusy(state, true, 320)
    expect(state.lastBusyAt).toBe(320)
  })

  it('forgets a run the moment it goes quiet, so blips never accumulate', () => {
    let state = stepBusy({ busySince: null, lastBusyAt: 0 }, true, 100)
    state = stepBusy(state, false, 116)
    expect(state.busySince).toBeNull()
    state = stepBusy(state, true, 132)
    expect(state.busySince).toBe(132) // a fresh run, not a continuation
  })
})

describe('saccade timing — why it reads as looking rather than flicker', () => {
  it('never moves fast enough to look like a teleport', () => {
    // A real saccade is ~70ms and that is what this used to be. On a stylized
    // face with nothing else moving, it read as the pupil snapping between two
    // static poses rather than as the eye travelling.
    for (let i = 0; i < 500; i++) {
      expect(planSaccade(Math.random).durationMs).toBeGreaterThanOrEqual(180)
    }
  })

  it('mixes slow glides in with quick flicks', () => {
    // Variety in SPEED is most of what reads as alive; a single cadence, however
    // well tuned, reads as a mechanism.
    const kinds = Array.from({ length: 2000 }, () => planSaccade(Math.random).kind)
    const glides = kinds.filter(k => k === 'glide').length / kinds.length
    expect(glides).toBeGreaterThan(0.2)
    expect(glides).toBeLessThan(0.4)
  })

  it('makes a glide clearly slower than a flick of the same size', () => {
    const rng = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)] }
    // Draw order with a forced amplitude: roll, angle, kind, hold. The
    // amplitude branch is skipped entirely, so it consumes no value.
    //                        roll  angle kind (<0.3 = glide)
    const glide = planSaccade(rng(0.1, 0.5, 0.05), 0.5)
    const flick = planSaccade(rng(0.1, 0.5, 0.9), 0.5)
    expect(glide.kind).toBe('glide')
    expect(flick.kind).toBe('flick')
    expect(glide.durationMs).toBeGreaterThan(flick.durationMs * 2)
  })

  it('still keeps every move inside the pupil range', () => {
    for (let i = 0; i < 500; i++) {
      const s = planSaccade(Math.random)
      expect(Math.abs(s.x)).toBeLessThanOrEqual(0.9)
      expect(Math.abs(s.y)).toBeLessThanOrEqual(0.5)
    }
  })
})
