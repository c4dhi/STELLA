/**
 * The render half of the emotion-tag contract (#face-emotions).
 *
 * The agent decides WHICH tags exist; this file decides how they look. The two
 * deploy separately, so the vocabulary is pinned here and cross-checked from the
 * agent side (test_wire_parity_with_frontend_registry). A tag the agent sends
 * and this registry has never heard of does not throw — it falls back to rest —
 * so drift would otherwise show up only as a face that quietly stops reacting.
 */
import { describe, it, expect } from 'vitest'
import {
  EXPRESSIONS,
  GESTURES,
  DEFAULT_EXPRESSION,
  resolveExpression,
  resolveGesture,
  SLEEP_POSE,
  WAKE_ANIMATION,
} from './emotionRegistry'

// Mirrors stella_agent_sdk/emotion/tags.py. Update both, or CI fails on both sides.
const WIRE_EXPRESSIONS = [
  'neutral', 'happy', 'excited', 'curious', 'thinking',
  'surprised', 'concerned', 'sad', 'playful', 'laughing',
]
const WIRE_GESTURES = [
  'nod', 'wink', 'brow_flash', 'glance_away', 'eye_roll', 'lean_in',
]

describe('vocabulary', () => {
  it('renders every expression the agent can send', () => {
    expect(Object.keys(EXPRESSIONS).sort()).toEqual([...WIRE_EXPRESSIONS].sort())
  })

  it('renders every gesture the agent can send', () => {
    expect(Object.keys(GESTURES).sort()).toEqual([...WIRE_GESTURES].sort())
  })

  it('keeps expressions and gestures disjoint', () => {
    for (const tag of Object.keys(GESTURES)) {
      expect(EXPRESSIONS).not.toHaveProperty(tag)
    }
  })
})

describe('resolveExpression', () => {
  it('falls back to rest for a tag from a newer agent', () => {
    // Survivable version skew: the reply still plays, the face just does not
    // take on an expression it has never heard of.
    expect(resolveExpression('transcendent')).toBe(DEFAULT_EXPRESSION)
    expect(resolveExpression(null)).toBe(DEFAULT_EXPRESSION)
    expect(resolveExpression(undefined)).toBe(DEFAULT_EXPRESSION)
  })

  it('resolves a known tag to its own pose', () => {
    expect(resolveExpression('thinking')).toBe(EXPRESSIONS.thinking)
  })
})

describe('expression poses', () => {
  it('keeps gaze offsets small enough not to break a gaze lock', () => {
    // An expression leans the eyes off a tracked face and springs back. Push it
    // past this and "focused on you" stops reading as focus.
    for (const [tag, spec] of Object.entries(EXPRESSIONS)) {
      expect(Math.abs(spec.gazeX ?? 0), tag).toBeLessThanOrEqual(0.3)
      expect(Math.abs(spec.gazeY ?? 0), tag).toBeLessThanOrEqual(0.3)
    }
  })

  it('keeps brow, roll and pupil within what the renderer can draw', () => {
    for (const [tag, spec] of Object.entries(EXPRESSIONS)) {
      // 20px is roughly where the brow leaves the top of its own viewBox.
      // Surprise wants nearly all of that headroom — a timid brow lift is the
      // difference between "startled" and "mildly interested".
      expect(Math.abs(spec.brow ?? 0), tag).toBeLessThanOrEqual(20)
      expect(Math.abs(spec.roll ?? 0), tag).toBeLessThanOrEqual(10)
      expect(spec.pupil ?? 1, tag).toBeGreaterThanOrEqual(0.5)
      expect(spec.pupil ?? 1, tag).toBeLessThanOrEqual(1.5)
    }
  })

  it('rests at neutral', () => {
    expect(DEFAULT_EXPRESSION).toBe(EXPRESSIONS.neutral)
    expect(EXPRESSIONS.neutral.gazeX ?? 0).toBe(0)
    expect(EXPRESSIONS.neutral.gazeY ?? 0).toBe(0)
  })
})

