'use strict';
/*
 * Validation of the AI-authored camera flow (scene "move" + "transitions" between scenes) for siteTemplate/ad.html.
 * The model is free to choose every number and to write the opening's mask expression; this module only keeps those
 * choices inside the range where the picture cannot break (no edges showing, no snaps, no unsafe shader code).
 * It contains NO list of transition types: a transition is just a point in a continuous parameter space.
 */
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
const hashStr = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
/** deterministic 0..1 noise per (brand, index, channel): missing values still differ from scene to scene and brand to brand */
const rnd = (seed, i, k) => { const s = Math.sin((seed % 100003) * 0.001 + i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };

const FUNCS = new Set(['p', 'q', 't', 'x', 'y', 'xy', 'yx', 'sin', 'cos', 'abs', 'length', 'min', 'max', 'pow', 'smoothstep', 'mix', 'clamp', 'fract', 'atan', 'sqrt', 'exp', 'vec2']);
/** A mask must be a plain arithmetic GLSL float expression over p, q, t: anything else is discarded (the default circular opening is used). */
function sanitizeMask(e) {
  e = String(e == null ? '' : e).trim().replace(/^return\s+/i, '').replace(/;\s*$/, '');
  if (!e || e.length > 170 || !/^[0-9A-Za-z_+\-*/().,\s]+$/.test(e)) return '';
  const ids = e.match(/[A-Za-z_]\w*/g) || [];
  if (ids.some((w) => !FUNCS.has(w))) return '';
  let depth = 0;
  for (const c of e) { if (c === '(') depth++; else if (c === ')' && --depth < 0) return ''; }
  if (depth !== 0) return '';
  return e.replace(/(^|[^\w.])(\d+)(?![\w.])/g, '$1$2.0'); // GLSL wants floats: 2 -> 2.0
}

/** scene.move: the camera never rests. zoom + pushes in, - pulls out; pan in screen fractions per scene; roll in degrees. */
function normalizeMove(m, seed, i) {
  m = m && typeof m === 'object' ? m : {};
  const dir = i % 2 ? -1 : 1, pan = Array.isArray(m.pan) ? m.pan : [];
  return {
    zoom: num(m.zoom, -0.24, 0.24, dir * (i % 3 === 2 ? -1 : 1) * (0.10 + 0.10 * rnd(seed, i, 1))),
    pan: [num(pan[0], -0.15, 0.15, dir * (0.04 + 0.08 * rnd(seed, i, 2))), num(pan[1], -0.04, 0.04, (rnd(seed, i, 3) - 0.5) * 0.06)],
    roll: num(m.roll, -3, 3, dir * (0.6 + 1.8 * rnd(seed, i, 4))),
  };
}

/** transition i: the camera dives through scene i while scene i+1 opens inside it. Every field is a continuous number. */
function normalizeTransition(t, seed, i) {
  t = t && typeof t === 'object' ? t : {};
  const f = Array.isArray(t.focus) ? t.focus : [];
  return {
    focus: [num(f[0], 0.12, 0.88, 0.32 + 0.36 * rnd(seed, i, 5)), num(f[1], 0.12, 0.85, 0.28 + 0.26 * rnd(seed, i, 6))],
    zoom: num(t.zoom, 0.3, 1.8, 0.7 + 0.7 * rnd(seed, i, 7)),
    spin: num(t.spin, -15, 15, (rnd(seed, i, 8) - 0.5) * 16),
    blur: num(t.blur, 0, 0.7, 0.3 + 0.3 * rnd(seed, i, 9)),
    warp: num(t.warp, 0, 0.7, 0.1 + 0.3 * rnd(seed, i, 10)),
    glow: num(t.glow, 0, 0.6, 0.15 + 0.3 * rnd(seed, i, 11)),
    chroma: num(t.chroma, 0, 0.1, 0.02),   // colour split looks like a cheap glitch preset: kept almost off
    soft: num(t.soft, 0.03, 0.35, 0.08 + 0.14 * rnd(seed, i, 13)),
    overlap: num(t.overlap, 0.28, 0.5, 0.34 + 0.12 * rnd(seed, i, 14)),
    mask: sanitizeMask(t.mask),
    sfx: typeof t.sfx === 'string' ? t.sfx.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) : '',
  };
}

module.exports = { sanitizeMask, normalizeMove, normalizeTransition, hashStr };
