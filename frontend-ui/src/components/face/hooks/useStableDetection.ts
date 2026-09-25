/**
 * useStableDetection Hook
 *
 * One debounced "is someone actually there" signal, shared by every layer that
 * needs it. Detection runs at 10Hz and drops frames on ordinary head movement,
 * so the raw flag flickers several times a second. Each consumer used to
 * debounce (or not) on its own, which is why pupil dilation and the idle
 * behavior could disagree about whether a face was present.
 *
 * Asymmetric on purpose: a detection takes effect immediately (look at the
 * person the instant they appear) but a loss is held, so a blink or a turn of
 * the head does not drop the gaze lock and start the eyes wandering.
 */

import { useEffect, useRef, useState } from 'react';

export const DETECTION_HOLD_MS = 800;

export const useStableDetection = (hasDetection: boolean, holdMs = DETECTION_HOLD_MS): boolean => {
  const [stable, setStable] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hasDetection) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setStable(true);
    } else if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setStable(false);
      }, holdMs);
    }
  }, [hasDetection, holdMs]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return stable;
};
