/**
 * useFaceBehavior Hook
 *
 * The single RAF loop that decides where the face is looking and how it holds
 * itself. Replaces the old useIdleBehavior, which produced plain numbers in a
 * ref and so only reached the screen when something else happened to re-render
 * StellaFace — a coupling that broke the moment the mouse fallback was removed.
 * Everything continuous is written to a MotionValue instead.
 *
 * ── The layer model ────────────────────────────────────────────────────────
 *
 *   gaze       (exclusive)  LOCKED → pupils track the detected face and hold
 *                           FREE   → look straight ahead, wander when idle
 *   expression (sustained)  eye / mouth / brow shape (thinking today; driven by
 *                           backend emotion tags in a later phase)
 *   gesture    (one-shot)   additive, time-boxed — brow flash, head tilt, peek
 *
 * The rule that makes this work: **gaze sets the base, the other layers add
 * bounded offsets on top.** That is why a thinking glance still reads while the
 * eyes are locked onto someone — it pulls them off the face by a fraction of
 * the pupil range and springs back, rather than replacing the gaze target. The
 * idle wander is the one thing that is genuinely exclusive to the unlocked
 * state: looking away is only believable when there is nobody to look at.
 */

import { useEffect, useRef, useState } from 'react';
import { useMotionValue, type MotionValue } from 'framer-motion';
import { useStore } from '../../../store';
import type { BlinkTarget } from './useFaceAnimation';
import {
  DEFAULT_EXPRESSION,
  resolveGesture,
  SLEEP_POSE,
  WAKE_ANIMATION,
  type ExpressionSpec,
  type GestureFrame,
} from '../animations/emotionRegistry';
import type { SleepPhase } from './useSleepState';

/** Quiet for this long, with nobody to look at, and the eyes start to wander. */
const IDLE_AFTER_MS = 2500;

/**
 * How long a "someone is talking" signal must HOLD before it counts as speech.
 *
 * This exists because the inputs are instantaneous and the idle timer is not.
 * `isRemoteSpeaking` is recomputed every animation frame from an RMS threshold
 * (`rms > 0.02` in PeerTransport) that was tuned to drive the mouth, not to
 * decide whether a turn is over. On a live audio track it flickers over that
 * line on room tone between utterances — and a single frame of it used to reset
 * the idle timer outright. One spurious frame every 2.5s was enough to keep the
 * face awake forever, which is exactly "the idle animation never runs".
 *
 * So sustained speech still holds the face awake frame by frame, but an
 * isolated blip cannot. Speech shorter than this does not register, which is
 * the right trade: nobody's turn is 300ms long.
 */
const BUSY_CONFIRM_MS = 300;

/**
 * Watchdog: no speech signal may hold the face awake longer than this.
 *
 * `isTTSPlaying` is a latch — set by a `tts_start` envelope and cleared by a
 * matching `tts_stop`. If the stop is ever missed the latch stays set forever,
 * and the idle timer keyed on it never advances again. That is precisely how
 * the organizer screen ended up with no idle animation while the participant
 * screen was fine: `setTTSPlaying` is wired ONLY in SessionView, so the
 * participant store kept the flag false and its face idled normally.
 *
 * A liveness property should not depend on a remote event arriving. Nobody
 * talks for 45 uninterrupted seconds in this product, so the worst case if the
 * watchdog fires wrongly is one idle glance during an unusually long monologue.
 * The worst case without it is the feature silently not existing.
 */
const BUSY_WATCHDOG_MS = 45_000;

/** Saccade timing. Eyes do not drift, they jump and then hold — the previous
 *  continuous sine drift is what made the face read as floating rather than
 *  alive. */
const SACCADE_HOLD_MIN_MS = 700;
const SACCADE_HOLD_MAX_MS = 2600;

/**
 * Movement timing. A real saccade is ~70ms, and building it that way is what
 * made this read as flicker rather than as looking: the pupil teleported and
 * nothing else on the face moved with it. Slower and eased carries far better
 * on a stylized face, so these are deliberately unrealistic.
 */
const FLICK_MIN_MS = 180;
const GLIDE_MIN_MS = 700;

/** Share of moves that are slow glides — watching something rather than
 *  snapping to it. Variety in SPEED is most of what reads as alive. */
const GLIDE_CHANCE = 0.3;

/** A saccade at least this large gets a blink and a head tilt, the way a real
 *  look-away does. */
const LARGE_SACCADE = 0.55;

/** Idle flourishes: gap between them, so the face reads as playful rather than
 *  twitchy. */
const MICRO_GAP_MIN_MS = 3500;
const MICRO_GAP_MAX_MS = 8500;

/** How far a gesture may pull the eyes off a locked gaze. Bounded so that
 *  "focused on you" survives the animation playing over it. */
