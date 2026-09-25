/**
 * useSleepState Hook
 *
 * Owns whether the face is awake, asleep, or in the middle of waking up — and
 * with it, whether the webcam is running at all. Sleep is not only an
 * animation: the camera light going out is the point, so this state has to be
 * the single thing that gates `useFaceTracking`.
 *
 * ── Why waking is its own phase ────────────────────────────────────────────
 *
 * Restarting the camera is slow. `getUserMedia` has to reacquire the device,
 * the video element has to reach its first frame, detection runs at 10Hz on top
 * of that, and `useStableDetection` debounces the result. Between a tap and the
 * eyes being able to find anyone there is the better part of a second, and
 * possibly several.
 *
 * So waking is a held phase with an animation long enough to cover it. The face
 * stirs, blinks itself awake and stretches while the camera comes back; by the
 * time the wake animation ends there is usually a detection waiting. Without
 * this the face would snap open and then stare blankly into the middle distance
 * for a second, which reads as broken rather than as waking up.
 *
 * ── Why speech wakes her, and why detection cannot ─────────────────────────
 *
 * While asleep the camera is OFF, so there is no detection to wake on — that is
 * the whole reason the user's spec is "wake on touch". But the agent starting to
 * talk with its eyes shut would be worse than never sleeping, so confirmed
 * speech wakes her too.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { stepBusy, type BusyState } from './useFaceBehavior';

/** No one visible for this long and she nods off. */
export const SLEEP_AFTER_MS = 30_000;

/** How long the wake animation runs. Also how long the camera has to recover. */
export const WAKE_MS = 2600;

/**
 * Fraction of the wake spent with the mouth still slack.
 *
 * The yawn has to end before the eyes pop open — a wide-eyed face with a
 * hanging jaw reads as a shock, not as waking up.
 */
export const YAWN_FRACTION = 0.55;

/** How often the machine is stepped. Well under a second is plenty for a 30s
 *  timer, and a tap is applied immediately rather than waiting for a tick. */
const TICK_MS = 200;

/** How long confirmed speech keeps counting after the audio dips. Bridges the
 *  gaps between syllables, which are not the end of a turn. */
const BUSY_HOLD_MS = 1500;

export type SleepPhase = 'awake' | 'asleep' | 'waking';

export interface SleepState {
  phase: SleepPhase;
  /** Last moment there was a reason to be awake. The countdown runs from here. */
  lastPresenceAt: number;
  /** When the current wake began. Only meaningful in 'waking'. */
  wakingSince: number;
}

export interface SleepInput {
  /** Someone is visible — debounced detection, see useStableDetection. */
  isPresent: boolean;
  /** Speech, already confirmed. Blips must not reach this. */
  isBusy: boolean;
  /**
   * The camera is genuinely running.
   *
   * Without this the face would fall asleep 30 seconds after loading on every
   * machine where the webcam is missing, blocked, or was never granted — the
   * timer measures "the camera is watching and sees nobody", and with no camera
   * that question has no answer. Those users would get a face that goes dead
   * and stays dead, since they have no idea a tap would revive it.
   */
  cameraActive: boolean;
  /** A tap landed since the last step. */
  wakeRequested: boolean;
  /**
   * The agent has asked to go to sleep — an `[sleep]` tag reached the cursor.
   *
   * Latched by the caller, not edge-triggered here, because it almost never
   * applies on the step it arrives: the tag sits at the END of a reply, so she
   * is still mid-sentence when the cursor reaches it and `isBusy` is holding
   * her awake. It stays raised until she is actually quiet enough to go under.
   */
  sleepRequested: boolean;
  /** Preview only: run the timer regardless of presence or camera. */
  force: boolean;
  sleepAfterMs: number;
}

export function initialSleepState(now: number): SleepState {
  return { phase: 'awake', lastPresenceAt: now, wakingSince: 0 };
}

/**
 * Advance the machine by one step.
 *
 * Pure for the same reason `stepBusy` is: every input is internal and the only
 * visible output is a face holding still, which looks identical whether it is
 * asleep, gaze-locked, or wedged.
 */
export function stepSleep(state: SleepState, input: SleepInput, now: number): SleepState {
  // `!cameraActive` counts as presence rather than as a separate guard, so the
  // countdown is only ever running while the camera is actually watching. Treat
  // it as a guard on the transition instead and a camera that comes back after
  // a minute away would find a stale timer and doze off on the spot.
  const present = input.force
    ? input.isBusy
    : input.isPresent || input.isBusy || !input.cameraActive;
  const lastPresenceAt = present ? now : state.lastPresenceAt;

  switch (state.phase) {
    case 'asleep':
      if (input.wakeRequested || input.isBusy) {
        return { phase: 'waking', lastPresenceAt: now, wakingSince: now };
      }
      return { ...state, lastPresenceAt };

    case 'waking':
      // Held for the full animation whatever the inputs do, and the countdown
      // is pinned to now throughout — so she gets a complete quiet period after
      // waking rather than inheriting however long she was out.
      if (now - state.wakingSince >= WAKE_MS) {
        return { phase: 'awake', lastPresenceAt: now, wakingSince: state.wakingSince };
      }
      return { ...state, lastPresenceAt: now };

    case 'awake':
    default:
      // Being TOLD to sleep skips the countdown and ignores who is watching:
      // "go to sleep" means now, not in thirty seconds if nobody is looking.
      // It still waits for her own voice to finish — closing her eyes halfway
      // through her own goodbye is not what anyone asked for.
      if (input.sleepRequested && !input.isBusy) {
        return { phase: 'asleep', lastPresenceAt, wakingSince: state.wakingSince };
      }
      if (!present && now - lastPresenceAt >= input.sleepAfterMs) {
        return { phase: 'asleep', lastPresenceAt, wakingSince: state.wakingSince };
      }
      return { ...state, lastPresenceAt };
  }
}

