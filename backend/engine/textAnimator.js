const { Property } = require('./keyframes');
const { clamp01, lerp } = require('./mathUtils');

/**
 * THE mechanism behind "letters cascade in one at a time" and every
 * other per-character text effect: a Selector answers "how strongly is
 * THIS character selected, right now" (0-1, not just on/off) for every
 * character in a string, and an Animator applies property changes
 * SCALED by that strength. Animating a range selector's start/end
 * across time is what makes a sweeping reveal work - the selector
 * doesn't need to know it's being swept, it just answers the question
 * at whatever t it's asked.
 */

function resolveVal(v, t) { return v instanceof Property ? v.valueAt(t) : v; }

/** Classic GLSL-style smoothstep - a cubic ease between two edges, degenerates to a hard step when edge0===edge1. */
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const tt = clamp01((x - edge0) / (edge1 - edge0));
  return tt * tt * (3 - 2 * tt);
}

// ---------------------------------------------------------------------
// Selectors: (unit: {charIndex, totalChars, wordIndex, totalWords, t}) => strength 0-1
// ---------------------------------------------------------------------

/**
 * A Range Selector - start/end/offset are 0-100 (%) and may each be a
 * plain number OR a keyframes.js Property; animating start/end IS how
 * a sweeping reveal works. `basedOn` picks whether position is judged
 * per-character or per-word (AE's own "Based On" control - a word-
 * based selector treats every character in one word identically).
 * `shape` controls how strength ramps at the transition (six visually
 * distinct, precisely-defined shapes - documented per-shape below;
 * these are real, well-defined curves, not claimed to be pixel-
 * identical to AE's own implementation, which isn't independently
 * checkable without AE itself, but each is exact against its own
 * stated definition, verified numerically).
 */
function rangeSelector({ start = 0, end = 100, offset = 0, shape = 'square', smoothness = 10, basedOn = 'characters' } = {}) {
  return function selector(unit) {
    const t = unit.t;
    const s = (resolveVal(start, t) + resolveVal(offset, t)) / 100;
    const e = (resolveVal(end, t) + resolveVal(offset, t)) / 100;
    const lo = Math.min(s, e), hi = Math.max(s, e);

    const index = basedOn === 'words' ? unit.wordIndex : unit.charIndex;
    const total = basedOn === 'words' ? unit.totalWords : unit.totalChars;
    const pos = total > 0 ? (index + 0.5) / total : 0;

    const smoothFrac = clamp01(resolveVal(smoothness, t)) / 100 * Math.max(hi - lo, 0.001);

    switch (shape) {
      case 'rampUp': {
        if (pos <= lo) return 0;
        if (pos >= hi) return 1;
        return (pos - lo) / (hi - lo);
      }
      case 'rampDown': {
        if (pos <= lo) return 1;
        if (pos >= hi) return 0;
        return 1 - (pos - lo) / (hi - lo);
      }
      case 'triangle': {
        if (pos <= lo || pos >= hi) return 0;
        const localT = (pos - lo) / (hi - lo);
        return 1 - Math.abs(localT * 2 - 1);
      }
      case 'round': {
        // A smooth DOME peaking at the range's midpoint, zero at both
        // ends - visually distinct from triangle's straight-line peak.
        if (pos <= lo || pos >= hi) return 0;
        const localT = (pos - lo) / (hi - lo);
        return Math.sin(localT * Math.PI);
      }
      case 'smooth': {
        // A soft PLATEAU (like square) but with a fixed, always-eased
        // sine transition rather than square's variable smoothstep -
        // genuinely different transition curve shape, not just a
        // renamed duplicate of square at a different smoothness.
        const span = Math.max(hi - lo, 0.001) * 0.3;
        const riseT = clamp01((pos - (lo - span)) / (2 * span));
        const fallT = clamp01((pos - (hi - span)) / (2 * span));
        const rise = riseT <= 0 ? 0 : riseT >= 1 ? 1 : (1 - Math.cos(riseT * Math.PI)) / 2;
        const fall = fallT <= 0 ? 0 : fallT >= 1 ? 1 : (1 - Math.cos(fallT * Math.PI)) / 2;
        return clamp01(rise - fall);
      }
      case 'square':
      default: {
        const rise = smoothstep(lo - smoothFrac, lo + smoothFrac, pos);
        const fall = smoothstep(hi - smoothFrac, hi + smoothFrac, pos);
        return clamp01(rise - fall);
      }
    }
  };
}

