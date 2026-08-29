/**
 * STELLA Face Component
 * Composes tracking, involuntary eye machinery, behavior, and rendering.
 *
 * The continuous channels (gaze, head, eye scale, pupil) are MotionValues that
 * flow straight to the DOM; this component re-renders only for discrete changes
 * (audio level, emotion, eyebrow offset). See FaceRendererProps for why.
 */

import React, { useMemo } from 'react';
import { useTransform } from 'framer-motion';
import FaceRenderer from './FaceRenderer';
import { useFaceTracking } from './hooks/useFaceTracking';
import { useFaceAnimation } from './hooks/useFaceAnimation';
import { useMouthAnimation } from './hooks/useMouthAnimation';
import { useFaceBehavior } from './hooks/useFaceBehavior';
import { useStableDetection } from './hooks/useStableDetection';
import { useStore } from '../../store';
import { resolveExpression } from './animations/emotionRegistry';
import type { StellaFaceProps } from './types';

const StellaFace: React.FC<StellaFaceProps> = ({
  isUserSpeaking: isUserSpeakingProp,
  isRemoteSpeaking: isRemoteSpeakingProp,
  audioLevel = 0,
  eyeEmotion: eyeEmotionProp,
  mouthEmotion: mouthEmotionProp,
  size,
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
  const expression = useMemo(() => resolveExpression(cueExpression), [cueExpression]);

  const isUserSpeaking = isUserSpeakingProp ?? (!isMuted && isRecording);
  const isRemoteSpeaking = isRemoteSpeakingProp ?? storeIsRemoteSpeaking;

  // Face tracking (webcam only — no mouse fallback, see useFaceTracking)
  const { trackingData } = useFaceTracking({
    enableWebcam: true,
    smoothingFactor: 0.25
  });

  // One debounced answer to "is someone there", shared by every layer.
  const isGazeLocked = useStableDetection(trackingData.hasDetection);

  // Tracked gaze target. Mirrored on X so the face looks back at the person
  // rather than away from them.
  const trackedX = -(trackingData.position.x - 0.5) * 2;
  const trackedY = (trackingData.position.y - 0.5) * 2;

  // Involuntary eye machinery (blinks, widen, dilation)
  const { leftBlink, rightBlink, eyeWiden, pupilDilation, blink } = useFaceAnimation({
    isUserSpeaking,
    isGazeLocked
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
    eyebrowOffset
  } = useFaceBehavior({
    isUserSpeaking,
    isRemoteSpeaking,
    isGazeLocked,
    trackedX,
    trackedY,
    onBlink: blink,
    expression,
    gesture: faceGesture
  });

  // Mouth animation (audio-reactive with spring physics)
  // A cue outranks the caller's default, but an explicitly passed emotion (the
  // gallery, a preview) outranks the cue.
  const activeEyeEmotion = eyeEmotionProp ?? (cueExpression ? expression.eye : 'listening');
  // While talking, use the expression's OWN speaking variant rather than a
  // generic one — otherwise the emotion survives only in the pauses, and the
  // whole point is to express while speaking.
  const activeMouthEmotion =
    mouthEmotionProp ??
    (isRemoteSpeaking
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
    <div className={`flex items-center justify-center ${className}`}>
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
      />
    </div>
  );
};

export default StellaFace;
