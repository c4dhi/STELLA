/**
 * STELLA Face Component
 * Composes tracking, involuntary eye machinery, behavior, and rendering.
 *
 * The continuous channels (gaze, head, eye scale, pupil) are MotionValues that
 * flow straight to the DOM; this component re-renders only for discrete changes
 * (audio level, emotion, eyebrow offset). See FaceRendererProps for why.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTransform } from 'framer-motion';
import FaceRenderer from './FaceRenderer';
import { useFaceTracking } from './hooks/useFaceTracking';
import { useFaceAnimation } from './hooks/useFaceAnimation';
import { useMouthAnimation } from './hooks/useMouthAnimation';
import { useFaceBehavior } from './hooks/useFaceBehavior';
import { useStableDetection } from './hooks/useStableDetection';
import { useSleepState } from './hooks/useSleepState';
import { useStore } from '../../store';
import { resolveExpression, eyeShapeOf, resolveState, SLEEP_POSE } from './animations/emotionRegistry';
import type { StellaFaceProps } from './types';

const StellaFace: React.FC<StellaFaceProps> = ({
  isUserSpeaking: isUserSpeakingProp,
  isRemoteSpeaking: isRemoteSpeakingProp,
  audioLevel = 0,
  eyeEmotion: eyeEmotionProp,
  mouthEmotion: mouthEmotionProp,
  size,
  sleep,
  className = ''
}) => {
  // Derive isUserSpeaking from Zustand store if not passed as prop
  const isMuted = useStore((s) => s.isMuted);
  const isRecording = useStore((s) => s.isRecording);
  const storeIsRemoteSpeaking = useStore((s) => s.isRemoteSpeaking);

  // Emotion tags (#face-emotions). Resolved by whichever view owns the
  // teleprompter cursor and published to the store, because the face renders in
  // a sibling subtree. Explicit props still win, so the gallery and previews can
  // pin an expression without a session running.
  const cueExpression = useStore((s) => s.faceExpression);
  const faceGesture = useStore((s) => s.faceGesture);
  // `[sleep]` off the wire (#face-sleep). Only the seq matters — resolveState
  // drops a state tag this client has never heard of, the same way an unknown
  // expression falls back to rest rather than throwing.
  const faceState = useStore((s) => s.faceState);
  const sleepCommandSeq =
    faceState && resolveState(faceState.tag) === 'sleep' ? faceState.seq : 0;
  const expression = useMemo(() => resolveExpression(cueExpression), [cueExpression]);
  // Lid shape and brow tilt change per cue, not per frame, so they cross the
  // React boundary as plain values and Framer tweens them in the renderer.
  const eyeShape = useMemo(() => eyeShapeOf(expression), [expression]);

  const isUserSpeaking = isUserSpeakingProp ?? (!isMuted && isRecording);
  const isRemoteSpeaking = isRemoteSpeakingProp ?? storeIsRemoteSpeaking;

  // Sleep (#face-sleep). The camera is released outright while she is out, so
  // the phase has to gate tracking rather than merely dim the animation.
  //
  // It reaches useFaceTracking through state rather than directly, because the
  // two hooks need each other: sleep decides whether the camera runs, and the
  // camera decides whether there is anyone to stay awake for. Routing one
  // direction through a render breaks the cycle, and a single extra render on a
  // transition that happens twice a sleep costs nothing.
  const [cameraEnabled, setCameraEnabled] = useState(true);

  // Face tracking (webcam only — no mouse fallback, see useFaceTracking)
  const { trackingData, isWebcamActive } = useFaceTracking({
    enableWebcam: cameraEnabled,
    smoothingFactor: 0.25
  });

  // One debounced answer to "is someone there", shared by every layer.
  const isGazeLocked = useStableDetection(trackingData.hasDetection);

  const { phase: sleepPhase, isYawning, wake } = useSleepState({
    isPresent: isGazeLocked,
    isUserSpeaking,
    isRemoteSpeaking,
    cameraActive: isWebcamActive,
    sleepAfterMs: sleep?.afterMs,
    force: sleep?.force,
    sleepCommandSeq
  });

  useEffect(() => {
    // Raised the moment the wake BEGINS, not when it ends: reacquiring the
    // camera is the slow part, and the wake animation runs for as long as it
    // does precisely to cover it.
    setCameraEnabled(sleepPhase !== 'asleep');
  }, [sleepPhase]);

  // Publish the phase for whoever owns the microphone (see useSleepMicrophone).
  const setFaceSleepPhase = useStore((s) => s.setFaceSleepPhase);
  useEffect(() => {
    setFaceSleepPhase(sleepPhase);
  }, [sleepPhase, setFaceSleepPhase]);
  // A view closed on a sleeping face must not leave the phase stuck at
  // 'asleep', which would hold that session's microphone shut with no face on
  // screen to explain why, and nothing left to tap to undo it.
  useEffect(() => () => setFaceSleepPhase('awake'), [setFaceSleepPhase]);

  const isAsleep = sleepPhase === 'asleep';

  // Tracked gaze target. Mirrored on X so the face looks back at the person
  // rather than away from them.
  const trackedX = -(trackingData.position.x - 0.5) * 2;
  const trackedY = (trackingData.position.y - 0.5) * 2;

  // Involuntary eye machinery (blinks, widen, dilation)
  const { leftBlink, rightBlink, eyeWiden, pupilDilation, blink } = useFaceAnimation({
    isUserSpeaking,
    isGazeLocked,
    isAsleep
  });

  // Gaze + idle + gesture layers (single RAF loop)
  const {
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
  } = useFaceBehavior({
    isUserSpeaking,
    isRemoteSpeaking,
    isGazeLocked,
    trackedX,
    trackedY,
    onBlink: blink,
    expression,
    gesture: faceGesture,
    sleepPhase
  });

  // Mouth animation (audio-reactive with spring physics)
  // A cue outranks the caller's default, but an explicitly passed emotion (the
  // gallery, a preview) outranks the cue.
  // Asleep, the brows go with the mouth: 'sleepy' is the one eye emotion whose
  // brow shape droops, and a slack mouth under level brows reads as vacant
  // rather than asleep. It carries into the first part of the wake, so the
  // brows are still heavy while she is stirring.
  const activeEyeEmotion =
    eyeEmotionProp ?? (isYawning ? 'sleepy' : cueExpression ? expression.eye : 'listening');
  // While talking, use the expression's OWN speaking variant rather than a
  // generic one — otherwise the emotion survives only in the pauses, and the
  // whole point is to express while speaking.
  const activeMouthEmotion =
    mouthEmotionProp ??
    (isYawning
      ? 'snoring'
      : isRemoteSpeaking
        ? cueExpression
          ? expression.mouthSpeaking ?? 'speaking'
          : 'speaking'
        : cueExpression
          ? expression.mouth
          : 'smile');

  const { mouthOpenness, mouthSpread } = useMouthAnimation({
    audioLevel,
    isRemoteSpeaking,
    emotion: activeMouthEmotion,
    smoothingFactor: 0.5
  });

  // Final lid scale per eye: blink × attention widen × anticipation pop. The
  // last two were previously computed and then discarded by the renderer, so
  // the pop on the agent starting to speak never actually showed.
  const leftEyeScaleY = useTransform(
    [leftBlink, eyeWiden, anticipation, lidLeft],
    ([lid, widen, pop, gestureLid]: number[]) => lid * widen * pop * gestureLid
  );
  const rightEyeScaleY = useTransform(
    [rightBlink, eyeWiden, anticipation, lidRight],
    ([lid, widen, pop, gestureLid]: number[]) => lid * widen * pop * gestureLid
  );

  // Expressions may dilate the pupils on top of the gaze-lock dilation.
  const pupilScale = useTransform(pupilDilation, (v) => v * (expression.pupil ?? 1));

  // Calculate responsive size
  const faceSize = useMemo(() => {
    if (size) return size;
    if (typeof window !== 'undefined') {
      const minDimension = Math.min(window.innerWidth, window.innerHeight);
      if (minDimension < 768) return 500;
      if (minDimension < 1024) return 650;
      return 800;
    }
    return 650;
  }, [size]);

  return (
    // Tap or touch to wake. Bound unconditionally — `wake` is a no-op unless she
    // is actually asleep — and deliberately passive: it neither swallows the
    // event nor preventDefaults, so it cannot interfere with whatever the face
    // happens to be sitting inside.
    <div
      className={`flex items-center justify-center ${isAsleep ? 'cursor-pointer' : ''} ${className}`}
      style={{ touchAction: 'manipulation' }}
      onPointerDown={wake}
    >
      <FaceRenderer
        size={faceSize}
        gazeX={gazeX}
        gazeY={gazeY}
        headRotation={headRotation}
        headPitch={headPitch}
        faceScale={faceScale}
        leftEyeScaleY={leftEyeScaleY}
        rightEyeScaleY={rightEyeScaleY}
        pupilDilation={pupilScale}
        mouthOpenness={mouthOpenness}
        mouthSpread={mouthSpread}
        mouthEmotion={activeMouthEmotion}
        eyeEmotion={activeEyeEmotion}
        eyebrowHeight={eyebrowOffset}
        eyeShape={eyeShape}
        browAngle={expression.browAngle ?? 0}
        browAsymmetry={expression.browAsymmetry ?? 0}
        sleepClosed={sleepClosed}
        showZzz={isAsleep}
        browDrop={isYawning ? SLEEP_POSE.browDrop : 0}
      />
    </div>
  );
};

export default StellaFace;
