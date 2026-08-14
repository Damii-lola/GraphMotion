const { Property } = require('./keyframes');
const { clamp01, lerpAngle } = require('./mathUtils');

/**
 * Selectors are their own first-class concept, distinct from the
 * Animators that consume them (textAnimator.js): a selector is purely
 * "how strongly is THIS character/word selected right now" (a number,
 * not necessarily clamped to 0-1 - see `amount` below), for every
 * character in a string. Batch 4 built Range and Wiggly selectors as
 * an implementation detail of the animator system; this batch promotes
 * them to their own module and brings them up to real AE parity:
 * Range gets Amount and Randomize Order, Wiggly gets Correlation and
 * Min/Max Amount, and an Expression Selector formalizes the "just pass
 * a custom function" escape hatch. textAnimator.js now depends on
 * THIS file (not the reverse) - selectors are upstream of animation.
 */

function resolveVal(v, t) { return v instanceof Property ? v.valueAt(t) : v; }

/** Classic GLSL-style smoothstep - a cubic ease between two edges, degenerates to a hard step when edge0===edge1. */
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const tt = clamp01((x - edge0) / (edge1 - edge0));
  return tt * tt * (3 - 2 * tt);
}

/** Deterministic pseudo-random in [0,1) from a single number - NOT Math.random(). Must be deterministic: motion blur (batch 2) samples the same character at several nearby t values per frame, and repeated renders must agree, or wiggly text / randomized order would flicker or differ between a blurred and unblurred pass. */
function hash01(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A deterministic, seeded Fisher-Yates shuffle of [0..n-1]. Used by
 * Range Selector's `randomizeOrder` (AE's own "Randomize Order"
 * toggle) - characters are still swept by the SAME shape/lo/hi math,
 * just against a shuffled index instead of literal left-to-right
 * position, so a sweep reveals characters in a fixed-but-scrambled
 * order rather than strictly in sequence. Driven by hash01, not
 * Math.random, for the same determinism reason as everything else
 * random in this engine.
 */