describe('gestures', () => {
  it('ends at rest, so the pose underneath comes back untouched', () => {
    // A gesture is additive over whatever expression is active. One that did not
    // return to rest would permanently offset the face after it played.
    for (const [tag, spec] of Object.entries(GESTURES)) {
      const end = spec.frame(1)
      expect(end.gazeX ?? 0, tag).toBeCloseTo(0, 5)
      expect(end.gazeY ?? 0, tag).toBeCloseTo(0, 5)
      expect(end.pitch ?? 0, tag).toBeCloseTo(0, 5)
      expect(end.roll ?? 0, tag).toBeCloseTo(0, 5)
      expect(end.brow ?? 0, tag).toBeCloseTo(0, 5)
      expect(end.scale ?? 1, tag).toBeCloseTo(1, 5)
      expect(end.lidLeft ?? 1, tag).toBeCloseTo(1, 5)
      expect(end.lidRight ?? 1, tag).toBeCloseTo(1, 5)
    }
  })

  it('stays inside the renderer\'s range for its whole duration', () => {
    for (const [tag, spec] of Object.entries(GESTURES)) {
      for (let i = 0; i <= 100; i++) {
        const f = spec.frame(i / 100)
        expect(Math.abs(f.gazeX ?? 0), tag).toBeLessThanOrEqual(1)
        expect(Math.abs(f.gazeY ?? 0), tag).toBeLessThanOrEqual(1)
        // Generous: the whole face is meant to commit to a gesture. Pupils
        // moving alone read as a twitch rather than as a performance.
        expect(Math.abs(f.pitch ?? 0), tag).toBeLessThanOrEqual(30)
        expect(f.scale ?? 1, tag).toBeLessThanOrEqual(1.2)
        expect(f.lidLeft ?? 1, tag).toBeGreaterThanOrEqual(0)
        expect(f.lidRight ?? 1, tag).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('actually moves — a gesture nobody can see is a bug', () => {
    for (const [tag, spec] of Object.entries(GESTURES)) {
      const moved = Array.from({ length: 21 }, (_, i) => spec.frame(i / 20)).some(
        f =>
          Math.abs(f.gazeX ?? 0) > 0.05 ||
          Math.abs(f.gazeY ?? 0) > 0.05 ||
          Math.abs(f.pitch ?? 0) > 1 ||
          Math.abs(f.roll ?? 0) > 1 ||
          Math.abs(f.brow ?? 0) > 1 ||
          Math.abs((f.scale ?? 1) - 1) > 0.01 ||
          (f.lidLeft ?? 1) < 0.9 ||
          (f.lidRight ?? 1) < 0.9
      )
      expect(moved, `${tag} never leaves rest`).toBe(true)
    }
  })

  it('gives every gesture a duration a viewer can register', () => {
    for (const [tag, spec] of Object.entries(GESTURES)) {
      expect(spec.durationMs, tag).toBeGreaterThanOrEqual(300)
      // 2.5s is the ceiling: past that a gesture stops reading as a reaction to
      // something and starts looking like the face has changed state. The eye
      // roll sits near the top of this deliberately — it is a performance.
      expect(spec.durationMs, tag).toBeLessThanOrEqual(2500)
    }
  })

  it('winks with one eye', () => {
    // Both eyes would just be a blink.
    const mid = GESTURES.wink.frame(0.3)
    expect(mid.lidRight).toBeLessThan(0.2)
    expect(mid.lidLeft ?? 1).toBe(1)
  })

  it('nods on the pitch axis, not the roll axis', () => {
    // headRotation is a CSS rotate — a tilt. A tilt does not read as agreement.
    const frames = Array.from({ length: 21 }, (_, i) => GESTURES.nod.frame(i / 20))
    expect(frames.some(f => Math.abs(f.pitch ?? 0) > 2)).toBe(true)
    expect(frames.every(f => (f.roll ?? 0) === 0)).toBe(true)
  })

  it('returns null for an unknown gesture rather than throwing', () => {
    expect(resolveGesture('backflip')).toBeNull()
    expect(resolveGesture(null)).toBeNull()
  })
})

describe('expressions while speaking', () => {
  it('gives every strongly-felt expression a speaking mouth', () => {
    // The renderer blends resting mouth curvature away as the jaw opens, so
    // without a speaking variant an emotion is legible only in the pauses —
    // which is exactly when nobody is looking for it.
    for (const tag of ['happy', 'excited', 'laughing', 'playful', 'sad', 'concerned']) {
      expect(EXPRESSIONS[tag].mouthSpeaking, tag).toBeDefined()
      expect(EXPRESSIONS[tag].mouthSpeaking, tag).toMatch(/-speaking$/)
    }
  })

  it('keeps happy and sad mouths distinguishable mid-speech', () => {
    // If both collapsed onto the generic 'speaking' shape, a laugh and bad news
    // would look identical while being said.
    expect(EXPRESSIONS.laughing.mouthSpeaking).not.toBe(EXPRESSIONS.sad.mouthSpeaking)
  })
})

describe('expressions that are movements, not poses', () => {
  it('makes thinking look away rather than stare', () => {
    // A narrowed, inward-tilted eye is the ANGER signal — the first version of
    // this read as a glare. Thought is the gaze leaving you, not the lids
    // closing on you.
    const t = EXPRESSIONS.thinking
    expect(t.avertsGaze).toBe(true)
    expect(t.gazeAside).toBeDefined()
    expect(t.gazeAside!.y).toBeLessThan(0) // upward
    expect(t.eyes?.lidAngle ?? 0).toBe(0) // no inward tilt: that is anger
  })

  it('settles thinking on ONE side instead of sweeping across', () => {
    // A gaze that travels between both extremes and back traces the eye-roll
    // path. Slowing it down does not help — it is still the same journey, just
    // a bored one. Thought settles somewhere and stops.
    const t = EXPRESSIONS.thinking
    expect(t.gazeDrift).toBeUndefined()
    expect(t.gazeAside!.x).toBeGreaterThan(0.3) // far enough to read as away
    // Not frozen either: eyes always have some residual movement.
    expect(t.gazeAside!.jitter ?? 0).toBeGreaterThan(0)
    // ...but small enough that it cannot be mistaken for a sweep.
    expect(t.gazeAside!.jitter!).toBeLessThan(t.gazeAside!.x / 4)
  })

  it('narrows one eye while thinking, not both', () => {
    // Symmetry is what keeps a face reading as a diagram. One lid down is the
    // clearest "working something out" signal there is, and closing both is
    // how the earlier version turned into a glare.
    const t = EXPRESSIONS.thinking
    expect(t.eyes?.lidAsymmetry ?? 0).toBeGreaterThan(0.15)
    expect(t.eyes?.lidUpper ?? 0).toBeLessThan(0.2) // the other eye stays open
  })

  it('gives laughing motion, without which it reads as smug', () => {
    const l = EXPRESSIONS.laughing
    expect(l.bounce).toBeDefined()
    expect(l.eyeSqueeze).toBeDefined()
    // Irregular, or the scrunch reads as a warning light.
    expect(l.eyeSqueeze!.maxGapMs).toBeGreaterThan(l.eyeSqueeze!.minGapMs)
    // And spaced further apart than they last, so the eyes are open more than shut.
    expect(l.eyeSqueeze!.minGapMs).toBeGreaterThan(l.eyeSqueeze!.holdMs)
  })

  it('keeps surprise brows level — tilting them is what says sad', () => {
    expect(EXPRESSIONS.surprised.browAngle ?? 0).toBe(0)
    expect(EXPRESSIONS.surprised.mouth).toBe('open')
  })

  it('only lets deliberate expressions break eye contact', () => {
    const averting = Object.entries(EXPRESSIONS).filter(([, s]) => s.avertsGaze)
    expect(averting.map(([tag]) => tag)).toEqual(['thinking'])
  })
})

describe('eye_roll travels the rim', () => {
  const at = (t: number) => GESTURES.eye_roll.frame(t)
  const radius = (t: number) => Math.hypot(at(t).gazeX ?? 0, at(t).gazeY ?? 0)

  it('holds the pupils out at the rim for the whole sweep', () => {
    // The bug: the radius was multiplied by a rise-and-fall curve, so the pupils
    // bulged out of the centre and sank back instead of going around anything.
    for (let t = 0.2; t <= 0.8; t += 0.05) {
      expect(radius(t), `t=${t.toFixed(2)}`).toBeGreaterThan(0.9)
    }
  })

  it('starts bottom-left and ends bottom-right', () => {
    const start = at(0.14) // just past the ramp-out
    const end = at(0.86) // just before the ramp-in
    expect(start.gazeX!).toBeLessThan(0) // left
    expect(start.gazeY!).toBeGreaterThan(0) // below centre
    expect(end.gazeX!).toBeGreaterThan(0) // right
    expect(end.gazeY!).toBeGreaterThan(0) // below centre again
  })

  it('passes over the top rather than cutting across', () => {
    const highest = Math.min(...Array.from({ length: 41 }, (_, i) => at(i / 40).gazeY ?? 0))
    expect(highest).toBeLessThan(-0.85)
  })

  it('sweeps one way the whole time — it never doubles back', () => {
    // A path that reverses reads as a twitch rather than a roll. Compared as
    // unwrapped deltas: atan2 wraps at +/-pi, and a naive comparison flags that
    // wrap as a reversal even on a perfectly smooth sweep.
    let prev = Math.atan2(at(0.1).gazeY ?? 0, at(0.1).gazeX ?? 0)
    for (let i = 5; i <= 36; i++) {
      const t = i / 40
      const raw = Math.atan2(at(t).gazeY ?? 0, at(t).gazeX ?? 0)
      let delta = raw - prev
      if (delta > Math.PI) delta -= Math.PI * 2
      if (delta < -Math.PI) delta += Math.PI * 2
      expect(delta, `reversed at t=${t.toFixed(2)}`).toBeGreaterThan(-1e-6)
      prev = raw
    }
  })
})

describe('the nod vocabulary', () => {
  const pitches = (variant: number) =>
    Array.from({ length: 41 }, (_, i) => GESTURES.nod.frame(i / 40, variant).pitch ?? 0)

  it('nods once or twice depending on the variant', () => {
    // A nod that is always identical is the tell that nothing is behind it —
    // the same reason the blink flips a coin between single and double.
    const peaks = (p: number[]) =>
      p.filter((v, i) => i > 0 && i < p.length - 1 && v > p[i - 1] && v >= p[i + 1] && v > 1)
    expect(peaks(pitches(0.1))).toHaveLength(1)
    expect(peaks(pitches(0.9))).toHaveLength(2)
  })

  it('makes the second beat smaller than the first', () => {
    const p = pitches(0.9)
    const firstHalf = Math.max(...p.slice(0, 20))
    const secondHalf = Math.max(...p.slice(22))
    expect(secondHalf).toBeLessThan(firstHalf)
    expect(secondHalf).toBeGreaterThan(0)
  })

  it('never rebounds upward, whichever variant plays', () => {
    // Down is agreement; a nod that lifts above resting reads as a flinch.
    for (const variant of [0.1, 0.9]) {
      expect(pitches(variant).every(v => v >= -0.001)).toBe(true)
    }
  })

  it('rests at both ends for either variant', () => {
    for (const variant of [0.1, 0.9]) {
      const p = pitches(variant)
      expect(p[0]).toBeCloseTo(0, 5)
      expect(p[p.length - 1]).toBeCloseTo(0, 5)
    }
  })

  it('moves the brow with the head, the way brow_flash does', () => {
    const mid = GESTURES.nod.frame(0.25, 0.1)
    expect(mid.brow ?? 0).toBeLessThan(0)
    expect(mid.pitch ?? 0).toBeGreaterThan(0) // down = agreement
  })
})

describe('sleep and waking (#face-sleep)', () => {
  const sample = (n = 101) => Array.from({ length: n }, (_, i) => i / (n - 1))

  it('runs long enough to cover the camera restarting', () => {
    // This is the animation's actual JOB. getUserMedia has to reacquire the
    // device, the video element has to reach a first frame, detection runs at
    // 10Hz on top of that and is then debounced. Shorten this and the face
    // finishes waking into a blank stare.
    expect(WAKE_ANIMATION.durationMs).toBeGreaterThanOrEqual(2000)
  })

  it('starts from exactly the pose it is waking out of', () => {
    // The lids are handed from the sleep layer to this animation on the frame
    // the tap lands. Any gap between the two values is a visible pop.
    const start = WAKE_ANIMATION.frame(0)
    expect(start.lidLeft).toBeCloseTo(SLEEP_POSE.lid, 5)
    expect(start.lidRight).toBeCloseTo(SLEEP_POSE.lid, 5)
  })

  it('ends at rest on every channel, so nothing has to fade it out', () => {
    const end = WAKE_ANIMATION.frame(1)
    expect(end.lidLeft).toBeCloseTo(1, 3)
    expect(end.lidRight).toBeCloseTo(1, 3)
    expect(end.scale).toBeCloseTo(1, 3)
    expect(Math.abs(end.pitch ?? 0)).toBeLessThan(0.01)
    expect(Math.abs(end.roll ?? 0)).toBeLessThan(0.01)
    expect(Math.abs(end.brow ?? 0)).toBeLessThan(0.01)
    expect(Math.abs(end.gazeX ?? 0)).toBeLessThan(0.01)
  })

  it('opens the lids continuously, with no jump between segments', () => {
    // The curve is piecewise, which is the one way it can go wrong: get an
    // endpoint wrong and the eye snaps open a fraction mid-wake.
    const lids = sample(400).map((t) => WAKE_ANIMATION.frame(t).lidLeft!)
    for (let i = 1; i < lids.length; i++) {
      expect(Math.abs(lids[i] - lids[i - 1])).toBeLessThan(0.05)
    }
  })

  it('peeks once and shuts again before opening for real', () => {
    // Bleary first, awake second. Straight from shut to open is a startle.
    const peak = Math.max(...sample(60).slice(0, 18).map((t) => WAKE_ANIMATION.frame(t).lidLeft!))
    expect(peak).toBeGreaterThan(SLEEP_POSE.lid + 0.1) // it does crack open
    expect(peak).toBeLessThan(0.5) // but nowhere near open
    expect(WAKE_ANIMATION.frame(0.28).lidLeft!).toBeLessThan(peak) // and shuts again
  })

  it('stretches before the eyes are fully open, not after', () => {
    // A person wakes in this order. Reverse it and it reads as being startled
    // awake, which is the opposite of the intended feel.
    const lidAt = (t: number) => WAKE_ANIMATION.frame(t).lidLeft!
    const stretchPeak = sample(200).reduce((best, t) =>
      Math.abs(WAKE_ANIMATION.frame(t).pitch!) > Math.abs(WAKE_ANIMATION.frame(best).pitch!) ? t : best
    , 0)
    expect(lidAt(stretchPeak)).toBeLessThan(0.9)
  })

  it('overshoots the lids on the way open, then settles', () => {
    // The "oh, you're there" pop. Without it the eyes just slide open.
    const maxLid = Math.max(...sample(200).map((t) => WAKE_ANIMATION.frame(t).lidLeft!))
    expect(maxLid).toBeGreaterThan(1.05)
    expect(WAKE_ANIMATION.frame(1).lidLeft!).toBeLessThan(maxLid)
  })

  it('flashes the brows with the eyes opening rather than before', () => {
    const browPeak = sample(200).reduce((best, t) =>
      (WAKE_ANIMATION.frame(t).brow ?? 0) < (WAKE_ANIMATION.frame(best).brow ?? 0) ? t : best
    , 0)
    expect(WAKE_ANIMATION.frame(browPeak).lidLeft!).toBeGreaterThan(0.5)
  })

  it('breathes slower asleep than anything the face does awake', () => {
    // The breath is the only thing saying there is something in there to wake
    // up. At a waking tempo it reads as a bob, not as sleep.
    expect(SLEEP_POSE.breath.periodMs).toBeGreaterThan(2500)
  })

  it('shuts the eyes all the way, so a drawn lid can take their place', () => {
    // Deliberately unlike a blink, which stops at a hairline. Squashing a white
    // ellipse to a few percent of its height leaves a bright sliver with the
    // pupil showing through, and held for minutes that reads as a slitted
    // stare. Anything above 0 here puts that sliver back UNDER the drawn lid.
    expect(SLEEP_POSE.lid).toBe(0)
  })

  it('brings the brows down toward the closed eyes', () => {
    // Slack brows are half of what says asleep — left at their waking height
    // over a pair of shut eyes they read as belonging to a different face.
    //
    // The lowering lives in `browDrop`, NOT in `brow`: the latter is baked into
    // the brow's own path and then halved, and it clips against the edge of the
    // brow viewBox well before the brow gets anywhere near the eye.
    expect(SLEEP_POSE.browDrop).toBeGreaterThan(30)
  })
})
