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

import { NEUTRAL_EYE, type EyeShape } from '../eyeGeometry';
import type { EyeEmotion, MouthEmotion } from '../types';

export interface ExpressionSpec {
  /**
   * Lid shape. The single biggest expressive lever — a round eye with no lid
   * work reads as the same blank stare whatever the brows are doing.
   */
  eyes?: Partial<EyeShape>;
  /** Brow tilt in degrees. Positive drops the inner ends (cross/determined). */
  browAngle?: number;
  /**
   * Raise one brow relative to the other, in px. The single most legible
   * "hmm" signal on a symmetric face — two level brows read as neutral no
   * matter what the eyes do.
   */
  browAsymmetry?: number;
  /**
   * Sustained gaze motion for as long as this expression is held.
   *
   * Some states are a MOVEMENT, not a pose. Thinking is the clearest case:
   * what reads as thought is the eyes drifting up and away and not settling —
   * a person working something out does not hold your gaze while doing it. A
   * static "thinking face" is just a face.
   */
  gazeDrift?: {
    /** Horizontal sweep, -1..1. The eyes travel between these extremes. */
    x: number;
    /** Vertical centre of the drift. Negative looks up. */
    y: number;
    /** Seconds for one full sweep out and back. */
    periodMs: number;
  };
  /**
   * Look away to ONE side and stay there, side chosen afresh each time.
   *
   * Distinct from `gazeDrift`, which sweeps between both extremes — and that
   * sweep is the problem it exists to solve. Eyes travelling left-to-right and
   * back across the top of the socket is the eye-roll path; run it slowly and
   * it is still an eye-roll, just a bored one. Thought does not scan. It
   * settles somewhere off to one side and stops, with only the small drift
   * that eyes always have.
   *
   * The side is re-rolled on each adoption rather than fixed, so the same
   * expression twice in a row does not look like a recording.
   */
  gazeAside?: {
    /** How far to the side, 0..1. Sign is chosen per adoption. */
    x: number;
    /** How far up. Negative looks up. */
    y: number;
    /** Small residual wander once settled, so the eyes are not frozen. */
    jitter?: number;
  };
  /**
   * Break eye contact while this expression is held, even with a face tracked.
   * Gaze lock normally wins over everything; averting is the deliberate
   * exception, because looking away IS the expression.
   */
  avertsGaze?: boolean;
  /**
   * Whole-face bounce while held, in px. Laughter is a body movement before it
   * is a face: eyes and mouth alone read as a broad, smug grin — the shake is
   * what makes it a laugh.
   */
  bounce?: { amplitude: number; periodMs: number };
  /**
   * Squeeze the eyes shut at irregular intervals while held.
   *
   * The GAP is randomised and the hold is not: laughter that scrunches on a
   * fixed beat reads as a warning light, but the scrunch itself is the same
   * movement every time.
   */
  eyeSqueeze?: { minGapMs: number; maxGapMs: number; holdMs: number };
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
  /**
   * Sampled with t in 0..1. Must return to rest at t=1 — a gesture ends by
   * having no effect, rather than by being faded out from outside.
   *
   * `variant` is a random 0..1 fixed ONCE when the gesture starts, so a gesture
   * can differ between plays without flickering: rolling the dice inside this
   * function would re-roll it every frame.
   */
  frame: (t: number, variant?: number) => GestureFrame;
}

/** Rises to 1 at the midpoint and back to 0 — the shape most gestures want. */
const bump = (t: number) => Math.sin(Math.PI * t);
/** Eased 0..1, gentle at both ends so nothing kicks out of rest. */
const easeInOutSine = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;

