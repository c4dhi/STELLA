/**
 * useFaceAnimation Hook
 *
 * Owns the involuntary eye machinery: blinks, the widen while the user speaks,
 * and pupil dilation on gaze lock. Everything it produces is a MotionValue
 * animated by Framer, so it reaches the DOM without a React render — see the
 * note on FaceRendererProps for why that matters.
 *
 * `blink()` is exposed rather than kept private because other layers need to
 * trigger one: real eyes blink on large saccades, so the idle look-around asks
 * for a blink as it jumps (see useFaceBehavior), and the per-eye argument is
 * what a wink gesture will be built from.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMotionValue, animate } from 'framer-motion';

const BLINK_INTERVAL_MIN = 3000;
const BLINK_INTERVAL_MAX = 8000;
// Roughly a third of blinks are doubles. Tuned by eye and confirmed as right —
// leave it alone unless someone asks for a different feel.
const DOUBLE_BLINK_CHANCE = 0.3;
const DOUBLE_BLINK_DELAY = 250;

/** How far the lids close on a blink. Not 0 — a hairline reads as an eye, a
 *  hard 0 reads as the eye vanishing. */
const LID_CLOSED = 0.05;

interface UseFaceAnimationOptions {
  isUserSpeaking?: boolean;
  /** A face is being tracked (debounced) — pupils dilate, as they do on a
   *  person you are actually looking at. */
  isGazeLocked?: boolean;
}

export type BlinkTarget = 'both' | 'left' | 'right';

export const useFaceAnimation = ({
  isUserSpeaking = false,
  isGazeLocked = false
}: UseFaceAnimationOptions) => {
  const leftBlink = useMotionValue(1);
  const rightBlink = useMotionValue(1);
  const eyeWiden = useMotionValue(1);
  const pupilDilation = useMotionValue(1);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doubleBlinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const blink = useCallback(
    (target: BlinkTarget = 'both', holdMs = 0) => {
      const lids = [];
      if (target !== 'right') lids.push(leftBlink);
      if (target !== 'left') lids.push(rightBlink);
      for (const lid of lids) {
        animate(lid, LID_CLOSED, { duration: 0.1, ease: 'easeIn' }).then(() => {
          const reopen = () => animate(lid, 1, { duration: 0.15, ease: 'easeOut' });
          if (holdMs > 0) setTimeout(reopen, holdMs);
          else reopen();
        });
      }
    },
    [leftBlink, rightBlink]
  );

  // --- Spontaneous blinking ---
  useEffect(() => {
    const scheduleBlink = () => {
      const interval =
        BLINK_INTERVAL_MIN + Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
      blinkTimerRef.current = setTimeout(() => {
        blink();
        if (Math.random() < DOUBLE_BLINK_CHANCE) {
          doubleBlinkTimerRef.current = setTimeout(() => blink(), DOUBLE_BLINK_DELAY);
        }
        scheduleBlink();
      }, interval);
    };

    scheduleBlink();
    return () => {
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
      if (doubleBlinkTimerRef.current) clearTimeout(doubleBlinkTimerRef.current);
    };
  }, [blink]);

  // --- Attention cues ---
  useEffect(() => {
    animate(eyeWiden, isUserSpeaking ? 1.08 : 1.0, { duration: 0.25, ease: 'easeOut' });
  }, [isUserSpeaking, eyeWiden]);

  useEffect(() => {
    animate(pupilDilation, isGazeLocked ? 1.35 : 1.0, { duration: 0.6, ease: 'easeInOut' });
  }, [isGazeLocked, pupilDilation]);

  return { leftBlink, rightBlink, eyeWiden, pupilDilation, blink };
};
