/**
 * Tiny, genuinely generic numeric helpers shared across the engine -
 * kept separate from easingCurves.js (which is specifically about
 * shaping a 0-1 progress value) and keyframes.js (which is specifically
 * about sampling a value off a timeline).
 */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(t) {
  return clamp(t, 0, 1);
}

/** Per-component lerp for vectors (arrays of numbers) of equal length. */
function lerpVector(a, b, t) {
  return a.map((av, i) => lerp(av, b[i], t));
}

/**
 * Shortest-path angle interpolation (radians). Plain lerp(a,b,t) on two
 * angles breaks near the +-PI wrap (e.g. 179deg -> -179deg would lerp
 * the LONG way around through 0deg instead of the true 2deg short way)
 * - this normalizes the delta into (-PI, PI] first so it always takes
 * the shorter arc. Used anywhere an angle itself (not a plain scalar)
 * is being blended: path tangents (textPath.js) and wiggly-selector
 * phase correlation (selectors.js).
 */
function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

module.exports = { lerp, clamp, clamp01, lerpVector, lerpAngle };
