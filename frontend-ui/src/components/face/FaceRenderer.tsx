/**
 * STELLA Face Renderer
 * Port from mobile client (stella-mobile-client/app/components/faces/defaultFace.tsx)
 * Renders eyes, eyebrows, and mouth using SVG
 */

import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useTransform } from 'framer-motion';
import { aperturePolygon } from './eyeGeometry';
import type { FaceRendererProps, MouthEmotion, EyeEmotion } from './types';

// Constants (matching mobile client)
const EYE_SIZE = 220;
const IRIS_SIZE = EYE_SIZE * 0.8;
const PUPIL_SIZE_BASE = IRIS_SIZE * 0.35;
const MAX_PUPIL_OFFSET_X = ((IRIS_SIZE - PUPIL_SIZE_BASE) / 2) * 0.8;
// Vertical travel used to be HALF the horizontal, which flattened every
// circular gaze path into a 2:1 ellipse — an eye roll physically could not look
// round. There is room for it: the pupil can move (IRIS - PUPIL)/2 in any
// direction, and this stays inside that. Still slightly less than horizontal,
// which is true of real eyes.
const MAX_PUPIL_OFFSET_Y = MAX_PUPIL_OFFSET_X * 0.72;

const IRIS_COLOR = '#FFFFFF';
const PUPIL_COLOR = '#000000';
const REFLECTION_COLOR = '#FFFFFF';
const MOUTH_COLOR = '#B0B0B0';      // Light grey for softer appearance on black background
const EYEBROW_COLOR = '#B0B0B0';    // Light grey matching mouth
const EYEBROW_WIDTH = 180;
const EYEBROW_THICKNESS = 12;
const MOUTH_HEIGHT_BASE = 70;  // Increased from 50 for larger mouth

// The lid drawn across a sleeping eye (#face-sleep).
//
// It bows upward, because that is the line a lash follows over the curve of the
// eye — but only JUST. How far it bows is the entire difference between a
// resting eye and a shut one: squeezing your eyes closed is exactly what pulls
// that line into a pronounced arch, so drawing a deep one reads as an awake
// face forcing its eyes shut rather than a sleeping face letting them fall.
// At this depth it is nearly a straight line, which is what a relaxed lid is.
//
// It also has to stay clearly shallower than the eyebrow above it. Two arcs of
// the same curvature stacked on top of each other read as one scrunching
// gesture, whatever either of them is doing on its own.
const SLEEP_LID_SPAN = 168;      // how far across the eye the lid runs
const SLEEP_LID_ARC = 9;         // how far the middle rises above the ends
const SLEEP_LID_THICKNESS = 14;

/** One "z" every ZZZ_CYCLE_S / 3 seconds, each taking the full cycle to rise.
 *  Slow on purpose — the drift has to read as slower than breathing. */
const ZZZ_CYCLE_S = 6.4;
const ZZZ_DELAYS = [0, ZZZ_CYCLE_S / 3, (ZZZ_CYCLE_S * 2) / 3];

// Mouth expression shapes
// `rest` is how open the mouth is with NO audio driving it, 0..1.
//
// It exists because the resting mouth was a flat line by construction: every
// opening term in calculateMouthPath was multiplied by how loudly the agent was
// talking, so `open` could only ever render as an oval mid-syllable. A silent
// surprised face had the same thin dash as a neutral one.
const MOUTH_EXPRESSIONS: Record<
  MouthEmotion,
  { curvature: number; width: number; height: number; rest?: number }