export const EXPRESSIONS: Record<string, ExpressionSpec> = {
  // Resting. Round, level, open — everything else is a departure from this.
  neutral: { eye: 'listening', mouth: 'smile' },

  // Smiling eyes come from the LOWER lid pushing up, not the upper lid closing.
  // Get that backwards and a smile reads as sleepiness.
  happy: {
    eye: 'happy',
    mouth: 'smile',
    mouthSpeaking: 'happy-speaking',
    eyes: { lidLower: 0.34, lidUpper: 0.04 },
    browAngle: -4,
    brow: -2,
  },
  excited: {
    eye: 'excited',
    mouth: 'big-smile',
    mouthSpeaking: 'excited-speaking',
    eyes: { height: 1.16 },
    browAngle: -7,
    brow: -8,
    pupil: 1.15,
  },
  // Head tilt, raised brows, eyes slightly widened — interest reads as OPEN.
  curious: {
    eye: 'wide',
    mouth: 'smirk',
    eyes: { height: 1.06, lidUpper: 0.06 },
    browAngle: -8,
    brow: -5,
    roll: 5,
  },
  // Thought is a MOVEMENT, not a pose: the eyes roll up and drift between the
  // top corners without settling, and they do not hold your gaze while doing
  // it. The previous version narrowed the lids and dropped the inner brows,
  // which is the anger signal — it read as cross, not thoughtful.
  thinking: {
    eye: 'surprised',
    mouth: 'pout',
    // One eye narrowed, the other open. Narrowing BOTH is what made an early
    // version read as a glare; narrowing one reads as working something out.
    eyes: { lidUpper: 0.04, lidLower: 0.1, lidAsymmetry: 0.3 },
    // Brows up and uneven — the "hmm" shape.
    browAngle: -5,
    browAsymmetry: 7,
    brow: -7,
    avertsGaze: true,
    // Settles off to one side and STAYS there. The sweeping version of this
    // traced the same path an eye-roll does, which is what it kept reading as.
    gazeAside: { x: 0.5, y: -0.42, jitter: 0.05 },
    roll: 3,
  },
  // Brows go UP and stay level. Tilting them was the mistake: lifted inner ends
  // are the sadness signal, so a "surprised" face with tilted brows just looks
  // upset. Surprise is high, level brows over a big round eye and an open mouth.
  surprised: {
    eye: 'surprised',
    mouth: 'open',
    eyes: { height: 1.42, lidUpper: 0, lidLower: 0 },
    browAngle: 0,
    brow: -17,
    pupil: 1.28,
  },
  // Inner brow ends LIFTED and lids tilted up at the inside — the universal
  // worry signal, and the thing a round eye alone can never say.
  concerned: {
    eye: 'focused',
    mouth: 'nervous',
    mouthSpeaking: 'sad-speaking',
    eyes: { lidUpper: 0.2, lidAngle: -9 },
    browAngle: -13,
    brow: 2,
  },
  sad: {
    eye: 'sleepy',
    mouth: 'sad',
    mouthSpeaking: 'sad-speaking',
    eyes: { lidUpper: 0.4, lidAngle: -15, height: 0.95 },
    browAngle: -17,
    brow: 3,
    gazeY: 0.15,
  },
  playful: {
    eye: 'happy',
    mouth: 'mischievous',
    mouthSpeaking: 'happy-speaking',
    eyes: { lidLower: 0.3, lidUpper: 0.08 },
    browAngle: -5,
    brow: -3,
    roll: 4,
  },
  // Laughter is a MOVEMENT. Held as a static pose — squinted eyes over a broad
  // smile — it reads as smug or proud, which is exactly what this looked like
  // before. What sells it is the bounce and the eyes scrunching shut in bursts.
  laughing: {
    eye: 'squinting',
    mouth: 'big-smile',
    mouthSpeaking: 'excited-speaking',
    // Nearly shut, squeezed from below the way a real laugh closes the eyes.
    eyes: { lidLower: 0.72, lidUpper: 0.2 },
    browAngle: -6,
    brow: -9,
    pupil: 1.1,
    bounce: { amplitude: 9, periodMs: 420 },
    eyeSqueeze: { minGapMs: 700, maxGapMs: 1600, holdMs: 180 },
  },
};

/**
 * Asleep (#face-sleep).
 *
 * Held for as long as the camera is off, so every part of it has to survive
 * being looked at for minutes at a time. That is what the breathing is for: a
 * face that is merely closed and still reads as switched off, and switched off
 * is what we are specifically trying not to look like. The rise and fall is the
 * only thing saying there is something in there to wake up.
 */
export const SLEEP_POSE = {
  /**
   * Lid multiplier while out cold: all the way shut.
   *
   * A blink stops at a hairline because a hard 0 makes the eye VANISH, and an
   * eye that is gone reads as broken. Sleep goes to 0 anyway, and pays for it
   * by drawing an actual closed lid in the eye's place — which is what the
   * hairline was only ever standing in for. Squashing a white ellipse to 6% of
   * its height leaves a bright sliver with the pupil still showing through it,
   * and held for minutes at a time that reads as a stare through slitted eyes,
   * not as sleep.
   */
  lid: 0,
  /** How far the head hangs, px. */
  droop: 26,
  /** And tips onto one side — a level head reads as powered down, not asleep. */
  roll: -7,
  /**
   * How far the whole brow slides down the face, in px at base scale.
   *
   * The brows sit a long way above the eyes by construction — the eye's own box
   * is 220 units tall with the lid drawn across its middle — and left up there
   * over a pair of closed eyes they read as belonging to a different face.
   *
   * Closes about half the gap. The rest is deliberate: brows resting ON the
   * lids is a scowl, not sleep.
   */
  browDrop: 60,
  /**
   * Brows go slack. Positive lowers them.
   *
   * Small, because this offset is baked into the brow's own path and the path
   * is clipped by its viewBox — pushing the real lowering through here put the
   * ends of the stroke through the bottom edge. The renderer translates the
   * whole brow instead (SLEEP_BROW_DROP); this is just the last of the slack.
   */
  brow: 4,
  /** Slow breathing. Deliberately slower than any waking movement on the face. */
  breath: { amplitude: 7, periodMs: 3800 },
  /** The face swells very slightly with the breath. Barely visible, and doing
   *  the whole thing on translation alone reads as bobbing rather than as
   *  breathing. */
  breathScale: 0.018,
};

