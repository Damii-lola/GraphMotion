'use strict';
/*
 * SCENE ARCHETYPES: the building blocks of every promo, taken from the reference spots.
 * An archetype is NOT a fixed clip: it has parameters (the words, fonts, colours, which pack shot, tilt, side, entrance and exit moves, prop counts...) that the AI chooses, and the
 * compiler applies the laws to whatever it chose. Each builder receives (params, ctx) and appends layers / hero waypoints / camera moves / sound cues for its scene window.
 */
const { LAWS, clamp, num, fixHex, rgb, hex, mix, fitSize, safeFont, cleanWord, oneOf, inkFor, W, H } = require('./laws');

// ------------------------------------------------------------------ helpers
const A = (ctx, u) => +(ctx.t0 + u).toFixed(3);
const wordsLines = (x, maxLines, maxChars) => {
  let arr = Array.isArray(x) ? x.map((s) => cleanWord(s, maxChars)).filter(Boolean) : String(x == null ? '' : x).split(/[\/\n]/).map((s) => cleanWord(s, maxChars)).filter(Boolean);
  if (arr.length === 1 && arr[0].length > maxChars * 0.7 && arr[0].includes(' ') && maxLines > 1) { const w = arr[0].split(' '), h = Math.ceil(w.length / 2); arr = [w.slice(0, h).join(' '), w.slice(h).join(' ')]; }
  return arr.slice(0, maxLines).map((s) => s.toUpperCase());
};
const sentenceLines = (x, maxLines, maxChars) => (Array.isArray(x) ? x : String(x == null ? '' : x).split(/[\/\n]/)).map((s) => cleanWord(s, maxChars)).filter(Boolean).slice(0, maxLines);
const nWords = (lines) => lines.join(' ').split(/\s+/).filter(Boolean).length;
const packId = (ctx, want, i = 0) => { const have = Object.keys(ctx.packs); return have.includes(want) ? want : have[Math.min(i, have.length - 1)] || 'hero'; };
const packH = (ctx, id, w) => (w * W / ((ctx.packs[id] && ctx.packs[id].aspect) || 0.5)) / H;   // height as a fraction of the screen height
const box = (ctx, id, x, y, w, tilt = 12) => { const h = packH(ctx, id, w) * (1 + Math.abs(tilt) / 100), ww = w * (1 + Math.abs(tilt) / 120); return { x0: x - ww / 2, x1: x + ww / 2, y0: y - h / 2, y1: y + h / 2 }; };
const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
/** LAW (type vs pack): a small line goes in the free band above or below the pack, never on it */
function freeY(ctx, boxes, hText, prefer) {
  const cands = prefer === 'bottom' ? [0.92, 0.88, 0.09, 0.13] : [0.09, 0.13, 0.92, 0.88];
  for (const y of cands) { const b = { x0: 0.05, x1: 0.95, y0: y - hText / 2, y1: y + hText / 2 }; if (!boxes.some((k) => hit(b, k))) return y; }
  return cands[0];
}
const push = (ctx, l) => { ctx.out.layers.push(l); return l; };
const text = (ctx, o) => {
  const u0 = o.u0 || 0, u1 = o.u1 !== undefined ? o.u1 : ctx.dur;
  const L = { kind: 'text', font: 'anton', color: ctx.pal.ink, upper: true, track: 0, r: 0, align: 'center', size: 0.06, x: 0.5, y: 0.5, lines: [], in: { kind: 'rise', dur: 0.45, stag: 0.09 }, ...o, t0: A(ctx, u0), t1: A(ctx, u1) };
  delete L.u0; delete L.u1; if (L.keys) L.keys = L.keys.map((k) => { const q = { ...k, t: A(ctx, k.u) }; delete q.u; return q; });
  L.lines = L.lines.map((s) => String(s)); return push(ctx, L);
};
const shape = (ctx, o) => { const L = { alpha: 1, r: 0, x: 0.5, y: 0.5, color: ctx.pal.accent, ...o, t0: A(ctx, o.u0 || 0), t1: A(ctx, o.u1 !== undefined ? o.u1 : ctx.dur) }; delete L.u0; delete L.u1; if (L.keys) L.keys = L.keys.map((k) => { const q = { ...k, t: A(ctx, k.u) }; delete q.u; return q; }); return push(ctx, L); };
const scatter = (ctx, o) => {
  const ids = (o.src && o.src.length ? o.src : ctx.props.map((p) => p.id)).filter((id) => ctx.props.some((p) => p.id === id) || ctx.packs[id]);
  if (!ids.length) return null;
  return push(ctx, { kind: 'scatter', src: ids, n: clamp(o.n || 6, 2, LAWS.props.maxPerScatter), cx: 0.5, cy: 0.55, spread: 0.5, size: [LAWS.props.size[0] + 0.02, LAWS.props.size[1] - 0.04], from: o.from || 'corners', seed: o.seed || 3, spin: o.spin || 240, stag: o.stag || 0.3, t0: A(ctx, o.u0 || 0.8), t1: A(ctx, o.u1 !== undefined ? o.u1 : ctx.dur) });
};
const cue = (ctx, u, kind) => ctx.out.cues.push({ t: A(ctx, Math.max(0, u)), kind });
const cam = (ctx, u, kind, o = {}) => ctx.out.cam.push({ t: A(ctx, u), kind, ...(kind === 'punch' ? { amp: 0.06, dur: 0.3 } : kind === 'shake' ? { amp: 8, dur: 0.35 } : {}), ...o });

