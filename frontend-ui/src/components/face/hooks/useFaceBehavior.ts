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
  type ExpressionSpec,
  type GestureFrame,
} from '../animations/emotionRegistry';

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
  gesture = null
}: UseFaceBehaviorOptions): FaceBehavior => {
  const gazeX = useMotionValue(0);
  const gazeY = useMotionValue(0);
  const headRotation = useMotionValue(0);
  const headPitch = useMotionValue(0);
  const faceScale = useMotionValue(1);
  const anticipation = useMotionValue(1);
  const lidLeft = useMotionValue(1);
  const lidRight = useMotionValue(1);
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
    let exprRoll = 0;
    let exprBrow = 0;

    // Gesture layer — sampled over its own duration and additive on top. It
    // ends by returning to rest of its own accord (see GestureSpec), so nothing
    // outside has to fade it out.
    let gestureSeq = -1;
    let gestureStart = 0;
    let gestureSpec: ReturnType<typeof resolveGesture> = null;
    const REST: GestureFrame = {};

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
      const mode = resolveGazeMode({ isGazeLocked: locked, quietMs, reducedMotion });
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
      if (quiet && !reducedMotion) {
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
      const nodTarget = speaking ? Math.sin(elapsed * Math.PI * 0.8) * 2 : 0;
      nod += (nodTarget - nod) * 0.1;
      tilt += (tiltTarget - tilt) * 0.06;

      // === Expression ===
      // Additive and bounded, which is what lets a pose play while the eyes are
      // locked onto a real face: they lean into the expression and spring back
      // onto the person, instead of leaving them.
      const pose = expressionRef.current ?? DEFAULT_EXPRESSION;
      const exprLerp = 0.08;
      exprGazeX += ((pose.gazeX ?? 0) - exprGazeX) * exprLerp;
      exprGazeY += ((pose.gazeY ?? 0) - exprGazeY) * exprLerp;
      exprRoll += ((pose.roll ?? 0) - exprRoll) * exprLerp;
      exprBrow += ((pose.brow ?? 0) - exprBrow) * exprLerp;

      // === Gesture ===
      const pending = gestureRef.current;
      if (pending && pending.seq !== gestureSeq) {
        gestureSeq = pending.seq;
        gestureSpec = reducedMotion ? null : resolveGesture(pending.tag);
        gestureStart = now;
      }
      let frame: GestureFrame = REST;
      if (gestureSpec) {
        const t = (now - gestureStart) / gestureSpec.durationMs;
        if (t >= 1) {
          gestureSpec = null;
        } else {
          frame = gestureSpec.frame(t);
        }
      }

      // === Compose ===
      const finalX = clamp(baseX + wanderX + thinkX + exprGazeX + (frame.gazeX ?? 0), -1, 1);
      const finalY = clamp(baseY + wanderY + thinkY + exprGazeY + (frame.gazeY ?? 0), -1, 1);
      // Head follow-through. The eyes lead and the head trails them slightly —
      // without it only the pupils move and the face reads as a mask with
      // something sliding behind it. Lagged well behind the gaze (0.04) so the
      // head drifts after the eyes rather than moving in lockstep with them.
      idlePitch += (finalY * 6 - idlePitch) * 0.04;

      gazeX.set(finalX);
      gazeY.set(finalY);
      headRotation.set(finalX * 8 + nod + tilt + exprRoll + (frame.roll ?? 0));
      headPitch.set(idlePitch + (frame.pitch ?? 0));
      faceScale.set(frame.scale ?? 1);
      lidLeft.set(frame.lidLeft ?? 1);
      lidRight.set(frame.lidRight ?? 1);
      anticipation.set(flash);

      // Eyebrows are a discrete channel — publish only on a real change, so the
      // renderer re-renders a few times a turn rather than every frame.
      // Rounded to whole pixels: this is the one channel that still crosses the
      // React boundary, and an unrounded gesture would re-render every frame.
      const brow = Math.round(thinkBrow + microBrow + exprBrow + (frame.brow ?? 0));
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
      };

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [gazeX, gazeY, headRotation, headPitch, faceScale, anticipation, lidLeft, lidRight]);

  return {
    gazeX,
    gazeY,
    headRotation,
    headPitch,
    faceScale,
    anticipation,
    lidLeft,
    lidRight,
    eyebrowOffset
  };
};
