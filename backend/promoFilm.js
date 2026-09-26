'use strict';
/*
 * PRODUCT PROMO: a ~9 second motion-graphics spot for a PHYSICAL product (a snack, a drink, a pack of anything), in the style of the best social product promos:
 * a real product hero on a vivid backdrop, giant kinetic type, ingredients flying in, patterns and rings, almost no words, no voice.
 *
 * NOTHING HERE IS A TEMPLATE. The AI designs each promo as a "motion script" out of primitives (sprites with in / out / idle motion and free keyframes, text with reveal
 * styles and stacked repeats, shapes, ingredient scatter, product patterns, camera punch / shake, one vivid backdrop zone per beat). siteTemplate/promo.html only PLAYS that script.
 * This module: the designer prompt, the validator that repairs whatever the AI got wrong (so a promo can never be broken or unreadable), the picture plan for the
 * hero product and its props, the cut-out, and the sound.
 */
const fs = require('fs');
const path = require('path');

const FONTS = { anton: 'tall heavy condensed (headlines)', bebas: 'tall clean condensed caps', archivo: 'wide ultra-bold', oswald: 'bold condensed', league: 'very tall condensed', bowlby: 'chunky rounded fat display', rubik: 'heavy friendly rounded', pacifico: 'brush script (playful)', lobster: 'bold retro script', caveat: 'handwritten marker', poppins: 'clean geometric bold (small lines)', inter: 'neutral ultra-bold', playfair: 'elegant heavy serif', bricolage: 'modern quirky grotesque', fjalla: 'punchy condensed' };
const IN_KINDS = ['pop', 'drop', 'slideL', 'slideR', 'slideU', 'slideD', 'spin', 'zoom', 'fade', 'stretch', 'none'];
const TEXT_IN = ['slam', 'rise', 'pop', 'fade', 'slideL', 'slideR', 'drop'];
const IDLE = ['float', 'wobble', 'spin', 'pulse', 'drift', 'none'];
const SHAPES = ['circle', 'rect', 'rings', 'wave', 'rays', 'dots', 'stripes', 'burst'];
const EASES = ['linear', 'inCubic', 'outCubic', 'inOutCubic', 'outQuint', 'outExpo', 'outBack', 'outBounce', 'outElastic'];

const PROMO_SYSTEM = 'You are a motion-graphics director who designs 9-second product promo spots for social media. You reply with ONE JSON object only.';