/** Deterministic pseudo-random in [0,1) from a single number - NOT Math.random(). Must be deterministic: motion blur (batch 2) samples the same character at several nearby t values per frame, and repeated renders must agree, or wiggly text would flicker/differ between a blurred and unblurred pass. */
function hash01(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A Wiggly Selector - pseudo-random per-character strength that
 * varies smoothly over time (a sine driven by a per-character random
 * phase, not literal noise, so it's smooth rather than jittery-flicker
 * frame to frame).
 */
function wigglySelector({ frequency = 2, seed = 0 } = {}) {
  return function selector(unit) {
    const phase = hash01(unit.charIndex * 17.13 + seed * 91.7) * Math.PI * 2;
    return 0.5 + 0.5 * Math.sin(unit.t * frequency * Math.PI * 2 + phase);
  };
}

// ---------------------------------------------------------------------
// Combining multiple selectors on one animator (AE lets you stack
// several) - the same "combine two 0-1 values by a named mode" idea as
// mask modes (maskAlpha.js) and blend modes (layerStack.js), just
// operating on a per-character scalar instead of a pixel buffer.
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

// ---------------------------------------------------------------------
// Character layout - real word-wrap + per-character base position,
// tracking both a character index AND a word index per character so
// basedOn:'words' selectors work.
// ---------------------------------------------------------------------

function layoutText(ctx, text, { fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY }) {
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const words = text.split(' ').filter((w) => w.length > 0);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  words.forEach((word) => {
    const wordWidth = ctx.measureText(`${word} `).width;
    if (currentWidth + wordWidth > maxWidth && current.length > 0) {
      lines.push(current); current = []; currentWidth = 0;
    }
    current.push(word);
    currentWidth += wordWidth;
  });
  if (current.length) lines.push(current);

  const totalHeight = lines.length * lineHeight;
  const startY = centerY - totalHeight / 2 + lineHeight / 2;

  const chars = [];
  let wordIndex = 0;
  lines.forEach((lineWords, li) => {
    const lineWidth = lineWords.reduce((sum, w) => sum + ctx.measureText(`${w} `).width, 0);
    let cx = centerX - lineWidth / 2;
    const cy = startY + li * lineHeight;
    lineWords.forEach((word) => {
      for (const ch of word) {
        const w = ctx.measureText(ch).width;
        chars.push({ ch, x: cx + w / 2, y: cy, index: chars.length, wordIndex });
        cx += w;
      }
      cx += ctx.measureText(' ').width;
      wordIndex++;
    });
  });

  return { chars, totalHeight, totalWords: wordIndex };
}

// ---------------------------------------------------------------------
// Rendering: layout once, then for every animator/character pair,
// blend "base" (strength 0) toward "base + property delta" (strength
// 1) by that character's combined selection strength.
// ---------------------------------------------------------------------

function renderAnimatedText(ctx, text, t, opts) {
  const {
    fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY,
    fillStyle = '#FFFFFF', animators = [],
  } = opts;

  const { chars, totalWords } = layoutText(ctx, text, { fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY });
  const totalChars = chars.length;

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    let dx = 0, dy = 0, scaleMul = 1, dRotation = 0, opacityDelta = 0;
    const unit = { charIndex: c.index, totalChars, wordIndex: c.wordIndex, totalWords, t };

    for (const anim of animators) {
      const strength = anim.selector(unit);
      if (strength <= 0) continue;
      const p = anim.properties || {};
      if (p.position) { dx += p.position[0] * strength; dy += p.position[1] * strength; }
      if (p.scale !== undefined) scaleMul *= lerp(1, p.scale, strength);
      if (p.rotation) dRotation += p.rotation * strength;
      if (p.opacity !== undefined) opacityDelta += p.opacity * strength;
    }

    const finalOpacity = clamp01(1 + opacityDelta);
    if (finalOpacity <= 0.001) continue;

    ctx.save();
    ctx.globalAlpha = finalOpacity;
    ctx.translate(c.x + dx, c.y + dy);
    ctx.rotate(dRotation);
    ctx.scale(scaleMul, scaleMul);
    ctx.fillStyle = fillStyle;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

module.exports = { rangeSelector, wigglySelector, combineSelectors, layoutText, renderAnimatedText };
