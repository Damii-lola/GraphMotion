'use strict';
/*
 * SCENE ARCHETYPES, version 2 (with variation): the building blocks of every promo, taken from the reference spots.
 * An archetype is NOT a fixed clip. It has parameters the AI chooses (words, colours, which pack shot, ...) and LAYOUT VARIANTS (a wall can be a grid, tilted rows, columns or a marquee; a
 * showcase can be centred, bleed off either edge, peek from the bottom, spin or drop...). Anything the plan leaves open is filled from the video's dice roll (vary.js), so two videos that follow
 * the same reference never come out the same. The compiler applies the laws to whatever comes out.
 */
const { LAWS, clamp, num, fixHex, rgb, hex, mix, fitSize, cleanWord, oneOf, inkFor, W, H } = require('./laws');

// ------------------------------------------------------------------ helpers
const A = (ctx, u) => +(ctx.t0 + u).toFixed(3);
const wordsLines = (x, maxLines, maxChars) => {
  // split into lines BEFORE trimming (a long two-word name is two lines, never one truncated line)
  const raw = (Array.isArray(x) ? x : String(x == null ? '' : x).split(/[\/\n]/)).map((s) => String(s == null ? '' : s).replace(/[<>"\\]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let arr = raw;
  if (raw.length === 1 && maxLines > 1 && raw[0].length > maxChars && raw[0].includes(' ')) { const w = raw[0].split(' '); let best = 1, bd = 1e9; for (let i = 1; i < w.length; i++) { const d = Math.abs(w.slice(0, i).join(' ').length - w.slice(i).join(' ').length); if (d < bd) { bd = d; best = i; } } arr = [w.slice(0, best).join(' '), w.slice(best).join(' ')]; }
  return arr.slice(0, maxLines).map((s) => s.slice(0, maxChars).toUpperCase());
};
const wrapWords = (t, maxLines, maxChars) => { const w = String(t).split(/\s+/).filter(Boolean), out = []; let cur = ''; for (const x of w) { if ((cur + ' ' + x).trim().length > maxChars && cur) { out.push(cur); cur = x; } else cur = (cur + ' ' + x).trim(); } if (cur) out.push(cur); return out.slice(0, maxLines); };
const sentenceLines = (x, maxLines, maxChars) => {
  const parts = (Array.isArray(x) ? x : String(x == null ? '' : x).split(/[\/\n]/)).map((s) => String(s == null ? '' : s).replace(/[<>"\\]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length === 1 && maxLines > 1 && parts[0].length > maxChars) return wrapWords(parts[0], maxLines, maxChars).map((s) => cleanWord(s, maxChars));   // one long sentence wraps onto two lines
  return parts.map((s) => cleanWord(s, maxChars)).filter(Boolean).slice(0, maxLines);
};
const nWords = (lines) => lines.join(' ').split(/\s+/).filter(Boolean).length;
const packId = (ctx, want, i = 0) => { const have = Object.keys(ctx.packs); return have.includes(want) ? want : have[Math.min(i, have.length - 1)] || 'hero'; };
const packH = (ctx, id, w) => (w * W / ((ctx.packs[id] && ctx.packs[id].aspect) || 0.5)) / H;
const box = (ctx, id, x, y, w, tilt = 12) => { const h = packH(ctx, id, w) * (1 + Math.abs(tilt) / 100), ww = w * (1 + Math.abs(tilt) / 120); return { x0: x - ww / 2, x1: x + ww / 2, y0: y - h / 2, y1: y + h / 2 }; };
const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
function freeY(ctx, boxes, hText, prefer) {
  const cands = prefer === 'bottom' ? [0.92, 0.88, 0.09, 0.13] : [0.09, 0.13, 0.92, 0.88];
  for (const y of cands) { const b = { x0: 0.05, x1: 0.95, y0: y - hText / 2, y1: y + hText / 2 }; if (!boxes.some((k) => hit(b, k))) return y; }
  return cands[0];
}
const push = (ctx, l) => { ctx.out.layers.push(l); return l; };
const text = (ctx, o) => {
  const u0 = o.u0 || 0, u1 = o.u1 !== undefined ? o.u1 : ctx.dur;
  const L = { kind: 'text', font: ctx.v.font('small'), color: ctx.pal.ink, upper: true, track: 0, r: 0, align: 'center', size: 0.06, x: 0.5, y: 0.5, lines: [], in: { kind: 'rise', dur: 0.45, stag: 0.09 }, ...o, t0: A(ctx, u0), t1: A(ctx, u1) };
  delete L.u0; delete L.u1; if (L.keys) L.keys = L.keys.map((k) => { const q = { ...k, t: A(ctx, k.u) }; delete q.u; return q; });
  L.lines = L.lines.map((s) => String(s)); return push(ctx, L);
};
const shape = (ctx, o) => { const L = { alpha: 1, r: 0, x: 0.5, y: 0.5, color: ctx.pal.accent, ...o, t0: A(ctx, o.u0 || 0), t1: A(ctx, o.u1 !== undefined ? o.u1 : ctx.dur) }; delete L.u0; delete L.u1; if (L.keys) L.keys = L.keys.map((k) => { const q = { ...k, t: A(ctx, k.u) }; delete q.u; return q; }); return push(ctx, L); };
const scatter = (ctx, o) => {
  const ids = (o.src && o.src.length ? o.src : ctx.props.map((p) => p.id)).filter((id) => ctx.props.some((p) => p.id === id) || ctx.packs[id]);
  if (!ids.length) return null;
  return push(ctx, { kind: 'scatter', src: ids, n: clamp(o.n || 6, 2, LAWS.props.maxPerScatter), cx: 0.5, cy: 0.55, spread: 0.5, size: [LAWS.props.size[0] + 0.02, LAWS.props.size[1] - 0.04], from: o.from || 'corners', seed: o.seed || 3, spin: o.spin || 240, stag: o.stag || 0.3, z: 2.6, t0: A(ctx, o.u0 || 0.8), t1: A(ctx, o.u1 !== undefined ? o.u1 : ctx.dur) });
};
const cue = (ctx, u, kind) => ctx.out.cues.push({ t: A(ctx, Math.max(0, u)), kind });
const cam = (ctx, u, kind, o = {}) => ctx.out.cam.push({ t: A(ctx, u), kind, ...(kind === 'punch' ? { amp: ctx.v.motion.punch, dur: 0.3 } : kind === 'shake' ? { amp: 8, dur: 0.35 } : {}), ...o });
/** backdrop furniture: the decoration style of this video (rays, rings, dots, stripes, waves, circles or nothing), quiet and behind everything */
function decor(ctx, kindWant) {
  const k = kindWant || ctx.v.decor();
  if (k === 'rays') shape(ctx, { kind: 'rays', n: ctx.v.pick([12, 16, 20]), speed: ctx.v.range(3, 8), color: ctx.pal.ink, alpha: 0.09, z: 0 });
  else if (k === 'rings') shape(ctx, { kind: 'rings', x: ctx.v.range(0.35, 0.65), y: ctx.v.range(0.4, 0.6), n: 8, gap: ctx.v.range(0.1, 0.15), width: 0.05, speed: 0.35, color: ctx.pal.ink, color2: ctx.pal.accent, alpha: 0.18, z: 0 });
  else if (k === 'dots') shape(ctx, { kind: 'dots', gap: ctx.v.range(0.06, 0.09), dot: 0.012, speed: 0.02, color: ctx.pal.ink, alpha: 0.16, z: 0 });
  else if (k === 'stripes') shape(ctx, { kind: 'stripes', w: ctx.v.range(0.08, 0.14), speed: 0.06, color: ctx.pal.ink, alpha: 0.08, r: ctx.v.pick([-20, 20, 35, 0]), z: 0 });
  else if (k === 'waves') shape(ctx, { kind: 'wave', y: ctx.v.range(0.82, 0.9), amp: 0.02, wl: 0.8, speed: 0.35, color: ctx.pal.accent, alpha: 0.85, side: 'bottom', z: 0 });
  else if (k === 'circles') shape(ctx, { kind: 'circle', x: ctx.v.pick([0.15, 0.85]), y: ctx.v.pick([0.2, 0.8]), size: ctx.v.range(0.25, 0.4), color: ctx.pal.ink, alpha: 0.13, z: 0 });
}
const F = (ctx, role, want) => ctx.v.font(role, want);

// ---- the pack's moves. Waypoints are {u,x,y,w,r,blur,e,sx,sy,o}; u = seconds from the start of the scene
function movePack(ctx, id, way) {
  const wp = way.map((k) => { const q = { ...k, t: A(ctx, k.u) }; delete q.u; return q; });
  // once the pack has landed it shows itself off with one full turn (a round pack turns like a turntable; a flat pack ignores the yaw)
  const ai = wp.findIndex((k) => k.yaw === 0);
  if (ai >= 0 && ai < wp.length - 1) { const a = wp[ai], last = wp[wp.length - 1]; if (last.t - a.t >= 1.7 && false) { const dir = ctx.v.pick([-1, 1]); wp.splice(ai + 1, 0, { ...a, t: +(a.t + 0.3).toFixed(3), yaw: 0, e: 'linear', blur: 0 }, { ...a, t: +(a.t + 1.3).toFixed(3), yaw: 360 * dir, e: 'inOutCubic', blur: 0 }); } }
  if (id === 'hero') { ctx.out.hero.push(...wp); ctx.out.heroUsed = true; return; }
  const f = wp[0];
  push(ctx, { kind: 'sprite', src: id, t0: f.t, t1: A(ctx, ctx.dur), x: f.x, y: f.y, w: f.w, r: 0, keys: wp.map((k) => ({ ...k })), pack: true, shadow: true });
  ctx.out.packUsed = true;
}
/** entrance moves: the pack arrives from off-screen (or out of nothing) and comes to rest; the motion personality sets how long and with which easing */
function enter(ctx, style, u, rest, dir = -1) {
  const M = ctx.v.motion, dur = M.enter, off = dir < 0 ? -0.6 : 1.6, e = ctx.v.ease();
  switch (style) {
    case 'drop': return [{ u, x: rest.x, y: -0.5, w: rest.w * 1.05, r: rest.r + 22, blur: 14, yaw: 200 }, { u: u + dur + 0.1, ...rest, blur: 0, yaw: 0, e: 'outBounce' }];
    case 'rise': return [{ u, x: rest.x, y: 1.6, w: rest.w * 1.05, r: rest.r - 18, blur: 14, yaw: -220 }, { u: u + dur, ...rest, blur: 0, yaw: 0, e: e === 'outBounce' ? 'outExpo' : e }];
    case 'spin': return [{ u, x: rest.x, y: rest.y, w: rest.w * 0.06, r: rest.r - 320, blur: 5, yaw: 540 }, { u: u + dur + 0.15, ...rest, blur: 0, yaw: 0, e: 'outBack' }];
    case 'pop': return [{ u, x: rest.x, y: rest.y, w: rest.w * 0.1, r: rest.r - 12, blur: 0, yaw: 360 }, { u: u + 0.6, ...rest, yaw: 0, e: 'outBack' }];
    default: return [{ u, x: off, y: rest.y + 0.22, w: rest.w * 1.1, r: rest.r + (dir < 0 ? -55 : 55), blur: 16, yaw: dir < 0 ? -260 : 260 }, { u: u + dur, ...rest, blur: 0, yaw: 0, e: e === 'outBounce' || e === 'outElastic' ? 'outExpo' : e }];   // whip
  }
}
const drift = (ctx, u, rest, sgn = 1) => { const d = ctx.v.motion.drift; return { u, x: +(rest.x + d * sgn).toFixed(3), y: +(rest.y - 0.012).toFixed(3), w: +(rest.w * 1.04).toFixed(3), r: rest.r + 6 * sgn, e: 'inOutCubic' }; };
function exitMove(style, u, from, dir = 1) {
  const off = dir > 0 ? 1.6 : -0.6;
  if (style === 'up') return { u, x: from.x, y: -0.5, w: from.w, r: from.r + 20, blur: 14, e: 'inCubic' };
  if (style === 'down') return { u, x: from.x, y: 1.6, w: from.w, r: from.r - 20, blur: 14, e: 'inCubic' };
  return { u, x: off, y: from.y - 0.12, w: from.w * 1.05, r: from.r + (dir > 0 ? 42 : -42), blur: 14, e: 'inCubic' };
}
/** LAW (pack size): a pack's visual AREA is constant whatever its proportions and its height never passes maxH of the screen (type needs room). bleed = true lets it be cropped by the frame */
const restPose = (ctx, id, x, y, w, r, hasGiant, maxH, bleed) => {
  const [lo, hi] = hasGiant ? LAWS.pack.restWithGiantType : LAWS.pack.restW, a = clamp((ctx.packs[id] && ctx.packs[id].aspect) || 0.5, 0.25, 1.6), hMax = (maxH || (hasGiant ? 0.5 : LAWS.pack.maxH)) * H * a / W;
  const boost = a > 0.75 ? 1.3 : 1, w1 = w * Math.sqrt(a / 0.5) * boost, w2 = bleed ? Math.min(w1, 0.85) : Math.min(w1, hMax), lo2 = Math.min(lo, hMax);
  return { x, y, w: +clamp(w2, bleed ? 0.3 : lo2 * (w < 0.4 ? 0.7 : 1), bleed ? 0.85 : Math.min(LAWS.pack.maxW, hi * boost)).toFixed(3), r: clamp(r, -LAWS.pack.tiltMax, LAWS.pack.tiltMax) };
};
const variantOf = (ctx, p, list) => (list.includes(String(p.variant || '').toLowerCase()) ? String(p.variant).toLowerCase() : ctx.v.pick(list));
const ENTR = ['whip', 'drop', 'rise', 'spin', 'pop'];

// ------------------------------------------------------------------ the archetypes
const ARCH = {};

ARCH.hook_slice = {
  about: 'A GIANT word (or two lines) fills the screen, arriving as horizontal strips sliding in from opposite sides (McDonald\'s, Wendy\'s, Canva). No pack. Variants: centre | diagonal | stack (two lines, different sizes) | left (huge, left-aligned).',
  params: { lines: 'the giant word(s), 1-2 lines, each up to 9 letters', font: 'a caps font', sub: 'optional tiny typed line (max 5 words)', style: 'slice | slam | slide', variant: 'centre | diagonal | stack | left' },
  packs: 'none',
  build(p, ctx) {
    const lines = wordsLines(p.lines || p.word || ctx.brand, 2, 9), chars = Math.max(...lines.map((l) => l.length), 1), v = variantOf(ctx, p, ['centre', 'diagonal', 'stack', 'left']), font = F(ctx, 'giant', p.font);
    const size = +(fitSize(chars, 'giant') * (lines.length > 1 ? 0.86 : 1)).toFixed(3), inK = oneOf(p.style, ['slice', 'slam', 'slideL'], ctx.v.pick(['slice', 'slam', 'slice']));
    decor(ctx);
    if (v === 'diagonal') text(ctx, { lines, size, font, y: 0.5, r: ctx.v.pick([-8, 8, -12, 12]), lineGap: 1.02, in: { kind: inK, dur: 0.8, stag: 0.12 }, shadow: true, z: 2 });
    else if (v === 'stack' && lines.length > 1) { text(ctx, { lines: [lines[0]], size: +(size * 0.6).toFixed(3), font, y: 0.36, x: ctx.v.pick([0.32, 0.68]), in: { kind: 'slideL', dur: 0.6, stag: 0.1 }, shadow: true, z: 2 }); text(ctx, { u0: 0.25, lines: [lines[1]], size: +(size * 1.05).toFixed(3), font, y: 0.55, in: { kind: inK, dur: 0.8, stag: 0.1 }, shadow: true, z: 2 }); }
    else if (v === 'left') text(ctx, { lines, size: +(size * 0.95).toFixed(3), font, align: 'left', x: 0.12 + Math.min(0.78, chars * size * 0.5) / 2, y: 0.5, lineGap: 1.0, in: { kind: 'slideL', dur: 0.7, stag: 0.12 }, shadow: true, z: 2 });
    else text(ctx, { lines, size, font, y: 0.5, lineGap: 1.02, in: { kind: inK, dur: 0.8, stag: 0.12 }, shadow: true, z: 2 });
    const sub = sentenceLines(p.sub, 1, 34); if (sub.length && nWords(sub) <= 5) text(ctx, { u0: 1.1, lines: sub, size: 0.046, font: F(ctx, 'small'), y: ctx.v.pick([0.86, 0.14]), track: 0.12, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    cue(ctx, 0.05, 'impact'); cue(ctx, 0.05, 'whoosh'); cam(ctx, 0.6, 'punch');
  },
};

ARCH.word_pack = {
  about: 'A giant word arrives sliced, then snaps up to the top as two lines while the pack drops in with a blur and lands with a bounce (McDonald\'s, Wendy\'s). Variants: drop | side (the pack whips in from a side) | peek (the pack rises huge from the bottom edge).',
  params: { lines: 'the giant word (1-2 lines, up to 8 letters each)', font: 'a caps font', pack: 'hero | hero2 | hero3', variant: 'drop | side | peek', tilt: 'degrees -20..20', tag: 'optional tiny line (max 3 words)' },
  packs: 'one',
  build(p, ctx) {
    const lines = wordsLines(p.lines || p.word, 2, 8), chars = Math.max(...lines.map((l) => l.length), 1), size = +(fitSize(chars, 'giant') * (lines.length > 1 ? 0.88 : 1)).toFixed(3), id = packId(ctx, p.pack), font = F(ctx, 'giant', p.font), v = variantOf(ctx, p, ['drop', 'side', 'peek']);
    const tilt = num(p.tilt, ctx.v.range(-12, 12), -20, 20), u1 = Math.min(1.2, ctx.dur * 0.42), top = v === 'peek' ? 0.2 : 0.17;
    decor(ctx, ctx.v.chance(0.5) ? 'none' : undefined);
    text(ctx, { lines, size, font, y: 0.5, lineGap: 1.0, in: { kind: 'slice', dur: 0.8, stag: 0.1 }, shadow: true, z: 2, keys: [{ u: u1, x: 0.5, y: 0.5, s: 1 }, { u: u1 + 0.45, x: 0.5, y: top, s: 0.5, e: 'inOutCubic' }] });
    if (v === 'peek') { const rest = restPose(ctx, id, ctx.v.range(0.4, 0.6), 0.86, 0.6, tilt, false, 0.62, true); movePack(ctx, id, [...enter(ctx, 'rise', u1 + 0.05, rest), drift(ctx, Math.max(u1 + 1.0, ctx.dur - 0.05), rest)]); }
    else if (v === 'side') { const rest = restPose(ctx, id, 0.5, 0.63, 0.5, tilt, true), d = ctx.v.pick([-1, 1]); movePack(ctx, id, [...enter(ctx, 'whip', u1 + 0.05, rest, d), drift(ctx, Math.max(u1 + 1.0, ctx.dur - 0.05), rest)]); }
    else { const rest = restPose(ctx, id, 0.5, 0.63, 0.5, tilt, true); movePack(ctx, id, [...enter(ctx, 'drop', u1 + 0.05, rest, -1), drift(ctx, Math.max(u1 + 1.0, ctx.dur - 0.05), rest)]); }
    const tag = sentenceLines(p.tag, 1, 24); if (tag.length && nWords(tag) <= 3) text(ctx, { u0: u1 + 0.9, lines: tag, size: 0.04, font: F(ctx, 'small'), y: 0.86, track: 0.14, in: { kind: 'fade', dur: 0.4, stag: 0.2 }, front: true, z: 5 });
    cue(ctx, 0.05, 'impact'); cue(ctx, u1 + 0.1, 'whoosh'); cue(ctx, u1 + 0.75, 'impact'); cam(ctx, u1 + 0.72, 'punch');
  },
};

ARCH.wall = {
  about: 'A WALL of one repeated word fills the screen in thin outline, rows scrolling in opposite directions with a motion-blur trail on arrival, a few words solid (Goli "NEW", Sunbake, Wendy\'s). Variants: grid | diagonal (tilted rows) | columns (vertical) | marquee (3 huge rows). The pack whips across it and shrinks, or drops, or is absent; small pieces float.',
  params: { word: 'ONE real word: the product/brand name, or a plain benefit word already common for this kind of product (NEW, COLD, FRESH, CRISP, ZERO, ICE...). NEVER an invented slogan or made-up compound (no "SPRITELIFE"): up to 10 letters', font: 'a caps font', variant: 'grid | diagonal | columns | marquee', pack: 'hero | hero2 | hero3 | none', action: 'cross | drop | absent', tilt: 'degrees', pieces: 'floating small pieces 0-5', caption: 'a benefit line typed under the pack (max 5 words, e.g. real juice, zero sugar)', badge: 'a round sticker (max 2 words, e.g. NEW)' },
  packs: 'optional',
  build(p, ctx) {
    const word = wordsLines(p.word || p.lines, 1, 10)[0] || 'NEW', chars = word.length, v = variantOf(ctx, p, ['grid', 'diagonal', 'columns', 'marquee']), font = F(ctx, 'giant', p.font);
    const base = clamp(0.36 / (chars * 0.5), 0.09, 0.24), size = +(v === 'marquee' ? clamp(base * 1.7, 0.16, 0.3) : base).toFixed(3);
    shape(ctx, { kind: 'wall', word, font, size, rowGap: v === 'marquee' ? 1.25 : 1.02, colGap: 1.45, speed: ctx.v.range(0.04, 0.08), rot: v === 'diagonal' ? ctx.v.pick([-14, 14, -20]) : v === 'columns' ? 90 : 0, color: ctx.pal.ink, alpha: ctx.v.range(0.75, 0.95), hl: [{ r: 2, c: 1, t: 0.3 }, { r: 5, c: 0, t: 0.55 }, { r: 7, c: 2, t: 0.8 }], u0: 0, z: 2 });
    const np = Math.round(num(p.pieces, 4, 0, 5)); if (np && ctx.props.length) [[0.74, 0.3], [0.18, 0.66], [0.84, 0.86], [0.3, 0.14], [0.9, 0.5]].slice(0, np).forEach(([x, y], i) => push(ctx, { kind: 'sprite', src: ctx.props[i % ctx.props.length].id, t0: A(ctx, 0.7 + i * 0.35), t1: A(ctx, ctx.dur), x, y, w: 0.13, r: i % 2 ? 20 : -15, in: { kind: 'pop', dur: 0.35 }, idle: { kind: 'float', amp: 0.012, speed: 1.1 }, shadow: false, z: 4 }));
    const id = packId(ctx, p.pack);
    if (oneOf(p.pack, ['none'], 'x') !== 'none' && p.action !== 'absent' && ctx.packs[id]) {
      shape(ctx, { kind: 'circle', x: 0.5, y: 0.58, size: 0.34, color: '#ffffff', alpha: 0.24, in: { kind: 'pop', dur: 0.5, delay: 0.3 }, idle: { kind: 'pulse', amp: 0.04, speed: 1.2 }, u0: 0.2, z: 2.5 });   // a glow behind the pack
      shape(ctx, { kind: 'circle', x: 0.5, y: 0.58, size: 0.46, color: ctx.pal.ink, alpha: 0.1, in: { kind: 'pop', dur: 0.6, delay: 0.4 }, u0: 0.2, z: 2.4 });
      const rest = restPose(ctx, id, 0.5, 0.58, 0.5, num(p.tilt, ctx.v.range(-12, 12), -20, 20), true), act = oneOf(p.action, ['cross', 'drop'], ctx.v.pick(['cross', 'drop', 'cross']));
      if (act === 'drop') movePack(ctx, id, [...enter(ctx, 'drop', 0.3, rest), drift(ctx, Math.max(1.6, ctx.dur - 0.05), rest)]);
      else { const d = ctx.v.pick([-1, 1]); movePack(ctx, id, [{ u: 0.15, x: d < 0 ? -0.6 : 1.6, y: 0.7, w: rest.w * 1.15, r: d < 0 ? -38 : 38, blur: 18 }, { u: 0.7, ...rest, blur: 0, e: 'outExpo' }, { u: 1.05, ...rest, w: +(rest.w * 1.1).toFixed(3), e: 'inOutCubic' }, { u: 1.5, ...rest, e: 'inOutCubic' }, { u: Math.max(1.9, ctx.dur - 0.1), x: d < 0 ? 0.62 : 0.38, y: 0.58, w: +(rest.w * 0.68).toFixed(3), r: 0, e: 'inOutCubic' }]); }
      shape(ctx, { kind: 'burst', x: 0.5, y: 0.58, n: 20, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.7, u1: 1.8, z: 4 });
      const cap = sentenceLines(p.caption, 1, 26); if (cap.length && nWords(cap) <= 5) {   // the benefit line sits on a dark pill in FRONT of the pack, sized to the words so nothing is ever cut off
        const capSize = +clamp(0.8 / (Math.max(...cap.map((l) => l.length)) * 0.58), 0.03, 0.044).toFixed(3), capW = +clamp(Math.max(...cap.map((l) => l.length)) * capSize * 0.62 + 0.1, 0.3, 0.86).toFixed(3);
        shape(ctx, { kind: 'rect', x: 0.5, y: 0.9, w: capW, h: capSize * 1.7, radius: 0.5, color: '#0c0c10', alpha: 0.82, in: { kind: 'pop', dur: 0.35 }, u0: 0.9, u1: ctx.dur - 0.25, z: 6 });
        text(ctx, { u0: 1.0, lines: cap, size: capSize, font: F(ctx, 'small'), upper: false, color: '#ffffff', noContrast: true, y: 0.9, in: { kind: 'blurin', dur: 0.4, stag: 0.15 }, front: true, z: 6.5 });
      }
      const bad = sentenceLines(p.badge, 1, 14); if (bad.length && nWords(bad) <= 2) { shape(ctx, { kind: 'circle', x: 0.84, y: 0.16, size: 0.09, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.4, delay: 0.5 }, idle: { kind: 'pulse', amp: 0.05, speed: 1.4 }, u0: 0.5, z: 4 }); text(ctx, { u0: 0.7, lines: bad, size: 0.04, font: F(ctx, 'head'), x: 0.84, y: 0.16, r: -12, color: inkFor(ctx.pal.accent, null), noContrast: true, in: { kind: 'pop', dur: 0.3 }, front: true, z: 6 }); }
      cue(ctx, 0.15, 'whoosh'); cue(ctx, 0.7, 'impact'); cam(ctx, 0.68, 'punch', { amp: 0.04 });
    } else cue(ctx, 0.1, 'tick');
  },
};

ARCH.typed = {
  about: 'A calm statement TYPED word by word in small clean bold type (each word arrives with a soft motion-blur trail) on a flat colour; one key word bigger with a hand-drawn oval round it (Goli "Meet the All New", Unicity). Variants: left | center | right | bottom | swap (one BIG word at a time replaces the last, on the beat). The pack is absent or small.',
  params: { lines: 'the statement, 1-3 short lines (max 9 words in all)', variant: 'left | center | right | bottom | swap', style: 'blurin | rise', emphasis: 'optional key word (up to 10 letters), shown bigger', scribble: 'true/false', wave: 'true/false', pack: 'none | hero | hero2 | hero3 (small)', font: 'poppins | inter | bricolage' },
  packs: 'optional',
  build(p, ctx) {
    const lines = sentenceLines(p.lines || p.sentence, 3, String(p.energy) === 'true' ? 17 : 30); while (nWords(lines) > 9) lines[lines.length - 1] = lines[lines.length - 1].split(' ').slice(0, -1).join(' ');
    const v = variantOf(ctx, p, ['left', 'center', 'right', 'bottom', 'swap']), chars = Math.max(...lines.map((l) => l.length), 1), size = +clamp(0.86 / (chars * 0.62), 0.045, String(p.energy) === 'true' ? 0.086 : 0.062).toFixed(3), stag = ctx.v.range(0.13, 0.19), tEnd = nWords(lines) * stag + 0.35, font = F(ctx, 'small', p.font), inK = oneOf(p.style, ['blurin', 'rise'], ctx.v.pick(['blurin', 'rise']));
    if (String(p.wave) === 'true' || (p.wave === undefined && ctx.v.chance(0.4))) decor(ctx, 'waves'); else decor(ctx, ctx.v.chance(0.5) ? 'none' : ctx.v.pick(['rings', 'dots', 'stripes', 'rays']));   // no wave when the plan turned it off
    if (v === 'swap') {
      const ws = lines.join(' ').split(/\s+/).filter(Boolean).slice(0, 7), per = clamp((ctx.dur - 0.3) / ws.length, 0.28, 0.6);
      ws.forEach((w, i) => text(ctx, { u0: 0.15 + i * per, u1: 0.15 + (i + 1) * per + (i === ws.length - 1 ? 0.8 : 0.05), lines: [w], size: +clamp(0.8 / (Math.max(3, w.length) * 0.5), 0.12, 0.3).toFixed(3), font: F(ctx, 'giant'), upper: true, y: 0.5, r: ctx.v.pick([0, 0, -6, 6]), color: i % 2 ? ctx.pal.accent : ctx.pal.ink, in: { kind: ctx.v.pick(['pop', 'slam', 'slideL']), dur: 0.22 }, z: 5, front: true, shadow: true })); ws.forEach((w, i) => cue(ctx, 0.15 + i * per, 'tick'));
    } else {
      const wE = Math.min(0.8, chars * size * 0.62), left = v === 'left', right = v === 'right', y0 = String(p.energy) === 'true' ? 0.15 : v === 'bottom' ? 0.72 : (p.emphasis ? 0.4 : 0.47);   // energetic hook: the words sit at the TOP and the whole product is the star below them
      text(ctx, { lines: lines.filter(Boolean), size, font, upper: false, align: left ? 'left' : right ? 'right' : 'center', x: left ? +(0.11 + wE / 2).toFixed(3) : right ? +(0.89 - wE / 2).toFixed(3) : 0.5, y: y0, lineGap: 1.5, in: { kind: inK, dur: 0.42, stag }, z: 5, front: true });
      const em = cleanWord(p.emphasis, 10);
      if (em) { const esz = +clamp(0.86 / (em.length * 0.5), 0.09, 0.16).toFixed(3), ey = String(p.energy) === 'true' ? 0.35 : v === 'bottom' ? 0.6 : 0.58; text(ctx, { u0: tEnd, lines: [em.toUpperCase()], size: esz, font: F(ctx, 'head', p.emfont), color: ctx.pal.accent, y: ey, in: { kind: em.includes(' ') ? 'blurin' : 'pop', dur: 0.35 }, z: 5, front: true, shadow: true }); if (String(p.scribble) !== 'false') shape(ctx, { kind: 'oval', u0: tEnd + 0.35, x: 0.5, y: ey, w: +clamp(em.length * esz * 0.55 + 0.14, 0.3, 0.9).toFixed(3), h: +(esz * 0.75).toFixed(3), r: -3, color: ctx.pal.ink, width: 0.007, dur: 0.7, z: 5 }); cue(ctx, tEnd, 'impact'); }
      for (let i = 0; i < nWords(lines); i++) cue(ctx, 0.15 + i * stag, 'tick');
    }
    if (String(p.energy) === 'true' && v !== 'swap') {   // ENERGY: the calm line is not alone: a ghost word wall, rays, a burst, drifting pieces and the pack rising huge from the bottom corner
      const gw = String(cleanWord(p.ghost || p.emphasis || ctx.brand, 8)).toUpperCase().split(' ')[0];
      if (gw) shape(ctx, { kind: 'wall', word: gw, font: F(ctx, 'giant'), size: 0.17, rowGap: 1.05, colGap: 1.5, speed: ctx.v.range(0.03, 0.06), color: ctx.pal.ink, alpha: 0.16, rot: ctx.v.pick([-14, 14, 0]), hl: [], u0: 0, z: 1 });
      decor(ctx, 'rays');
      shape(ctx, { kind: 'burst', x: 0.5, y: 0.5, n: 26, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.15, u1: 1.3, z: 4 });
      ctx.props.slice(0, 4).forEach((pr, i) => { const [x, y, w] = [[0.09, 0.52, 0.17], [0.91, 0.46, 0.15], [0.1, 0.9, 0.18], [0.9, 0.92, 0.16]][i]; push(ctx, { kind: 'sprite', src: pr.id, t0: A(ctx, 0.25 + i * 0.15), t1: A(ctx, ctx.dur), x, y, w, r: ctx.v.range(-25, 25), in: { kind: 'pop', dur: 0.4 }, idle: { kind: 'float', amp: 0.012, speed: 1 }, shadow: false, z: 4 }); });   // pieces sit at the sides and bottom: never on the words
      if (ctx.packs.hero && !(p.pack && p.pack !== 'none')) { const lf = v === 'left', rt = v === 'right', px = lf ? 0.52 : rt ? 0.48 : 0.5, rest = restPose(ctx, 'hero', px, 0.68, 0.44, ctx.v.range(8, 16) * (lf ? 1 : -1), false, 0.4); movePack(ctx, 'hero', [...enter(ctx, ctx.v.pick(['spin', 'whip', 'pop']), 0.08, rest, lf ? 1 : -1), drift(ctx, Math.max(1.3, ctx.dur - 0.05), rest)]); cue(ctx, 0.1, 'whoosh'); }   // the WHOLE product, big, from the first moments: it is what grabs the eye
      cam(ctx, 0.5, 'punch');
    }
    const id = packId(ctx, p.pack);
    if (p.pack && p.pack !== 'none' && ctx.packs[id]) { const rest = restPose(ctx, id, ctx.v.range(0.35, 0.65), 0.84, 0.3, ctx.v.range(-8, 8), false, 0.28); movePack(ctx, id, [...enter(ctx, 'rise', 0.6, rest), drift(ctx, Math.max(2.0, ctx.dur - 0.05), rest)]); }
  },
};

ARCH.showcase = {
  about: 'The HERO scene: the pack whips in and comes to rest BIG and tilted, slowly rolling; a two-line bold title with a tiny kicker above it types in; tiny handwritten cheer words pop around it; big BLURRED ingredients sit cropped at the corners, or fruit flies around at the edges; optionally a giant word runs vertically up the side (Goli, Berry White, Unicity). Poses: centre | left-bleed | right-bleed | bottom-peek | spin | top-drop.',
  params: { pack: 'hero | hero2 | hero3', pose: 'centre | left-bleed | right-bleed | bottom-peek | spin | top-drop', tilt: 'degrees -28..28', entrance: 'whip | drop | rise | spin', kicker: 'optional tiny line above the title (max 4 words)', title: 'the title, 1-2 lines (max 6 words)', cheer: 'optional 2-4 tiny handwritten words (up to 7 letters)', blurred: 'true/false: big blurred ingredients at the corners', vertical: 'optional giant vertical word (up to 10 letters): the BRAND name or its promise (CALM, FRESH, PURE), never a guessed ingredient or flavour', props: 'flying sharp pieces 0-7', from: 'corners | edges | sides | burst | top' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), pose = variantOf(ctx, { variant: p.pose }, ['centre', 'left-bleed', 'right-bleed', 'bottom-peek', 'spin', 'top-drop']), vert = cleanWord(p.vertical, 11).toUpperCase();
    const sg = pose === 'left-bleed' ? -1 : pose === 'right-bleed' ? 1 : ctx.v.pick([-1, 1]), tilt = num(p.tilt, sg * ctx.v.range(14, 26), -28, 28);
    const bleedPose = pose === 'left-bleed' || pose === 'right-bleed', vsg = bleedPose ? -sg : sg;   // the vertical word runs on the side the pack does NOT bleed from
    const rp = (c, id2, x, y, w, r, gt, mh, bl) => { const q = restPose(c, id2, x, y, w, r, gt, mh, bl); if (vert && !bleedPose) { q.x = +(0.5 - vsg * 0.07).toFixed(3); const edge = vsg > 0 ? 0.76 : 0.24; q.w = +Math.min(q.w, Math.max(0.2, 1.5 * Math.abs(edge - q.x))).toFixed(3); } return q; };
    let rest, path, titleX = 0.5, titleAlign = 'center';
    if (pose === 'left-bleed') { rest = restPose(ctx, id, 0.16, 0.6, 0.62, tilt, false, 0.62, true); path = [...enter(ctx, 'whip', 0.1, rest, -1)]; titleX = 0.68; titleAlign = 'left'; }
    else if (pose === 'right-bleed') { rest = restPose(ctx, id, 0.84, 0.6, 0.62, tilt, false, 0.62, true); path = [...enter(ctx, 'whip', 0.1, rest, 1)]; titleX = 0.32; titleAlign = 'right'; }
    else if (pose === 'bottom-peek') { rest = rp(ctx, id, ctx.v.range(0.4, 0.6), 0.86, 0.62, tilt * 0.5, false, 0.62, true); path = [...enter(ctx, 'rise', 0.1, rest)]; }
    else if (pose === 'spin') { rest = rp(ctx, id, 0.5, 0.58, vert ? 0.44 : 0.5, tilt, !!vert); path = [{ u: 0.1, x: rest.x, y: rest.y, w: rest.w * 0.5, r: rest.r - 360, blur: 6, o: 1 }, { u: 0.95, ...rest, blur: 0, e: 'outBack' }]; }
    else if (pose === 'top-drop') { rest = rp(ctx, id, ctx.v.range(0.42, 0.58), 0.6, vert ? 0.44 : 0.5, tilt, !!vert); path = [...enter(ctx, 'drop', 0.1, rest)]; }
    else { rest = rp(ctx, id, ctx.v.range(0.42, 0.6), 0.6, vert ? 0.44 : 0.5, tilt, !!vert); path = [...enter(ctx, oneOf(p.entrance, ENTR, ctx.v.entrance()), 0.1, rest, sg)]; }
    if (vert) text(ctx, { lines: [vert], size: +clamp(Math.min(0.25, 2.2 / vert.length), 0.17, 0.25).toFixed(3), r: vsg > 0 ? 90 : -90, x: vsg > 0 ? 0.835 : 0.165, y: 0.5, alpha: 0.9, font: F(ctx, 'giant', p.font), in: { kind: 'slideL', dur: 0.6, stag: 0.05 }, z: 2 });
    if (vert && !bleedPose) titleX = +(titleX - vsg * 0.06).toFixed(3);   // the title keeps clear of the vertical word
    decor(ctx);
    movePack(ctx, id, [...path, drift(ctx, Math.max(1.4, ctx.dur * 0.7), rest, sg), { ...drift(ctx, Math.max(1.5, ctx.dur - 0.05), rest, -sg), w: rest.w, r: rest.r - 3 * sg }]);
    const kicker = sentenceLines(p.kicker, 1, 28), title = sentenceLines(p.title, 2, 15), ty = pose === 'bottom-peek' ? 0.22 : 0.15;
    if (kicker.length && nWords(kicker) <= 4) text(ctx, { u0: 0.4, lines: kicker, size: 0.044, font: F(ctx, 'small'), upper: true, track: 0.1, y: ty - 0.075, x: titleX, align: titleAlign, in: { kind: 'blurin', dur: 0.4, stag: 0.22 }, front: true, shadow: true, z: 5 });   // an eyebrow line reads as a deliberate design element in caps with tracking, not a faded afterthought in plain sentence case
    if (title.length && nWords(title) <= 6) text(ctx, { u0: 0.8, lines: title, size: +clamp(0.78 / (Math.max(...title.map((l) => l.length)) * 0.72), 0.045, 0.07).toFixed(3), font: F(ctx, 'small'), upper: false, y: ty, x: titleX, align: titleAlign, lineGap: 1.25, in: { kind: 'blurin', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    if (String(p.blurred) === 'true' && ctx.props.length && ctx.v.chance(0.3)) [[0.05, 0.9, 0.3, 12], [0.97, 0.7, 0.24, 14], [0.03, 0.16, 0.17, 9]].forEach(([x, y, w, b], i) => push(ctx, { kind: 'sprite', src: ctx.props[i % ctx.props.length].id, t0: A(ctx, 0.5 + i * 0.25), t1: A(ctx, ctx.dur), x, y, w, r: i * 40, blur: b, in: { kind: 'fade', dur: 0.5 }, idle: { kind: 'drift', amp: 0.012, speed: 0.8 }, shadow: false, z: 4 }));
    const words = (Array.isArray(p.cheer) ? p.cheer : []).map((w) => cleanWord(w, 7)).filter(Boolean).slice(0, 4), sideX = (k) => +clamp(rest.x + k * (rest.w * 0.5 + 0.1), 0.1, 0.9).toFixed(3), CP = [[sideX(-1), 0.6, -9], [sideX(1), 0.84, 8], [sideX(1), 0.44, 12], [sideX(-1), 0.82, -12]];   // the tiny cheer words sit BESIDE the pack, never on it
    words.forEach((w, i) => text(ctx, { u0: 1.0 + i * 0.3, lines: [w], size: 0.03, font: F(ctx, 'script'), upper: true, x: CP[i][0], y: CP[i][1], r: CP[i][2], in: { kind: 'pop', dur: 0.25 }, front: true, z: 5 }));
    const np = clamp(Math.round(num(p.props, ctx.v.pick([0, 3, 4, 5]), 0, 6)), 0, 6); if (np >= 2) scatter(ctx, { n: np, from: oneOf(p.from, ['corners', 'edges', 'sides', 'burst', 'top'], ctx.v.pick(['corners', 'edges', 'sides', 'top'])), u0: 0.85, u1: ctx.dur - 0.75, seed: (ctx.seed || 3) + 7 });   // clear again before the closing brand name / CTA has to read
    if (ctx.v.chance(0.7)) shape(ctx, { kind: 'burst', x: rest.x, y: rest.y, n: 22, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.7, u1: 1.8, z: 4 });
    cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.7, 'impact'); cam(ctx, 0.68, 'punch');
  },
};

ARCH.parade = {
  about: 'Several pack shots (flavours) replace each other: each whips in diagonally from a corner, rotated, decelerates into place, holds, and is replaced by the next one from the opposite corner; tiny two-line text appears in the gaps (Pluckk).',
  params: { packs: 'list of 2-3 of hero | hero2 | hero3 (the order they appear)', lines: 'list of tiny lines, one per pack (max 3 words each)', tilt: 'degrees 12..26' },
  packs: 'several',
  build(p, ctx) {
    const have = Object.keys(ctx.packs), want = (Array.isArray(p.packs) ? p.packs : []).filter((x) => have.includes(x)), ids = (want.length ? want : have).slice(0, 3);
    const seq = ids.length >= 2 ? ids : [ids[0], ids[0]], lines = Array.isArray(p.lines) ? p.lines : [], tilt = num(p.tilt, ctx.v.range(12, 26), 12, 26), d0 = ctx.v.pick([-1, 1]);
    const step = Math.max(0.85, (ctx.dur - 0.5) / seq.length); decor(ctx, ctx.v.chance(0.5) ? 'none' : undefined);
    seq.forEach((id, i) => {
      const dir = i % 2 ? -d0 : d0, u = 0.1 + i * step - (i ? 0.3 : 0), rest = restPose(ctx, id, dir < 0 ? 0.62 : 0.38, ctx.v.range(0.5, 0.6), 0.5, tilt * (dir < 0 ? -1 : 1), false);
      movePack(ctx, id, i < seq.length - 1 ? [...enter(ctx, 'whip', u, rest, dir), exitMove('whip', Math.min(ctx.dur - 0.05, u + step + 0.2), rest, -dir)] : [...enter(ctx, 'whip', u, rest, dir), drift(ctx, Math.max(u + 0.9, ctx.dur - 0.05), rest)]);   // the last pack stays
      const ln = sentenceLines(lines[i], 2, 20); if (ln.length && nWords(ln) <= 3) { const hT = ln.length * 0.065 * 0.6 + 0.02, y = freeY(ctx, [box(ctx, id, rest.x, rest.y, rest.w, tilt)], hT, i % 2 ? 'top' : 'bottom'); text(ctx, { u0: u + 0.55, u1: Math.min(ctx.dur, u + step + 0.2 + (i === seq.length - 1 ? 1 : 0)), lines: ln, size: 0.065, font: F(ctx, 'small'), upper: true, x: dir < 0 ? 0.3 : 0.7, y, track: 0.1, in: { kind: 'slideL', dur: 0.35, stag: 0.2 }, out: { kind: 'fade', dur: 0.2 }, front: true, z: 5 }); }
      cue(ctx, u, 'whoosh'); cue(ctx, u + 0.55, 'impact');
    });
    cam(ctx, 0.65, 'punch', { amp: 0.04 });
  },
};

ARCH.ring = {
  about: 'The packs multiply into a spinning radial ring / grid around a centre word (Pluckk "JUST FRUIT IN A BOTTLE").',
  params: { packs: 'list of hero | hero2 | hero3 used in the ring', lines: 'the centre words (max 4 words, up to 2 lines)', font: 'a caps font', style: 'ring | grid' },
  packs: 'several',
  build(p, ctx) {
    const have = Object.keys(ctx.packs), ids = ((Array.isArray(p.packs) ? p.packs : []).filter((x) => have.includes(x)).concat(have)).slice(0, 3), lines = wordsLines(p.lines || p.word, 2, 12), style = variantOf(ctx, { variant: p.style }, ['ring', 'grid']);
    shape(ctx, { kind: 'circle', x: 0.5, y: 0.5, size: 0.46, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.4 }, u0: 0.1, z: 4.5 });   // a solid disc IN FRONT of the ring of packs: the words on it are always readable
    push(ctx, { kind: 'pattern', src: ids, sub: style === 'grid' ? 'grid' : 'radial', cx: 0.5, cy: 0.5, w: 0.17, spin: ctx.v.pick([35, -35, 55]), rings: 2, cols: 4, rows: 7, stag: 0.03, alpha: 1, t0: A(ctx, 0.25), t1: A(ctx, ctx.dur) });
    if (lines.length) text(ctx, { u0: 0.5, lines, size: +clamp(0.36 / (Math.max(...lines.map((l) => l.length)) * 0.5), 0.06, 0.11).toFixed(3), font: F(ctx, 'giant', p.font), color: inkFor(ctx.pal.accent, null), noContrast: true, y: 0.5, in: { kind: 'rise', dur: 0.4, stag: 0.25 }, front: true, z: 5 });
    cue(ctx, 0.25, 'whoosh'); cue(ctx, 0.6, 'impact');
  },
};

ARCH.callouts = {
  about: 'The pack small and upright, a bold sentence above it, tiny white icons appear one by one around it, each with a tiny label and a hairline connector DRAWN ON from the pack (Goli "Non-GMO / Gluten-Free / Kosher"). Variants: sides | radial (icons on a circle) | list (labels stacked on one side).',
  params: { pack: 'hero | hero2 | hero3', sentence: 'a sentence, 1-2 lines (max 8 words)', items: 'list of 2-5 short labels (max 2 words each)', variant: 'sides | radial | list', entrance: 'spin | pop | rise', float: 'true/false: small ingredients drift in the corners' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), items = (Array.isArray(p.items) ? p.items : []).map((s) => cleanWord(s, 26)).filter(Boolean).slice(0, 5), sent = sentenceLines(p.sentence, 2, 26);   // 26, not 18: "No artificial colours/flavours/sweeteners" used to all get chopped down to the same "No artificial"
    let v = variantOf(ctx, p, ['sides', 'radial', 'list']);
    if (v !== 'list' && Math.max(0, ...items.map((s) => s.length * 0.026 + 0.08)) > 0.25) v = 'list';   // long claim pills do not fit beside a centred pack: all of them go on ONE side, the pack on the other
    const px = v === 'list' ? ctx.v.pick([0.32, 0.68]) : 0.5, rest = restPose(ctx, id, px, 0.64, v === 'radial' ? 0.3 : 0.34, ctx.v.range(-9, 9), false, 0.46);
    movePack(ctx, id, [...enter(ctx, oneOf(p.entrance, ['spin', 'pop', 'rise'], ctx.v.pick(['spin', 'pop', 'rise'])), 0.15, rest), drift(ctx, Math.max(2.0, ctx.dur - 0.05), rest)]);
    if (sent.length) text(ctx, { u0: 0.1, lines: sent, size: +clamp(0.9 / (Math.max(...sent.map((l) => l.length)) * 0.6), 0.05, 0.07).toFixed(3), font: F(ctx, 'small'), upper: false, y: 0.24, lineGap: 1.25, in: { kind: 'blurin', dur: 0.4, stag: 0.13 }, front: true, z: 5 });
    // ENERGY behind the pack: rays, a glow disc, a ghost word wall and a burst when the pack lands
    decor(ctx, 'rays');
    shape(ctx, { kind: 'circle', x: rest.x, y: rest.y, size: 0.4, color: '#ffffff', alpha: 0.22, in: { kind: 'pop', dur: 0.5, delay: 0.3 }, idle: { kind: 'pulse', amp: 0.05, speed: 1.3 }, u0: 0.2, z: 2.5 });
    const gwc = String(items[0] || '').toUpperCase().split(' ')[0].slice(0, 8); if (gwc.length >= 3) shape(ctx, { kind: 'wall', word: gwc, font: F(ctx, 'giant'), size: 0.15, rowGap: 1.1, colGap: 1.6, speed: ctx.v.range(0.03, 0.05), color: ctx.pal.ink, alpha: 0.11, rot: ctx.v.pick([-12, 12, 0]), hl: [], u0: 0, z: 1 });
    shape(ctx, { kind: 'burst', x: rest.x, y: rest.y, n: 22, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.25, u1: 1.3, z: 4 }); cam(ctx, 0.4, 'punch');
    let POS;
    if (v === 'radial') { const n = items.length || 3, a0 = ctx.v.range(0, 40); POS = items.map((_, i) => { const a = ((i / n) * 360 + a0 - 90) * Math.PI / 180; const sg = Math.cos(a) >= 0 ? 1 : -1, dx = sg * Math.max(Math.abs(Math.cos(a)) * 0.34, rest.w * 0.5 + 0.1);   // never on the pack itself: at least a hand's width outside it
      return [+clamp(rest.x + dx, 0.14, 0.86).toFixed(3), +(rest.y + Math.sin(a) * 0.2).toFixed(3), sg > 0 ? 'R' : 'L']; }); }
    else if (v === 'list') { const sd = px < 0.5 ? 'R' : 'L', x = sd === 'R' ? 0.76 : 0.24; POS = items.map((_, i) => [x, +(0.47 + i * 0.075).toFixed(3), sd]); }
    else POS = [[0.8, 0.51, 'R'], [0.8, 0.61, 'R'], [0.8, 0.71, 'R'], [0.13, 0.61, 'L'], [0.17, 0.71, 'L']];
    items.forEach((lab, i) => {
      const [ix0, iy, sd] = POS[i], labSize = +clamp(0.68 / (lab.length * 0.62), 0.026, 0.04).toFixed(3), tw = lab.length * labSize * 0.62, pw = +(tw + 0.08).toFixed(3), ix = +(sd === 'R' ? Math.min(Math.max(ix0, rest.x + rest.w * 0.5 + 0.075), 0.965 - pw) : Math.max(Math.min(ix0, rest.x - rest.w * 0.5 - 0.075), 0.035 + pw)).toFixed(3), u = 0.9 + i * 0.36, sx = rest.x + (sd === 'R' ? 1 : -1) * (rest.w * 0.5 + 0.012), sy = clamp(iy, rest.y - 0.14, rest.y + 0.14), pxc = +(ix + (sd === 'R' ? pw / 2 : -pw / 2)).toFixed(3), pc = i % 2 ? ctx.pal.ink : ctx.pal.accent;
      shape(ctx, { kind: 'line', x1: +sx.toFixed(3), y1: +sy.toFixed(3), x2: +ix.toFixed(3), y2: iy, cx: +((sx + ix) / 2).toFixed(3), cy: +(sy + (iy - sy) * 0.3).toFixed(3), color: ctx.pal.ink, alpha: 0.9, width: 0.0034, dur: 0.4, u0: u + 0.3, u1: ctx.dur - 0.25, z: 4.1 });   // matches the pill's own delay: a line pointing at an empty spot for 0.3s read as a stray artifact, not a connector
      shape(ctx, { kind: 'rect', x: pxc, y: iy, w: pw, h: labSize * 1.65, radius: 0.5, color: pc, in: { kind: 'pop', dur: 0.4, delay: 0.3 }, u0: u, u1: ctx.dur - 0.25, z: 4.6 });
      text(ctx, { u0: u + 0.4, lines: [lab], size: labSize, font: F(ctx, 'head'), upper: true, track: 0.04, color: (() => { const q = rgb(pc), l = (0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]) / 255; return l < 0.55 ? '#ffffff' : '#0c0c10'; })(), noContrast: true, x: pxc, y: iy, in: { kind: 'pop', dur: 0.3 }, front: true, z: 5 });
      shape(ctx, { kind: 'burst', x: pxc, y: iy, n: 10, color: pc, color2: ctx.pal.ink, life: 0.7, u0: u + 0.3, u1: u + 0.9, z: 4.7 });
      cue(ctx, u + 0.3, 'tick');
    });
    if (String(p.float) !== 'false' && ctx.props.length && ctx.v.chance(0.85)) [[0.1, 0.42, 0.15, 20], [0.9, 0.36, 0.15, -25], [0.12, 0.91, 0.17, 10]].forEach(([x, y, w, r], i) => push(ctx, { kind: 'sprite', src: ctx.props[i % ctx.props.length].id, t0: A(ctx, 0.4 + i * 0.3), t1: A(ctx, ctx.dur), x, y, w, r, in: { kind: 'pop', dur: 0.4 }, idle: { kind: 'float', amp: 0.01, speed: 1 }, shadow: false, z: 4 }));
  },
};

ARCH.ingredients = {
  about: 'Round badges pop in as a grid (or a row, or a diagonal), each holding an ingredient picture with a tiny label under it, a title typed above (Goli sleep ingredients).',
  params: { title: 'title (max 5 words)', items: 'list of 2-4 {prop: 0-3 (which prop picture), label: up to 2 words}', pack: 'none | hero | hero2 | hero3 (small)', variant: 'grid | row | diagonal' },
  packs: 'optional',
  build(p, ctx) {
    const items = (Array.isArray(p.items) ? p.items : []).map((it) => ({ prop: Math.round(num(it && it.prop, 0, 0, 3)), label: cleanWord(it && it.label, 16) })).slice(0, 4), n = Math.max(2, items.length), title = sentenceLines(p.title, 1, 30), v = variantOf(ctx, p, ['grid', 'row', 'diagonal']);
    const G = { 2: [[0.3, 0.5], [0.7, 0.5]], 3: [[0.5, 0.34], [0.28, 0.6], [0.72, 0.6]], 4: [[0.3, 0.36], [0.7, 0.36], [0.3, 0.62], [0.7, 0.62]] }[n] || [[0.3, 0.5], [0.7, 0.5]];
    const POS = v === 'row' ? Array.from({ length: n }, (_, i) => [+(0.5 + (i - (n - 1) / 2) * (n > 3 ? 0.24 : 0.3)).toFixed(3), 0.5]) : v === 'diagonal' ? Array.from({ length: n }, (_, i) => [+(0.25 + (i / Math.max(1, n - 1)) * 0.5).toFixed(3), +(0.34 + (i / Math.max(1, n - 1)) * 0.3).toFixed(3)]) : G;
    if (title.length) text(ctx, { u0: 0.15, lines: title, size: 0.058, font: F(ctx, 'small', p.font), upper: false, y: 0.15, in: { kind: ctx.v.pick(['rise', 'blurin']), dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    decor(ctx, ctx.v.chance(0.5) ? 'none' : undefined);
    items.forEach((it, i) => {
      const [x, y] = POS[i] || POS[0], u = 0.5 + i * 0.32, pid = 'prop' + it.prop, has = ctx.props.some((q) => q.id === pid), bs = n > 3 && v === 'row' ? 0.11 : 0.13;
      shape(ctx, { kind: 'circle', x, y, size: bs, color: '#ffffff', alpha: 0.96, in: { kind: 'pop', dur: 0.35 }, u0: u, z: 3 });
      if (has) push(ctx, { kind: 'sprite', src: pid, t0: A(ctx, u + 0.1), t1: A(ctx, ctx.dur), x, y, w: bs * 1.45, r: 0, in: { kind: 'pop', dur: 0.35 }, idle: { kind: 'float', amp: 0.006, speed: 1.2 }, shadow: false, z: 4 });
      if (it.label) text(ctx, { u0: u + 0.35, lines: [it.label], size: 0.04, font: F(ctx, 'small'), upper: false, x, y: +(y + bs + 0.02).toFixed(3), in: { kind: 'rise', dur: 0.35, stag: 0.15 }, front: true, z: 5 });
      cue(ctx, u + 0.05, 'tick');
    });
    const id = packId(ctx, p.pack); if (p.pack && p.pack !== 'none' && ctx.packs[id]) { const rest = restPose(ctx, id, 0.5, 0.86, 0.28, 3, false, 0.24); movePack(ctx, id, [...enter(ctx, 'rise', 1.4, rest), drift(ctx, Math.max(2.2, ctx.dur - 0.05), rest)]); }
  },
};

ARCH.cheer = {
  about: 'The pack in the centre with handwritten cheer words (YIPPEE! WOOHOO! NEW! HOORAY!) popping around it at different tilts (Goli sleep).',
  params: { pack: 'hero | hero2 | hero3', words: 'list of 3-4 cheer words (up to 9 letters each)', entrance: 'pop | spin | drop' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), rest = restPose(ctx, id, ctx.v.range(0.44, 0.56), 0.56, 0.4, ctx.v.range(-10, 10), false, 0.5), words = (Array.isArray(p.words) ? p.words : []).map((w) => cleanWord(w, 9)).filter(Boolean).slice(0, 4);
    decor(ctx, ctx.v.chance(0.4) ? 'none' : undefined);
    movePack(ctx, id, [...enter(ctx, oneOf(p.entrance, ['pop', 'spin', 'drop'], ctx.v.pick(['pop', 'spin', 'drop'])), 0.15, rest), drift(ctx, Math.max(1.6, ctx.dur - 0.05), rest)]);
    const flip = ctx.v.chance(0.5), POS = [[0.24, 0.27, -14], [0.77, 0.3, 12], [0.25, 0.82, 11], [0.76, 0.79, -13]].map(([x, y, r]) => [flip ? 1 - x : x, y, flip ? -r : r]), font = F(ctx, 'script');
    words.forEach((w, i) => { const [x, y, r] = POS[i]; text(ctx, { u0: 0.6 + i * 0.28, lines: [w], size: 0.14, font, upper: true, color: i % 2 ? ctx.pal.ink : ctx.pal.accent, x, y, r, in: { kind: 'pop', dur: 0.3 }, shadow: true, front: true, z: 5 }); cue(ctx, 0.62 + i * 0.28, 'tick'); });
    cue(ctx, 0.15, 'whoosh'); cue(ctx, 0.6, 'impact');
  },
};

ARCH.disc_pack = {
  about: 'A bold colour disc pulses in the centre and the pack spins out of it, a giant word behind (Canva lemon circle, Lay\'s).',
  params: { pack: 'hero | hero2 | hero3', word: 'optional giant word behind (up to 8 letters)', tilt: 'degrees' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), word = cleanWord(p.word, 8).toUpperCase(), rest = restPose(ctx, id, 0.5, 0.52, 0.5, num(p.tilt, ctx.v.range(-14, 14), -22, 22), !!word);
    shape(ctx, { kind: 'circle', x: 0.5, y: 0.52, size: ctx.v.range(0.3, 0.38), color: ctx.pal.accent, in: { kind: 'pop', dur: 0.45 }, idle: { kind: 'pulse', amp: 0.03, speed: 1 }, u0: 0, z: 0 });
    if (word) text(ctx, { u0: 0.3, lines: [word], size: fitSize(word.length, 'giant'), font: F(ctx, 'giant', p.font), y: ctx.v.pick([0.2, 0.82]), in: { kind: 'slam', dur: 0.4 }, shadow: true, z: 2 });
    movePack(ctx, id, [...enter(ctx, 'spin', 0.25, rest), drift(ctx, Math.max(1.5, ctx.dur - 0.05), rest)]);
    shape(ctx, { kind: 'burst', x: 0.5, y: 0.52, n: 22, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.85, u1: 1.9, z: 4 });
    cue(ctx, 0.25, 'whoosh'); cue(ctx, 0.85, 'impact'); cam(ctx, 0.82, 'punch');
  },
};

ARCH.rings_drop = {
  about: 'Concentric rings pulse outward all scene; the pack zooms in spinning out of a dot, big pieces fly in from the frame edges and out again, tiny text at the corners; optionally the range (2-3 packs) rises as a row at the end (Lay\'s).',
  params: { pack: 'hero | hero2 | hero3', tiny: 'tiny top-left text (max 2 words)', line: 'lower-right line (max 3 words)', row: 'true/false: end with a row of 2-3 packs', props: 'flying pieces 0-6' },
  packs: 'one or row',
  build(p, ctx) {
    const id = packId(ctx, p.pack), rest = restPose(ctx, id, 0.5, 0.52, 0.5, ctx.v.range(-14, 14), false);
    shape(ctx, { kind: 'rings', x: 0.5, y: 0.52, n: 9, gap: 0.13, width: 0.06, speed: 0.35, color: ctx.pal.ink, color2: ctx.pal.accent, alpha: 0.22, u0: 0, z: 0 });
    const rowOn = String(p.row) === 'true' && Object.keys(ctx.packs).length >= 2, tRow = Math.max(1.9, ctx.dur - 1.7);
    movePack(ctx, id, rowOn ? [...enter(ctx, 'spin', 0.1, rest), { u: tRow, ...rest, e: 'inOutCubic' }, { u: tRow + 0.5, x: 0.5, y: 0.5, w: 0.3, r: 0, e: 'inOutCubic' }] : [...enter(ctx, 'spin', 0.1, rest), drift(ctx, Math.max(1.6, ctx.dur - 0.05), rest)]);
    const t1 = sentenceLines(p.tiny, 1, 18), t2 = sentenceLines(p.line, 1, 26);
    if (t1.length && nWords(t1) <= 2) text(ctx, { u0: 0.5, lines: t1, size: 0.04, font: F(ctx, 'small'), upper: false, x: 0.2, y: 0.08, in: { kind: 'blurin', dur: 0.4, stag: 0.2 }, front: true, z: 5 });
    if (t2.length && nWords(t2) <= 3) text(ctx, { u0: 1.2, lines: t2, size: 0.05, font: F(ctx, 'small'), upper: true, x: 0.72, y: 0.9, track: 0.06, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    const np = clamp(Math.round(num(p.props, 4, 0, 6)), 0, 6); if (np >= 2) scatter(ctx, { n: np, from: 'corners', u0: 0.8, u1: rowOn ? tRow : ctx.dur, seed: (ctx.seed || 3) + 3 });
    if (rowOn) { const others = Object.keys(ctx.packs).filter((k) => k !== id).slice(0, 2), xs = others.length === 2 ? [0.2, 0.8] : [0.78]; others.forEach((o, i) => push(ctx, { kind: 'sprite', src: o, t0: A(ctx, tRow + 0.3), t1: A(ctx, ctx.dur), x: xs[i], y: 0.52, w: 0.3, r: 0, in: { kind: 'slideU', dur: 0.5 }, idle: { kind: 'float', amp: 0.008, speed: 1 }, z: 4 })); }
    cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.8, 'impact'); cam(ctx, 0.78, 'punch');
  },
};

ARCH.endcard = {
  about: 'The closing card. Variants: centre (the pack, the BRAND NAME big below it, a call to action, an optional badge) | top (a kicker line and the web address big at the TOP, the pack or an open-box shot big at the bottom, cropped by the frame, slowly zooming in: Goli "Try them today! goli.com") | split (the brand runs vertically up one side, the pack on the other). Always the last scene.',
  params: { pack: 'hero | hero2 | hero3 (hero2/hero3 can be an open gift box)', variant: 'centre | top | split', style: 'slam | slice | pop', cta: 'call to action / kicker (max 3 words)', url: 'variant top: the web address to show big (e.g. brand.com)', badge: 'optional tiny badge text (max 2 words)', entrance: 'spin | drop | whip | rise | pop' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), v = variantOf(ctx, { variant: p.variant || p.layout }, ['centre', 'top', 'split']), style = oneOf(p.style, ['slam', 'slice', 'pop'], ctx.v.pick(['slam', 'pop', 'slice'])), ent = oneOf(p.entrance, ENTR, ctx.v.entrance());
    if (v === 'top') {
      const url = cleanWord(p.url || (ctx.brand.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com'), 22).toLowerCase(), cta = sentenceLines(p.cta || ctx.cta, 1, 26), a = clamp((ctx.packs[id] && ctx.packs[id].aspect) || 0.5, 0.25, 1.6);
      if (cta.length) text(ctx, { u0: 0.3, lines: cta, size: 0.04, font: F(ctx, 'small'), upper: false, y: 0.085, in: { kind: 'blurin', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
      text(ctx, { u0: 0.55, lines: [url], size: +clamp(0.84 / (url.length * 0.56), 0.06, 0.12).toFixed(3), font: F(ctx, 'small'), upper: false, y: 0.145, in: { kind: style, dur: 0.5, stag: 0.14 }, shadow: true, front: true, z: 6, isBrand: true });
      const w = +clamp(a > 0.8 ? 0.95 : 0.62, 0.4, 0.95).toFixed(3), rest = { x: ctx.v.range(0.5, 0.6), y: 0.8, w, r: ctx.v.range(-12, -5) };
      movePack(ctx, id, [...enter(ctx, oneOf(ent, ['rise', 'spin', 'drop', 'whip', 'pop'], 'rise'), 0.1, rest), { u: Math.max(1.4, ctx.dur - 0.05), x: rest.x - 0.02, y: 0.79, w: +(w * 1.07).toFixed(3), r: rest.r + 2, e: 'inOutCubic' }]);
      cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.75, 'impact'); return;
    }
    const brandLines = wordsLines(ctx.brand, 2, 12), chars = Math.max(...brandLines.map((l) => l.length), 1);
    if (v === 'split') {
      const sd = ctx.v.pick([-1, 1]), rest = restPose(ctx, id, sd > 0 ? 0.34 : 0.66, 0.52, 0.46, ctx.v.range(-10, 10), false, 0.55);
      text(ctx, { u0: 0.6, lines: [brandLines.join(' ')], size: +clamp(Math.min(0.3, 3.0 / Math.max(6, ctx.brand.length)), 0.14, 0.3).toFixed(3), r: sd > 0 ? -90 : 90, x: sd > 0 ? 0.85 : 0.15, y: 0.5, font: F(ctx, 'giant'), color: inkFor(ctx.pal.c0, ctx.pal.accent), in: { kind: 'slideL', dur: 0.6, stag: 0.05 }, shadow: true, front: true, z: 6, isBrand: true });
      movePack(ctx, id, [...enter(ctx, ent, 0.1, rest, sd), drift(ctx, Math.max(1.4, ctx.dur - 0.05), rest, sd)]);
      const cta = sentenceLines(p.cta || ctx.cta, 1, 24); if (cta.length && nWords(cta) <= 3) text(ctx, { u0: 1.3, lines: cta, size: 0.045, font: F(ctx, 'small'), upper: true, y: 0.92, x: sd > 0 ? 0.36 : 0.64, track: 0.14, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
      cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.75, 'impact'); cam(ctx, 0.72, 'punch'); return;
    }
    const rest = restPose(ctx, id, 0.5, 0.38, 0.46, ctx.v.range(-8, 8), false, 0.52);
    movePack(ctx, id, [...enter(ctx, ent, 0.1, rest), drift(ctx, Math.max(1.4, ctx.dur - 0.05), rest)]);
    text(ctx, { u0: 0.7, lines: brandLines, size: fitSize(chars, 'heading') * (brandLines.length > 1 ? 0.92 : 1), font: F(ctx, 'head'), color: inkFor(ctx.pal.c0, ctx.pal.accent), y: brandLines.length > 1 ? 0.76 : 0.78, lineGap: 1.0, in: { kind: style, dur: 0.5, stag: 0.14 }, shadow: true, front: true, z: 6, isBrand: true });
    const cta = sentenceLines(p.cta || ctx.cta, 1, 24); if (cta.length && nWords(cta) <= 3) text(ctx, { u0: 1.3, lines: cta, size: 0.045, font: F(ctx, 'small'), upper: true, y: 0.91, track: 0.14, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    const badge = sentenceLines(p.badge, 1, 14); if (badge.length && nWords(badge) <= 2) { shape(ctx, { kind: 'circle', x: 0.83, y: 0.15, size: 0.085, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.4, delay: 0.9 }, u0: 0.9, z: 4 }); text(ctx, { u0: 1.1, lines: badge, size: 0.034, font: F(ctx, 'small'), x: 0.83, y: 0.15, color: inkFor(ctx.pal.accent, null), noContrast: true, r: -12, in: { kind: 'pop', dur: 0.3 }, front: true, z: 6 }); }
    shape(ctx, { kind: 'burst', x: rest.x, y: rest.y, n: 24, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.75, u1: 1.9, z: 4 });
    cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.75, 'impact'); cue(ctx, 0.75, 'sparkle'); cam(ctx, 0.72, 'punch');
  },
};

/** LAW (time): the shortest a scene may be for what it does to finish and be read */
const MIN_DUR = {
  hook_slice: () => 1.8, word_pack: () => 2.6, wall: () => 2.3, showcase: () => 2.4, endcard: () => 2.4, cheer: () => 2.2, disc_pack: () => 2.0, ring: () => 2.2,
  typed: (p) => { const l = sentenceLines(p.lines || p.sentence, 3, 30); return String(p.variant) === 'swap' ? Math.max(1.8, Math.min(4, nWords(l) * 0.4 + 0.8)) : Math.max(1.4, nWords(l) * 0.27 + (p.emphasis ? 0.5 + 1.3 : 0.9)); },
  callouts: (p) => 0.9 + Math.max(2, Math.min(5, (Array.isArray(p.items) ? p.items.length : 2))) * 0.36 + 1.0,
  ingredients: (p) => 0.5 + Math.max(2, Math.min(4, (Array.isArray(p.items) ? p.items.length : 2))) * 0.32 + 1.3,
  parade: (p) => Math.max(2, Math.min(3, (Array.isArray(p.packs) ? p.packs.length : 2))) * 0.85 + 1.0,
  rings_drop: (p) => (String(p.row) === 'true' ? 3.2 : 2.4),
};
const minDur = (id, p) => (MIN_DUR[id] ? MIN_DUR[id](p || {}) : 2);
const IDS = Object.keys(ARCH);
module.exports = { minDur, ARCH, IDS, movePack, enter, exitMove, drift, A, text, shape, scatter, push, packH, box };
