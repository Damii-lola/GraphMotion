'use strict';
/*
 * THE LAWS of the promo engine: the do's and don'ts every promo must obey, whatever the AI chose.
 * The AI is free to choose the scenes, the words, the colours, the moves and the extras; the compiler applies these laws to everything it writes,
 * so a promo can never come out cluttered, unreadable, off-screen, too heavy to render or in the wrong order.
 */
const W = 720, H = 1280;

const LAWS = {
  canvas: { W, H, margin: 0.05 },
  // TYPE: sizes are fractions of the screen width
  type: { giant: [0.26, 0.36], heading: [0.1, 0.2], line: [0.04, 0.06], minHold: 1.0, maxWordsPerScene: 9, maxWordsTotal: 26 },
  // THE PACK
  pack: { maxH: 0.6, restW: [0.4, 0.62], restWithGiantType: [0.3, 0.5], maxW: 0.8, zoomThroughMaxW: 1.4, zoomThroughMaxSecs: 0.4, tiltMax: 28 },
  // PROPS / PIECES
  props: { size: [0.16, 0.4], maxPerScatter: 9, maxScatterAtOnce: 2 },
  // DENSITY = render cost (a promo is drawn frame by frame on a small server)
  density: { maxLayersPerScene: 18, maxLayersTotal: 60, maxFlash: 3, flashSecs: 0.3, maxWaves: 2, maxZoomBlur: 2, maxWipe: 3, maxExtrasPerScene: 3 },
  // COLOUR
  colour: { minSat: 0.6, lMin: 0.36, lMax: 0.62, minContrast: 4.5 },
  // TIME
  timing: { sceneMin: 1.4, sceneMax: 4.2, totalMin: 6, totalMax: 12.3, transitionSecs: { cut: 0, flash: 0.28, wipe: 0.5, zoomblur: 0.5, iris: 0.6, glide: 0.7 } },
  // STRUCTURE
  structure: { scenesMin: 3, scenesMax: 6, last: 'endcard', maxSameArchetype: 2, packAbsentScenesMin: 1, giantTypeScenesMin: 2 },
  // fonts the AI may pick (all loaded by the page)
  fonts: { caps: ['anton', 'bebas', 'league', 'oswald', 'fjalla', 'archivo', 'bowlby', 'rubik'], body: ['poppins', 'inter', 'bricolage'], script: ['pacifico', 'lobster', 'caveat'], serif: ['playfair'] },
};
const ALL_FONTS = [...LAWS.fonts.caps, ...LAWS.fonts.body, ...LAWS.fonts.script, ...LAWS.fonts.serif];

// ------------------------------------------------------------------ small maths and colour helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d, lo, hi) => { v = +v; if (!Number.isFinite(v)) return d; return clamp(v, lo, hi); };
const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim());
const fixHex = (v, d) => (isHex(v) ? '#' + v.trim().replace('#', '').toLowerCase() : d);
const rgb = (h) => { const n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hex = (c) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const toHsl = (c) => { const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } const l = (mx + mn) / 2; return [h, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l]; };
const fromHsl = ([h, s, l]) => { const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); }; return [f(0) * 255, f(8) * 255, f(4) * 255]; };
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const relLum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

/** LAW (colour): a backdrop has real colour: saturated, neither near-white nor a grey pastel. Dark saturated colours are allowed. */
function vividBackdrop(c) { let [h, s, l] = toHsl(c); if (l > LAWS.colour.lMax + 0.04) l = LAWS.colour.lMax; if (l > 0.3 && s < LAWS.colour.minSat) s = LAWS.colour.minSat + 0.02; return fromHsl([h, s, l]); }
/** LAW (colour): words must read on their backdrop: the ink is white or near-black, whichever contrasts more (the AI's own colour is honoured when it already reads). */
function inkFor(bg, want) {
  const b = rgb(bg), w = want && isHex(want) ? rgb(want) : null;
  if (w && contrast(w, b) >= LAWS.colour.minContrast) return hex(w);
  return contrast([255, 255, 255], b) >= contrast([12, 12, 16], b) ? '#ffffff' : '#0c0c10';
}
/** an accent that stands out from the backdrop: the AI's own when it differs enough, else the hue-opposite */
function accentFor(bg, want) {
  const b = rgb(bg);
  if (want && isHex(want) && dist(rgb(want), b) > 150) return fixHex(want);
  const [h, s, l] = toHsl(b); return hex(fromHsl([(h + 165) % 360, 0.9, l > 0.5 ? 0.35 : 0.62]));
}

// ------------------------------------------------------------------ text laws
/** LAW (type): the biggest size at which a word of this many characters fits the width, inside the type scale for its role */
function fitSize(chars, role, fontCondensed = true) {
  const per = fontCondensed ? 0.5 : 0.68, want = (0.9 / Math.max(1, chars)) / per, [lo, hi] = role === 'giant' ? LAWS.type.giant : role === 'heading' ? LAWS.type.heading : LAWS.type.line;
  return +clamp(want, role === 'giant' ? 0.16 : lo, hi).toFixed(3);   // a long giant word may drop below the giant floor: it must still fit the screen
}
const safeFont = (f, fallback = 'anton') => (ALL_FONTS.includes(String(f || '').toLowerCase()) ? String(f).toLowerCase() : fallback);
const cleanWord = (s, n = 12) => String(s == null ? '' : s).replace(/[<>"\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

module.exports = { LAWS, W, H, ALL_FONTS, clamp, num, isHex, fixHex, rgb, hex, mix, toHsl, fromHsl, contrast, dist, vividBackdrop, inkFor, accentFor, fitSize, safeFont, cleanWord, oneOf };