function promoPrompt(brief) {
  return `Design a 9-second vertical (9:16) product promo for the PHYSICAL product in the brief below. It must feel like the best snack and drink launch spots on TikTok and Reels: the real product as a big hero on a vivid, saturated backdrop, ONE giant word of type, ingredients and pieces flying around it, moving rings / waves / patterns, a punchy camera, and almost no words. NEVER tell the company's story or list features like an explainer: show off the PRODUCT and how it makes people feel, in 3 or 4 tiny beats, and end on the product with the brand name.

BRIEF (the product, the brand and what to promote):
${brief}

YOU DESIGN EVERYTHING - there are no templates. You write a "motion script" from these primitives; the renderer plays exactly what you write. Coordinates x, y, cx, cy are fractions of the screen (0,0 = top-left, 1,1 = bottom-right); widths (w) and sizes are fractions of the screen WIDTH; times are seconds from 0. Layers are drawn in the order you write them (later = on top).
PRIMITIVES ("kind"):
- "sprite": a picture. src is "hero" (the product pack shot) or "prop0".."prop3" (your props). Fields: beat (0..n-1, or "all" so it stays through every beat), t0, t1, x, y, w, r (rotation degrees), in {kind, dur, delay}, out {kind, dur}, idle {kind, amp, speed}, keys [{t, x, y, s (scale), r, o (opacity), e (ease)}]. in/out kinds: ${IN_KINDS.join(', ')}. idle kinds: ${IDLE.join(', ')}. ease names: ${EASES.join(', ')}. "keys" are free keyframes: use them to fly the hero from one place to another between beats.
- "text": lines ["WORD","WORD"], beat, t0, t1, x, y, size (0.04 tiny .. 0.34 giant), font, color, upper, track (letter spacing), r, align, stroke {color, w}, shadow (true/false), in {kind, dur, stag} (kinds: ${TEXT_IN.join(', ')}; words arrive one by one), out {kind}, repeat {n, dy, speed}: the same word stacked n times, the copies outlined and fading away from the middle (the "NEW NEW NEW" wall behind a product). Fonts: ${Object.entries(FONTS).map(([k, v]) => k + ' (' + v + ')').join('; ')}.
- "scatter": pieces flying around the hero. src (one prop id or a list), n (1-16), beat, t0, t1, cx, cy, spread, size [min,max], from ("burst" out of the centre, "edges", "top", "sides"), seed, spin, stag.
- "pattern": src repeated as a pattern. sub ("radial" rings of copies, "grid", "ring"), t0, t1, cx, cy, w, spin, rings, cols, rows, stag, alpha.
- shapes (the moving furniture of the backdrop): kind one of ${SHAPES.join(', ')}. circle {x,y,size,color}; rect {x,y,w,h,radius,color}; rings {x,y,n,gap,width,speed,color,color2} (concentric rings pulsing outward); wave {y,amp,wl,speed,color,side:"top"|"bottom"}; rays {x,y,n,speed,color}; dots {gap,dot,speed,color}; stripes {w,speed,color,r}; burst {x,y,n,color,color2,life}. All shapes take beat, t0, t1, alpha, in / out / idle / keys like sprites.
CAMERA: "cam": [{t, kind:"punch"|"shake", amp, dur}] (a punch is a quick zoom bump: use one when the hero slams in).
BACKDROP: "zones": one per beat, {c0, c1, shape:"radial"}: c0 is the vivid bright centre colour, c1 the deeper edge colour; the camera glides across the board from zone to zone between beats. Choose colours that make the product POP (usually the product's own colour family or its strong opposite), and make consecutive zones clearly different.
DESIGN RULES: the hero is big (w 0.38-0.62) and on screen within 1.2 s; at most ONE giant word (size 0.18-0.34) per beat, and the whole promo shows AT MOST 14 words; one idea per beat; 3 or 4 beats of about 2-3.5 s that tile 0..duration with no gaps; layer 5-16 elements so every beat is rich (backdrop shape + giant word + hero + props + a tiny line); use different motion for every element; keep text inside the screen; the last beat is the product plus the BRAND NAME big plus at most 3 words of call to action. No prices, no claims you cannot see. Use ONLY words that come from the brief or describe the product's taste, feel or look.

Return ONE JSON object with these keys:
"brand" (the brand name exactly as in the brief, max 24 characters), "product": {"name", "kind" (what it physically is: "canned soft drink", "bag of potato chips", "chocolate bar"...), "look" (how the pack looks for an image AI: shape, materials, the two or three colours, label art WITHOUT any text, max 30 words), "colors" ["#rrggbb","#rrggbb"] (its two main colours)}, "props": 2 to 4 objects {"name", "look" (one thing that belongs to the product - an ingredient, a slice, a piece, a splash, a crumb - described for an image AI, no text, max 18 words)}, "duration" (8 to 10), "zones" (one per beat), "beats": [{"t0","t1","zone"}], "layers" (the motion script), "cam", "sound": {"music": "pulse" | "warm pad" | "tense" | "dark drone"}.
Output the JSON object only.`;
}