/**
 * Waking up (#face-sleep).
 *
 * This animation has a JOB beyond being cute: it is the cover for restarting
 * the camera. A tap has to produce something immediately, but detection is not
 * available again for the better part of a second, so the face spends that time
 * doing something that would look right even if the camera never came back —
 * stirring, blinking itself awake, and stretching. Cutting it short would
 * expose the gap as a blank stare.
 *
 * The order matters and it is the order a person actually wakes in: stir first,
 * one bleary peek, eyes at half-mast, a stretch, and only THEN the eyes come
 * fully open. Opening them first and stretching afterwards reads as a startle.
 */
export const WAKE_DURATION_MS = 2600;

/** How far past open the lids overshoot on the way up — the "oh, you're there"
 *  pop. Without it the eyes just slide open and nothing registers. */
const WAKE_POP = 1.14;

/** Progress within a sub-interval of the timeline, clamped to 0..1. */
const seg = (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));

export const WAKE_ANIMATION: GestureSpec = {
  durationMs: WAKE_DURATION_MS,
  frame: (t) => {
    // Lids, in one continuous curve: still out → one bleary peek that shuts
    // again → half-mast → properly open, overshooting into a small "oh, hello"
    // pop → settled. Each segment starts where the last one ended, so there is
    // nothing for the eye to catch on.
    // Every segment starts from the one before it rather than from a literal:
    // hard-coding the handover points meant changing how far the lids close in
    // sleep silently tore a step into the middle of the wake.
    const halfMast = SLEEP_POSE.lid + 0.18;
    let lid: number;
    if (t < 0.12) lid = SLEEP_POSE.lid;
    else if (t < 0.24) lid = SLEEP_POSE.lid + bump(seg(t, 0.12, 0.24)) * 0.26;
    else if (t < 0.44) lid = SLEEP_POSE.lid + easeInOutSine(seg(t, 0.24, 0.44)) * 0.18;
    else if (t < 0.66) lid = halfMast + easeInOutSine(seg(t, 0.44, 0.66)) * (WAKE_POP - halfMast);
    else lid = WAKE_POP - easeInOutSine(seg(t, 0.66, 1)) * (WAKE_POP - 1);

    // Shaking it off: a decaying wobble, gone well before the eyes open.
    const shake =
      Math.sin(seg(t, 0.08, 0.52) * Math.PI * 3) * 7 * (1 - seg(t, 0.08, 0.62));

    return {
      lidLeft: lid,
      lidRight: lid,
      roll: shake,
      // The stretch, then a small bob as she settles out of it.
      pitch: -18 * bump(seg(t, 0.28, 0.8)) + 5 * bump(seg(t, 0.78, 1)),
      scale: 1 + 0.06 * bump(seg(t, 0.3, 0.75)),
      // The brow flash lands WITH the eyes opening, not before — it is the
      // beat that turns "awake" into "oh, you're there".
      brow: -28 * bump(seg(t, 0.45, 0.9)),
      // One look around to place the room. A full cycle, so it ends centred.
      gazeX: 0.3 * Math.sin(seg(t, 0.6, 1) * Math.PI * 2),
    };
  },
};

