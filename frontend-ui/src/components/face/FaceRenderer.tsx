/**
 * STELLA Face Renderer
 * Port from mobile client (stella-mobile-client/app/components/faces/defaultFace.tsx)
 * Renders eyes, eyebrows, and mouth using SVG
 */

import React, { useEffect, useRef } from 'react';
import { motion, useTransform } from 'framer-motion';
import type { FaceRendererProps, MouthEmotion, EyeEmotion } from './types';

// Constants (matching mobile client)
const EYE_SIZE = 220;
const IRIS_SIZE = EYE_SIZE * 0.8;
const PUPIL_SIZE_BASE = IRIS_SIZE * 0.35;
const MAX_PUPIL_OFFSET_X = ((IRIS_SIZE - PUPIL_SIZE_BASE) / 2) * 0.8;
const MAX_PUPIL_OFFSET_Y = MAX_PUPIL_OFFSET_X / 2;

const IRIS_COLOR = '#FFFFFF';
const PUPIL_COLOR = '#000000';
const REFLECTION_COLOR = '#FFFFFF';
const MOUTH_COLOR = '#B0B0B0';      // Light grey for softer appearance on black background
const EYEBROW_COLOR = '#B0B0B0';    // Light grey matching mouth
const EYEBROW_WIDTH = 180;
const EYEBROW_THICKNESS = 12;
const MOUTH_HEIGHT_BASE = 70;  // Increased from 50 for larger mouth

// Mouth expression shapes
const MOUTH_EXPRESSIONS: Record<MouthEmotion, { curvature: number; width: number; height: number }> = {
  neutral: { curvature: 0, width: 0.5, height: 1 },
  smile: { curvature: 1, width: 0.6, height: 0.8 },
  'big-smile': { curvature: 1.8, width: 0.9, height: 0.9 },
  frown: { curvature: -1.0, width: 0.5, height: 0.7 },
  sad: { curvature: -0.8, width: 0.4, height: 0.6 },
  open: { curvature: 0, width: 0.5, height: 1.8 },
  speaking: { curvature: 0, width: 0.6, height: 1.2 },
  'happy-speaking': { curvature: 0.6, width: 0.7, height: 1.2 },
  'sad-speaking': { curvature: -0.4, width: 0.5, height: 1.1 },
  'excited-speaking': { curvature: 1.0, width: 0.8, height: 1.3 },
  whistling: { curvature: 0, width: 0.3, height: 0.6 },
  snoring: { curvature: 0, width: 0.6, height: 1.8 },
  smirk: { curvature: 0.6, width: 0.4, height: 0.7 },
  pout: { curvature: -0.4, width: 0.3, height: 0.9 },
  grin: { curvature: 3.0, width: 0.6, height: 0.3 },
  'tongue-out': { curvature: 0.3, width: 0.7, height: 1.4 },
  nervous: { curvature: -0.3, width: 0.4, height: 0.7 },
  confident: { curvature: 0.8, width: 0.7, height: 0.8 },
  mischievous: { curvature: 0.8, width: 0.5, height: 0.8 },
  listening: { curvature: 0.4, width: 0.5, height: 0.8 }
};

// Eyebrow expression shapes
interface EyebrowShape {
  leftCurvature: number;
  rightCurvature: number;
  leftHeight: number;
  rightHeight: number;
}

const EYEBROW_EXPRESSIONS: Record<EyeEmotion, EyebrowShape> = {
  neutral: { leftCurvature: 0, rightCurvature: 0, leftHeight: 0, rightHeight: 0 },
  happy: { leftCurvature: 0.5, rightCurvature: 0.5, leftHeight: -3, rightHeight: -3 },
  excited: { leftCurvature: 0.7, rightCurvature: 0.7, leftHeight: -8, rightHeight: -8 },
  sleepy: { leftCurvature: -0.5, rightCurvature: -0.5, leftHeight: 5, rightHeight: 5 },
  surprised: { leftCurvature: 0.3, rightCurvature: 0.3, leftHeight: -15, rightHeight: -15 },
  focused: { leftCurvature: -0.3, rightCurvature: -0.3, leftHeight: 8, rightHeight: 8 },
  winking: { leftCurvature: 0.5, rightCurvature: 0, leftHeight: -8, rightHeight: 0 },
  rolling: { leftCurvature: 0, rightCurvature: 0, leftHeight: 0, rightHeight: 0 },
  wide: { leftCurvature: 0.4, rightCurvature: 0.4, leftHeight: -12, rightHeight: -12 },
  squinting: { leftCurvature: -0.6, rightCurvature: -0.6, leftHeight: 12, rightHeight: 12 },
  loving: { leftCurvature: 0.6, rightCurvature: 0.6, leftHeight: -5, rightHeight: -5 },
  listening: { leftCurvature: 0.2, rightCurvature: 0.2, leftHeight: -2, rightHeight: -2 }
};

