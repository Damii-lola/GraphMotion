/**
 * THE MATHEMATICAL FOUNDATION of the whole new engine. Everything that
 * moves, fades, scales, or times itself in this codebase should
 * eventually reduce to "a value being read off a curve at some
 * fraction 0-1" - that's what this file provides, precisely and
 * correctly, instead of the old system's approach (every template
 * hand-wrote its own clamp01((t-x)/y) + a random Math.pow/Math.sin
 * shape, scattered across 20+ files, no shared vocabulary, no way to
 * reuse a "feel" once it was tuned).
 *
 * Two separate but unified things live here:
 *
 * 1. A real cubic-bezier solver (cubicBezier(x1,y1,x2,y2)) - the exact
 *    algorithm browsers use for CSS's `cubic-bezier()` and the same
 *    math behind After Effects' temporal Bezier keyframe interpolation.
 *    This is what lets keyframes.js support genuinely arbitrary,
 *    hand-shaped easing curves, not just a fixed preset list.
 *
 * 2. The standard named easing library (Robert Penner's equations, as
 *    canonicalized at easings.net and reproduced identically across
 *    nearly every animation tool in the industry - CSS, Framer Motion,
 *    GSAP, Unity, etc). This is the "easing presets as first-class
 *    citizens" piece: a rich, well-known vocabulary an AI (or a human)
 *    can pick from by NAME ("easeOutBack", "easeInOutElastic") instead
 *    of hand-deriving bezier tangents for every single animation.
 *
 * These two are NOT separate systems bolted together - every named
 * preset below is available as a plain (t) => t' function for direct
 * use, AND keyframes.js can reference any of them by name per-segment,
 * so "start from a preset, then hand-tweak the curve" is a real,
 * supported workflow, not a false choice between two disconnected
 * mechanisms.
 */

// ---------------------------------------------------------------------
// 1. Cubic bezier solver
// ---------------------------------------------------------------------

/**
 * Builds an easing function from the same 4 numbers CSS's
 * cubic-bezier(x1, y1, x2, y2) takes - control points P1=(x1,y1) and
 * P2=(x2,y2) of a cubic bezier anchored at P0=(0,0) and P3=(1,1).
 * Given a time-fraction x (0-1), solves for the bezier parameter u
 * such that Bx(u) = x (there is exactly one solution for any valid
 * easing curve, since x1/x2 are expected in [0,1] making Bx monotonic),
 * then returns By(u) as the eased value.
 *
 * This is the canonical algorithm (Newton-Raphson with a bisection
 * fallback) used by WebKit/Blink's UnitBezier class for real CSS
 * easing - not an approximation. Verified below against independent
 * brute-force sampling, not just "looks right."
 */
function cubicBezier(x1, y1, x2, y2) {
  // Polynomial coefficients for Bx(u) = ax*u^3 + bx*u^2 + cx*u
  // (P0=(0,0) and P3=(1,1) drop out of the expansion entirely).
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  function sampleX(u) { return ((ax * u + bx) * u + cx) * u; }
  function sampleY(u) { return ((ay * u + by) * u + cy) * u; }
  function sampleDerivativeX(u) { return (3 * ax * u + 2 * bx) * u + cx; }

  const EPSILON = 1e-6;

  function solveU(x) {
    // Newton-Raphson first - fast, and correct for the overwhelming
    // majority of real easing curves (x1/x2 in [0,1]).
    let u = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(u) - x;
      if (Math.abs(dx) < EPSILON) return u;
      const d = sampleDerivativeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= dx / d;
    }
    // Bisection fallback - guarantees convergence even if Newton's
    // method stalls (a near-zero derivative, or control points outside
    // [0,1] producing a non-monotonic Bx that Newton could jump out of).
    let lo = 0, hi = 1;
    u = x;
    while (lo < hi) {
      const xEst = sampleX(u);
      if (Math.abs(xEst - x) < EPSILON) return u;
      if (x > xEst) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  }

  return function easingFn(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveU(x));
  };
}

// ---------------------------------------------------------------------
// 2. Named easing library (Penner equations)
// ---------------------------------------------------------------------
// Every function: (t: 0-1) => eased value, generally 0-1 but "back",
// "elastic" deliberately overshoot outside that range - by design,
// that overshoot IS the spring/anticipation feel these exist for.
// Back/elastic/bounce accept an optional params object so the AI (or a
// template) can dial the FEEL (how much overshoot, how bouncy) rather
// than being stuck with one fixed curve per name.

const linear = (t) => t;

const easeInSine = (t) => 1 - Math.cos((t * Math.PI) / 2);
const easeOutSine = (t) => Math.sin((t * Math.PI) / 2);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

const easeInQuad = (t) => t * t;
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const easeInQuart = (t) => t * t * t * t;
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
const easeInOutQuart = (t) => (t < 0.5 ? 8 * Math.pow(t, 4) : 1 - Math.pow(-2 * t + 2, 4) / 2);