// ------------------------------------------------------------------ validation: the AI's script is repaired, never trusted
const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim());
const fixHex = (v, d) => (isHex(v) ? '#' + v.trim().replace('#', '').toLowerCase() : d);
const num = (v, d, lo, hi) => { v = +v; if (!Number.isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); };
const rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const hueShift = (c, deg) => {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360; const l = (mx + mn) / 2, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0, s2 = Math.max(0.75, sat), a = s2 * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const cleanStr = (v, n) => String(v == null ? '' : v).replace(/[<>"\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

function motionIO(o, kinds, dDur) {
  if (!o || typeof o !== 'object') return undefined;
  const k = oneOf(o.kind, kinds, null); if (!k) return undefined;
  return { kind: k, dur: num(o.dur, dDur, 0.1, 1.6), ...(o.delay !== undefined ? { delay: num(o.delay, 0, 0, 6) } : {}), ...(o.stag !== undefined ? { stag: num(o.stag, 0.09, 0, 0.4) } : {}), ...(o.turns !== undefined ? { turns: num(o.turns, 1, 0.25, 4) } : {}), ...(o.ease ? { ease: oneOf(o.ease, EASES, undefined) } : {}) };
}

/** Turn the AI's raw script into a safe, playable promo (throws only if there is nothing to play at all). */
function normalizePromo(raw, ctx = {}) {
  const S = raw && typeof raw === 'object' ? raw : {};
  const brand = cleanStr(S.brand || ctx.brand || 'Brand', 24).toUpperCase() || 'BRAND';
  const D = num(S.duration, 9, 7.5, 10.5);
  const P = S.product && typeof S.product === 'object' ? S.product : {};
  const colors = (Array.isArray(P.colors) ? P.colors : []).filter(isHex).map((c) => fixHex(c)).slice(0, 2);
  const product = { name: cleanStr(P.name, 60) || brand, kind: cleanStr(P.kind, 50) || 'product pack', look: cleanStr(P.look, 260) || 'a premium retail pack', colors: colors.length ? colors : ['#ff5c1a', '#ffd23f'] };
  const props = (Array.isArray(S.props) ? S.props : []).slice(0, 4).map((p) => ({ name: cleanStr(p && p.name, 40), look: cleanStr(p && p.look, 200) })).filter((p) => p.look);
  while (props.length < 2) props.push({ name: 'splash', look: 'a fresh splash of the product, glossy droplets' });
  // the assets the layers may refer to
  const assets = [{ id: 'hero' }, ...props.map((_, i) => ({ id: 'prop' + i }))], okSrc = new Set(assets.map((a) => a.id));

  // beats: 3 or 4 contiguous windows covering 0..D
  let beatsIn = (Array.isArray(S.beats) ? S.beats : []).filter((b) => b && typeof b === 'object').slice(0, 4);
  if (beatsIn.length < 3) beatsIn = [{}, {}, {}];
  const nb = beatsIn.length, cuts = [0];
  const raws = beatsIn.map((b, i) => (Number.isFinite(+b.t1) ? +b.t1 : (D * (i + 1)) / nb));
  for (let i = 0; i < nb - 1; i++) cuts.push(Math.max(cuts[i] + 1.6, Math.min(D - 1.6 * (nb - 1 - i), raws[i])));
  cuts.push(D);
  const beats = beatsIn.map((b, i) => ({ t0: +cuts[i].toFixed(2), t1: +cuts[i + 1].toFixed(2), zone: i }));

  // zones: vivid, distinct, different from the last; positions on the board are set here (a seeded random walk, like GraphMotion)
  const zin = Array.isArray(S.zones) ? S.zones : [];
  const pc = colors.length ? rgb(fixHex(colors[0])) : [255, 92, 26];
  const seedH = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  let rs = seedH(brand + product.name); const rand = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
  const zones = []; let px = 0, py = 0;
  for (let i = 0; i < nb; i++) {
    const z = zin[i] && typeof zin[i] === 'object' ? zin[i] : {};
    let c0 = rgb(fixHex(z.c0, toHex(mix(pc, [255, 255, 255], 0.25 + 0.1 * i)))), c1 = rgb(fixHex(z.c1, toHex(mix(pc, [10, 10, 30], 0.5))));
    if (Math.max(...c0) - Math.min(...c0) < 55) c0 = mix(c0, pc, 0.6);                        // washed-out greys are not a backdrop: keep the centre vivid
    if (lum(c1) > lum(c0)) [c0, c1] = [c1, c0];                                               // bright centre, deeper edge
    if (i && dist(c0, rgb(zones[i - 1].c0)) < 70) { c0 = hueShift(c0, 150 + 30 * i); c1 = hueShift(c1, 150 + 30 * i); }   // consecutive zones must be clearly different: a real hue change, never a dull mix
    if (i > 0) { const a = rand() * Math.PI * 2, d = 1600 + rand() * 1000; px = Math.round(px + Math.cos(a) * d); py = Math.round(py + Math.sin(a) * d); }
    zones.push({ c0: toHex(c0), c1: toHex(c1), shape: 'radial', x: px, y: py });
  }

  // layers
  const fontIds = Object.keys(FONTS), layers = []; let words = 0;
  const beatIdx = (v) => (v === 'all' ? 'all' : Number.isInteger(+v) && +v >= 0 && +v < nb ? +v : undefined);
  const timing = (L, o) => { let t0 = num(L.t0, undefined, 0, D), t1 = num(L.t1, undefined, 0, D); const b = beatIdx(L.beat); if (t0 === undefined) t0 = b !== undefined && b !== 'all' ? beats[b].t0 : 0; if (t1 === undefined || t1 <= t0 + 0.25) t1 = b !== undefined && b !== 'all' ? beats[b].t1 + 0.35 : D; o.t0 = +Math.min(t0, D - 0.4).toFixed(2); o.t1 = +Math.min(D, t1).toFixed(2); if (b !== undefined) o.beat = b; return o; };
  (Array.isArray(S.layers) ? S.layers : []).slice(0, 30).forEach((L) => {
    if (!L || typeof L !== 'object') return;
    const kind = String(L.kind || '');
    if (kind === 'sprite') {
      const src = okSrc.has(L.src) ? L.src : null; if (!src) return;
      const o = timing(L, { kind, src, x: num(L.x, 0.5, -0.2, 1.2), y: num(L.y, 0.5, -0.2, 1.2), w: num(L.w, src === 'hero' ? 0.5 : 0.22, 0.05, src === 'hero' ? 0.85 : 0.6), r: num(L.r, 0, -360, 360) });
      const i = motionIO(L.in, IN_KINDS, 0.5), out = motionIO(L.out, IN_KINDS, 0.35), idle = L.idle && oneOf(L.idle.kind, IDLE, null) ? { kind: L.idle.kind, amp: num(L.idle.amp, 0.02, 0, 0.12), speed: num(L.idle.speed, 1, 0.2, 3) } : undefined;
      if (i) o.in = i; if (out) o.out = out; if (idle) o.idle = idle;
      if (Array.isArray(L.keys)) { const ks = L.keys.filter((k) => k && Number.isFinite(+k.t)).slice(0, 8).map((k) => ({ t: num(k.t, 0, 0, D), ...(k.x !== undefined ? { x: num(k.x, 0.5, -0.5, 1.5) } : {}), ...(k.y !== undefined ? { y: num(k.y, 0.5, -0.5, 1.5) } : {}), ...(k.s !== undefined ? { s: num(k.s, 1, 0.2, 3) } : {}), ...(k.r !== undefined ? { r: num(k.r, 0, -720, 720) } : {}), ...(k.o !== undefined ? { o: num(k.o, 1, 0, 1) } : {}), ...(k.e ? { e: oneOf(k.e, EASES, 'inOutCubic') } : {}) })).sort((a, b) => a.t - b.t); if (ks.length >= 2) o.keys = ks; }
      layers.push(o);
    } else if (kind === 'text') {
      let lines = (Array.isArray(L.lines) ? L.lines : [L.text]).map((s) => cleanStr(s, 30)).filter(Boolean).slice(0, 3); if (!lines.length) return;
      const wc = lines.join(' ').split(' ').filter(Boolean).length; if (words + wc > 16) return; words += wc;      // the promo stays nearly wordless
      const o = timing(L, { kind, lines, x: num(L.x, 0.5, 0.05, 0.95), y: num(L.y, 0.5, 0.05, 0.95), size: num(L.size, 0.1, 0.03, 0.36), font: oneOf(L.font, fontIds, 'anton'), color: fixHex(L.color, '#ffffff'), upper: L.upper !== false, track: num(L.track, 0, -0.05, 0.4), r: num(L.r, 0, -25, 25), align: oneOf(L.align, ['center', 'left', 'right'], 'center') });
      const i = L.in && oneOf(L.in.kind, TEXT_IN, null) ? { kind: L.in.kind, dur: num(L.in.dur, 0.45, 0.15, 1.2), stag: num(L.in.stag, 0.09, 0, 0.4) } : { kind: 'rise', dur: 0.45, stag: 0.09 }; o.in = i;
      const out = motionIO(L.out, IN_KINDS, 0.3); if (out) o.out = out;
      if (L.stroke && typeof L.stroke === 'object') o.stroke = { color: fixHex(L.stroke.color, '#000000'), w: num(L.stroke.w, 0.03, 0.01, 0.12) };
      if (L.shadow) o.shadow = true;
      if (L.repeat && typeof L.repeat === 'object') o.repeat = { n: num(L.repeat.n, 5, 2, 11) | 0, dy: num(L.repeat.dy, 0.92, 0.6, 1.4), speed: num(L.repeat.speed, 0.04, 0, 0.2) };
      layers.push(o);
    } else if (kind === 'scatter') {
      const srcList = (Array.isArray(L.src) ? L.src : [L.src]).filter((s) => okSrc.has(s) && s !== 'hero'); if (!srcList.length) return;
      const sz = Array.isArray(L.size) && L.size.length === 2 ? [num(L.size[0], 0.12, 0.04, 0.4), num(L.size[1], 0.24, 0.05, 0.5)] : [0.12, 0.24];
      layers.push(timing(L, { kind, src: srcList, n: num(L.n, 8, 1, 16) | 0, cx: num(L.cx, 0.5, 0, 1), cy: num(L.cy, 0.5, 0, 1), spread: num(L.spread, 0.42, 0.15, 0.9), size: sz, from: oneOf(L.from, ['burst', 'edges', 'top', 'sides'], 'burst'), seed: num(L.seed, 3, 1, 999) | 0, spin: num(L.spin, 240, 0, 720), stag: num(L.stag, 0.35, 0, 1) }));
    } else if (kind === 'pattern') {
      const src = okSrc.has(L.src) ? L.src : 'hero';
      layers.push(timing(L, { kind, src, sub: oneOf(L.sub, ['radial', 'grid', 'ring'], 'radial'), cx: num(L.cx, 0.5, 0, 1), cy: num(L.cy, 0.5, 0, 1), w: num(L.w, 0.14, 0.05, 0.4), spin: num(L.spin, 30, -180, 180), rings: num(L.rings, 3, 1, 5) | 0, cols: num(L.cols, 4, 1, 6) | 0, rows: num(L.rows, 6, 1, 10) | 0, stag: num(L.stag, 0.02, 0, 0.08), alpha: num(L.alpha, 0.7, 0.1, 0.75) }));
    } else if (SHAPES.includes(kind)) {
      const o = timing(L, { kind, x: num(L.x, 0.5, -0.5, 1.5), y: num(L.y, 0.5, -0.5, 1.5), color: fixHex(L.color, '#ffffff'), alpha: num(L.alpha, 1, 0.05, 1), r: num(L.r, 0, -360, 360) });
      if (L.color2) o.color2 = fixHex(L.color2, o.color);
      ['size', 'w', 'h', 'radius', 'n', 'gap', 'width', 'speed', 'amp', 'wl', 'thick', 'dot', 'life', 'seed'].forEach((k) => { if (L[k] !== undefined) o[k] = num(L[k], 0, -5, 200); });
      if (L.side) o.side = oneOf(L.side, ['top', 'bottom'], 'bottom');
      const i = motionIO(L.in, IN_KINDS, 0.5), out = motionIO(L.out, IN_KINDS, 0.35); if (i) o.in = i; if (out) o.out = out;
      layers.push(o);
    }
  });
  // guarantees: the product is on screen early and stays for most of the promo; the brand name closes it
  const heroLayers = layers.filter((l) => l.kind === 'sprite' && l.src === 'hero');
  if (!heroLayers.length) layers.push({ kind: 'sprite', src: 'hero', beat: 'all', t0: 0.4, t1: D, x: 0.5, y: 0.52, w: 0.5, r: 0, in: { kind: 'pop', dur: 0.6 }, idle: { kind: 'float', amp: 0.012, speed: 1 } });
  else if (Math.min(...heroLayers.map((l) => l.t0)) > 1.3) heroLayers[0].t0 = 0.6;
  const lastBeat = beats[nb - 1];
  const hasBrand = layers.some((l) => l.kind === 'text' && l.t1 >= D - 0.3 && l.lines.join(' ').toUpperCase().includes(brand.split(' ')[0]));
  if (!hasBrand) layers.push({ kind: 'text', beat: nb - 1, t0: +(lastBeat.t0 + 0.5).toFixed(2), t1: D, lines: [brand.length > 12 && brand.includes(' ') ? brand.split(' ').slice(0, 2).join(' ') : brand], x: 0.5, y: 0.86, size: brand.length > 10 ? 0.11 : 0.15, font: 'anton', color: '#ffffff', upper: true, track: 0, r: 0, align: 'center', in: { kind: 'slam', dur: 0.4, stag: 0.14 }, shadow: true });
  const cam = (Array.isArray(S.cam) ? S.cam : []).filter((c) => c && Number.isFinite(+c.t)).slice(0, 6).map((c) => ({ t: num(c.t, 0.5, 0, D - 0.3), kind: c.kind === 'shake' ? 'shake' : 'punch', amp: num(c.amp, c.kind === 'shake' ? 8 : 0.06, 0, c.kind === 'shake' ? 16 : 0.12), dur: num(c.dur, 0.3, 0.15, 0.8) }));
  if (!cam.length) cam.push({ t: Math.min(D - 0.5, (heroLayers[0] ? heroLayers[0].t0 : 0.4) + 0.15), kind: 'punch', amp: 0.06, dur: 0.3 });
  const music = oneOf(S.sound && S.sound.music, ['pulse', 'warm pad', 'tense', 'dark drone'], 'pulse');
  return { brand, product, props, assets, duration: +D.toFixed(2), zones, beats, layers, cam, sound: { music }, pan: 0.55 };
}

// ------------------------------------------------------------------ pictures: the hero pack shot and the props, painted on a key colour, then cut out
const KEYS = [['#ff00ff', 'magenta'], ['#00ff00', 'green'], ['#00b8ff', 'cyan blue'], ['#ff8a00', 'orange']];
/** the chroma-key colour that is furthest from the product's own colours (an object is never lost into its background) */
function pickKey(colors) {
  const cs = (colors || []).map((c) => rgb(fixHex(c, '#888888')));
  let best = KEYS[0], bd = -1;
  for (const k of KEYS) { const d = cs.length ? Math.min(...cs.map((c) => dist(c, rgb(k[0])))) : 200; if (d > bd) { bd = d; best = k; } }
  return { hex: best[0], name: best[1] };
}
function heroPrompt(promo, key) {
  const p = promo.product;
  return `A single ${p.kind}, ${p.look}, front view, premium product photography, studio lighting, sharp focus, vivid colour, the whole product fully in frame and centered, isolated on a plain flat pure ${key.name} (${key.hex}) chroma-key background, no shadow, no ground, no other objects. The reference image is the brand name: print exactly this brand name, spelled identically letter for letter, large and clear on the front of the pack, as the only text on it.`;
}
function propPrompt(prop, key) {
  return `${prop.look}, macro product photography, vivid colour, sharp focus, one single object fully in frame and centered, isolated on a plain flat pure ${key.name} (${key.hex}) chroma-key background, no shadow, no ground, no text, no letters`;
}

let canvasLib = null;
const cv = () => canvasLib || (canvasLib = require('@napi-rs/canvas'));
/** The brand name drawn with a real font: the image AI COPIES this onto the pack (image models cannot spell a brand from scratch). */
function wordmarkCard(name) {
  try {
    const { createCanvas, GlobalFonts } = cv();
    const font = path.join(__dirname, 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
    if (fs.existsSync(font) && !GlobalFonts.has('WordmarkFont')) GlobalFonts.registerFromPath(font, 'WordmarkFont');
    const W = 900, H = 360, c = createCanvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    let px = 190; g.font = px + 'px WordmarkFont, Arial Black, sans-serif';
    while (g.measureText(name).width > W * 0.86 && px > 40) { px -= 6; g.font = px + 'px WordmarkFont, Arial Black, sans-serif'; }
    g.fillStyle = '#0a0a0a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, W / 2, H / 2 + px * 0.04);
    return c.toBuffer('image/png');
  } catch (e) { console.warn('[wordmark] could not draw the brand card:', e.message); return null; }
}

/**
 * Cut an object out of a plain key-colour background: sample the border colour, flood-fill from every border pixel, also drop key-coloured pixels the flood could not reach
 * (holes), remove the coloured halo around the outline, soften the rim, crop to the object. Returns { buf (PNG with alpha), aspect }.
 */
async function cutout(buf, tol = 72) {
  const { loadImage, createCanvas } = cv();
  const img = await loadImage(buf), W = img.width, H = img.height;
  const c = createCanvas(W, H), g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const id = g.getImageData(0, 0, W, H), d = id.data;
  const bs = []; for (let x = 0; x < W; x += 3) bs.push(x, (H - 1) * W + x); for (let y = 0; y < H; y += 3) bs.push(y * W, y * W + W - 1);
  const med = (ch) => { const v = bs.map((p) => d[p * 4 + ch]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [med(0), med(1), med(2)];
  const near = (p, t) => { const dr = d[p * 4] - bg[0], dg = d[p * 4 + 1] - bg[1], db = d[p * 4 + 2] - bg[2]; return Math.sqrt(dr * dr + dg * dg + db * db) < t; };
  const gone = new Uint8Array(W * H), stack = [];
  const push = (p) => { if (!gone[p] && near(p, tol)) { gone[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) { const p = stack.pop(), x = p % W, y = (p / W) | 0; if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W); }
  const strict = tol * 0.6; for (let p = 0; p < W * H; p++) if (!gone[p] && near(p, strict)) gone[p] = 1;
  // the halo the image AI paints around an object carries the key colour: within a few pixels of the removed area, key-leaning pixels go too
  const distMap = new Uint8Array(W * H).fill(255); let q = [];
  for (let p = 0; p < W * H; p++) if (gone[p]) { distMap[p] = 0; q.push(p); }
  for (let step = 1; step <= 5 && q.length; step++) { const nq = []; for (const p of q) { const x = p % W, y = (p / W) | 0; for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (n >= 0 && distMap[n] === 255) { distMap[n] = step; nq.push(n); } } q = nq; }
  for (let p = 0; p < W * H; p++) if (!gone[p] && distMap[p] <= 5 && near(p, tol * 1.25)) gone[p] = 1;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; let a = gone[p] ? 0 : 255;
    if (!gone[p]) { const rim = (x > 0 && gone[p - 1]) || (x < W - 1 && gone[p + 1]) || (y > 0 && gone[p - W]) || (y < H - 1 && gone[p + W]); if (rim) a = 130; }
    d[p * 4 + 3] = a; if (a) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX <= minX || maxY <= minY || (maxX - minX) * (maxY - minY) < W * H * 0.02) throw new Error('cutout found no object');
  g.putImageData(id, 0, 0);
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04), cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad), cw = Math.min(W - cx, maxX - minX + 1 + 2 * pad), ch = Math.min(H - cy, maxY - minY + 1 + 2 * pad);
  const out = createCanvas(cw, ch), og = out.getContext('2d'); og.drawImage(c, cx, cy, cw, ch, 0, 0, cw, ch);
  return { buf: out.toBuffer('image/png'), aspect: cw / ch };
}

// ------------------------------------------------------------------ sound: a bed and punchy hits placed on the beats; no voice
async function promoAudio(promo, dir) {
  const { synth } = require('./siteAudio');
  const adMix = require('./adMix'), lib = adMix.library(), D = promo.duration, end = Math.max(2, D - 1.6);
  const music = { style: promo.sound.music || 'pulse', key: 'A', bpm: 124 };
  const hero = promo.layers.find((l) => l.kind === 'sprite' && l.src === 'hero');
  const hits = [...new Set(promo.layers.filter((l) => l.kind === 'text' && l.in && (l.in.kind === 'slam' || l.in.kind === 'pop')).map((l) => +l.t0.toFixed(1)))].slice(0, 5);
  if (!lib.list.length) {
    const cues = []; promo.beats.forEach((b, i) => { if (i) cues.push({ t: b.t0 - 0.35, kind: 'whoosh', dur: 0.6, gain: 0.12 }); });
    if (hero) cues.push({ t: hero.t0, kind: 'impact', gain: 0.5 }, { t: hero.t0, kind: 'sub', gain: 0.35 }); hits.forEach((t) => cues.push({ t, kind: 'tick', gain: 0.5 }));
    cues.push({ t: D - 1.0, kind: 'tick', gain: 0.6 });
    fs.writeFileSync(path.join(dir, 'audio.wav'), synth({ duration: D + 1, cues: cues.filter((c) => c.t >= 0), music }));
    return 'audio.wav';
  }
  const pick = (kind, salt) => { const l = lib.of(kind); return l.length ? l[((promo.zones.length * 7) + salt) % l.length] : null; };
  const G = adMix.GAIN, ev = [], at = (x) => path.join(adMix.LIB, x.file);
  const whoosh = pick('whoosh', 0), tick = pick('tick', 1), hit = pick('impact', 2), spark = pick('sparkle', 3), riser = pick('riser', 4);
  promo.beats.forEach((b, i) => { if (i && whoosh) ev.push({ file: at(whoosh), at: Math.max(0, b.t0 - 0.4), gain: G.whoosh * 1.6 }); });
  if (hero && hit) ev.push({ file: at(hit), at: hero.t0, gain: G.impact });
  hits.forEach((t) => { if (tick) ev.push({ file: at(tick), at: t, gain: G.tick }); });
  if (riser) ev.push({ file: at(riser), at: Math.max(0, D - 1.5 - riser.seconds * 0.5), gain: G.riser * 0.8 });
  if (spark) ev.push({ file: at(spark), at: D - 0.9, gain: G.sparkle });
  const bed = adMix.tmpFile('.wav'), out = path.join(dir, 'audio.wav');
  fs.writeFileSync(bed, synth({ duration: D + 1, cues: [], music }));
  try { await adMix.mix({ bedWav: bed, events: ev, outWav: out, end }); } finally { fs.rmSync(bed, { force: true }); }
  return 'audio.wav';
}

/** A stand-in prop (a glossy disc in the product's colour) for when the image AI refuses or fails a prop: the promo is never lost over one ingredient. */
function fallbackProp(hex) {
  const { createCanvas } = cv(), c = createCanvas(400, 400), g = c.getContext('2d'), col = rgb(fixHex(hex, '#ff7a00'));
  const gr = g.createRadialGradient(150, 140, 20, 200, 200, 190); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.35, 'rgb(' + col.join(',') + ')'); gr.addColorStop(1, 'rgb(' + col.map((v) => Math.round(v * 0.55)).join(',') + ')');
  g.fillStyle = gr; g.beginPath(); g.arc(200, 200, 185, 0, Math.PI * 2); g.fill();
  return { buf: c.toBuffer('image/png'), aspect: 1 };
}

module.exports = { fallbackProp, PROMO_SYSTEM, promoPrompt, normalizePromo, pickKey, heroPrompt, propPrompt, wordmarkCard, cutout, promoAudio, FONTS };