// Helper function to clamp values
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Helper function to interpolate
const interpolate = (value: number, inputRange: number[], outputRange: number[]): number => {
  if (value <= inputRange[0]) return outputRange[0];
  if (value >= inputRange[inputRange.length - 1]) return outputRange[outputRange.length - 1];

  for (let i = 0; i < inputRange.length - 1; i++) {
    if (value >= inputRange[i] && value <= inputRange[i + 1]) {
      const t = (value - inputRange[i]) / (inputRange[i + 1] - inputRange[i]);
      return outputRange[i] + t * (outputRange[i + 1] - outputRange[i]);
    }
  }
  return outputRange[0];
};

// Calculate mouth SVG path using UNIFIED cubic bezier structure
// Path is always M -> C -> C -> Z to prevent glitches during transitions.
//
// Two independent axes drive the speaking shape:
//   mouthOpenness  — jaw drop (0 = closed, ~1 = fully open)
//   mouthSpread    — lip width (0 = narrow/rounded "oo", 1 = wide "ah"/"ee")
// The top lip moves less than the bottom lip (jaw drops, upper lip stays).
const calculateMouthPath = (
  mouthOpenness: number,
  mouthSpread: number,
  mouthEmotion: MouthEmotion,
  isSpeaking: boolean
): string => {
  const centerX = 110;
  const centerY = 45;

  const shape = MOUTH_EXPRESSIONS[mouthEmotion] || MOUTH_EXPRESSIONS.neutral;

  // --- Speaking dimensions ---
  // Height driven by openness
  const speakingBaseHeight = Math.max(shape.height * 35, 30);
  const openness = interpolate(
    mouthOpenness,
    [0, 0.05, 0.2, 0.5, 1.0],
    [0, 0.6, 1.2, 1.8, 2.4]
  );
  const speakingHeight = speakingBaseHeight * openness;

  // Width driven independently by spread
  const speakingBaseWidth = Math.max(shape.width * MOUTH_HEIGHT_BASE * 1.3, 48);
  const spreadFactor = interpolate(mouthSpread, [0, 0.5, 1.0], [0.65, 0.9, 1.15]);
  const speakingWidth = speakingBaseWidth * spreadFactor;

  // --- Non-speaking dimensions ---
  const smileWidth = Math.max(shape.width * MOUTH_HEIGHT_BASE * 1.0, 35);

  // Blend between speaking and non-speaking
  const talkingAmount = isSpeaking ? Math.min(mouthOpenness * 5, 1) : 0;

  const finalWidth = smileWidth + (speakingWidth - smileWidth) * talkingAmount;
  const radiusX = Math.max(finalWidth / 2, 18);

  // Vertical radii: top lip (small movement) vs bottom lip (big jaw drop)
  const speakingRadiusY = Math.max(speakingHeight / 2, 18);
  const smileRadiusY = 2;
  const totalRadiusY = smileRadiusY + (speakingRadiusY - smileRadiusY) * talkingAmount;

  // Asymmetric split: upper lip 40%, lower jaw 60%
  const topRadiusY = totalRadiusY * 0.4;
  const bottomRadiusY = totalRadiusY * 0.6;

  // Smile curvature (only when not talking)
  const smileCurveAmount = shape.curvature * 22 * (1 - talkingAmount);

  // Bezier factor: 0.552 approximates a circle, but for a wide-open mouth
  // we need higher values so the curve actually reaches the full radius height.
  // Blend from 0.552 (idle) toward 0.85 (speaking) for a rounder, fuller opening.
  const k = 0.552 + talkingAmount * 0.3;

  const startX = centerX - radiusX;
  const endX = centerX + radiusX;

  // --- Top curve (upper lip) ---
  const topCurveOffset = -topRadiusY * k * talkingAmount + smileCurveAmount;

  // --- Bottom curve (lower jaw) ---
  const bottomCurveOffset = bottomRadiusY * k * talkingAmount + smileCurveAmount;

  // Corner tension: when mouth is open wide, pull corners slightly inward
  // This prevents the "balloon" look and creates a more organic shape
  const cornerTension = talkingAmount * openness * 0.06;
  const topCpSpread = 0.3 + cornerTension; // control points move toward center
  const botCpSpread = 0.3 - cornerTension * 0.3; // bottom stays wider

  // Control points for top curve (upper lip, left to right)
  const topCp1X = startX + radiusX * topCpSpread;
  const topCp1Y = centerY + topCurveOffset;
  const topCp2X = endX - radiusX * topCpSpread;
  const topCp2Y = centerY + topCurveOffset;

  // Control points for bottom curve (lower jaw, right back to left)
  const botCp1X = endX - radiusX * botCpSpread;
  const botCp1Y = centerY + bottomCurveOffset;
  const botCp2X = startX + radiusX * botCpSpread;
  const botCp2Y = centerY + bottomCurveOffset;

  return `M ${startX} ${centerY} C ${topCp1X} ${topCp1Y} ${topCp2X} ${topCp2Y} ${endX} ${centerY} C ${botCp1X} ${botCp1Y} ${botCp2X} ${botCp2Y} ${startX} ${centerY} Z`;
};

