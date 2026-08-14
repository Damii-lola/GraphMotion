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

module.exports = { lerp, clamp, clamp01, lerpVector };