export const GESTURES: Record<string, GestureSpec> = {
  // ONE clean beat, the same shape as brow_flash — a dip down and back, with
  // the brow moving with it. It was a decaying double-bob at 22px, which is a
  // whole performance where a nod wants to be an acknowledgement.
  //
  // Deliberately the same curve as the backchannel nod, just larger: one nod in
  // the face's vocabulary, at two volumes. Two different nod SHAPES would read
  // as two different gestures.
  //
  // Pitch is a translate, not a rotate: rotating the head is a tilt, and a tilt
  // does not read as agreement.
  nod: {
    // Long enough for two beats; a single nod simply finishes early and rests
    // out the remainder, which costs nothing and keeps the spec one shape.
    durationMs: 1150,
    // Defaults to the single beat when no variant is supplied, so a caller that
    // does not care about the coin flip gets deterministic behaviour.
    frame: (t, variant = 0) => {
      // Sometimes once, sometimes twice — the same coin flip that makes the
      // blink read as alive rather than as a timer. A nod that is always
      // identical is the tell that nothing is behind it.
      const double = variant >= 0.5;
      const first = t < 0.5 ? bump(t / 0.5) : 0;
      // The second beat is smaller and starts just after the first lands, so
      // they never overlap and sum past full amplitude.
      const second = double && t >= 0.52 ? bump((t - 0.52) / 0.48) * 0.6 : 0;
      const beat = first + second;
      return { pitch: 14 * beat, brow: -7 * beat };
    },
  },
  // One lid, plus the brow that always comes with it on a real face.
  wink: {
    durationMs: 620,
    frame: (t) => ({
      lidRight: t > 0.12 && t < 0.55 ? 0.05 : 1,
      brow: t < 0.6 ? -14 : 0,
      roll: Math.sin(Math.PI * t) * 3,
    }),
  },
  // The eyebrow flash: the universal "I heard you" beat.
  //
  // This was -7px and read as nothing at all, because calculateEyebrowPath
  // HALVES the offset before drawing — so it moved 3.5 units inside a 60-unit
  // viewBox. A flash has to actually leap, and the head lifts with it.
  brow_flash: {
    durationMs: 520,
    frame: (t) => ({
      brow: -30 * bump(t),
      pitch: -5 * bump(t),
    }),
  },
  glance_away: {
    durationMs: 900,
    frame: (t) => ({
      gazeX: 0.85 * bump(t),
      gazeY: -0.25 * bump(t),
      roll: -7 * bump(t),
      pitch: -3 * bump(t),
    }),
  },
  // A full theatrical eye-roll: the pupils leave from the bottom LEFT, travel
  // the rim of the eye up and over the top, and come back down to the bottom
  // RIGHT — 270 degrees of actual travel.
  //
  // Two things make or break this. The radius must stay pinned at the rim for
  // the whole sweep (multiplying it by a rise-and-fall curve makes the pupils
  // bulge out of the centre instead of going round anything), and the ramps at
  // each end have to be WIDE. A short ramp darts the pupils out to the rim and
  // snaps them back, which is what read as jumpy — a fifth of the gesture at
  // each end is spent easing out and in, so the whole path is one glide.
  eye_roll: {
    durationMs: 2200,
    frame: (t) => {
      // Screen angles, y down: 135deg is bottom-left, +270deg lands on 45deg,
      // bottom-right, having passed through left, top and right on the way.
      // Sine easing rather than smoothstep: gentler off the mark, so the eyes
      // drift into the roll instead of kicking into it.
      const angle = ((135 + 270 * easeInOutSine(t)) * Math.PI) / 180;
      const rim = easeInOutSine(Math.max(0, Math.min(1, t / 0.22, (1 - t) / 0.22)));
      return {
        gazeX: Math.cos(angle) * 0.95 * rim,
        gazeY: Math.sin(angle) * 0.95 * rim,
        // The head tips back and leans with the eyes — nobody rolls their eyes
        // with their head held still. A single lean, not an oscillation: a full
        // sine cycle here read as a wobble.
        pitch: -16 * bump(t),
        roll: -6 * bump(t),
        brow: -18 * bump(t),
      };
    },
  },
  lean_in: {
    durationMs: 900,
    frame: (t) => ({ scale: 1 + 0.1 * bump(t), pitch: 6 * bump(t) }),
  },
};

/**
 * State tags (#face-sleep). Mirrors STATE_TAGS in the agent SDK.
 *
 * Neither a pose nor a movement but a COMMAND: it acts on the face once and the
 * face stays changed long after the reply is over. There is nothing to draw, so
 * unlike EXPRESSIONS and GESTURES this is a bare list — the behaviour lives in
 * the machine the tag addresses, and the only job here is to be the one place
 * the vocabulary is written down for the parity test to check.
 */
export const STATES = ['sleep'] as const;
export type StateTag = (typeof STATES)[number];

export function resolveState(tag: string | null | undefined): StateTag | null {
  if (!tag) return null;
  return (STATES as readonly string[]).includes(tag) ? (tag as StateTag) : null;
}

/** Fill an expression's partial lid spec out to a complete shape. */
export function eyeShapeOf(spec: ExpressionSpec): EyeShape {
  return { ...NEUTRAL_EYE, ...(spec.eyes ?? {}) };
}

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