// ---- the pack's moves. Waypoints are {u,x,y,w,r,blur,e,sx,sy,o}; u = seconds from the start of the scene
function movePack(ctx, id, way) {
  const wp = way.map((k) => { const q = { ...k, t: A(ctx, k.u) }; delete q.u; return q; });
  if (id === 'hero') { ctx.out.hero.push(...wp); ctx.out.heroUsed = true; return; }
  const f = wp[0], l = wp[wp.length - 1];
  push(ctx, { kind: 'sprite', src: id, t0: f.t, t1: A(ctx, ctx.dur), x: f.x, y: f.y, w: f.w, r: 0, keys: wp.map((k) => ({ ...k })), pack: true, shadow: true });
  ctx.out.packUsed = true;
}
/** entrance moves: the pack arrives from off-screen (or out of nothing) and comes to rest */
function enter(style, u, rest, dir = -1) {
  const dur = 0.6, off = dir < 0 ? -0.6 : 1.6;
  switch (style) {
    case 'drop': return [{ u, x: rest.x, y: -0.5, w: rest.w * 1.05, r: rest.r + 22, blur: 14 }, { u: u + dur + 0.1, ...rest, blur: 0, e: 'outBounce' }];
    case 'rise': return [{ u, x: rest.x, y: 1.6, w: rest.w * 1.05, r: rest.r - 18, blur: 14 }, { u: u + dur, ...rest, blur: 0, e: 'outExpo' }];
    case 'spin': return [{ u, x: rest.x, y: rest.y, w: rest.w * 0.06, r: rest.r - 320, blur: 5 }, { u: u + dur + 0.15, ...rest, blur: 0, e: 'outBack' }];
    case 'pop': return [{ u, x: rest.x, y: rest.y, w: rest.w * 0.1, r: rest.r - 12, blur: 0 }, { u: u + 0.5, ...rest, e: 'outBack' }];
    default: return [{ u, x: off, y: rest.y + 0.22, w: rest.w * 1.1, r: rest.r + (dir < 0 ? -55 : 55), blur: 16 }, { u: u + dur, ...rest, blur: 0, e: 'outExpo' }];   // whip
  }
}
const drift = (u, rest, sgn = 1) => ({ u, x: +(rest.x + 0.03 * sgn).toFixed(3), y: +(rest.y - 0.012).toFixed(3), w: +(rest.w * 1.04).toFixed(3), r: rest.r + 6 * sgn, e: 'inOutCubic' });
function exitMove(style, u, from, dir = 1) {
  const off = dir > 0 ? 1.6 : -0.6;
  if (style === 'up') return { u, x: from.x, y: -0.5, w: from.w, r: from.r + 20, blur: 14, e: 'inCubic' };
  if (style === 'down') return { u, x: from.x, y: 1.6, w: from.w, r: from.r - 20, blur: 14, e: 'inCubic' };
  return { u, x: off, y: from.y - 0.12, w: from.w * 1.05, r: from.r + (dir > 0 ? 42 : -42), blur: 14, e: 'inCubic' };
}
const restPose = (ctx, id, x, y, w, r, hasGiant) => { const [lo, hi] = hasGiant ? LAWS.pack.restWithGiantType : LAWS.pack.restW; return { x, y, w: +clamp(w, lo, hi).toFixed(3), r: clamp(r, -LAWS.pack.tiltMax, LAWS.pack.tiltMax) }; };
const seedRand = (s) => { let x = (s * 2654435761) >>> 0; return () => { x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return x / 4294967296; }; };

// ------------------------------------------------------------------ the archetypes
const ARCH = {};

