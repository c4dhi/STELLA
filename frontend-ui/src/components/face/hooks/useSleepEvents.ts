/**
 * useSleepEvents Hook
 *
 * Tells the agent when the face falls asleep and when it wakes (#face-sleep).
 *
 * The agent cannot see either on its own. Sleep mutes the microphone, so from
 * its side a sleeping face is just a user who stopped talking; and a tap that
 * wakes her is the start of a new conversation the agent would otherwise only
 * notice at the first word. What it does with the two events is its business.
 *
 * Like useSleepMicrophone, this lives with the view and not in the sleep
 * machine: the connection to the agent belongs to the view.
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../../../store';
import type { SleepPhase } from './useSleepState';

/** The event to report for a phase change, if it is one worth reporting. */
export function sleepEventFor(previous: SleepPhase, next: SleepPhase): 'sleep' | 'wake' | null {
  if (next === previous) return null;
  if (next === 'asleep') return 'sleep';
  // 'waking' is when the user tapped; 'awake' straight from 'asleep' is the
  // face unmounting, which also ends the sleep.
  if (previous === 'asleep') return 'wake';
  return null;
}

interface UseSleepEventsOptions {
  /** The view's way of sending a client event to the agent. */
  send: (event: string) => void;
  /** Skip entirely when there is no session to report to. */
  enabled?: boolean;
}

export const useSleepEvents = ({ send, enabled = true }: UseSleepEventsOptions): void => {
  const phase = useStore((s) => s.faceSleepPhase);
  const prevPhaseRef = useRef(phase);
  // Read at transition time: the effect keys on the phase alone.
  const liveRef = useRef({ send, enabled });
  liveRef.current = { send, enabled };

  useEffect(() => {
    const previous = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    const event = sleepEventFor(previous, phase);
    if (event && liveRef.current.enabled) liveRef.current.send(event);
  }, [phase]);
};