/** True while the mouth should still hang open. */
export function isYawningAt(state: SleepState, now: number): boolean {
  if (state.phase === 'asleep') return true;
  return state.phase === 'waking' && now - state.wakingSince < WAKE_MS * YAWN_FRACTION;
}

interface UseSleepStateOptions {
  /** Debounced face detection. */
  isPresent: boolean;
  isUserSpeaking: boolean;
  isRemoteSpeaking: boolean;
  /** From useFaceTracking — a stream is live and detection is running. */
  cameraActive: boolean;
  /** Preview only: shorten the timer and ignore presence. */
  sleepAfterMs?: number;
  force?: boolean;
  /** `[sleep]` from the agent — a new seq is a new request (#face-sleep). */
  sleepCommandSeq?: number;
}

export interface SleepControls {
  phase: SleepPhase;
  /** Mouth still slack — asleep, or early in the wake. */
  isYawning: boolean;
  /** Tap handler. A no-op unless she is actually asleep. */
  wake: () => void;
}

export const useSleepState = ({
  isPresent,
  isUserSpeaking,
  isRemoteSpeaking,
  cameraActive,
  sleepAfterMs = SLEEP_AFTER_MS,
  force = false,
  sleepCommandSeq = 0,
}: UseSleepStateOptions): SleepControls => {
  const stateRef = useRef<SleepState>(initialSleepState(Date.now()));
  const wakeRequestedRef = useRef(false);
  // A commanded sleep, held until it can actually be honoured. See sleepRequested.
  const sleepPendingRef = useRef(false);
  const seenSleepSeqRef = useRef(sleepCommandSeq);
  // Speech flags are recomputed every frame from an RMS threshold tuned to
  // drive the mouth, so they flicker across the line on room tone. The idle
  // timer already learned this the hard way; the sleep timer runs 12x longer
  // and would be kept awake forever by one blip every half minute.
  const busyRef = useRef<BusyState>({ busySince: null, lastBusyAt: 0 });

  const inputRef = useRef({
    isPresent,
    isUserSpeaking,
    isRemoteSpeaking,
    cameraActive,
    force,
    sleepAfterMs,
    sleepCommandSeq,
  });
  inputRef.current = {
    isPresent,
    isUserSpeaking,
    isRemoteSpeaking,
    cameraActive,
    force,
    sleepAfterMs,
    sleepCommandSeq,
  };

  const [view, setView] = useState<{ phase: SleepPhase; isYawning: boolean }>({
    phase: 'awake',
    isYawning: false,
  });

  const step = useCallback(() => {
    const now = Date.now();
    const live = inputRef.current;

    busyRef.current = stepBusy(
      busyRef.current,
      live.isUserSpeaking || live.isRemoteSpeaking,
      now
    );
    // Held for a beat after the last confirmed frame, so the gaps between
    // syllables do not read as the conversation being over.
    const { lastBusyAt } = busyRef.current;
    const isBusy = lastBusyAt > 0 && now - lastBusyAt < BUSY_HOLD_MS;

    if (live.sleepCommandSeq !== seenSleepSeqRef.current) {
      seenSleepSeqRef.current = live.sleepCommandSeq;
      sleepPendingRef.current = true;
    }
    // The user speaking cancels a pending sleep. They asked her to go to sleep
    // and then carried on talking, which is a change of mind — and honouring
    // the old request the moment they pause would switch the camera off in the
    // middle of a conversation that had clearly restarted.
    if (live.isUserSpeaking) sleepPendingRef.current = false;

    const next = stepSleep(
      stateRef.current,
      {
        isPresent: live.isPresent,
        isBusy,
        cameraActive: live.cameraActive,
        wakeRequested: wakeRequestedRef.current,
        sleepRequested: sleepPendingRef.current,
        force: live.force,
        sleepAfterMs: live.sleepAfterMs,
      },
      now
    );
    wakeRequestedRef.current = false;
    // Cleared by being HONOURED, not by leaving 'awake'. The looser condition
    // also caught 'waking', so a `[sleep]` that landed while she was still
    // coming round was dropped on the floor and the reply that asked for it had
    // no effect — with nothing anywhere to say why.
    if (next.phase === 'asleep') sleepPendingRef.current = false;
    stateRef.current = next;

    const isYawning = isYawningAt(next, now);
    setView((prev) =>
      prev.phase === next.phase && prev.isYawning === isYawning
        ? prev
        : { phase: next.phase, isYawning }
    );
  }, []);

  // Stepped immediately rather than on the next tick: 200ms between the tap and
  // the eyes moving is exactly the lag that makes a touch feel unregistered.
  const wake = useCallback(() => {
    wakeRequestedRef.current = true;
    step();
  }, [step]);

  useEffect(() => {
    const id = setInterval(step, TICK_MS);
    return () => clearInterval(id);
  }, [step]);

  // Turning the preview's sleep test OFF wakes her.
  //
  // Without this she stays out cold: the camera is off, so there is nothing to
  // detect, and the only ways back are a tap or speech. Which means switching
  // the test off leaves a sleeping face and no wake animation — exactly the
  // thing the toggle exists to let you watch.
  const prevForceRef = useRef(force);
  useEffect(() => {
    if (prevForceRef.current && !force) wake();
    prevForceRef.current = force;
  }, [force, wake]);

  return { phase: view.phase, isYawning: view.isYawning, wake };
};