ARCH.hook_slice = {
  about: 'A GIANT word (or two lines) fills the screen, arriving as horizontal strips sliding in from opposite sides (McDonald\'s, Wendy\'s, Canva). No pack. A tiny line can type in below.',
  params: { lines: 'the giant word(s), 1-2 lines, each up to 9 letters', font: 'a caps font', sub: 'optional tiny typed line (max 5 words)', style: 'slice | slam | slide' },
  packs: 'none',
  build(p, ctx) {
    const lines = wordsLines(p.lines || p.word || ctx.brand, 2, 9), chars = Math.max(...lines.map((l) => l.length), 1), size = +(fitSize(chars, 'giant') * (lines.length > 1 ? 0.86 : 1)).toFixed(3), font = safeFont(p.font, 'anton');
    shape(ctx, { kind: 'rays', n: 16, speed: 5, color: ctx.pal.ink, alpha: 0.1, u0: 0, z: 0 });
    text(ctx, { lines, size, font, y: 0.5, lineGap: 1.02, in: { kind: oneOf(p.style, ['slice', 'slam', 'slideL'], 'slice'), dur: 0.8, stag: 0.12 }, shadow: true, z: 2 });
    const sub = sentenceLines(p.sub, 1, 34); if (sub.length && nWords(sub) <= 5) text(ctx, { u0: 1.1, lines: sub, size: 0.046, font: 'poppins', y: 0.86, track: 0.12, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    cue(ctx, 0.05, 'impact'); cue(ctx, 0.05, 'whoosh'); cam(ctx, 0.6, 'punch', { amp: 0.05 });
  },
};

ARCH.word_pack = {
  about: 'A giant word arrives sliced, then snaps up to the top as two lines while the pack drops in with a blur and lands with a bounce (McDonald\'s, Wendy\'s).',
  params: { lines: 'the giant word (1-2 lines, up to 8 letters each)', font: 'a caps font', pack: 'hero | hero2 | hero3', entrance: 'drop | whip | rise | spin', tilt: 'degrees -20..20', tag: 'optional tiny line under the pack (max 3 words)' },
  packs: 'one',
  build(p, ctx) {
    const lines = wordsLines(p.lines || p.word, 2, 8), chars = Math.max(...lines.map((l) => l.length), 1), size = +(fitSize(chars, 'giant') * (lines.length > 1 ? 0.88 : 1)).toFixed(3), id = packId(ctx, p.pack), font = safeFont(p.font, 'anton');
    const rest = restPose(ctx, id, 0.5, 0.63, 0.5, num(p.tilt, -4, -20, 20), true), u1 = Math.min(1.2, ctx.dur * 0.42);
    text(ctx, { lines, size, font, y: 0.5, lineGap: 1.0, in: { kind: 'slice', dur: 0.8, stag: 0.1 }, shadow: true, z: 2, keys: [{ u: u1, x: 0.5, y: 0.5, s: 1 }, { u: u1 + 0.45, x: 0.5, y: 0.17, s: 0.5, e: 'inOutCubic' }] });
    movePack(ctx, id, [...enter(oneOf(p.entrance, ['drop', 'whip', 'rise', 'spin'], 'drop'), u1 + 0.05, rest, -1), drift(Math.max(u1 + 1.0, ctx.dur - 0.05), rest)]);
    const tag = sentenceLines(p.tag, 1, 24); if (tag.length && nWords(tag) <= 3) text(ctx, { u0: u1 + 0.9, lines: tag, size: 0.04, font: 'poppins', y: 0.93, track: 0.14, in: { kind: 'fade', dur: 0.4, stag: 0.2 }, front: true, z: 5 });
    cue(ctx, 0.05, 'impact'); cue(ctx, u1 + 0.1, 'whoosh'); cue(ctx, u1 + 0.75, 'impact'); cam(ctx, u1 + 0.72, 'punch');
  },
};

ARCH.wall = {
  about: 'A WALL of one repeated word fills the whole screen, rows scrolling sideways in opposite directions, two rows solid (Goli "NEW", Sunbake, Wendy\'s). The pack whips across it, or drops onto it, or is absent.',
  params: { word: 'the wall word (up to 8 letters)', font: 'a caps font', pack: 'hero | hero2 | hero3 | none', action: 'cross | drop | absent', tilt: 'degrees' },
  packs: 'optional',
  build(p, ctx) {
    const word = wordsLines(p.word || p.lines, 1, 8)[0] || 'NEW', chars = word.length, size = +clamp(0.95 / (chars * 0.5), 0.11, 0.2).toFixed(3), font = safeFont(p.font, 'anton'), rowH = size * W * 1.05 * 0.85 / H, n = clamp(Math.ceil(1.0 / rowH) + 2, 7, 15);
    text(ctx, { lines: [word], size, font, fill: false, stroke: { color: ctx.pal.ink, w: 0.035 }, alpha: 0.7, repeat: { n, dy: 0.85, speed: 0.07 }, in: { kind: 'slideL', dur: 0.5, stag: 0.05 }, z: 2 });
    const mid = (n - 1) / 2; [[-3, 'slideL', 0.25], [2, 'slideR', 0.45]].forEach(([off, kind, u0]) => { const y = 0.5 + (Math.round(mid + off) - mid) * rowH; if (y > 0.08 && y < 0.92) text(ctx, { u0, lines: [word], size, font, y: +y.toFixed(3), in: { kind, dur: 0.45, stag: 0.05 }, z: 2 }); });
    const id = packId(ctx, p.pack);
    if (oneOf(p.pack, ['none'], 'x') !== 'none' && p.action !== 'absent' && ctx.packs[id]) {
      const rest = restPose(ctx, id, 0.5, 0.56, 0.5, num(p.tilt, -10, -20, 20), true);
      if (p.action === 'drop') movePack(ctx, id, [...enter('drop', 0.3, rest), drift(Math.max(1.6, ctx.dur - 0.05), rest)]);
      else movePack(ctx, id, [{ u: 0.2, x: -0.6, y: 0.66, w: rest.w * 1.15, r: -38, blur: 16 }, { u: 0.75, ...rest, blur: 0, e: 'outExpo' }, { u: 1.1, ...rest, w: +(rest.w * 1.12).toFixed(3), e: 'inOutCubic' }, { u: 1.5, ...rest, e: 'inOutCubic' }, exitMove('whip', Math.max(1.9, ctx.dur - 0.4), rest, 1)]);
      cue(ctx, 0.2, 'whoosh'); cue(ctx, 0.75, 'impact'); cam(ctx, 0.72, 'punch');
    } else cue(ctx, 0.1, 'tick');
  },
};

ARCH.typed = {
  about: 'A calm statement TYPED word by word in small clean type on a flat colour, one key word bigger with a hand-drawn oval scribbled round it (Goli, Unicity, Sunbake). The pack is absent or small at the bottom.',
  params: { lines: 'the statement, 1-3 short lines (max 9 words in all)', emphasis: 'one key word (up to 10 letters), shown bigger', scribble: 'true/false: an oval drawn round the key word', pack: 'none | hero | hero2 | hero3 (small at the bottom)', font: 'poppins | inter | bricolage' },
  packs: 'optional',
  build(p, ctx) {
    const lines = sentenceLines(p.lines || p.sentence, 3, 30); while (nWords(lines) > 9) lines[lines.length - 1] = lines[lines.length - 1].split(' ').slice(0, -1).join(' ');
    shape(ctx, { kind: 'wave', y: 0.86, amp: 0.02, wl: 0.8, speed: 0.35, color: ctx.pal.accent, alpha: 0.5, side: 'bottom', u0: 0, z: 0 });
    const chars = Math.max(...lines.map((l) => l.length), 1), size = +clamp(0.86 / (chars * 0.62), 0.04, 0.06).toFixed(3), stag = 0.27, tEnd = nWords(lines) * stag + 0.5, y0 = p.emphasis ? 0.4 : 0.47;
    text(ctx, { lines: lines.filter(Boolean), size, font: safeFont(p.font, 'poppins'), upper: false, y: y0, lineGap: 1.5, in: { kind: 'rise', dur: 0.4, stag }, z: 5, front: true });
    const em = cleanWord(p.emphasis, 10);
    if (em) {
      const esz = +clamp(0.86 / (em.length * 0.5), 0.09, 0.16).toFixed(3);
      text(ctx, { u0: tEnd, lines: [em.toUpperCase()], size: esz, font: safeFont(p.emfont, 'anton'), color: ctx.pal.accent, y: 0.58, in: { kind: 'pop', dur: 0.35 }, z: 5, front: true, shadow: true });
      if (String(p.scribble) !== 'false') shape(ctx, { kind: 'oval', u0: tEnd + 0.35, x: 0.5, y: 0.58, w: +clamp(em.length * esz * 0.55 + 0.14, 0.3, 0.9).toFixed(3), h: +(esz * 0.75).toFixed(3), r: -3, color: ctx.pal.ink, width: 0.007, dur: 0.7, z: 5 });
      cue(ctx, tEnd, 'impact');
    }
    for (let i = 0; i < nWords(lines); i++) cue(ctx, 0.15 + i * stag, 'tick');
    const id = packId(ctx, p.pack);
    if (p.pack && p.pack !== 'none' && ctx.packs[id]) { const rest = restPose(ctx, id, 0.5, 0.83, 0.3, 4, false); movePack(ctx, id, [...enter('rise', 0.6, rest), drift(Math.max(2.0, ctx.dur - 0.05), rest)]); }
  },
};

ARCH.showcase = {
  about: 'The HERO scene: the pack whips in tilted 15-25 degrees, comes to rest to one side, slowly rolls; big fruit / ingredients fly around at the frame edges; a tiny title types in at the top; optionally a giant word runs vertically up the other side (Berry White, Goli, Unicity).',
  params: { pack: 'hero | hero2 | hero3', side: 'L | R (which side the pack rests on)', tilt: 'degrees -25..25', entrance: 'whip | drop | rise | spin', title: 'optional tiny title (max 6 words)', vertical: 'optional giant vertical word (up to 8 letters)', props: 'how many flying pieces 0-7', from: 'corners | edges | sides | burst | top' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), R = String(p.side || 'R').toUpperCase() === 'R', vert = cleanWord(p.vertical, 8).toUpperCase(), sgn = R ? 1 : -1;
    const rest = restPose(ctx, id, R ? 0.6 : 0.4, 0.56, vert ? 0.46 : 0.52, num(p.tilt, 18 * sgn, -25, 25), !!vert);
    if (vert) text(ctx, { lines: [vert], size: +clamp(Math.min(0.34, 3.0 / vert.length), 0.2, 0.34).toFixed(3), r: R ? -90 : 90, x: R ? 0.13 : 0.87, y: 0.5, alpha: 0.9, font: safeFont(p.font, 'anton'), in: { kind: 'slideL', dur: 0.6, stag: 0.05 }, z: 2 });
    shape(ctx, { kind: 'rays', n: 14, speed: 6, color: ctx.pal.ink, alpha: 0.09, u0: 0, z: 0 });
    movePack(ctx, id, [...enter(oneOf(p.entrance, ['whip', 'drop', 'rise', 'spin'], 'whip'), 0.15, rest, R ? 1 : -1), drift(Math.max(1.4, ctx.dur * 0.7), rest, sgn), { ...drift(Math.max(1.5, ctx.dur - 0.05), rest, -sgn), w: rest.w, r: rest.r - 4 * sgn }]);
    const title = sentenceLines(p.title, 1, 40); if (title.length && nWords(title) <= 6) text(ctx, { u0: 0.9, lines: title, size: 0.048, font: 'poppins', upper: false, y: 0.09, track: 0.06, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    const np = clamp(Math.round(num(p.props, 5, 0, 7)), 0, 7); if (np >= 2) scatter(ctx, { n: np, from: oneOf(p.from, ['corners', 'edges', 'sides', 'burst', 'top'], 'corners'), u0: 0.85, seed: (ctx.seed || 3) + 7 });
    shape(ctx, { kind: 'burst', x: rest.x, y: rest.y, n: 22, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.75, u1: 1.9, z: 4 });
    cue(ctx, 0.15, 'whoosh'); cue(ctx, 0.75, 'impact'); cam(ctx, 0.72, 'punch');
  },
};

ARCH.parade = {
  about: 'Several pack shots (flavours) replace each other: each whips in diagonally from a corner, rotated, decelerates into place, holds, and is replaced by the next one from the opposite corner; tiny two-line text appears in the gaps (Pluckk).',
  params: { packs: 'list of 2-3 of hero | hero2 | hero3 (the order they appear)', lines: 'list of tiny lines, one per pack (max 3 words each)', tilt: 'degrees 12..26' },
  packs: 'several',
  build(p, ctx) {
    const have = Object.keys(ctx.packs), want = (Array.isArray(p.packs) ? p.packs : []).filter((x) => have.includes(x)), ids = (want.length ? want : have).slice(0, 3);
    const seq = ids.length >= 2 ? ids : [ids[0], ids[0]], lines = Array.isArray(p.lines) ? p.lines : [], tilt = num(p.tilt, 18, 12, 26), boxes = [];
    const step = Math.max(0.85, (ctx.dur - 0.5) / seq.length);
    seq.forEach((id, i) => {
      const dir = i % 2 ? 1 : -1, u = 0.1 + i * step, rest = restPose(ctx, id, i % 2 ? 0.62 : 0.38, 0.56, 0.5, tilt * (i % 2 ? -1 : 1), false);
      movePack(ctx, id, [...enter('whip', u, rest, dir), exitMove('whip', Math.min(ctx.dur - 0.05, u + step - 0.05), rest, -dir)]);
      boxes.push(box(ctx, id, rest.x, rest.y, rest.w, tilt));
      const ln = sentenceLines(lines[i], 2, 20); if (ln.length && nWords(ln) <= 3) { const hT = ln.length * 0.05 * 0.6 + 0.02, y = freeY(ctx, [box(ctx, id, rest.x, rest.y, rest.w, tilt)], hT, i % 2 ? 'top' : 'bottom'); text(ctx, { u0: u + 0.55, u1: Math.min(ctx.dur, u + step), lines: ln, size: 0.05, font: 'poppins', upper: true, x: i % 2 ? 0.3 : 0.7, y, track: 0.1, in: { kind: 'slideL', dur: 0.35, stag: 0.2 }, out: { kind: 'fade', dur: 0.2 }, front: true, z: 5 }); }
      cue(ctx, u, 'whoosh'); cue(ctx, u + 0.55, 'impact');
    });
    cam(ctx, 0.65, 'punch', { amp: 0.04 });
  },
};

ARCH.ring = {
  about: 'The packs multiply into a spinning radial ring / grid around a centre word; the whole thing spins and zoom-blurs out (Pluckk "JUST FRUIT IN A BOTTLE").',
  params: { packs: 'list of hero | hero2 | hero3 used in the ring', lines: 'the centre words (max 4 words, up to 2 lines)', font: 'a caps font', style: 'ring | grid' },
  packs: 'several',
  build(p, ctx) {
    const have = Object.keys(ctx.packs), ids = ((Array.isArray(p.packs) ? p.packs : []).filter((x) => have.includes(x)).concat(have)).slice(0, 3), lines = wordsLines(p.lines || p.word, 2, 12);
    shape(ctx, { kind: 'circle', x: 0.5, y: 0.5, size: 0.26, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.4 }, u0: 0.1, z: 0 });
    push(ctx, { kind: 'pattern', src: ids, sub: p.style === 'grid' ? 'grid' : 'radial', cx: 0.5, cy: 0.5, w: 0.17, spin: 35, rings: 2, cols: 4, rows: 7, stag: 0.03, alpha: 1, t0: A(ctx, 0.25), t1: A(ctx, ctx.dur) });
    if (lines.length) text(ctx, { u0: 0.5, lines, size: +clamp(0.36 / (Math.max(...lines.map((l) => l.length)) * 0.5), 0.06, 0.11).toFixed(3), font: safeFont(p.font, 'anton'), color: inkFor(ctx.pal.accent, null), y: 0.5, in: { kind: 'rise', dur: 0.4, stag: 0.25 }, front: true, z: 5 });
    cue(ctx, 0.25, 'whoosh'); cue(ctx, 0.6, 'impact');
  },
};

ARCH.callouts = {
  about: 'The pack small and upright in the centre, a sentence typed at the top, round icons pop in around it one by one with hairline connectors DRAWN ON from the pack to each, each with a tiny label (Goli).',
  params: { pack: 'hero | hero2 | hero3', sentence: 'a sentence (max 8 words)', items: 'list of 2-4 short labels (max 3 words each)', entrance: 'spin | pop | rise' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), rest = restPose(ctx, id, 0.5, 0.6, 0.34, 0, false), items = (Array.isArray(p.items) ? p.items : []).map((s) => cleanWord(s, 22)).filter(Boolean).slice(0, 4), sent = sentenceLines(p.sentence, 2, 26);
    movePack(ctx, id, [...enter(oneOf(p.entrance, ['spin', 'pop', 'rise'], 'spin'), 0.2, rest), drift(Math.max(2.0, ctx.dur - 0.05), rest)]);
    if (sent.length) text(ctx, { u0: 0.3, lines: sent, size: 0.05, font: 'poppins', upper: false, y: 0.15, lineGap: 1.4, in: { kind: 'rise', dur: 0.4, stag: 0.25 }, front: true, z: 5 });
    const POS = [[0.2, 0.4], [0.8, 0.4], [0.2, 0.76], [0.8, 0.76]];
    items.forEach((lab, i) => {
      const [ix, iy] = POS[i], u = 1.0 + i * 0.42, sgnx = ix > rest.x ? 1 : -1, sx = rest.x + sgnx * (rest.w * 0.5 + 0.015), sy = clamp(iy, rest.y - 0.16, rest.y + 0.16);
      shape(ctx, { kind: 'line', x1: +sx.toFixed(3), y1: +sy.toFixed(3), x2: ix, y2: iy, cx: +((sx + ix) / 2).toFixed(3), cy: +(iy > sy ? (sy + iy) / 2 + 0.02 : (sy + iy) / 2 - 0.02).toFixed(3), color: ctx.pal.ink, width: 0.005, dur: 0.45, u0: u, z: 4 });
      shape(ctx, { kind: 'circle', x: ix, y: iy, size: 0.06, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.3, delay: 0.3 }, u0: u, z: 4 });
      text(ctx, { u0: u + 0.4, lines: [lab], size: 0.038, font: 'poppins', upper: false, x: ix, y: +(iy + 0.075).toFixed(3), in: { kind: 'rise', dur: 0.35, stag: 0.15 }, front: true, z: 5 });
      cue(ctx, u + 0.3, 'tick');
    });
  },
};

