const { clamp01, clamp } = require('./mathUtils');
const { resolve } = require('./node');

/**
 * Real color-grading tools, all implemented as (ImageData) => ImageData
 * functions - the exact shape batch 3's Adjustment Layer mechanism
 * already expects (layerStack.js's `node.effects` array), so every
 * tool here plugs directly into that existing, verified pipeline with
 * no adapter needed. Each `*Effect(opts)` factory wraps the raw apply
 * function with node.js's resolve() so any option can be a plain value
 * or an animatable keyframes.js Property, matching the convention
 * every other per-effect config object in this engine already follows.
 */

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clampByte(v) { return Math.min(255, Math.max(0, v)); }

function identityLUT() {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
}

// ---------------------------------------------------------------------
// Curves: a real monotonic cubic Hermite spline through user control
// points - the Fritsch-Carlson method, the standard correct technique
// for a SHAPE-PRESERVING tone curve. A plain (non-monotonic) cubic
// spline through control points can overshoot BETWEEN points and
// actually invert brightness order locally, which reads as visible
// banding/posterization-like artifacts in a real image - the
// monotonicity correction below is specifically what prevents that,
// not a cosmetic extra step.
// ---------------------------------------------------------------------

/**
 * Builds a 256-entry lookup table from control points {x,y} (both in
 * 0-255 space) via a monotonic cubic Hermite spline:
 * 1. Compute each segment's secant slope (delta).
 * 2. Seed each point's tangent as the average of its two adjacent
 *    secants (endpoints just take their single neighboring secant).
 * 3. Fritsch-Carlson correction: wherever a segment's tangents would
 *    make the curve overshoot past monotonic (alpha^2+beta^2 > 9,
 *    the exact, standard threshold from the original 1980 paper),
 *    rescale them down to the largest values that stay monotonic.
 * Values outside the given control-point range clamp to the nearest
 * endpoint's y (matching how a real curves tool's flat curve ends behave).
 */
function buildMonotonicCurveLUT(controlPoints) {
  const pts = [...controlPoints].sort((a, b) => a.x - b.x);
  const n = pts.length;
  const lut = new Uint8ClampedArray(256);

  if (n === 0) return identityLUT();
  if (n === 1) { lut.fill(Math.round(clampByte(pts[0].y))); return lut; }

  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const segCount = n - 1;
  const delta = new Array(segCount);
  for (let k = 0; k < segCount; k++) {
    const dx = xs[k + 1] - xs[k];
    delta[k] = dx !== 0 ? (ys[k + 1] - ys[k]) / dx : 0;
  }

  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[segCount - 1];
  for (let k = 1; k < n - 1; k++) m[k] = (delta[k - 1] + delta[k]) / 2;

  for (let k = 0; k < segCount; k++) {
    if (delta[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const alpha = m[k] / delta[k], beta = m[k + 1] / delta[k];
    const s = alpha * alpha + beta * beta;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[k] = tau * alpha * delta[k];
      m[k + 1] = tau * beta * delta[k];
    }
  }

  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { lut[x] = Math.round(clampByte(ys[0])); continue; }
    if (x >= xs[n - 1]) { lut[x] = Math.round(clampByte(ys[n - 1])); continue; }
    let k = 0;
    while (k < segCount - 1 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k];
    const t = h !== 0 ? (x - xs[k]) / h : 0;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const y = h00 * ys[k] + h10 * h * m[k] + h01 * ys[k + 1] + h11 * h * m[k + 1];
    lut[x] = Math.round(clampByte(y));
  }
  return lut;
}

/** Applies master + per-channel curves (each optional - omitted channels pass through unchanged via an identity LUT). Master is applied FIRST, then the per-channel curve, matching how a real Curves tool stacks a master tone curve with individual RGB fine-tuning. */
function applyCurves(imageData, { master, r, g, b } = {}) {
  const lutMaster = master && master.length >= 2 ? buildMonotonicCurveLUT(master) : identityLUT();
  const lutR = r && r.length >= 2 ? buildMonotonicCurveLUT(r) : identityLUT();
  const lutG = g && g.length >= 2 ? buildMonotonicCurveLUT(g) : identityLUT();
  const lutB = b && b.length >= 2 ? buildMonotonicCurveLUT(b) : identityLUT();
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lutR[lutMaster[data[i]]];
    data[i + 1] = lutG[lutMaster[data[i + 1]]];
    data[i + 2] = lutB[lutMaster[data[i + 2]]];
  }
  return imageData;
}

// ---------------------------------------------------------------------
// Hue/Saturation: real RGB<->HSL conversion (the standard formulas),
// not an approximation - hue rotation and saturation/lightness scaling
// all happen in true HSL space, then convert back.
// ---------------------------------------------------------------------

function rgbToHsl(r8, g8, b8) {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hueToRgbChannel(p, q, tIn) {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgbChannel(p, q, h + 1 / 3) * 255,
    hueToRgbChannel(p, q, h) * 255,
    hueToRgbChannel(p, q, h - 1 / 3) * 255,
  ];
}

