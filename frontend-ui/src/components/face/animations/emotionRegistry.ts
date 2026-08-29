/**
 * How each emotion tag is drawn (#face-emotions).
 *
 * This is the frontend half of the contract with the agent. The agent owns the
 * VOCABULARY — which tags exist and whether each is an expression or a gesture
 * (`stella_agent_sdk/emotion/tags.py`) — and this file owns how they LOOK, which
 * is data the agent has no business knowing.
 *
 * The two halves deploy separately, so they will occasionally disagree. That is
 * handled rather than prevented: an unknown tag off the wire is ignored (see
 * `resolveExpression`), and `emotionRegistry.test.ts` pins the vocabulary so the
 * disagreement shows up in CI rather than as a face that quietly stops reacting.
 *
 * ── Expressions vs gestures ────────────────────────────────────────────────
 *
 * An expression is a POSE: it holds until the next cue or the end of the reply.
 * A gesture is a MOVEMENT sampled over its own duration, applied on top of
 * whatever pose is active and handing it back untouched when it finishes.
 *
 * Both are additive over the gaze layer, and deliberately bounded, so they can
 * play while the eyes are locked onto a real face without breaking the lock —
 * the eyes pull away and spring back rather than jumping somewhere else.
 */

import type { EyeEmotion, MouthEmotion } from '../types';

export interface ExpressionSpec {
  eye: EyeEmotion;
  mouth: MouthEmotion;
  /**
   * Mouth to use while the agent is actually talking.
   *
   * The resting mouth shape cannot survive speech — the renderer blends its
   * curvature out as the jaw opens, so a laughing mouth and a sad one converge
   * on the same oval. The renderer ships purpose-built speaking variants for
   * exactly this; without them an expression is only legible in the pauses,
   * which is precisely when nobody is looking for it.
   */
  mouthSpeaking?: MouthEmotion;
  /** Additive pupil offset, -1..1. Kept small so a gaze lock survives it. */
  gazeX?: number;
  gazeY?: number;
  /** Eyebrow offset in px; negative raises. */
  brow?: number;
  /** Head roll bias in degrees. */
  roll?: number;
  /** Pupil dilation multiplier. */
  pupil?: number;
}

/** Additive channels a gesture may drive. Everything omitted is left alone. */
export interface GestureFrame {
  gazeX?: number;
  gazeY?: number;
  /** Vertical head movement in px — the nod axis. */
  pitch?: number;
  roll?: number;
  brow?: number;
  /** Whole-face scale multiplier. */
  scale?: number;
  /** Per-eye lid multiplier, 0 = shut. */
  lidLeft?: number;
  lidRight?: number;
}

export interface GestureSpec {
  durationMs: number;
  /** Sampled with t in 0..1. Must return to rest at t=1 — the gesture ends by
   *  having no effect, rather than by being faded out from outside. */
  frame: (t: number) => GestureFrame;
}

/** Rises to 1 at the midpoint and back to 0. The shape most gestures want. */
const bump = (t: number) => Math.sin(Math.PI * t);
/** Decaying oscillation: `cycles` swings that settle by t=1. */
const wobble = (t: number, cycles: number) =>
  Math.sin(Math.PI * 2 * cycles * t) * (1 - t);

export const EXPRESSIONS: Record<string, ExpressionSpec> = {
  // The resting pose. Matches what the face wore before tags existed, so a
  // reply with no cues looks exactly as it always has.
  neutral: { eye: 'listening', mouth: 'smile' },
  happy: { eye: 'happy', mouth: 'smile', mouthSpeaking: 'happy-speaking', brow: -2 },
  excited: {
    eye: 'excited',
    mouth: 'big-smile',
    mouthSpeaking: 'excited-speaking',
    brow: -6,
    pupil: 1.15,
  },
  // Head tilt plus one raised brow — the most legible of the set, and the only
  // one that needs no mouth change to read.
  curious: { eye: 'wide', mouth: 'smirk', brow: -4, roll: 5 },
  // The glance up and away that already existed as the idle "thinking" state.
  thinking: { eye: 'focused', mouth: 'pout', gazeX: -0.15, gazeY: -0.2, brow: -4 },
  surprised: { eye: 'surprised', mouth: 'open', brow: -10, pupil: 1.25 },
  concerned: { eye: 'focused', mouth: 'nervous', mouthSpeaking: 'sad-speaking', brow: 4 },
  sad: { eye: 'sleepy', mouth: 'sad', mouthSpeaking: 'sad-speaking', gazeY: 0.15, brow: 3 },
  playful: {
    eye: 'happy',
    mouth: 'mischievous',
    mouthSpeaking: 'happy-speaking',
    brow: -3,
    roll: 4,
  },
  // Laughter squints the eyes — that, not the mouth, is what separates a laugh
  // from a broad smile. The brow drops with the squint rather than lifting.
  laughing: {
    eye: 'squinting',
    mouth: 'big-smile',
    mouthSpeaking: 'excited-speaking',
    brow: 3,
    pupil: 1.1,
  },
};

export const GESTURES: Record<string, GestureSpec> = {
  // Two dips, decaying. Pitch is a translate, not a rotate: rotating the head
  // is a tilt, and a tilt does not read as agreement.
  nod: { durationMs: 900, frame: (t) => ({ pitch: wobble(t, 1.5) * 12 }) },
  // One lid, plus the brow that always comes with it on a real face.
  wink: {
    durationMs: 620,
    frame: (t) => ({
      lidRight: t > 0.12 && t < 0.55 ? 0.05 : 1,
      brow: t < 0.6 ? -4 : 0,
    }),
  },
  // The eyebrow flash: the universal "I heard you" beat, and the cheapest
  // gesture here to read at a glance.
  brow_flash: { durationMs: 480, frame: (t) => ({ brow: -7 * bump(t) }) },
  glance_away: {
    durationMs: 850,
    frame: (t) => ({ gazeX: 0.55 * bump(t), gazeY: -0.15 * bump(t) }),
  },
  // Pupils travel up and around rather than just up, which is what separates a
  // roll from a glance.
  eye_roll: {
    durationMs: 1000,
    frame: (t) => ({
      gazeX: Math.sin(Math.PI * 2 * t) * 0.4 * bump(t),
      gazeY: -Math.abs(Math.cos(Math.PI * t)) * 0.35 * bump(t) - 0.15 * bump(t),
    }),
  },
  lean_in: { durationMs: 900, frame: (t) => ({ scale: 1 + 0.05 * bump(t) }) },
};

/** The resting pose, used between replies and for an unrecognized tag. */
export const DEFAULT_EXPRESSION = EXPRESSIONS.neutral;

/**
 * Look up an expression, falling back to rest.
 *
 * An unknown tag means the agent is newer than this client. Falling back is the
 * whole reason that is survivable: the reply still plays, the face just does not
 * take on the one expression it has never heard of.
 */
export function resolveExpression(tag: string | null | undefined): ExpressionSpec {
  if (!tag) return DEFAULT_EXPRESSION;
  return EXPRESSIONS[tag] ?? DEFAULT_EXPRESSION;
}

export function resolveGesture(tag: string | null | undefined): GestureSpec | null {
  if (!tag) return null;
  return GESTURES[tag] ?? null;
}
