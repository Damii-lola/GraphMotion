/**
 * Standard easing functions (formulas from easings.net). Each takes
 * t in [0, 1] and returns the eased progress, also generally in [0, 1]
 * (easeOutBack briefly overshoots past 1, by design - that's the
 * "spring" feel used throughout the templates).
 */

function linear(t) {
  return t;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
  return t * t * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function easeInExpo(t) {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Linearly interpolates between a and b using an eased t.
 * lerp(0, 100, easeOutCubic(0.5)) etc.
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Clamps t into [0, 1] - used constantly when computing a sub-range's
 * local progress from a scene's overall local time (e.g. "the entrance
 * animation is the first 30% of this scene's duration").
 */
function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

module.exports = {
  linear,
  easeOutCubic,
  easeInCubic,
  easeInOutCubic,
  easeOutExpo,
  easeInExpo,
  easeOutBack,
  lerp,
  clamp01,
};