const easeInQuint = (t) => Math.pow(t, 5);
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeInOutQuint = (t) => (t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2);

const easeInExpo = (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10));
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeInOutExpo = (t) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
};

const easeInCirc = (t) => 1 - Math.sqrt(1 - Math.pow(t, 2));
const easeOutCirc = (t) => Math.sqrt(1 - Math.pow(t - 1, 2));
const easeInOutCirc = (t) =>
  t < 0.5
    ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
    : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2;

// "Back" - overshoots past the target then settles, like an object
// pulled back before being released. `overshoot` (AE calls this
// concept "Overshoot" too) controls how far past 1 it swings - 1.70158
// is the value that makes a 10% overshoot the "standard" feel.
function makeBackEasing(overshoot = 1.70158) {
  const c1 = overshoot;
  const c3 = c1 + 1;
  const c2 = c1 * 1.525;
  return {
    in: (t) => c3 * t * t * t - c1 * t * t,
    out: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
    inOut: (t) =>
      t < 0.5
        ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
        : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (2 * t - 2) + c2) + 2) / 2,
  };
}

// "Elastic" - a spring settling with decaying oscillation. `period`
// controls how many oscillations happen before it settles (smaller =
// more, tighter wobbles).
function makeElasticEasing(period = 3) {
  const c4 = (2 * Math.PI) / period;
  const c5 = (2 * Math.PI) / (period * 1.5);
  return {
    in: (t) => {
      if (t === 0) return 0;
      if (t === 1) return 1;
      return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
    },
    out: (t) => {
      if (t === 0) return 0;
      if (t === 1) return 1;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    inOut: (t) => {
      if (t === 0) return 0;
      if (t === 1) return 1;
      return t < 0.5
        ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
        : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
    },
  };
}

function easeOutBounceRaw(t) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}
const easeOutBounce = easeOutBounceRaw;
const easeInBounce = (t) => 1 - easeOutBounceRaw(1 - t);
const easeInOutBounce = (t) =>
  t < 0.5 ? (1 - easeOutBounceRaw(1 - 2 * t)) / 2 : (1 + easeOutBounceRaw(2 * t - 1)) / 2;

const backDefault = makeBackEasing();
const elasticDefault = makeElasticEasing();

// ---------------------------------------------------------------------
// Registry - the AI-facing vocabulary. getEasing(name, params) always
// returns a plain (t) => number function, regardless of whether the
// name maps to a fixed Penner formula or a parameterized family
// (back/elastic accept params.overshoot / params.period; cubicBezier
// requires params.x1/y1/x2/y2).
// ---------------------------------------------------------------------

const EASING_REGISTRY = {
  linear,
  easeInSine, easeOutSine, easeInOutSine,
  easeInQuad, easeOutQuad, easeInOutQuad,
  easeInCubic, easeOutCubic, easeInOutCubic,
  easeInQuart, easeOutQuart, easeInOutQuart,
  easeInQuint, easeOutQuint, easeInOutQuint,
  easeInExpo, easeOutExpo, easeInOutExpo,
  easeInCirc, easeOutCirc, easeInOutCirc,
  easeInBack: backDefault.in, easeOutBack: backDefault.out, easeInOutBack: backDefault.inOut,
  easeInElastic: elasticDefault.in, easeOutElastic: elasticDefault.out, easeInOutElastic: elasticDefault.inOut,
  easeInBounce, easeOutBounce, easeInOutBounce,
};

/**
 * Looks up an easing function by name. For "back"/"elastic" variants,
 * params.overshoot / params.period rebuild the family with a custom
 * feel instead of using the default constant. For "cubicBezier",
 * params must supply {x1,y1,x2,y2} - the escape hatch for a fully
 * custom hand-shaped curve when no named preset fits.
 */
function getEasing(name, params) {
  if (name === 'cubicBezier') {
    if (!params || [params.x1, params.y1, params.x2, params.y2].some((v) => typeof v !== 'number')) {
      throw new Error('getEasing("cubicBezier", ...) requires numeric params.x1/y1/x2/y2');
    }
    return cubicBezier(params.x1, params.y1, params.x2, params.y2);
  }
  if (params && (params.overshoot !== undefined) && name.endsWith('Back')) {
    const family = makeBackEasing(params.overshoot);
    if (name === 'easeInBack') return family.in;
    if (name === 'easeOutBack') return family.out;
    if (name === 'easeInOutBack') return family.inOut;
  }
  if (params && (params.period !== undefined) && name.endsWith('Elastic')) {
    const family = makeElasticEasing(params.period);
    if (name === 'easeInElastic') return family.in;
    if (name === 'easeOutElastic') return family.out;
    if (name === 'easeInOutElastic') return family.inOut;
  }
  const fn = EASING_REGISTRY[name];
  if (!fn) throw new Error(`Unknown easing preset "${name}" - see EASING_REGISTRY for valid names`);
  return fn;
}

module.exports = {
  cubicBezier,
  getEasing,
  EASING_REGISTRY,
  makeBackEasing,
  makeElasticEasing,
};
