/**
 * useSleepMicrophone Hook
 *
 * Mutes the microphone when the face falls asleep and restores it on the way
 * back (#face-sleep). Sleeping releases the camera; leaving a live microphone
 * open alongside a switched-off camera would be the worse half of the promise.
 *
 * It lives out here rather than inside the sleep machine because the microphone
 * does NOT belong to the face. Each view owns its own mic — publishing the track
 * to LiveKit, holding the MediaStream, driving the VU meter — and they do not
 * share an implementation. So the face publishes its phase and the views that
 * have a microphone subscribe; the ones that do not simply never call this.
 *
 * Restoring is conditional on purpose. Sleep may only give back what it took:
 * someone who was already muted when she nodded off must not find their mic
 * live afterwards, which is a privacy failure rather than a cosmetic one.
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../../../store';

interface UseSleepMicrophoneOptions {
  /** The view's own mute state — store-backed or local, this hook does not care. */
  isMuted: boolean;
  /**
   * The view's existing mute toggle. Called only when the current state is the
   * opposite of what is wanted, so a plain toggle is safe to pass.
   */
  toggleMute: () => void | Promise<void>;
  /** Skip entirely when there is no session to have a microphone in. */
  enabled?: boolean;
}

export const useSleepMicrophone = ({
  isMuted,
  toggleMute,
  enabled = true
}: UseSleepMicrophoneOptions): void => {
  const phase = useStore((s) => s.faceSleepPhase);
  // Whether sleep is the reason the mic is off, and so whether waking owes it
  // back. A plain "unmute on wake" would hand a live mic to someone who muted
  // themselves before she went under.
  const owedRef = useRef(false);
  const prevPhaseRef = useRef(phase);
  // Read at transition time rather than closed over: the effect keys on the
  // phase alone, so re-running it whenever the mute state changes would fire
  // the transition again on the mute this hook had just performed.
  const liveRef = useRef({ isMuted, toggleMute, enabled });
  liveRef.current = { isMuted, toggleMute, enabled };

  useEffect(() => {
    const previous = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase === previous) return;

    const live = liveRef.current;
    if (!live.enabled) return;

    if (phase === 'asleep') {
      owedRef.current = !live.isMuted;
      if (!live.isMuted) void live.toggleMute();
      return;
    }

    // Coming round — including straight to 'awake', which is what the face
    // publishes when it unmounts. Unmuting here rather than at the end of the
    // wake is deliberate: acquiring a microphone is slow in the same way
    // acquiring a camera is, and the wake animation exists to cover both.
    if (previous === 'asleep' && owedRef.current) {
      owedRef.current = false;
      if (live.isMuted) void live.toggleMute();
    }
  }, [phase]);
};