/**
 * The eye-widen when the agent starts talking, and the minimum silence before
 * it may fire again.
 *
 * This is a beat that marks the START of a turn. It used to fire on every
 * rising edge of `isRemoteSpeaking` — but that flag is an RMS threshold that
 * crosses back and forth between words, so it re-fired several times per
 * sentence and the eyes visibly bounced along with the mouth. Requiring real
 * silence first makes it once per turn, which is what it was always meant to be.
 *
 * The magnitude is down from 1.14 as well: 14% of the eye's height is a lot of
 * vertical travel when scaleY grows about the centre, and it read as a bounce
 * rather than as attention.
 */
const ANTICIPATION_SCALE = 1.07;
const ANTICIPATION_MIN_SILENCE_MS = 800;

const THINKING_OFFSET_X = -0.15;
const THINKING_OFFSET_Y = -0.2;
const THINKING_BROW = -4;
const MICRO_BROW = -5;

/** Lid multiplier by which the drawn sleeping lid has fully faded out. Wide
 *  enough that the eye is genuinely open behind it before it disappears. */
const SLEEP_LID_FADE = 0.25;

/**
 * How long one backchannel nod takes, and how far it travels.
 *
 * Small, and getting smaller each time it is looked at, because the sum of what
 * the face does while someone is TALKING is much easier to overdo than any one
 * movement suggests: this nod rides on top of the head already following the
 * speaker's face, plus a constant listening bob, plus the eyes widening. Each
 * is defensible alone; together they read as fidgeting.
 */
const LISTEN_NOD_MS = 1150;
const LISTEN_NOD_PX = 4.5;

/** Gap before the FIRST backchannel nod of a turn, and between later ones. A
 *  listener who nods every two seconds is agreeing with the sound of a voice,
 *  not with anything being said. */
const LISTEN_NOD_FIRST_MIN_MS = 3200;
const LISTEN_NOD_FIRST_MAX_MS = 6500;
const LISTEN_NOD_GAP_MIN_MS = 5200;
const LISTEN_NOD_GAP_MAX_MS = 11_000;

/** The constant sway while the user talks, in degrees. Under a degree of roll:
 *  it is there to stop the head being carved out of stone, nothing more. */
const LISTEN_SWAY_DEG = 0.9;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const easeInOutSine = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Which layer owns the eyes right now.
 *
 * Pure, because this is the rule the whole feature turns on and it is worth
 * stating once rather than re-deriving from four booleans inside a RAF loop:
 *
 *   tracking — a face is detected: look at it and STAY on it. Gestures still
 *              play over the top, but the eyes do not go wandering.
 *   wander   — nobody there and nothing said for a beat: idle look-around.
 *   straight — nobody there but something is happening (or reduced motion):
 *              look straight ahead.
 */
export type GazeMode = 'tracking' | 'wander' | 'straight';

export function resolveGazeMode(input: {
  isGazeLocked: boolean;
  /** ms since anyone last spoke. */
  quietMs: number;
  reducedMotion: boolean;
}): GazeMode {
  if (input.isGazeLocked) return 'tracking';
  if (input.reducedMotion) return 'straight';
  return input.quietMs > IDLE_AFTER_MS ? 'wander' : 'straight';
}

export interface BusyState {
  /** When the current run of "someone is talking" began; null when quiet. */
  busySince: number | null;
  /** Last moment speech was CONFIRMED. The idle countdown runs from here. */
  lastBusyAt: number;
}

/**
 * Advance the idle timer by one frame.
 *
 * Pure because this is the rule that broke: the inputs are recomputed every
 * animation frame from thresholds tuned for other purposes, and the old version
 * let any single frame of `busyNow` reset the countdown. One spurious frame per
 * 2.5s kept the face permanently awake, and from the outside that is
 * indistinguishable from the idle animation simply not existing.
 */
export function stepBusy(state: BusyState, busyNow: boolean, now: number): BusyState {
  if (!busyNow) return { busySince: null, lastBusyAt: state.lastBusyAt };
  const busySince = state.busySince ?? now;
  // Wedged latch: stop believing it. See BUSY_WATCHDOG_MS.
  if (now - busySince >= BUSY_WATCHDOG_MS) {
    return { busySince, lastBusyAt: state.lastBusyAt };
  }
  const confirmed = now - busySince >= BUSY_CONFIRM_MS;
  return { busySince, lastBusyAt: confirmed ? now : state.lastBusyAt };
}

export interface Saccade {
  /** Target offset, -1 to 1. */
  x: number;
  y: number;
  amplitude: number;
  durationMs: number;
  /** How long to rest on the target once there. */
  holdMs: number;
  /** Big enough to warrant a blink and a head tilt, as a real look-away does. */
  isLargeExcursion: boolean;
  /** 'flick' snaps to the target; 'glide' drifts across to it. */
  kind: 'flick' | 'glide';
}