ARCH.ingredients = {
  about: 'Round badges pop in as a grid, each holding an ingredient picture with a tiny label under it, a title typed above (Goli sleep ingredients).',
  params: { title: 'title (max 5 words)', items: 'list of 2-4 {prop: 0-3 (which prop picture), label: up to 2 words}', pack: 'none | hero | hero2 | hero3 (small at the bottom)' },
  packs: 'optional',
  build(p, ctx) {
    const items = (Array.isArray(p.items) ? p.items : []).map((it) => ({ prop: Math.round(num(it && it.prop, 0, 0, 3)), label: cleanWord(it && it.label, 16) })).slice(0, 4), n = Math.max(2, items.length), title = sentenceLines(p.title, 1, 30);
    const POS = { 2: [[0.3, 0.5], [0.7, 0.5]], 3: [[0.5, 0.34], [0.28, 0.6], [0.72, 0.6]], 4: [[0.3, 0.36], [0.7, 0.36], [0.3, 0.62], [0.7, 0.62]] }[n] || [[0.3, 0.5], [0.7, 0.5]];
    if (title.length) text(ctx, { u0: 0.15, lines: title, size: 0.058, font: safeFont(p.font, 'poppins'), upper: false, y: 0.15, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    items.forEach((it, i) => {
      const [x, y] = POS[i] || POS[0], u = 0.5 + i * 0.32, pid = 'prop' + it.prop, has = ctx.props.some((q) => q.id === pid);
      shape(ctx, { kind: 'circle', x, y, size: 0.13, color: '#ffffff', alpha: 0.96, in: { kind: 'pop', dur: 0.35 }, u0: u, z: 3 });
      if (has) push(ctx, { kind: 'sprite', src: pid, t0: A(ctx, u + 0.1), t1: A(ctx, ctx.dur), x, y, w: 0.19, r: 0, in: { kind: 'pop', dur: 0.35 }, idle: { kind: 'float', amp: 0.006, speed: 1.2 }, shadow: false, z: 4 });
      if (it.label) text(ctx, { u0: u + 0.35, lines: [it.label], size: 0.04, font: 'poppins', upper: false, x, y: +(y + 0.11).toFixed(3), in: { kind: 'rise', dur: 0.35, stag: 0.15 }, front: true, z: 5 });
      cue(ctx, u + 0.05, 'tick');
    });
    const id = packId(ctx, p.pack); if (p.pack && p.pack !== 'none' && ctx.packs[id]) { const rest = restPose(ctx, id, 0.5, 0.86, 0.28, 3, false); movePack(ctx, id, [...enter('rise', 1.4, rest), drift(Math.max(2.2, ctx.dur - 0.05), rest)]); }
  },
};

ARCH.cheer = {
  about: 'The pack in the centre with handwritten cheer words (YIPPEE! WOOHOO! NEW! HOORAY!) popping around it at different tilts (Goli sleep).',
  params: { pack: 'hero | hero2 | hero3', words: 'list of 3-4 cheer words (up to 9 letters each)', font: 'pacifico | lobster | caveat', entrance: 'pop | spin | drop' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), rest = restPose(ctx, id, 0.5, 0.56, 0.4, -5, false), words = (Array.isArray(p.words) ? p.words : []).map((w) => cleanWord(w, 9)).filter(Boolean).slice(0, 4);
    movePack(ctx, id, [...enter(oneOf(p.entrance, ['pop', 'spin', 'drop'], 'pop'), 0.15, rest), drift(Math.max(1.6, ctx.dur - 0.05), rest)]);
    const POS = [[0.24, 0.27, -14], [0.77, 0.3, 12], [0.25, 0.82, 11], [0.76, 0.79, -13]], font = safeFont(p.font, 'caveat');
    words.forEach((w, i) => { const [x, y, r] = POS[i]; text(ctx, { u0: 0.6 + i * 0.28, lines: [w], size: 0.14, font, upper: true, color: i % 2 ? ctx.pal.ink : ctx.pal.accent, x, y, r, in: { kind: 'pop', dur: 0.3 }, shadow: true, front: true, z: 5 }); cue(ctx, 0.62 + i * 0.28, 'tick'); });
    cue(ctx, 0.15, 'whoosh'); cue(ctx, 0.6, 'impact');
  },
};

ARCH.disc_pack = {
  about: 'A bold colour disc pulses in the centre and the pack spins out of it, a giant word behind (Canva lemon circle, Lay\'s).',
  params: { pack: 'hero | hero2 | hero3', word: 'optional giant word behind (up to 8 letters)', font: 'a caps font', tilt: 'degrees' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), word = cleanWord(p.word, 8).toUpperCase(), rest = restPose(ctx, id, 0.5, 0.52, 0.5, num(p.tilt, -8, -22, 22), !!word);
    shape(ctx, { kind: 'circle', x: 0.5, y: 0.52, size: 0.34, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.45 }, idle: { kind: 'pulse', amp: 0.03, speed: 1 }, u0: 0, z: 0 });
    if (word) text(ctx, { u0: 0.3, lines: [word], size: fitSize(word.length, 'giant'), font: safeFont(p.font, 'anton'), y: 0.2, in: { kind: 'slam', dur: 0.4 }, shadow: true, z: 2 });
    movePack(ctx, id, [...enter('spin', 0.25, rest), drift(Math.max(1.5, ctx.dur - 0.05), rest)]);
    shape(ctx, { kind: 'burst', x: 0.5, y: 0.52, n: 22, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.85, u1: 1.9, z: 4 });
    cue(ctx, 0.25, 'whoosh'); cue(ctx, 0.85, 'impact'); cam(ctx, 0.82, 'punch');
  },
};

