/**
 * STELLA Face Component Types
 * Port from mobile client with web-specific adaptations
 */

import type { MotionValue } from 'framer-motion';
import type { EyeShape } from './eyeGeometry';

export type EyeEmotion =
  | 'neutral'
  | 'happy'
  | 'excited'
  | 'sleepy'
  | 'surprised'
  | 'focused'
  | 'winking'
  | 'rolling'
  | 'wide'
  | 'squinting'
  | 'loving'
  | 'listening';

export type MouthEmotion =
  | 'neutral'
  | 'smile'
  | 'big-smile'
  | 'frown'
  | 'sad'
  | 'open'
  | 'speaking'
  | 'happy-speaking'
  | 'sad-speaking'
  | 'excited-speaking'
  | 'whistling'
  | 'snoring'
  | 'smirk'
  | 'pout'
  | 'grin'
  | 'tongue-out'
  | 'nervous'
  | 'confident'
  | 'mischievous'
  | 'listening';

export interface FacePosition {
  x: number;
  y: number;
}

export interface FaceTrackingData {
  position: FacePosition;
  hasDetection: boolean;
  method: 'webcam' | 'none';
}

export interface StellaFaceProps {
  isUserSpeaking?: boolean;
  isRemoteSpeaking?: boolean;
  audioLevel?: number; // 0.0 to 1.0
  eyeEmotion?: EyeEmotion;
  mouthEmotion?: MouthEmotion;
  size?: number; // Face size in pixels (default: responsive)
  /**
   * Preview only (#face-sleep). Production never passes this.
   *
   * Waiting out a real 30 seconds of being invisible to the camera — while
   * sitting in front of it, to click the result — is not a workable way to look
   * at the sleep and wake animations, which is the only reason this exists.
   */
  sleep?: {
    /** Override the 30s countdown. */
    afterMs?: number;
    /** Run the countdown regardless of who is visible or whether the camera works. */
    force?: boolean;
  };
  className?: string;
}


/**
 * Everything the renderer needs, split by update rate.
 *
 * The CONTINUOUS channels (gaze, head, eye scale, pupil dilation) are
 * MotionValues written by the behavior loop, so they reach the DOM without a
 * React render. This is not an optimization detail — it is load-bearing: the
 * face only re-renders on discrete events (audio level, emotion, detection),
 * and with no webcam permission those can stop entirely. Passing plain numbers
 * would freeze the idle animation on whatever frame rendered last.
 *
 * The DISCRETE channels (emotions, eyebrow offset, mouth openness) stay plain
 * values — they change a few times a second at most and Framer's own
 * transitions smooth them in the renderer.
 */
export interface FaceRendererProps {
  size: number;
  /** Composed pupil offset, -1 to 1 (tracked gaze + idle wander + gesture). */
  gazeX: MotionValue<number>;
  gazeY: MotionValue<number>;
  /** Head roll in degrees. */
  headRotation: MotionValue<number>;
  /** Vertical head movement in px — the nod axis. */
  headPitch: MotionValue<number>;
  /** Whole-face scale, for lean-in. */
  faceScale: MotionValue<number>;
  /** Per-eye vertical scale — blinks, winks, and the anticipation pop. */
  leftEyeScaleY: MotionValue<number>;
  rightEyeScaleY: MotionValue<number>;
  /** Pupil scale multiplier (1.0 = resting, larger = dilated). */
  pupilDilation: MotionValue<number>;
  /** Jaw drop, 0.0-1.0. A MotionValue: the mouth is drawn every frame from the
   *  spring that drives it, never sampled at React's render rate. */
  mouthOpenness: MotionValue<number>;
  /** Lip width, 0.0 (narrow) to 1.0 (wide). */
  mouthSpread?: MotionValue<number>;
  mouthEmotion: MouthEmotion;
  eyeEmotion: EyeEmotion;
  eyebrowHeight: number; // -5 to 5 pixels
  /** Lid position, tilt and eye height — where most of the expression lives. */
  eyeShape: EyeShape;
  /** Brow tilt in degrees; positive drops the inner ends (cross), negative lifts them (sad). */
  browAngle?: number;
  /** Raise one brow relative to the other, in px — the "hmm" signal. */
  browAsymmetry?: number;
  /**
   * How much the drawn sleeping lid shows, 0..1 (#face-sleep).
   *
   * Sleep shuts the eye all the way, which makes it disappear rather than look
   * closed, so a lid is drawn in its place and cross-faded against it.
   */
  sleepClosed?: MotionValue<number>;
  /** Float the "z"s. Discrete — it changes twice a sleep, not per frame. */
  showZzz?: boolean;
  /**
   * Push the brows down the face, in px (#face-sleep).
   *
   * Separate from `eyebrowHeight` because that one is baked into the brow's own
   * path and then HALVED, so it runs out of room and starts clipping against
   * the edge of the brow viewBox long before the brow is anywhere near the
   * eye. This translates the whole brow instead, which has no such ceiling.
   */
  browDrop?: number;
}

export interface UseFaceTrackingOptions {
  enableWebcam?: boolean;
  smoothingFactor?: number; // LERP factor (0 to 1)
}

export interface UseMouthAnimationOptions {
  audioLevel: number;
  isRemoteSpeaking: boolean;
  emotion: MouthEmotion;
  smoothingFactor?: number;
}

// Visualizer types for the face modal gallery
export type VisualizerType =
  | 'face'
  | 'sphere'
  | 'galaxy'
  | 'rainy'
  | 'snowy'
  | 'christmas'
  | 'sunny';

// Standard props all visualizers receive
export interface VisualizerProps {
  audioLevel: number;
  isRemoteSpeaking: boolean;
  isUserSpeaking?: boolean;
}

export interface VisualizerConfig {
  id: VisualizerType;
  name: string;
  description: string;
  previewBg: string;
  checkmarkColor: string;
}

export const VISUALIZER_CONFIGS: VisualizerConfig[] = [
  {
    id: 'face',
    name: 'Face',
    description: 'Animated SVG face',
    previewBg: 'bg-black',
    checkmarkColor: 'bg-violet-400',
  },
  {
    id: 'sphere',
    name: 'Sphere',
    description: 'Glowing orb',
    previewBg: 'bg-gradient-to-br from-slate-950 via-violet-950 to-slate-900',
    checkmarkColor: 'bg-violet-400',
  },
  {
    id: 'galaxy',
    name: 'Galaxy',
    description: 'Starry night sky',
    previewBg: 'bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950',
    checkmarkColor: 'bg-purple-400',
  },
  {
    id: 'rainy',
    name: 'Rainy',
    description: 'Falling raindrops',
    previewBg: 'bg-gradient-to-b from-slate-700 via-slate-800 to-slate-900',
    checkmarkColor: 'bg-slate-400',
  },
  {
    id: 'snowy',
    name: 'Snowy',
    description: 'Winter wonderland',
    previewBg: 'bg-gradient-to-b from-slate-300 via-slate-200 to-slate-100',
    checkmarkColor: 'bg-slate-400',
  },
  {
    id: 'christmas',
    name: 'Christmas',
    description: 'Festive lights',
    previewBg: 'bg-gradient-to-b from-slate-900 via-green-950 to-red-950',
    checkmarkColor: 'bg-yellow-400',
  },
  {
    id: 'sunny',
    name: 'Sunny',
    description: 'Bright blue sky',
    previewBg: 'bg-gradient-to-b from-sky-200 via-sky-100 to-emerald-100',
    checkmarkColor: 'bg-amber-400',
  },
];
