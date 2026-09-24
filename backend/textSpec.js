'use strict';
/*
 * TEXT DESIGN. Everything about a scene's text - size, position, outline, shadow, highlight, and how each element ANIMATES
 * (free keyframes, stagger order, ease) - is chosen by the AI per scene. This module only clamps values to safe ranges, fills in
 * anything the AI left out with the house default, and guarantees the text stays readable (WCAG contrast against its scrim).
 * There is no list of text animations anywhere: an animation is a set of keyframes plus timing numbers the AI wrote.
 */
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lumOf = (r) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r[0]) + 0.7152 * f(r[1]) + 0.0722 * f(r[2]); };
const contrastOf = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hexOk = (v) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim()); return m ? '#' + m[1].toLowerCase() : ''; };
const inkOn = (hex) => { const c = hex2rgb(hex) || [255, 92, 26]; return contrastOf(c, [255, 255, 255]) >= contrastOf(c, [10, 10, 10]) ? '#ffffff' : '#0a0a0a'; };

const EASES = /^(none|linear|(power[1-4]|sine|expo|circ|back|elastic|bounce)\.(in|out|inOut)(\([0-9.,\s]{1,12}\))?)$/;
const okEase = (e, d) => (typeof e === 'string' && EASES.test(e.trim()) ? e.trim() : d);

/** Keyframes of one animated state. x,y in line-heights (1 = the element's own height), s scale, r rotation deg, o opacity, b blur px. */
function normalizeKf(list, def) {
  const src = Array.isArray(list) ? list.slice(0, 5) : [];
  const use = src.length >= 2 ? src : def;
  const out = [];
  let cur = { x: 0, y: 0, s: 1, r: 0, o: 1, b: 0 };
  use.forEach((k, i) => {
    k = k && typeof k === 'object' ? k : {};
    const st = {
      t: i === 0 ? 0 : num(k.t, out[i - 1].t + 0.01, 1, i / (use.length - 1)),
      x: num(k.x, -4, 4, cur.x), y: num(k.y, -4, 4, cur.y), s: num(k.s, 0.2, 2.5, cur.s), r: num(k.r, -90, 90, cur.r), o: num(k.o, 0, 1, cur.o), b: num(k.b, 0, 16, cur.b),
    };
    if (typeof k.e === 'string' && okEase(k.e, '')) st.e = k.e.trim();
    out.push(st); cur = st;
  });
  const L = out[out.length - 1];
  L.t = 1; L.o = 1; L.b = 0; L.s = num(L.s, 0.8, 1.3, 1);   // the resting state is always readable: opaque, sharp, about full size
  return out;
}

/** An entrance: when it starts (scene units), how long, per-word stagger + order, whether words are masked, ease and the keyframes. */
function normalizeIn(t, def) {
  t = t && typeof t === 'object' ? t : {};
  return {
    at: num(t.at, -0.2, 0.6, def.at), dur: num(t.dur, 0.03, 0.45, def.dur), stag: num(t.stag, 0, 0.12, def.stag),
    order: ['fwd', 'rev', 'mid', 'rand'].includes(t.order) ? t.order : def.order,
    clip: t.clip === undefined ? def.clip : !!t.clip,
    ease: okEase(t.ease, def.ease),
    kf: normalizeKf(t.kf, def.kf),
  };
}
const DEF_IN = (first) => ({ at: first ? 0 : -0.1, dur: 0.075, stag: first ? 0.03 : 0.04, order: 'fwd', clip: true, ease: 'back.out(1.5)', kf: [{ y: 1.18, s: 0.92, o: 1 }, { y: 0, s: 1, o: 1, t: 1 }] });
const DEF_SUB_IN = { at: 0.2, dur: 0.07, stag: 0.014, order: 'fwd', clip: true, ease: 'power3.out', kf: [{ y: 1.18, o: 1 }, { y: 0, o: 1, t: 1 }] };
const DEF_EL_IN = (at, dur, ease, kf) => ({ at, dur, stag: 0, order: 'fwd', clip: false, ease, kf });