ARCH.rings_drop = {
  about: 'Concentric rings pulse outward all scene; the pack zooms in spinning out of a dot, big pieces fly in from the frame edges and out again, tiny text at the corners; optionally the range (2-3 packs) rises as a row at the end (Lay\'s).',
  params: { pack: 'hero | hero2 | hero3', tiny: 'tiny top-left text (max 2 words)', line: 'lower-right line (max 3 words)', row: 'true/false: end with a row of 2-3 packs', props: 'flying pieces 0-6' },
  packs: 'one or row',
  build(p, ctx) {
    const id = packId(ctx, p.pack), rest = restPose(ctx, id, 0.5, 0.52, 0.5, -12, false);
    shape(ctx, { kind: 'rings', x: 0.5, y: 0.52, n: 9, gap: 0.13, width: 0.06, speed: 0.35, color: ctx.pal.ink, color2: ctx.pal.accent, alpha: 0.22, u0: 0, z: 0 });
    const rowOn = String(p.row) === 'true' && Object.keys(ctx.packs).length >= 2, tRow = Math.max(1.9, ctx.dur - 1.7);
    movePack(ctx, id, rowOn ? [...enter('spin', 0.1, rest), { u: tRow, ...rest, e: 'inOutCubic' }, { u: tRow + 0.5, x: 0.5, y: 0.5, w: 0.3, r: 0, e: 'inOutCubic' }] : [...enter('spin', 0.1, rest), drift(Math.max(1.6, ctx.dur - 0.05), rest)]);
    const t1 = sentenceLines(p.tiny, 1, 18), t2 = sentenceLines(p.line, 1, 26);
    if (t1.length && nWords(t1) <= 2) text(ctx, { u0: 0.5, lines: t1, size: 0.04, font: 'poppins', upper: false, x: 0.2, y: 0.08, in: { kind: 'rise', dur: 0.4, stag: 0.2 }, front: true, z: 5 });
    if (t2.length && nWords(t2) <= 3) text(ctx, { u0: 1.2, lines: t2, size: 0.05, font: 'poppins', upper: true, x: 0.72, y: 0.9, track: 0.06, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    const np = clamp(Math.round(num(p.props, 4, 0, 6)), 0, 6); if (np >= 2) scatter(ctx, { n: np, from: 'corners', u0: 0.8, u1: rowOn ? tRow : ctx.dur, seed: (ctx.seed || 3) + 3 });
    if (rowOn) { const others = Object.keys(ctx.packs).filter((k) => k !== id).slice(0, 2), xs = others.length === 2 ? [0.2, 0.8] : [0.78]; others.forEach((o, i) => push(ctx, { kind: 'sprite', src: o, t0: A(ctx, tRow + 0.3), t1: A(ctx, ctx.dur), x: xs[i], y: 0.52, w: 0.3, r: 0, in: { kind: 'slideU', dur: 0.5 }, idle: { kind: 'float', amp: 0.008, speed: 1 }, z: 4 })); if (others.length === 1) { /* two packs: the main one slides left */ } }
    cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.8, 'impact'); cam(ctx, 0.78, 'punch');
  },
};

ARCH.endcard = {
  about: 'The closing card: the pack, the BRAND NAME big, a call to action of up to 3 words, an optional round badge. Always the last scene.',
  params: { pack: 'hero | hero2 | hero3', style: 'slam | slice | pop (how the brand arrives)', font: 'a caps font', cta: 'call to action (max 3 words)', badge: 'optional tiny badge text (max 2 words)', entrance: 'spin | drop | whip | rise | pop' },
  packs: 'one',
  build(p, ctx) {
    const id = packId(ctx, p.pack), rest = restPose(ctx, id, 0.5, 0.4, 0.46, 5, false), brandLines = wordsLines(ctx.brand, 2, 12), chars = Math.max(...brandLines.map((l) => l.length), 1);
    movePack(ctx, id, [...enter(oneOf(p.entrance, ['spin', 'drop', 'whip', 'rise', 'pop'], 'spin'), 0.1, rest), drift(Math.max(1.4, ctx.dur - 0.05), rest)]);
    text(ctx, { u0: 0.7, lines: brandLines, size: fitSize(chars, 'heading') * (brandLines.length > 1 ? 0.92 : 1), font: safeFont(p.font, 'anton'), color: inkFor(ctx.pal.c0, ctx.pal.accent), y: brandLines.length > 1 ? 0.76 : 0.78, lineGap: 1.0, in: { kind: oneOf(p.style, ['slam', 'slice', 'pop'], 'slam'), dur: 0.5, stag: 0.14 }, shadow: true, front: true, z: 6, isBrand: true });
    const cta = sentenceLines(p.cta || ctx.cta, 1, 24); if (cta.length && nWords(cta) <= 3) text(ctx, { u0: 1.3, lines: cta, size: 0.045, font: 'poppins', upper: true, y: 0.91, track: 0.14, in: { kind: 'rise', dur: 0.4, stag: 0.22 }, front: true, z: 5 });
    const badge = sentenceLines(p.badge, 1, 14); if (badge.length && nWords(badge) <= 2) { shape(ctx, { kind: 'circle', x: 0.83, y: 0.15, size: 0.085, color: ctx.pal.accent, in: { kind: 'pop', dur: 0.4, delay: 0.9 }, u0: 0.9, z: 4 }); text(ctx, { u0: 1.1, lines: badge, size: 0.034, font: 'poppins', x: 0.83, y: 0.15, color: inkFor(ctx.pal.accent, null), r: -12, in: { kind: 'pop', dur: 0.3 }, front: true, z: 6 }); }
    shape(ctx, { kind: 'burst', x: rest.x, y: rest.y, n: 24, color: ctx.pal.ink, color2: ctx.pal.accent, life: 1, u0: 0.75, u1: 1.9, z: 4 });
    cue(ctx, 0.1, 'whoosh'); cue(ctx, 0.75, 'impact'); cue(ctx, 0.75, 'sparkle'); cam(ctx, 0.72, 'punch');
  },
};

/** LAW (time): the shortest a scene may be for what it does to finish and be read */
const MIN_DUR = {
  hook_slice: () => 1.8, word_pack: () => 2.6, wall: () => 2.2, showcase: () => 2.4, endcard: () => 2.4, cheer: () => 2.2, disc_pack: () => 2.0, ring: () => 2.2,
  typed: (p) => { const l = sentenceLines(p.lines || p.sentence, 3, 30); return Math.max(2.0, nWords(l) * 0.27 + (p.emphasis ? 0.5 + 1.3 : 1.0)); },
  callouts: (p) => 1.0 + Math.max(2, Math.min(4, (Array.isArray(p.items) ? p.items.length : 2))) * 0.42 + 1.1,
  ingredients: (p) => 0.5 + Math.max(2, Math.min(4, (Array.isArray(p.items) ? p.items.length : 2))) * 0.32 + 1.3,
  parade: (p) => Math.max(2, Math.min(3, (Array.isArray(p.packs) ? p.packs.length : 2))) * 0.85 + 1.0,
  rings_drop: (p) => (String(p.row) === 'true' ? 3.2 : 2.4),
};
const minDur = (id, p) => (MIN_DUR[id] ? MIN_DUR[id](p || {}) : 2);
const IDS = Object.keys(ARCH);
module.exports = { minDur, ARCH, IDS, movePack, enter, exitMove, drift, seedRand, A, text, shape, scatter, push, packH, box };
