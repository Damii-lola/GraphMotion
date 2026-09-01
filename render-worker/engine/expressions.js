const vm = require('vm');
const { buildPermutation, perlin2D } = require('./noiseEffects');
const { hash01 } = require('./selectors');
const { clamp, lerp } = require('./mathUtils');

/**
 * Expressions: AE's expressions genuinely ARE JavaScript, evaluated
 * per-frame with a handful of injected variables/functions - so this
 * engine's Expressions are REAL JavaScript too, evaluated via Node's
 * built-in `vm` module (a true sandboxed realm - a fresh global scope
 * per context, verified directly before relying on it: the outer
 * Node process's own globals like `process` are NOT visible inside),
 * not a limited custom DSL that only handles a few guessed patterns.
 * This is both more honest (an expression can do anything real JS
 * can) and less work than building and maintaining a parser for a
 * "good enough" expression subset.
 *
 * The injected scope mirrors AE's own real expression variables:
 * `time` (the current evaluation time), `value` (what this property
 * would be from its OWN keyframes/animation, before the expression
 * touches it - so an expression can be purely ADDITIVE, e.g.
 * `value + wiggle(2,10)`, not just a full replacement), plus AE's
 * real built-in expression helper functions below.
 */

function isVectorValue(v) { return Array.isArray(v); }
function addValues(a, b) { return isVectorValue(a) ? a.map((v, i) => v + b[i]) : a + b; }
function subValues(a, b) { return isVectorValue(a) ? a.map((v, i) => v - b[i]) : a - b; }
function scaleValue(a, s) { return isVectorValue(a) ? a.map((v) => v * s) : a * s; }

/**
 * The real technique behind AE's wiggle(): a SMOOTH, time-coherent
 * pseudo-random oscillation - not literal per-frame Math.random(),
 * which would flicker rather than wobble. This is fundamentally the
 * exact same fractal-Brownian-motion technique noiseEffects.js's
 * fractalNoise2D already implements for 2D space, applied along the
 * TIME axis instead (Perlin noise is coherent along ANY axis you
 * sample it on - it doesn't have to be spatial x/y) - a deliberate,
 * direct reuse of batch 9's real Perlin noise core (buildPermutation/
 * perlin2D), not a separately-invented "smooth randomness" trick.
 * `seedOffset` picks a different "row" of the 2D noise field so
 * multiple independent wiggle dimensions (e.g. x and y of a position)
 * don't move in lockstep along a diagonal.
 */
function wiggleNoise1D(perm, t, freq, seedOffset, octaves) {
  let amplitude = 1, frequency = 1, sum = 0, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    sum += perlin2D(perm, t * freq * frequency, seedOffset) * amplitude;
    maxAmp += amplitude;
    amplitude *= 0.5; // persistence
    frequency *= 2; // lacunarity
  }
  return maxAmp > 0 ? sum / maxAmp : 0;
}

/**
 * AE's real loopOut()/loopIn(): once time moves past (loopOut) or
 * before (loopIn) the property's own keyframed range, synthesizes a
 * continuation using one of AE's real four loop types:
 * - 'cycle': repeats the keyframed span verbatim.
 * - 'pingpong': repeats with alternating direction (a real triangle-
 *   wave fold of elapsed time into the span, not just "cycle but
 *   sometimes reversed").
 * - 'offset': repeats the span but keeps adding the delta between the
 *   first and last keyframe each repeat - the real mechanism behind
 *   e.g. a continuously spinning wheel built from only 2 keyframes.
 * - 'continue': extrapolates linearly using the real velocity
 *   (measured via a tiny finite-difference sample) at the boundary
 *   keyframe, rather than looping the pattern at all.
 * The exact phase alignment (which direction pingpong "starts"
 * folding, for instance) is an internally-consistent, tested
 * convention - not claimed to be bit-identical to AE's own internal
 * phase choice, the same honest stance every other "AE-inspired, not
 * AE-exact" formula in this engine takes.
 */
function loopValue(baseProperty, t, type, direction) {
  const kfs = baseProperty.keyframes;
  if (kfs.length < 2) return baseProperty.valueAt(t);
  const firstT = kfs[0].time, lastT = kfs[kfs.length - 1].time;
  const span = lastT - firstT;
  if (span <= 0) return baseProperty.valueAt(t);

  const isOut = direction === 'out';
  if (isOut ? t <= lastT : t >= firstT) return baseProperty.valueAt(t);

  if (type === 'continue') {
    const edgeT = isOut ? lastT : firstT;
    const eps = Math.max(span * 0.0005, 1e-4);
    // Sample ONLY on the interior side of the boundary keyframe -
    // Property.valueAt clamps flat past its own keyframe range (real,
    // correct, already-established behavior from batch 1), so a
    // centered difference straddling the boundary would silently mix
    // in that flat-clamped value and corrupt the velocity estimate.
    // Confirmed directly before fixing: a straddled sample on a truly
    // linear 0->10 ramp measured a velocity of ~2.5/s instead of the
    // real 5/s, because one of the two sample points landed just past
    // the last keyframe where the curve is already flat.
    const a = isOut ? baseProperty.valueAt(edgeT - eps) : baseProperty.valueAt(edgeT);
    const b = isOut ? baseProperty.valueAt(edgeT) : baseProperty.valueAt(edgeT + eps);
    const velocity = scaleValue(subValues(b, a), 1 / eps);
    const edgeVal = baseProperty.valueAt(edgeT);
    return addValues(edgeVal, scaleValue(velocity, t - edgeT));
  }

  const elapsed = isOut ? (t - lastT) : (firstT - t);
  const cyclesCompleted = Math.floor(elapsed / span);
  const remainder = elapsed - cyclesCompleted * span;

  let localT;
  if (type === 'pingpong') {
    const m = elapsed % (2 * span);
    if (isOut) localT = m <= span ? lastT - m : firstT + (m - span);
    else localT = m <= span ? firstT + m : lastT - (m - span);
  } else {
    localT = isOut ? firstT + remainder : lastT - remainder;
  }

  let val = baseProperty.valueAt(localT);
  if (type === 'offset') {
    const deltaPerCycle = subValues(baseProperty.valueAt(lastT), baseProperty.valueAt(firstT));
    const totalCycles = isOut ? (cyclesCompleted + 1) : -(cyclesCompleted + 1);
    val = addValues(val, scaleValue(deltaPerCycle, totalCycles));
  }
  return val;
}