/** ctx = { k: scene index, tone: 'dark'|'light', upper: theme uppercases, accent: '#hex' } */
function normalizeText(t, ctx) {
  t = t && typeof t === 'object' ? t : {};
  const first = ctx.k === 0, light = ctx.tone === 'light';
  const plate = light ? [248, 250, 251] : [20, 26, 34];                         // what the scrim makes of the picture behind the copy
  const PT = [0.25, 0.22, 0.23, 0.22, 0.24, 0.20];
  const pos = Array.isArray(t.pos) ? t.pos : [];
  const color = (v) => { const h = hexOk(v); return h && contrastOf(hex2rgb(h), plate) >= 4.5 ? h : ''; };   // unreadable colours are dropped -> the house ink
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const hl = obj(t.hl), sub = obj(t.sub), tag = obj(t.tag), stk = obj(t.stk), out = obj(t.out), hi = obj(hl.hi);
  const ol = Array.isArray(hl.out) ? hl.out : [], sh = Array.isArray(hl.sh) ? hl.sh : [];
  const hic = hexOk(hi.c) || ctx.accent;
  const snapW = (v, d) => { v = +v; return Number.isFinite(v) ? (v < 550 ? 400 : v < 750 ? 700 : 800) : d; };
  return {
    pos: [num(pos[0], 0.2, 0.8, 0.5), num(pos[1], 0.17, 0.5, PT[ctx.k] == null ? 0.22 : PT[ctx.k])], w: num(t.w, 0.5, 0.88, 0.88),
    align: ['l', 'c', 'r'].includes(t.align) ? t.align : 'c',
    size: num(t.size, 0.6, 1.5, 1),
    hl: {
      font: hl.font === 'b' ? 'b' : 'd', weight: snapW(hl.w, 0), case: hl.case === 'u' ? 'u' : hl.case === 'n' ? 'n' : (ctx.upper ? 'u' : 'n'),
      trk: num(hl.trk, -0.05, 0.2, ctx.upper ? 0.005 : -0.01), lead: num(hl.lead, 0.85, 1.4, ctx.upper ? 1.02 : 1.04), rot: num(hl.rot, -10, 10, 0),
      col: color(hl.col), out: { w: num(ol[0], 0, 0.1, 0), c: hexOk(ol[1]) || (light ? '#ffffff' : '#000000') },
      sh: { blur: num(sh[0], 0, 1, light ? 0.5 : 0.55), dy: num(sh[1], -0.1, 0.15, light ? 0 : 0.05), a: num(sh[2], 0, 0.8, light ? 0.75 : 0.42) },
      hi: { style: ['block', 'under', 'glow', 'none'].includes(hi.s) ? hi.s : 'block', c: hic, ink: inkOn(hic) },
      in: normalizeIn(hl.in, DEF_IN(first)),
    },
    sub: { size: num(sub.size, 0.6, 1.5, 1), font: sub.font === 'd' ? 'd' : 'b', col: color(sub.col), case: sub.case === 'u' ? 'u' : 'n', trk: num(sub.trk, -0.05, 0.2, 0), in: normalizeIn(sub.in, DEF_SUB_IN) },
    tag: { style: ['pill', 'plain', 'outline', 'tape'].includes(tag.s) ? tag.s : 'pill', in: normalizeIn(tag.in, DEF_EL_IN(first ? 0 : -0.1, 0.06, 'back.out(2)', [{ y: 0.5, s: 0.9, o: 0 }, { y: 0, s: 1, o: 1, t: 1 }])) },
    stk: { rot: num(stk.rot, -14, 14, -3), style: ['block', 'outline', 'round'].includes(stk.s) ? stk.s : 'block', in: normalizeIn(stk.in, DEF_EL_IN(0.28, 0.14, 'back.out(2.2)', [{ s: 0.55, r: -14, o: 0 }, { s: 1, r: 0, o: 1, t: 1 }])) },
    btn: { in: normalizeIn(obj(t.btn).in, DEF_EL_IN(0.3, 0.14, 'back.out(2)', [{ y: 0.9, s: 0.85, o: 0 }, { y: 0, s: 1, o: 1, t: 1 }])) },
    out: { s: num(out.s, 0.7, 1.9, 1.32), r: num(out.r, -25, 25, 0), b: num(out.b, 0, 14, 5), x: num(out.x, -60, 60, 0), y: num(out.y, -60, 60, 0), ease: okEase(out.ease, 'power2.in') },
  };
}
module.exports = { normalizeText, inkOn };