/**
 * Pick the next place to look.
 *
 * Weighted toward small movements because that is what real eyes do — a
 * uniform spread reads as a nervous scan. The rare large excursion is the one
 * that registers as "looking away", which is why it is the one that gets the
 * blink and the head tilt. Bigger jumps take longer, so the eye's speed stays
 * roughly constant instead of every saccade snapping in the same 70ms.
 */
export function planSaccade(random: () => number, forcedAmplitude?: number): Saccade {
  const roll = random();
  const amplitude =
    forcedAmplitude ??
    (roll < 0.68
      ? 0.12 + random() * 0.16
      : roll < 0.94
        ? 0.32 + random() * 0.22
        : 0.6 + random() * 0.28);
  const angle = random() * Math.PI * 2;
  const kind: 'flick' | 'glide' = random() < GLIDE_CHANCE ? 'glide' : 'flick';
  return {
    x: clamp(Math.cos(angle) * amplitude, -0.9, 0.9),
    // Vertical excursions are smaller — the eye's vertical range is, and going
    // as far up as sideways reads as an eye-roll rather than a glance.
    y: clamp(Math.sin(angle) * amplitude * 0.55, -0.5, 0.5),
    amplitude,
    durationMs:
      kind === 'glide' ? GLIDE_MIN_MS + amplitude * 800 : FLICK_MIN_MS + amplitude * 200,
    holdMs: SACCADE_HOLD_MIN_MS + random() * (SACCADE_HOLD_MAX_MS - SACCADE_HOLD_MIN_MS),
    isLargeExcursion: amplitude >= LARGE_SACCADE,
    kind
  };
}

interface UseFaceBehaviorOptions {
  isUserSpeaking: boolean;
  isRemoteSpeaking: boolean;
  /** Debounced face detection — see useStableDetection. */
  isGazeLocked: boolean;
  /** Normalized tracked gaze target, -1 to 1. Meaningful only while locked. */
  trackedX: number;
  trackedY: number;
  /** Blink trigger, owned by useFaceAnimation. */
  onBlink?: (target?: BlinkTarget, holdMs?: number) => void;
  /** Sustained pose from the current emotion cue (#face-emotions). */
  expression?: ExpressionSpec;
  /** One-shot gesture. A new `seq` starts it, even for a repeated tag. */
  gesture?: { tag: string; seq: number } | null;
  /** Awake, out cold, or coming round (#face-sleep). */
  sleepPhase?: SleepPhase;
}

export interface FaceBehavior {
  /** Composed pupil offset, -1 to 1. */
  gazeX: MotionValue<number>;
  gazeY: MotionValue<number>;
  /** Head roll in degrees. */
  headRotation: MotionValue<number>;
  /** Vertical head movement in px — the nod axis, which roll cannot express. */
  headPitch: MotionValue<number>;
  /** Whole-face scale, for lean-in. */
  faceScale: MotionValue<number>;
  /** Eye-scale multiplier for the anticipation pop. */
  anticipation: MotionValue<number>;
  /** Per-eye lid multipliers, so a gesture can close one eye (wink). */
  lidLeft: MotionValue<number>;
  lidRight: MotionValue<number>;
  /**
   * How much the SLEEPING lid should be drawn, 0..1 (#face-sleep).
   *
   * Separate from `lidLeft`/`lidRight` because those carry blinks and winks
   * too, and a blink must not put a sleeping face on screen for 100ms. This
   * one rises only when sleep is closing the eyes.
   */
  sleepClosed: MotionValue<number>;
  /** Eyebrow offset in px. Discrete — Framer smooths it in the renderer. */
  eyebrowOffset: number;
}