// Calculate eyebrow SVG path
const calculateEyebrowPath = (
  curvature: number,
  heightOffset: number,
  isLeft: boolean
): string => {
  const centerX = 50;
  const baseY = 45;
  const eyebrowWidth = 80;

  const startX = centerX - eyebrowWidth / 2;
  const endX = centerX + eyebrowWidth / 2;

  const baseCurve = -10;
  const emotionCurve = curvature * 15;
  const controlY = baseY + baseCurve + emotionCurve + heightOffset * 0.5;

  return `M ${startX} ${baseY + heightOffset * 0.5} Q ${centerX} ${controlY} ${endX} ${baseY + heightOffset * 0.5}`;
};

const FaceRenderer: React.FC<FaceRendererProps> = ({
  size,
  gazeX,
  gazeY,
  headRotation,
  headPitch,
  faceScale,
  leftEyeScaleY,
  rightEyeScaleY,
  pupilDilation,
  mouthOpenness,
  mouthSpread,
  mouthEmotion,
  eyeEmotion,
  eyebrowHeight
}) => {
  const scale = size / 600; // Base size is 600px

  // Normalized gaze (-1..1) -> pixel offset within the iris. Both eyes share
  // one pair of transforms: they always look at the same thing, and deriving
  // them per eye would mean calling hooks inside the render helper.
  const pupilOffsetX = useTransform(gazeX, (v) =>
    clamp(v * MAX_PUPIL_OFFSET_X, -MAX_PUPIL_OFFSET_X, MAX_PUPIL_OFFSET_X) * scale
  );
  const pupilOffsetY = useTransform(gazeY, (v) =>
    clamp(v * MAX_PUPIL_OFFSET_Y, -MAX_PUPIL_OFFSET_Y, MAX_PUPIL_OFFSET_Y) * scale
  );

  // The mouth is written straight to the DOM from its MotionValues, never
  // through React. It used to be sampled with `.get()` during render, so it
  // only moved when something else re-rendered the face — at the store's audio
  // update rate, in visible steps. Framer's own 0.05s tween on the path then
  // smeared each step, which is what read as lag. Subscribing here gives the
  // mouth every frame of the spring that drives it.
  const pathRef = useRef<SVGPathElement | null>(null);
  const speakingRef = useRef(false);
  const ENTER_THRESHOLD = 0.15;  // Must exceed this to start showing oval
  const EXIT_THRESHOLD = 0.03;   // Must drop below this to show smile

  useEffect(() => {
    const draw = () => {
      const openness = mouthOpenness.get();
      const spread = mouthSpread?.get() ?? 0.5;
      // Hysteresis, held in a ref: crossing the threshold changes the SHAPE,
      // and routing that through state would re-render the whole face twice a
      // word for a value only this callback reads.
      if (!speakingRef.current && openness > ENTER_THRESHOLD) speakingRef.current = true;
      else if (speakingRef.current && openness < EXIT_THRESHOLD) speakingRef.current = false;
      pathRef.current?.setAttribute(
        'd',
        calculateMouthPath(openness, spread, mouthEmotion, speakingRef.current)
      );
    };
    draw();
    const unsubscribe = [mouthOpenness.on('change', draw)];
    if (mouthSpread) unsubscribe.push(mouthSpread.on('change', draw));
    return () => unsubscribe.forEach((u) => u());
  }, [mouthOpenness, mouthSpread, mouthEmotion]);

  const eyebrowShape = EYEBROW_EXPRESSIONS[eyeEmotion] || EYEBROW_EXPRESSIONS.neutral;
  const leftEyebrowPath = calculateEyebrowPath(
    eyebrowShape.leftCurvature,
    eyebrowShape.leftHeight + eyebrowHeight,
    true
  );
  const rightEyebrowPath = calculateEyebrowPath(
    eyebrowShape.rightCurvature,
    eyebrowShape.rightHeight + eyebrowHeight,
    false
  );

  const renderEye = (index: number) => {
    const eyeMotionValue = index === 0 ? leftEyeScaleY : rightEyeScaleY;
    const basePupilSize = PUPIL_SIZE_BASE * scale;
    const baseReflectionSize = PUPIL_SIZE_BASE * 0.3 * scale;

    return (
      <div
        key={index}
        className="flex flex-col items-center"
        style={{ marginLeft: index === 0 ? 0 : EYE_SIZE * 0.08 * scale }}
      >
        {/* Eyebrow */}
        <div style={{ width: EYEBROW_WIDTH * scale, height: 60 * scale, marginBottom: 0 }}>
          <svg width="100%" height="100%" viewBox="0 0 100 60">
            <motion.path
              d={index === 0 ? leftEyebrowPath : rightEyebrowPath}
              stroke={EYEBROW_COLOR}
              strokeWidth={EYEBROW_THICKNESS}
              strokeLinecap="round"
              fill="none"
              initial={false}
              animate={{ d: index === 0 ? leftEyebrowPath : rightEyebrowPath }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            />
          </svg>
        </div>

        {/* Eye — MotionValue style binding for 60fps smooth blinks */}
        <motion.div
          className="relative flex items-center justify-center overflow-hidden rounded-full"
          style={{
            width: EYE_SIZE * scale,
            height: EYE_SIZE * scale,
            backgroundColor: 'transparent',
            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
            scaleY: eyeMotionValue
          }}
        >
          {/* Iris */}
          <div
            className="relative flex items-center justify-center rounded-full"
            style={{
              width: IRIS_SIZE * scale,
              height: IRIS_SIZE * scale,
              backgroundColor: IRIS_COLOR
            }}
          >
            {/* Pupil Container — dilation applied as CSS scale for smooth animation */}
            <motion.div
              className="relative flex items-center justify-center"
              style={{
                width: basePupilSize,
                height: basePupilSize,
                x: pupilOffsetX,
                y: pupilOffsetY,
                scale: pupilDilation
              }}
            >
              {/* Pupil */}
              <div
                className="absolute rounded-full"
                style={{
                  width: basePupilSize,
                  height: basePupilSize,
                  backgroundColor: PUPIL_COLOR
                }}
              />

              {/* Reflection */}
              <div
                className="absolute rounded-full"
                style={{
                  width: baseReflectionSize,
                  height: baseReflectionSize,
                  backgroundColor: REFLECTION_COLOR,
                  top: `15%`,
                  left: `20%`,
                  opacity: 0.9
                }}
              />
            </motion.div>
          </div>
        </motion.div>
      </div>
    );
  };

  return (
    <motion.div
      className="flex flex-col items-center justify-center"
      style={{ rotate: headRotation, y: headPitch, scale: faceScale }}
    >
      {/* Eyes Row */}
      <div className="flex items-center" style={{ marginBottom: EYE_SIZE * 0.05 * scale }}>
        {renderEye(0)}
        {renderEye(1)}
      </div>

      {/* Mouth */}
      <div
        className="flex items-center justify-center"
        style={{
          width: 220 * scale,
          height: 90 * scale,
          marginTop: EYE_SIZE * -0.01 * scale
        }}
      >
        <svg width="100%" height="100%" viewBox="0 0 220 90">
          <path
            ref={pathRef}
            stroke={MOUTH_COLOR}
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>
    </motion.div>
  );
};

export default FaceRenderer;