/** hueShift in degrees (-180..180 typical, wraps), saturationScale a multiplier (0=grayscale, 1=unchanged, >1=boosted), lightnessShift an additive -1..1 offset in HSL lightness. */
function applyHueSaturation(imageData, { hueShift = 0, saturationScale = 1, lightnessShift = 0 } = {}) {
  const data = imageData.data;
  const hueOffset = hueShift / 360;
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    let newH = (h + hueOffset) % 1;
    if (newH < 0) newH += 1;
    const newS = clamp01(s * saturationScale);
    const newL = clamp01(l + lightnessShift);
    const [r, g, b] = hslToRgb(newH, newS, newL);
    data[i] = Math.round(clampByte(r));
    data[i + 1] = Math.round(clampByte(g));
    data[i + 2] = Math.round(clampByte(b));
  }
  return imageData;
}

// ---------------------------------------------------------------------
// Color Balance: AE's real 3-way shadows/midtones/highlights tool -
// each tonal range gets its own additive R/G/B shift, weighted by how
// much a given pixel's LUMINANCE actually falls into that range (a
// pure black pixel should be affected by the Shadows sliders and
// essentially untouched by Highlights, and vice versa). The three
// weights are built from smoothstep so they transition softly rather
// than having a hard cutoff, and are constructed to always sum to
// exactly 1 (verified in the batch 8 test suite) so the three ranges
// never double-count or leave a luminance value with zero coverage.
// ---------------------------------------------------------------------
function toneWeights(luma) {
  const shadow = 1 - smoothstep(0, 0.5, luma);
  const highlight = smoothstep(0.5, 1, luma);
  const midtone = clamp01(1 - shadow - highlight);
  return [shadow, midtone, highlight];
}

function applyColorBalance(imageData, {
  shadows = [0, 0, 0], midtones = [0, 0, 0], highlights = [0, 0, 0],
} = {}) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const [sw, mw, hw] = toneWeights(luma);
    for (let c = 0; c < 3; c++) {
      const shift = shadows[c] * sw + midtones[c] * mw + highlights[c] * hw;
      data[i + c] = clampByte(Math.round(data[i + c] + shift));
    }
  }
  return imageData;
}

// ---------------------------------------------------------------------
// Levels: the classic input black/white point + gamma + output
// black/white remap, built once as a LUT (256 entries) rather than
// recomputed per pixel.
// ---------------------------------------------------------------------
function applyLevels(imageData, {
  inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255, channel = 'master',
} = {}) {
  const lut = new Uint8ClampedArray(256);
  const range = inWhite - inBlack || 1;
  for (let i = 0; i < 256; i++) {
    let v = clamp01((i - inBlack) / range);
    v = gamma > 0 ? v ** (1 / gamma) : v;
    v = outBlack + v * (outWhite - outBlack);
    lut[i] = Math.round(clampByte(v));
  }
  const data = imageData.data;
  const doR = channel === 'master' || channel === 'r';
  const doG = channel === 'master' || channel === 'g';
  const doB = channel === 'master' || channel === 'b';
  for (let i = 0; i < data.length; i += 4) {
    if (doR) data[i] = lut[data[i]];
    if (doG) data[i + 1] = lut[data[i + 1]];
    if (doB) data[i + 2] = lut[data[i + 2]];
  }
  return imageData;
}

// ---------------------------------------------------------------------
// Adjustment-layer-ready factories: (opts) => (imageData, t) => imageData,
// resolving any Property-valued option at the given t via node.js's
// resolve() - matching every other animatable-config pattern already
// used across this engine (selectors, layer styles, etc).
// ---------------------------------------------------------------------
function curvesEffect(opts = {}) {
  return (imageData, t) => applyCurves(imageData, {
    master: resolve(opts.master, t), r: resolve(opts.r, t), g: resolve(opts.g, t), b: resolve(opts.b, t),
  });
}

function hueSaturationEffect(opts = {}) {
  return (imageData, t) => applyHueSaturation(imageData, {
    hueShift: resolve(opts.hueShift != null ? opts.hueShift : 0, t),
    saturationScale: resolve(opts.saturationScale != null ? opts.saturationScale : 1, t),
    lightnessShift: resolve(opts.lightnessShift != null ? opts.lightnessShift : 0, t),
  });
}

function colorBalanceEffect(opts = {}) {
  return (imageData, t) => applyColorBalance(imageData, {
    shadows: resolve(opts.shadows, t) || [0, 0, 0],
    midtones: resolve(opts.midtones, t) || [0, 0, 0],
    highlights: resolve(opts.highlights, t) || [0, 0, 0],
  });
}

function levelsEffect(opts = {}) {
  return (imageData, t) => applyLevels(imageData, {
    inBlack: resolve(opts.inBlack != null ? opts.inBlack : 0, t),
    inWhite: resolve(opts.inWhite != null ? opts.inWhite : 255, t),
    gamma: resolve(opts.gamma != null ? opts.gamma : 1, t),
    outBlack: resolve(opts.outBlack != null ? opts.outBlack : 0, t),
    outWhite: resolve(opts.outWhite != null ? opts.outWhite : 255, t),
    channel: opts.channel || 'master',
  });
}

module.exports = {
  buildMonotonicCurveLUT, applyCurves, applyHueSaturation, applyColorBalance, applyLevels, toneWeights,
  curvesEffect, hueSaturationEffect, colorBalanceEffect, levelsEffect,
  rgbToHsl, hslToRgb,
};