function seededPermutation(n, seed) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(hash01(i * 7.919 + seed * 13.37) * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/**
 * A Range Selector - start/end/offset are 0-100 (%) and may each be a
 * plain number OR a keyframes.js Property; animating start/end IS how
 * a sweeping reveal works. `basedOn` picks whether position is judged
 * per-character or per-word. `shape` controls the transition curve
 * (six precisely-defined shapes, unchanged from batch 4).
 *
 * NEW this batch:
 * `amount` (plain number or Property, default 1) - AE's own Amount
 * property: an overall strength multiplier on top of the shape curve.
 * Deliberately NOT clamped to 0-1 here - amount > 1 lets a combined
 * selector chain overshoot past full selection, and amount < 0
 * legitimately INVERTS the selection (an animator's property deltas
 * get applied in reverse for whatever this selector chooses). Whatever
 * finally consumes the strength (renderAnimatedText's opacity clamp,
 * etc.) is responsible for clamping where clamping is actually needed.
 *
 * `randomizeOrder` (+ `randomSeed`) - see seededPermutation above.
 */
function rangeSelector({
  start = 0, end = 100, offset = 0, shape = 'square', smoothness = 10,
  basedOn = 'characters', amount = 1, randomizeOrder = false, randomSeed = 0,
} = {}) {
  const permCacheByTotal = new Map();

  return function selector(unit) {
    const t = unit.t;
    const s = (resolveVal(start, t) + resolveVal(offset, t)) / 100;
    const e = (resolveVal(end, t) + resolveVal(offset, t)) / 100;
    const lo = Math.min(s, e), hi = Math.max(s, e);

    let index = basedOn === 'words' ? unit.wordIndex : unit.charIndex;
    const total = basedOn === 'words' ? unit.totalWords : unit.totalChars;

    if (randomizeOrder && total > 0) {
      let perm = permCacheByTotal.get(total);
      if (!perm) { perm = seededPermutation(total, randomSeed); permCacheByTotal.set(total, perm); }
      index = perm[index];
    }

    const pos = total > 0 ? (index + 0.5) / total : 0;
    const smoothFrac = clamp01(resolveVal(smoothness, t)) / 100 * Math.max(hi - lo, 0.001);

    let raw;
    switch (shape) {
      case 'rampUp': {
        if (pos <= lo) raw = 0;
        else if (pos >= hi) raw = 1;
        else raw = (pos - lo) / (hi - lo);
        break;
      }
      case 'rampDown': {
        if (pos <= lo) raw = 1;
        else if (pos >= hi) raw = 0;
        else raw = 1 - (pos - lo) / (hi - lo);
        break;
      }
      case 'triangle': {
        if (pos <= lo || pos >= hi) raw = 0;
        else { const localT = (pos - lo) / (hi - lo); raw = 1 - Math.abs(localT * 2 - 1); }
        break;
      }
      case 'round': {
        if (pos <= lo || pos >= hi) raw = 0;
        else { const localT = (pos - lo) / (hi - lo); raw = Math.sin(localT * Math.PI); }
        break;
      }
      case 'smooth': {
        const span = Math.max(hi - lo, 0.001) * 0.3;
        const riseT = clamp01((pos - (lo - span)) / (2 * span));
        const fallT = clamp01((pos - (hi - span)) / (2 * span));
        const rise = riseT <= 0 ? 0 : riseT >= 1 ? 1 : (1 - Math.cos(riseT * Math.PI)) / 2;
        const fall = fallT <= 0 ? 0 : fallT >= 1 ? 1 : (1 - Math.cos(fallT * Math.PI)) / 2;
        raw = clamp01(rise - fall);
        break;
      }
      case 'square':
      default: {
        const rise = smoothstep(lo - smoothFrac, lo + smoothFrac, pos);
        const fall = smoothstep(hi - smoothFrac, hi + smoothFrac, pos);
        raw = clamp01(rise - fall);
        break;
      }
    }

    return raw * resolveVal(amount, t);
  };
}

/**
 * A Wiggly Selector - pseudo-random per-character strength, smoothly
 * varying over time via a sine driven by a per-character random phase.
 *
 * NEW this batch:
 * `correlation` (0-100, AE units) blends between every character
 * wiggling fully independently (0, each with its own random phase) and
 * the WHOLE selection moving as one unit (100, a single shared phase).
 * Blending the PHASE ANGLE itself (via lerpAngle's shortest-path
 * interpolation, not a naive linear lerp) rather than blending the two
 * finished sine outputs keeps the result a single clean sine wave at
 * every correlation setting - blending two already-evaluated sine
 * WAVES instead would produce visible beating (a sum-of-two-
 * frequencies artifact) at intermediate correlation values, which a
 * true "how in-sync are these characters" control should never show.
 *
 * `minAmount`/`maxAmount` (default 0/1) remap the wave's natural 0-1
 * output range - AE's own Wiggly Selector exposes exactly this pair,
 * letting the wiggle bottom out above 0 or swing negative.
 */
function wigglySelector({ frequency = 2, seed = 0, correlation = 0, minAmount = 0, maxAmount = 1 } = {}) {
  const corr = clamp01(correlation / 100);
  const sharedPhase = hash01(seed * 91.7 + 3.14159) * Math.PI * 2;

  return function selector(unit) {
    const independentPhase = hash01(unit.charIndex * 17.13 + seed * 91.7) * Math.PI * 2;
    const phase = lerpAngle(independentPhase, sharedPhase, corr);
    const wave = 0.5 + 0.5 * Math.sin(unit.t * frequency * Math.PI * 2 + phase);
    return minAmount + wave * (maxAmount - minAmount);
  };
}

/**
 * AE's "Expression Selector" is really just "supply arbitrary custom
 * per-character logic instead of Range/Wiggly" - since every selector
 * in this engine already IS a plain (unit) => strength function, this
 * is a thin, explicit wrapper (not new machinery): it documents the
 * escape hatch as a first-class option alongside Range/Wiggly, and
 * optionally clamps output for callers who want the 0-1 safety Range/
 * Wiggly give by default without amount/minAmount tricks.
 */
function expressionSelector(fn, { clampOutput = false } = {}) {
  return function selector(unit) {
    const v = fn(unit);
    return clampOutput ? clamp01(v) : v;
  };
}

// ---------------------------------------------------------------------
// Combining multiple selectors on one animator (AE lets you stack
// several) - the same "combine two values by a named mode" idea as
// mask modes (maskAlpha.js) and blend modes (layerStack.js), just
// operating on a per-character scalar instead of a pixel buffer.
// add/subtract/intersect assume 0-1 inputs (AE's own combination math);
// min/max are meaningful at any range, including amount-driven overshoot/
// negative values.
// ---------------------------------------------------------------------

const SELECTOR_COMBINE = {
  add: (a, b) => clamp01(a + b - a * b),
  subtract: (a, b) => clamp01(a * (1 - b)),
  intersect: (a, b) => a * b,
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
};

function combineSelectors(selectors, mode = 'add') {
  const fn = SELECTOR_COMBINE[mode] || SELECTOR_COMBINE.add;
  return function combined(unit) {
    if (selectors.length === 0) return 1;
    let acc = selectors[0](unit);
    for (let i = 1; i < selectors.length; i++) acc = fn(acc, selectors[i](unit));
    return acc;
  };
}

module.exports = {
  rangeSelector, wigglySelector, expressionSelector, combineSelectors,
  hash01, seededPermutation, smoothstep,
};