> = {
  neutral: { curvature: 0, width: 0.5, height: 1 },
  smile: { curvature: 1, width: 0.6, height: 0.8 },
  'big-smile': { curvature: 1.8, width: 0.9, height: 0.9 },
  frown: { curvature: -1.0, width: 0.5, height: 0.7 },
  sad: { curvature: -0.8, width: 0.4, height: 0.6 },
  open: { curvature: 0, width: 0.55, height: 1.8, rest: 0.85 },
  speaking: { curvature: 0, width: 0.6, height: 1.2 },
  'happy-speaking': { curvature: 0.6, width: 0.7, height: 1.2 },
  'sad-speaking': { curvature: -0.4, width: 0.5, height: 1.1 },
  'excited-speaking': { curvature: 1.0, width: 0.8, height: 1.3 },
  whistling: { curvature: 0, width: 0.3, height: 0.6 },
  snoring: { curvature: 0, width: 0.6, height: 1.8, rest: 0.7 },
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
  // How open the mouth is overall — whichever is greater, the voice or the
  // expression's own resting aperture.
  const restOpen = shape.rest ?? 0;
  const openAmount = Math.max(talkingAmount, restOpen);

  const finalWidth = smileWidth + (speakingWidth - smileWidth) * talkingAmount;
  const radiusX = Math.max(finalWidth / 2, 18);

  // Vertical radii: top lip (small movement) vs bottom lip (big jaw drop)
  const speakingRadiusY = Math.max(speakingHeight / 2, 18);
  const smileRadiusY = 2;
  const restRadiusY = smileRadiusY + restOpen * 26;
  const totalRadiusY = Math.max(
    restRadiusY,
    smileRadiusY + (speakingRadiusY - smileRadiusY) * talkingAmount
  );

  // Asymmetric split: upper lip 40%, lower jaw 60%
  const topRadiusY = totalRadiusY * 0.4;
  const bottomRadiusY = totalRadiusY * 0.6;

  // Smile curvature (only when not talking)
  const smileCurveAmount = shape.curvature * 22 * (1 - openAmount);

  // Bezier factor: 0.552 approximates a circle, but for a wide-open mouth
  // we need higher values so the curve actually reaches the full radius height.
  // Blend from 0.552 (idle) toward 0.85 (speaking) for a rounder, fuller opening.
  const k = 0.552 + openAmount * 0.3;

  const startX = centerX - radiusX;
  const endX = centerX + radiusX;

  // --- Top curve (upper lip) ---
  const topCurveOffset = -topRadiusY * k * openAmount + smileCurveAmount;

  // --- Bottom curve (lower jaw) ---
  const bottomCurveOffset = bottomRadiusY * k * openAmount + smileCurveAmount;

  // Corner tension: when mouth is open wide, pull corners slightly inward
  // This prevents the "balloon" look and creates a more organic shape
  const cornerTension = openAmount * openness * 0.06;
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
  eyebrowHeight,
  eyeShape,
  browAngle = 0,
  browAsymmetry = 0,
  sleepClosed,
  showZzz = false,
  browDrop = 0
}) => {
  const scale = size / 600; // Base size is 600px

  // Normalized gaze (-1..1) -> pixel offset within the iris. Both eyes share
  // one pair of transforms: they always look at the same thing, and deriving
  // them per eye would mean calling hooks inside the render helper.
  // In viewBox units: the eye SVG scales itself, so these must NOT be
  // multiplied by `scale` the way the old absolutely-positioned pupil was.
  const pupilOffsetX = useTransform(gazeX, (v) =>
    clamp(v * MAX_PUPIL_OFFSET_X, -MAX_PUPIL_OFFSET_X, MAX_PUPIL_OFFSET_X)
  );
  const pupilOffsetY = useTransform(gazeY, (v) =>
    clamp(v * MAX_PUPIL_OFFSET_Y, -MAX_PUPIL_OFFSET_Y, MAX_PUPIL_OFFSET_Y)
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
  // Asymmetry lifts ONE brow. Two level brows read as neutral no matter what
  // the eyes are doing, which is why a symmetric "hmm" never lands.
  const leftEyebrowPath = calculateEyebrowPath(
    eyebrowShape.leftCurvature,
    eyebrowShape.leftHeight + eyebrowHeight - browAsymmetry,
    true
  );
  const rightEyebrowPath = calculateEyebrowPath(
    eyebrowShape.rightCurvature,
    eyebrowShape.rightHeight + eyebrowHeight,
    false
  );

  const renderEye = (index: number) => {
    const eyeMotionValue = index === 0 ? leftEyeScaleY : rightEyeScaleY;
    const mirrored = index === 1;
    // The aperture carries the expression; the wrapper's scaleY carries the
    // blink. Keeping them separate is what lets a blink happen DURING an
    // expression without either one having to know about the other.
    const aperture = aperturePolygon(eyeShape, EYE_SIZE, mirrored);
    const irisRadius = (IRIS_SIZE / 2) * eyeShape.height;
    const half = EYE_SIZE / 2;
    // Inner ends down = angry, up = sad. Mirrored so the pair reads as one
    // expression rather than as two eyes leaning the same way.
    const browRotation = (mirrored ? -1 : 1) * browAngle;

    return (
      <div
        key={index}
        className="flex flex-col items-center"
        style={{ marginLeft: index === 0 ? 0 : EYE_SIZE * 0.08 * scale }}
      >
        {/* Eyebrow — rotated on the wrapper, because the ANGLE of a brow is
            most of what separates cross from sad on an otherwise round face. */}
        <motion.div
          style={{ width: EYEBROW_WIDTH * scale, height: 60 * scale, marginBottom: 0 }}
          animate={{ rotate: browRotation, y: browDrop * scale }}
          transition={{ duration: 0.35, ease: 'easeInOut' }}
        >
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
        </motion.div>

        {/* Eye. The wrapper below carries the 60fps blink; the closed sleeping
            lid is a SIBLING of it, because anything inside gets flattened by
            the same scaleY that shuts the eye. */}
        <div
          style={{
            position: 'relative',
            width: EYE_SIZE * scale,
            height: EYE_SIZE * scale
          }}
        >
          <motion.div
            style={{
              width: '100%',
              height: '100%',
              scaleY: eyeMotionValue
            }}
          >
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${EYE_SIZE} ${EYE_SIZE}`}
              style={{ overflow: 'visible' }}
            >
              <defs>
                <clipPath id={`stella-eye-aperture-${index}`}>
                  {/* Animating the points string tweens the lids between
                      expressions — the same trick the mouth and brows already use
                      for `d`, so no morphing library is involved. */}
                  <motion.polygon
                    points={aperture}
                    initial={false}
                    animate={{ points: aperture }}
                    transition={{ duration: 0.35, ease: 'easeInOut' }}
                  />
                </clipPath>
              </defs>

              <g clipPath={`url(#stella-eye-aperture-${index})`}>
                <motion.ellipse
                  cx={half}
                  cy={half}
                  rx={IRIS_SIZE / 2}
                  /* Static value as well as the animated one: without it the very
                     first paint has no `ry` at all, SVG falls back to `auto` (a
                     circle), and the eye pops from round to its real height. */
                  ry={irisRadius}
                  fill={IRIS_COLOR}
                  initial={false}
                  animate={{ ry: irisRadius }}
                  transition={{ duration: 0.35, ease: 'easeInOut' }}
                />
                <motion.g style={{ x: pupilOffsetX, y: pupilOffsetY, scale: pupilDilation }}>
                  <circle cx={half} cy={half} r={PUPIL_SIZE_BASE / 2} fill={PUPIL_COLOR} />
                  <circle
                    cx={half - PUPIL_SIZE_BASE * 0.22}
                    cy={half - PUPIL_SIZE_BASE * 0.24}
                    r={PUPIL_SIZE_BASE * 0.15}
                    fill={REFLECTION_COLOR}
                    opacity={0.9}
                  />
                </motion.g>
              </g>
            </svg>
          </motion.div>

          {sleepClosed && (
            <motion.svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${EYE_SIZE} ${EYE_SIZE}`}
              style={{
                position: 'absolute',
                inset: 0,
                opacity: sleepClosed,
                pointerEvents: 'none',
                overflow: 'visible'
              }}
            >
              <path
                d={`M ${half - SLEEP_LID_SPAN / 2} ${half} Q ${half} ${half - SLEEP_LID_ARC} ${half + SLEEP_LID_SPAN / 2} ${half}`}
                stroke={IRIS_COLOR}
                strokeWidth={SLEEP_LID_THICKNESS}
                strokeLinecap="round"
                fill="none"
              />
            </motion.svg>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="relative flex flex-col items-center justify-center">
      {/* Floating "z"s (#face-sleep). Outside the head transform on purpose:
          they are drifting away from her, so tilting and bobbing with the head
          would glue them to it and break the illusion that they have left. */}
      <AnimatePresence>
        {showZzz && (
          <motion.div
            className="absolute"
            // Clear of the head, off the upper right. There is not much room to
            // play with: any lower and the first z fades in on top of the
            // eyebrow, which reads as a glitch in the face rather than as
            // something drifting off it. What buys the space is the brows
            // dropping while she sleeps — see SLEEP_POSE.browDrop.
            style={{ left: '82%', top: '3%', pointerEvents: 'none' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.4 } }}
          >
            {ZZZ_DELAYS.map((delay, i) => (
              <motion.span
                key={i}
                className="absolute select-none"
                style={{
                  color: MOUTH_COLOR,
                  fontSize: 44 * scale,
                  fontWeight: 300,
                  lineHeight: 1
                }}
                initial={{ opacity: 0, x: 0, y: 0, scale: 0.5 }}
                animate={{
                  // Rising, drifting aside and swelling as it goes, then gone.
                  // The fade has to finish BEFORE the top of the travel, or the
                  // z appears to stop dead rather than to dissipate.
                  opacity: [0, 0.85, 0.85, 0],
                  x: [0, 18 * scale, 40 * scale],
                  y: [0, -120 * scale],
                  scale: [0.5, 1.25]
                }}
                transition={{
                  duration: ZZZ_CYCLE_S,
                  // Staggered rather than randomised: three z's on one timer
                  // read as a repeating asset, and randomising each cycle makes
                  // the spacing lurch. A fixed offset is what "drifting" is.
                  delay,
                  repeat: Infinity,
                  repeatDelay: 0,
                  ease: 'easeOut'
                }}
              >
                z
              </motion.span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

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
    </div>
  );
};

export default FaceRenderer;