export const useFaceBehavior = ({
  isUserSpeaking,
  isRemoteSpeaking,
  isGazeLocked,
  trackedX,
  trackedY,
  onBlink,
  expression = DEFAULT_EXPRESSION,
  gesture = null,
  sleepPhase = 'awake'
}: UseFaceBehaviorOptions): FaceBehavior => {
  const gazeX = useMotionValue(0);
  const gazeY = useMotionValue(0);
  const headRotation = useMotionValue(0);
  const headPitch = useMotionValue(0);
  const faceScale = useMotionValue(1);
  const anticipation = useMotionValue(1);
  const lidLeft = useMotionValue(1);
  const lidRight = useMotionValue(1);
  const sleepClosed = useMotionValue(0);
  const [eyebrowOffset, setEyebrowOffset] = useState(0);

  // Snapshot refs — the loop reads live values without being torn down and
  // restarted (which would lose every saccade timer mid-flight).
  const isUserSpeakingRef = useRef(isUserSpeaking);
  const isRemoteSpeakingRef = useRef(isRemoteSpeaking);
  const isGazeLockedRef = useRef(isGazeLocked);
  const trackedRef = useRef({ x: trackedX, y: trackedY });
  const onBlinkRef = useRef(onBlink);
  const expressionRef = useRef(expression);
  const gestureRef = useRef(gesture);
  isUserSpeakingRef.current = isUserSpeaking;
  isRemoteSpeakingRef.current = isRemoteSpeaking;
  isGazeLockedRef.current = isGazeLocked;
  trackedRef.current = { x: trackedX, y: trackedY };
  onBlinkRef.current = onBlink;
  expressionRef.current = expression;
  gestureRef.current = gesture;
  const sleepPhaseRef = useRef(sleepPhase);
  sleepPhaseRef.current = sleepPhase;

  const isTTSPlaying = useStore((s) => s.isTTSPlaying);
  const isTTSPlayingRef = useRef(isTTSPlaying);
  isTTSPlayingRef.current = isTTSPlaying;

  useEffect(() => {
    const isMobile =
      typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent);
    const targetInterval = isMobile ? 1000 / 30 : 1000 / 60;
    const reducedMotion =
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let rafId: number | null = null;
    let lastFrame = 0;

    // Gaze base (tracked target, or straight ahead when nobody is there)
    let baseX = 0;
    let baseY = 0;
    let prevMode: GazeMode | null = null;

    // Idle wander
    let wanderX = 0;
    let wanderY = 0;
    let fromX = 0;
    let fromY = 0;
    let toX = 0;
    let toY = 0;
    let moveStart = 0;
    let moveDur = FLICK_MIN_MS;
    let holdUntil = 0;

    // Thinking
    let thinkX = 0;
    let thinkY = 0;
    let thinkBrow = 0;
    let userStoppedAt: number | null = null;
    let wasUserSpeaking = false;

    // Anticipation flash
    let flash = 1;
    let prevRemoteSpeaking = false;
    let remoteQuietSince = 0; // when the agent's voice last stopped

    // Head: listening nod + idle tilt
    let nod = 0;
    let tilt = 0;
    let idlePitch = 0;
    let tiltTarget = 0;
    let tiltUntil = 0;

    // Idle flourishes
    let lastBusyAt = Date.now();
    let busySince: number | null = null;
    let nextMicroAt = 0;
    let microBrow = 0;
    let microBrowUntil = 0;
    let peekReturnAt = 0;

    let emittedBrow = 0;

    // Expression layer — lerped, so a cue change eases in rather than snapping.
    let exprGazeX = 0;
    let exprGazeY = 0;
    // Which way a `gazeAside` expression is looking, and which pose it was
    // rolled for. Re-rolled on every adoption so the same expression twice does
    // not land on the same side — the tell that nothing is behind it.
    let asideSign = 1;
    let asidePose: ExpressionSpec | null = null;
    let exprRoll = 0;
    let exprBrow = 0;

    // Sustained-motion layer. Some expressions are a MOVEMENT, not a pose:
    // thought is eyes drifting away and not settling, laughter is a bounce.
    // Held still, both read as something else entirely — a glare and a smirk.
    // Backchannel nods. A listener who never moves reads as a recording; a
    // nod every few seconds while someone talks is what says "still with you".
    // Irregular on purpose — a nod on a fixed beat is worse than none.
    let listenNodStart = 0;
    let listenNodDouble = false;
    let nextListenNodAt = 0;

    let bounceGate = 0;
    let lastBounce: { amplitude: number; periodMs: number } | null = null;
    let nextSqueezeAt = 0;

    // Gesture layer — sampled over its own duration and additive on top. It
    // ends by returning to rest of its own accord (see GestureSpec), so nothing
    // outside has to fade it out.
    let gestureSeq = -1;
    let gestureStart = 0;
    let gestureVariant = 0;
    let gestureSpec: ReturnType<typeof resolveGesture> = null;
    const REST: GestureFrame = {};

    // Sleep layer (#face-sleep). `sleepGate` fades the droop in and out so
    // nodding off and coming round are both movements rather than cuts;
    // `sleepLid` is the eyelid, handed to the wake animation for the duration
    // of the wake and lerped the rest of the time.
    let sleepGate = 0;
    let sleepLid = 1;
    let wakeStart = 0;
    let prevSleepPhase: SleepPhase = 'awake';

    let moveEase: (t: number) => number = smoothstep;

    const startSaccade = (now: number, forcedAmplitude?: number) => {
      const s = planSaccade(Math.random, forcedAmplitude);
      // A glide is a slow drift across, so it wants a gentler curve than the
      // ease-in-out a flick uses; easing a long move like a short one makes it
      // look like it is being dragged.
      moveEase = s.kind === 'glide' ? easeInOutSine : smoothstep;
      fromX = wanderX;
      fromY = wanderY;
      toX = s.x;
      toY = s.y;
      moveStart = now;
      moveDur = s.durationMs;
      holdUntil = now + s.durationMs + s.holdMs;
      if (s.isLargeExcursion) {
        onBlinkRef.current?.();
        tiltTarget = -s.x * 3.5;
        tiltUntil = holdUntil;
      }
    };

    const tick = (frameTime: number) => {
      if (frameTime - lastFrame < targetInterval) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      lastFrame = frameTime;

      const now = Date.now();
      const speaking = isUserSpeakingRef.current;
      const remoteSpeaking = isRemoteSpeakingRef.current;
      const locked = isGazeLockedRef.current;
      const ttsPlaying = isTTSPlayingRef.current;

      // === Idle gate ===
      // Keyed on speech only: a detected face suppresses the WANDER (below),
      // but a person sitting quietly should still get the small flourishes.
      //
      // A blip cannot hold the face awake — only a signal that persists past
      // BUSY_CONFIRM_MS does. Once confirmed it refreshes every frame, so the
      // 2.5s of quiet is measured from when speech actually stopped.
      // ttsPlaying is deliberately NOT part of this. It carries no information
      // `remoteSpeaking` does not already carry — that one is derived from the
      // actual audio — and unlike audio it is a latch that can stick. Two
      // signals for one fact, where one of them can wedge, is how the organizer
      // face stopped idling.
      const busy = stepBusy({ busySince, lastBusyAt }, speaking || remoteSpeaking, now);
      busySince = busy.busySince;
      lastBusyAt = busy.lastBusyAt;
      const quietMs = now - lastBusyAt;
      const quiet = quietMs > IDLE_AFTER_MS;

      // === Sleep (#face-sleep) ===
      // `dormant` covers asleep AND waking: every voluntary layer below —
      // wandering, flourishes, backchannel nods — has to stay out of the way,
      // or the idle behavior carries on underneath the closed lids and the
      // head drifts around while she is supposed to be out.
      const phase = sleepPhaseRef.current;
      if (phase !== prevSleepPhase) {
        if (phase === 'waking') wakeStart = now;
        prevSleepPhase = phase;
      }
      const asleep = phase === 'asleep';
      const dormant = phase !== 'awake';
      // Asymmetric: she goes under slowly and comes round faster, so the droop
      // has unwound by the time the wake animation gets to the stretch.
      sleepGate += ((asleep ? 1 : 0) - sleepGate) * (asleep ? 0.03 : 0.08);

      // Under reduced motion the phase still runs its full length — it is
      // covering the camera restart, which is not a preference — but the stir
      // and the stretch are dropped and the lids simply open.
      const performingWake = phase === 'waking' && !reducedMotion;
      let wakeFrame: GestureFrame = REST;
      if (performingWake) {
        const wt = clamp((now - wakeStart) / WAKE_ANIMATION.durationMs, 0, 1);
        wakeFrame = WAKE_ANIMATION.frame(wt);
      }
      // The wake animation owns the lids outright while it plays — it starts at
      // exactly SLEEP_POSE.lid, so the handover is invisible — and the lerp
      // takes them back afterwards.
      sleepLid = performingWake
        ? (wakeFrame.lidLeft ?? 1)
        : sleepLid + ((asleep ? SLEEP_POSE.lid : 1) - sleepLid) * 0.06;

      const breath =
        sleepGate > 0.001 && !reducedMotion
          ? Math.sin((now / SLEEP_POSE.breath.periodMs) * Math.PI * 2)
          : 0;
      const sleepPitch = sleepGate * (SLEEP_POSE.droop + breath * SLEEP_POSE.breath.amplitude);
      const sleepRoll = sleepGate * SLEEP_POSE.roll;
      const sleepBrow = sleepGate * SLEEP_POSE.brow;
      const sleepScale = 1 + sleepGate * breath * SLEEP_POSE.breathScale;
      // Looking away IS the expression, so it outranks the gaze lock — the one
      // thing allowed to. Forced to 'straight' rather than left to wander, so
      // the drift below owns the movement instead of fighting saccades.
      const averting = (expressionRef.current ?? DEFAULT_EXPRESSION).avertsGaze === true;
      const mode: GazeMode = dormant
        ? 'straight'
        : averting
          ? 'straight'
          : resolveGazeMode({ isGazeLocked: locked, quietMs, reducedMotion });
      const wandering = mode === 'wander';

      // === Handing the eyes between layers ===
      // Where the eyes are is base + wander. Those two are lerped independently,
      // so switching which one owns the gaze used to produce a two-stage move:
      // the wander unwound to centre while the base travelled out to the face,
      // and you saw the eyes cross back through the middle on the way to you.
      //
      // Instead, transfer the offset at the moment of the switch. The sum is
      // unchanged on that frame — so nothing jumps — and the eyes then travel to
      // the person in ONE arc from wherever they happened to be looking.
      if (mode !== prevMode) {
        if (mode === 'tracking') {
          baseX += wanderX;
          baseY += wanderY;
          wanderX = 0;
          wanderY = 0;
          holdUntil = 0;
          peekReturnAt = 0;
        } else if (prevMode === 'tracking') {
          // Losing the lock: carry the position into the wander so the next
          // saccade departs from where the eyes are, rather than snapping to
          // centre first and then starting to look around.
          wanderX = baseX;
          wanderY = baseY;
          baseX = 0;
          baseY = 0;
          fromX = wanderX;
          fromY = wanderY;
          toX = wanderX;
          toY = wanderY;
        }
        prevMode = mode;
      }

      // === Gaze base ===
      // Locked: ease onto the tracked face. Free: straight ahead. The per-frame
      // lerp is what smooths the 10Hz detection into continuous motion, and it
      // is gentle enough that acquiring a face reads as settling onto someone
      // rather than snapping to them.
      const targetBaseX = mode === 'tracking' ? trackedRef.current.x : 0;
      const targetBaseY = mode === 'tracking' ? trackedRef.current.y : 0;
      baseX += (targetBaseX - baseX) * 0.07;
      baseY += (targetBaseY - baseY) * 0.07;

      // === Idle wander (saccades) ===
      if (wandering) {
        if (now >= holdUntil) {
          startSaccade(now);
        } else if (peekReturnAt && now >= peekReturnAt) {
          // Double-take: snap back to where we were looking.
          peekReturnAt = 0;
          fromX = wanderX;
          fromY = wanderY;
          toX = 0;
          toY = 0;
          moveStart = now;
          moveDur = 90;
          holdUntil = now + moveDur + rand(900, 1800);
        }
        const t = clamp((now - moveStart) / moveDur, 0, 1);
        const e = moveEase(t);
        // Micro-drift, always on while wandering. Eyes are never still — the
        // hold between two moves used to freeze them completely, which is what
        // turned the whole behavior into a flicker between two static poses.
        // Small enough not to fight the saccade it rides on top of.
        const secs = now / 1000;
        const driftX = Math.sin(secs * 0.63) * 0.028 + Math.sin(secs * 1.27) * 0.014;
        const driftY = Math.cos(secs * 0.48) * 0.018 + Math.cos(secs * 1.09) * 0.009;
        wanderX = fromX + (toX - fromX) * e + driftX;
        wanderY = fromY + (toY - fromY) * e + driftY;
      } else {
        // Someone to look at (or speech in progress) — unwind the wander so the
        // eyes settle onto the face instead of snapping.
        wanderX += (0 - wanderX) * 0.06;
        wanderY += (0 - wanderY) * 0.06;
        holdUntil = 0;
        peekReturnAt = 0;
      }

      // === Idle flourishes ===
      if (quiet && !reducedMotion && !dormant) {
        if (nextMicroAt === 0) nextMicroAt = now + rand(MICRO_GAP_MIN_MS, MICRO_GAP_MAX_MS);
        if (now >= nextMicroAt) {
          nextMicroAt = now + rand(MICRO_GAP_MIN_MS, MICRO_GAP_MAX_MS);
          // 'peek' needs somewhere to look away FROM, so it is unlocked-only.
          const options = wandering ? ['brow', 'tilt', 'peek'] : ['brow', 'tilt'];
          switch (options[Math.floor(Math.random() * options.length)]) {
            case 'brow':
              microBrow = MICRO_BROW;
              microBrowUntil = now + 450;
              break;
            case 'tilt':
              tiltTarget = Math.random() < 0.5 ? -4 : 4;
              tiltUntil = now + rand(1200, 2200);
              break;
            case 'peek':
              startSaccade(now, rand(0.65, 0.9));
              peekReturnAt = now + rand(320, 520);
              break;
          }
        }
      } else {
        nextMicroAt = 0;
      }
      if (microBrowUntil && now >= microBrowUntil) {
        microBrow = 0;
        microBrowUntil = 0;
      }
      if (tiltUntil && now >= tiltUntil) {
        tiltTarget = 0;
        tiltUntil = 0;
      }

      // === Thinking ===
      // Deliberately NOT gated on detection: the user asked for animations that
      // still play while the face is locked onto someone, and this is the one
      // that exists today. It is an additive offset, so the eyes drift up-left
      // in thought and return to the tracked face.
      if (speaking && !wasUserSpeaking) userStoppedAt = null;
      if (!speaking && wasUserSpeaking) userStoppedAt = now;
      wasUserSpeaking = speaking;

      const isThinking =
        userStoppedAt !== null && now - userStoppedAt > 800 && !remoteSpeaking && !ttsPlaying;
      const thinkLerp = 0.06;
      thinkX += ((isThinking ? THINKING_OFFSET_X : 0) - thinkX) * thinkLerp;
      thinkY += ((isThinking ? THINKING_OFFSET_Y : 0) - thinkY) * thinkLerp;
      thinkBrow += ((isThinking ? THINKING_BROW : 0) - thinkBrow) * thinkLerp;

      // === Anticipation flash ===
      // Only on a rising edge that follows real silence — see the constants.
      if (!remoteSpeaking && prevRemoteSpeaking) remoteQuietSince = now;
      if (remoteSpeaking && !prevRemoteSpeaking) {
        const silence = remoteQuietSince === 0 ? Infinity : now - remoteQuietSince;
        if (silence >= ANTICIPATION_MIN_SILENCE_MS) flash = ANTICIPATION_SCALE;
      }
      prevRemoteSpeaking = remoteSpeaking;
      flash += (1 - flash) * 0.15;
      if (Math.abs(flash - 1) < 0.001) flash = 1;

      // === Head ===
      const elapsed = now / 1000;
      const nodTarget = speaking ? Math.sin(elapsed * Math.PI * 0.8) * LISTEN_SWAY_DEG : 0;
      nod += (nodTarget - nod) * 0.1;

      // === Listening nods ===
      if (speaking && !reducedMotion && !dormant) {
        if (nextListenNodAt === 0)
          nextListenNodAt = now + rand(LISTEN_NOD_FIRST_MIN_MS, LISTEN_NOD_FIRST_MAX_MS);
        if (listenNodStart === 0 && now >= nextListenNodAt) {
          listenNodStart = now;
          listenNodDouble = Math.random() >= 0.5;
          nextListenNodAt = now + rand(LISTEN_NOD_GAP_MIN_MS, LISTEN_NOD_GAP_MAX_MS);
        }
      } else {
        nextListenNodAt = 0; // an in-flight nod is allowed to finish
      }
      let listenNod = 0;
      if (listenNodStart !== 0) {
        const t = (now - listenNodStart) / LISTEN_NOD_MS;
        if (t >= 1) listenNodStart = 0;
        // Same shape as the [nod] gesture — one beat or two, chosen per nod —
        // just far quieter. This one fires unprompted every few seconds while
        // someone talks, so it has to sit under conscious notice: a deliberate
        // nod agrees with you, a backchannel nod only says "still here".
        else {
          const first = t < 0.5 ? Math.sin(Math.PI * (t / 0.5)) : 0;
          const second =
            listenNodDouble && t >= 0.52 ? Math.sin(Math.PI * ((t - 0.52) / 0.48)) * 0.6 : 0;
          listenNod = (first + second) * LISTEN_NOD_PX;
        }
      }
      tilt += (tiltTarget - tilt) * 0.06;

      // === Expression ===
      // Additive and bounded, which is what lets a pose play while the eyes are
      // locked onto a real face: they lean into the expression and spring back
      // onto the person, instead of leaving them.
      const pose = expressionRef.current ?? DEFAULT_EXPRESSION;
      const exprLerp = 0.08;
      // Sustained drift, if this expression has one. Two incommensurate
      // frequencies so the eyes never retrace the same path — a single sine
      // reads as a metronome, which is the opposite of thinking.
      let driftX = 0;
      let driftY = 0;
      if (pose.gazeDrift && !reducedMotion) {
        const phase = (now / pose.gazeDrift.periodMs) * Math.PI * 2;
        driftX = Math.sin(phase) * pose.gazeDrift.x;
        driftY = pose.gazeDrift.y + Math.cos(phase * 1.7) * 0.06;
      }
      // Look aside and HOLD. The lerp below carries the eyes there over about a
      // second, so this is a destination rather than a jump.
      if (pose.gazeAside && !reducedMotion) {
        if (pose !== asidePose) {
          asidePose = pose;
          asideSign = Math.random() < 0.5 ? -1 : 1;
        }
        const jitter = pose.gazeAside.jitter ?? 0;
        const secs = now / 1000;
        driftX = asideSign * pose.gazeAside.x + Math.sin(secs * 0.51) * jitter;
        driftY = pose.gazeAside.y + Math.cos(secs * 0.37) * jitter * 0.6;
      } else if (!pose.gazeAside) {
        asidePose = null;
      }
      exprGazeX += ((pose.gazeX ?? 0) + driftX - exprGazeX) * exprLerp;
      exprGazeY += ((pose.gazeY ?? 0) + driftY - exprGazeY) * exprLerp;
      exprRoll += ((pose.roll ?? 0) - exprRoll) * exprLerp;
      exprBrow += ((pose.brow ?? 0) - exprBrow) * exprLerp;

      // === Gesture ===
      const pending = gestureRef.current;
      if (pending && pending.seq !== gestureSeq) {
        gestureSeq = pending.seq;
        gestureSpec = reducedMotion ? null : resolveGesture(pending.tag);
        gestureStart = now;
        // Rolled once per play, not per frame.
        gestureVariant = Math.random();
      }
      // Bounce. The gate fades the shake in and out so an expression change is
      // not a jump-cut; the spec is remembered while it fades so the motion has
      // something to fade OUT of.
      if (pose.bounce) lastBounce = pose.bounce;
      bounceGate += ((pose.bounce && !reducedMotion && !dormant ? 1 : 0) - bounceGate) * 0.08;
      const bounceY =
        lastBounce && bounceGate > 0.001
          ? Math.sin((now / lastBounce.periodMs) * Math.PI * 2) *
            lastBounce.amplitude *
            bounceGate
          : 0;

      // Irregular eye-scrunches. Randomised gap, because laughter that blinks
      // on a fixed beat reads as a warning light.
      if (pose.eyeSqueeze && !reducedMotion && !dormant) {
        const squeeze = pose.eyeSqueeze;
        const gap = () => rand(squeeze.minGapMs, squeeze.maxGapMs);
        if (nextSqueezeAt === 0) nextSqueezeAt = now + gap();
        if (now >= nextSqueezeAt) {
          onBlinkRef.current?.('both', squeeze.holdMs);
          nextSqueezeAt = now + gap();
        }
      } else {
        nextSqueezeAt = 0;
      }

      let frame: GestureFrame = REST;
      if (gestureSpec) {
        const t = (now - gestureStart) / gestureSpec.durationMs;
        if (t >= 1) {
          gestureSpec = null;
        } else {
          frame = gestureSpec.frame(t, gestureVariant);
        }
      }

      // === Compose ===
      const finalX = clamp(
        baseX + wanderX + thinkX + exprGazeX + (frame.gazeX ?? 0) + (wakeFrame.gazeX ?? 0),
        -1,
        1
      );
      const finalY = clamp(
        baseY + wanderY + thinkY + exprGazeY + (frame.gazeY ?? 0) + (wakeFrame.gazeY ?? 0),
        -1,
        1
      );
      // Head follow-through. The eyes lead and the head trails them slightly —
      // without it only the pupils move and the face reads as a mask with
      // something sliding behind it. Lagged well behind the gaze (0.04) so the
      // head drifts after the eyes rather than moving in lockstep with them.
      idlePitch += (finalY * 14 - idlePitch) * 0.04;

      gazeX.set(finalX);
      gazeY.set(finalY);
      // The head commits to where the eyes go. This used to be a token 8deg,
      // which left the face reading as a mask with pupils sliding behind it.
      headRotation.set(
        finalX * 15 + nod + tilt + exprRoll + (frame.roll ?? 0) + sleepRoll + (wakeFrame.roll ?? 0)
      );
      headPitch.set(
        idlePitch + bounceY + listenNod + (frame.pitch ?? 0) + sleepPitch + (wakeFrame.pitch ?? 0)
      );
      faceScale.set((frame.scale ?? 1) * sleepScale * (wakeFrame.scale ?? 1));
      // The sleep lid multiplies rather than replaces, so a gesture that closes
      // one eye still works on a face that is only half awake.
      lidLeft.set((frame.lidLeft ?? 1) * sleepLid);
      lidRight.set((frame.lidRight ?? 1) * sleepLid);
      // The drawn lid fades out as the eye opens, so the two never both show.
      // It is gone by the time the wake's first bleary peek gets underway.
      sleepClosed.set(clamp(1 - sleepLid / SLEEP_LID_FADE, 0, 1));
      anticipation.set(flash);

      // Eyebrows are a discrete channel — publish only on a real change, so the
      // renderer re-renders a few times a turn rather than every frame.
      // Rounded to whole pixels: this is the one channel that still crosses the
      // React boundary, and an unrounded gesture would re-render every frame.
      const brow = Math.round(
        thinkBrow + microBrow + exprBrow + (frame.brow ?? 0) + sleepBrow + (wakeFrame.brow ?? 0)
      );
      if (brow !== emittedBrow) {
        emittedBrow = brow;
        setEyebrowOffset(brow);
      }

      // Why the face is doing what it is doing, readable from the console as
      // `__stellaFace`. The last round of "the idle animation does not run" was
      // undiagnosable from the outside: every input is internal, and the only
      // visible output is a face that holds still — which looks identical
      // whether it is gaze-locked, mid-conversation, or wedged. Read-only.
      (window as unknown as Record<string, unknown>).__stellaFace = {
        mode,
        isGazeLocked: locked,
        quietMs: Math.round(quietMs),
        busy: { speaking, remoteSpeaking, ttsPlaying, confirmed: busySince !== null },
        reducedMotion,
        expression: pose === DEFAULT_EXPRESSION ? 'neutral' : 'cue',
        sleep: phase,
      };

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    gazeX,
    gazeY,
    headRotation,
    headPitch,
    faceScale,
    anticipation,
    lidLeft,
    lidRight,
    sleepClosed
  ]);

  return {
    gazeX,
    gazeY,
    headRotation,
    headPitch,
    faceScale,
    anticipation,
    lidLeft,
    lidRight,
    sleepClosed,
    eyebrowOffset
  };
};