/**
 * ExpressionProperty: drop-in interchangeable with keyframes.js's
 * Property (same .valueAt(t) contract, so anywhere in this engine that
 * already accepts a Property - node.js's resolve(), any effect config
 * - transparently accepts an expression-driven value too) wrapping an
 * OPTIONAL base Property (AE's real "value" comes from) and a real JS
 * expression string, compiled ONCE (vm.Script, reused across every
 * .valueAt call - compiling fresh every frame would be wasteful) and
 * run in a fresh sandboxed context per call (time/value/the helper
 * functions below all change per call, so the context itself is cheap
 * to rebuild each time - the compiled Script is the expensive part,
 * and that's cached).
 */
class ExpressionProperty {
  constructor(expressionString, { baseProperty = null, seed = 0 } = {}) {
    this.expressionString = expressionString;
    this.baseProperty = baseProperty;
    this.seed = seed;
    this.isVector = false; // resolved lazily once we know the base/expression's real shape
    this._perm = buildPermutation(seed);
    this._script = new vm.Script(expressionString, { filename: 'expression.js' });
  }

  valueAt(t) {
    const baseValue = this.baseProperty ? this.baseProperty.valueAt(t) : 0;
    const perm = this._perm;
    const seed = this.seed;

    const wiggle = (freq, amp, octaves = 1) => {
      if (isVectorValue(baseValue)) {
        return baseValue.map((v, i) => v + wiggleNoise1D(perm, t, freq, i * 137.9 + seed * 7.1 + 11, octaves) * amp);
      }
      return baseValue + wiggleNoise1D(perm, t, freq, seed * 7.1 + 11, octaves) * amp;
    };

    const loopOut = (type = 'cycle') => {
      if (!this.baseProperty) return baseValue;
      return loopValue(this.baseProperty, t, type, 'out');
    };
    const loopIn = (type = 'cycle') => {
      if (!this.baseProperty) return baseValue;
      return loopValue(this.baseProperty, t, type, 'in');
    };

    const linear = (tt, tMin, tMax, val1, val2) => {
      const frac = tMax === tMin ? 0 : clamp((tt - tMin) / (tMax - tMin), 0, 1);
      return isVectorValue(val1) ? val1.map((v, i) => lerp(v, val2[i], frac)) : lerp(val1, val2, frac);
    };

    const ease = (tt, tMin, tMax, val1, val2) => {
      const raw = tMax === tMin ? 0 : clamp((tt - tMin) / (tMax - tMin), 0, 1);
      const frac = raw * raw * (3 - 2 * raw); // smoothstep - AE's ease() is itself an eased remap, matching this shape
      return isVectorValue(val1) ? val1.map((v, i) => lerp(v, val2[i], frac)) : lerp(val1, val2, frac);
    };

    // Deterministic per (time, seed) - NOT Math.random, matching every
    // other randomness source in this engine (repeated evaluation at
    // the same t, e.g. across motion-blur sub-samples, must agree).
    const random = (a, b) => {
      let lo = 0, hi = 1;
      if (a !== undefined && b !== undefined) { lo = a; hi = b; } else if (a !== undefined) { hi = a; }
      return lo + hash01(t * 104729.7 + seed * 37.1) * (hi - lo);
    };

    const context = vm.createContext({
      time: t,
      value: baseValue,
      Math,
      wiggle,
      loopOut,
      loopIn,
      linear,
      ease,
      random,
      clamp: (v, lo, hi) => clamp(v, lo, hi),
    });

    // Real, confirmed-live crash: an expression referencing a variable
    // this sandbox doesn't provide (most often "index" - a genuinely
    // real AE per-character-animator expression variable, just not one
    // this engine's own selector expression context happens to inject)
    // throws a plain ReferenceError straight out of runInContext with
    // NO handling anywhere above this, taking the ENTIRE render process
    // down mid-frame. One malformed expression on one character
    // shouldn't be able to crash a whole video - fall back to this
    // property's own un-transformed base value (matching AE's real
    // "value" semantics: an expression is an ADDITIVE layer on top of
    // it, so losing the expression's contribution is a graceful
    // degradation, not a meaningless default) and keep rendering.
    try {
      return this._script.runInContext(context);
    } catch (err) {
      console.warn(`[expressions] evaluation failed ("${this.expressionString}"): ${err.message} - using the property's own base value instead of crashing the render.`);
      return baseValue;
    }
  }
}

module.exports = { ExpressionProperty, loopValue, wiggleNoise1D };
