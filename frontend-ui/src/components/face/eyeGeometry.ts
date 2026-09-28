/**
 * Eye geometry (#face-emotions).
 *
 * The eye used to be a CSS circle with a vertical scale, which is why the face
 * could only ever look "more or less blinky". Nearly all of an emoji face's
 * expression lives in the LIDS — a straight edge cutting across the eye, and
 * the angle it cuts at — and a border-radius cannot cut anything.
 *
 * So the eye is drawn as an SVG ellipse seen through an aperture: a rotated
 * band bounded by an upper and a lower lid. Every expression is then a handful
 * of NUMBERS (how far each lid is down, what angle it sits at, how tall the eye
 * is), and numbers interpolate — which is what makes the transitions smooth
 * without any morphing machinery. Same approach the mouth has always used.
 *
 * The aperture is a clip path rather than lids painted in the background
 * colour, so this survives being drawn on something other than black.
 */

export interface EyeShape {
  /** 0 = wide open, 1 = shut. Upper lid, the expressive one. */
  lidUpper: number;
  /** 0 = wide open, 1 = shut. Lower lid — squints and smiling eyes. */
  lidLower: number;
  /**
   * Lid tilt in degrees, mirrored between the eyes.
   *
   * Positive drops the INNER corner (angry, suspicious); negative lifts it
   * (sad, pleading). This one parameter carries more expression than anything
   * else on the face, which is why "angry" and "sad" are otherwise so hard to
   * tell apart on a round eye.
   */
  lidAngle: number;
  /** Vertical stretch of the eye itself. >1 tall and startled, <1 flattened. */
  height: number;
  /**
   * Extra upper lid on ONE eye only, 0..1.
   *
   * Everything else here is symmetric, and symmetry is what keeps a face
   * reading as a diagram. One eye narrowed while the other stays open is the
   * single clearest "working something out" signal there is — and unlike a
   * brow it survives being seen from across a room.
   */
  lidAsymmetry: number;
}

export const NEUTRAL_EYE: EyeShape = {
  lidUpper: 0,
  lidLower: 0,
  lidAngle: 0,
  height: 1,
  lidAsymmetry: 0,
};

/** Blend two eye shapes — used to ease between expressions. */
export function mixEye(a: EyeShape, b: EyeShape, t: number): EyeShape {
  const m = (x: number, y: number) => x + (y - x) * t;
  return {
    lidUpper: m(a.lidUpper, b.lidUpper),
    lidLower: m(a.lidLower, b.lidLower),
    lidAngle: m(a.lidAngle, b.lidAngle),
    height: m(a.height, b.height),
    lidAsymmetry: m(a.lidAsymmetry, b.lidAsymmetry),
  };
}

/**
 * The visible aperture, as a polygon in the eye's local viewBox.
 *
 * Deliberately oversized horizontally: the ellipse supplies the outer edge, so
 * the polygon only has to carry the two lid lines. `mirror` flips the angle for
 * the other eye, so a tilt reads as one symmetric expression rather than two
 * eyes leaning the same way.
 */
export function aperturePolygon(
  shape: EyeShape,
  size: number,
  mirror: boolean
): string {
  const half = size / 2;
  const wide = size * 1.6; // well past the ellipse on both sides
  // A fully closed lid travels slightly past centre so the eye actually shuts.
  // The asymmetry lands on one eye only — `mirror` is true for the right one.
  const upperLid = shape.lidUpper + (mirror ? shape.lidAsymmetry : 0);
  const upper = -half + upperLid * (size * 0.56);
  const lower = half - shape.lidLower * (size * 0.56);
  const angle = ((mirror ? -shape.lidAngle : shape.lidAngle) * Math.PI) / 180;
  // Rotating the lid LINES rather than the whole eye keeps the eyeball round
  // while its opening tilts — which is what an eyelid actually does.
  const dy = Math.tan(angle) * wide * 0.5;
  const pts: [number, number][] = [
    [half - wide * 0.5, upper - dy],
    [half + wide * 0.5, upper + dy],
    [half + wide * 0.5, lower + dy],
    [half - wide * 0.5, lower - dy],
  ];
  return pts.map(([x, y]) => `${x.toFixed(2)},${(y + half).toFixed(2)}`).join(' ');
}
