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
      expect(Math.abs(spec.brow ?? 0), tag).toBeLessThanOrEqual(15)
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
        expect(Math.abs(f.pitch ?? 0), tag).toBeLessThanOrEqual(20)
        expect(f.scale ?? 1, tag).toBeLessThanOrEqual(1.15)
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
      expect(spec.durationMs, tag).toBeLessThanOrEqual(2000)
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
