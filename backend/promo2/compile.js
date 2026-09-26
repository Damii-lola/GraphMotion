'use strict';
/*
 * THE COMPILER: plan (what the AI chose) + the real picture sizes -> the finished promo (layers, hero path, camera, sound), with the LAWS applied to everything.
 */
const { showName, LAWS, W, H, clamp, num, fixHex, rgb, hex, mix, vividBackdrop, inkFor, accentFor, fitSize, safeFont, cleanWord, oneOf } = require('./laws');
const vary = require('./vary');
const backdrop = require('./backdrop');
const { ARCH, IDS, minDur, seedRand, A, text, shape, scatter, push } = require('./archetypes');

const TRANSITIONS = ['cut', 'flash', 'wipe', 'zoomblur', 'iris', 'glide', 'brandflash'];

/** LAW (time): scenes are 1.4-4.2 s, the promo 6-12.4 s; durations are scaled to fit, keeping their proportions */
function fitDurations(durs) {
  const T = LAWS.timing; let d = durs.map((x) => clamp(+x || 2.2, T.sceneMin, T.sceneMax)), sum = d.reduce((a, b) => a + b, 0);
  for (let k = 0; k < 6 && (sum > T.totalMax + 1e-6 || sum < T.totalMin - 1e-6); k++) { const f = sum > T.totalMax ? T.totalMax / sum : T.totalMin / sum; d = d.map((x) => clamp(x * f, T.sceneMin, T.sceneMax)); sum = d.reduce((a, b) => a + b, 0); }
  return d.map((x) => +x.toFixed(2));
}

/** extras: the AI's own free layers for a scene, kept inside the laws (few, big, inside the scene, inside the frame) */
function addExtras(ctx, extras) {
  (Array.isArray(extras) ? extras : []).slice(0, LAWS.density.maxExtrasPerScene).forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const u0 = clamp(num(e.u0 !== undefined ? e.u0 : e.t0, 0.3, 0, ctx.dur - 0.5), 0, ctx.dur - 0.5), u1 = clamp(num(e.u1 !== undefined ? e.u1 : e.t1, ctx.dur, u0 + 0.3, ctx.dur), u0 + 0.3, ctx.dur);
    if (e.kind === 'text') { const lines = (Array.isArray(e.lines) ? e.lines : [e.text]).map((s) => cleanWord(s, 18)).filter(Boolean).slice(0, 2); if (!lines.length || lines.join(' ').split(' ').length > 4) return; text(ctx, { u0, u1: Math.max(u1, u0 + LAWS.type.minHold), lines, size: clamp(num(e.size, 0.06, 0.04, 0.3), 0.04, 0.3), font: safeFont(e.font, 'anton'), x: ((xx, yy) => (xx > 0.3 && xx < 0.7 && yy > 0.25 && yy < 0.88 ? (xx < 0.5 ? 0.17 : 0.83) : xx))(clamp(num(e.x, 0.5, 0.12, 0.88), 0.12, 0.88), clamp(num(e.y, 0.5, 0.07, 0.93), 0.07, 0.93)), y: clamp(num(e.y, 0.5, 0.07, 0.93), 0.07, 0.93), r: clamp(num(e.r, 0, -90, 90), -90, 90), color: inkFor(ctx.pal.c0, e.color), in: { kind: oneOf(e.in, ['slam', 'rise', 'pop', 'fade', 'slideL', 'slideR', 'drop', 'slice'], 'pop'), dur: 0.4, stag: 0.15 }, front: true, z: 5 }); }
    else if (e.kind === 'scatter') scatter(ctx, { n: num(e.n, 5, 2, 9), from: oneOf(e.from, ['burst', 'corners', 'edges', 'top', 'sides'], 'corners'), u0, u1, seed: num(e.seed, 5, 1, 999) | 0 });
    else if (['burst', 'rings', 'circle', 'oval', 'line'].includes(e.kind)) shape(ctx, { kind: e.kind, u0, u1, x: clamp(num(e.x, 0.5, -0.1, 1.1), -0.1, 1.1), y: clamp(num(e.y, 0.5, -0.1, 1.1), -0.1, 1.1), size: clamp(num(e.size, 0.2, 0.04, 0.5), 0.04, 0.5), w: clamp(num(e.w, 0.4, 0.05, 0.9), 0.05, 0.9), h: clamp(num(e.h, 0.12, 0.03, 0.4), 0.03, 0.4), n: clamp(num(e.n, 8, 3, 14), 3, 14), gap: 0.12, width: 0.01, speed: 0.5, life: 1, dur: 0.6, x1: num(e.x1, 0.3, 0, 1), y1: num(e.y1, 0.5, 0, 1), x2: num(e.x2, 0.7, 0, 1), y2: num(e.y2, 0.5, 0, 1), arrow: !!e.arrow, color: fixHex(e.color, ctx.pal.accent), color2: ctx.pal.ink, alpha: clamp(num(e.alpha, 0.5, 0.05, 1), 0.05, 1), z: kindZ(e.kind) });
  });
}
const kindZ = (k) => (['rings', 'rays', 'wave', 'stripes', 'dots'].includes(k) ? 0 : ['circle', 'rect'].includes(k) ? 0 : ['flash', 'wipe', 'zoomblur', 'iris'].includes(k) ? 7 : 4);

/**
 * plan: { brand, cta, product, props, sound, mimic, scenes:[{archetype, dur, backdrop:{c0,c1}, accent, transition_in, dir, params, extras}] }  (already normalised by director.normalizePlan)
 * assets: { packs: { hero: {aspect}, hero2?, hero3? }, props: ['prop0', ...] }
 */
function compile(plan, assets) {
  const dice = plan.dice || vary.roll(vary.hashStr(plan.brand + '|' + (plan.product && plan.product.name)));
  const durs = fitDurations(plan.scenes.map((s) => Math.max(s.dur, minDur(s.archetype, s.params)))), scenes = [];
  let t = 0; plan.scenes.forEach((s, i) => { scenes.push({ ...s, dur: durs[i], t0: +t.toFixed(2), t1: +(t + durs[i]).toFixed(2) }); t += durs[i]; });
  const D = +t.toFixed(2), zones = [], beats = [], layers = [], cam = [], cues = [], heroWay = [], summaries = [];
  const out = (i) => ({ layers: [], hero: [], cam: [], cues: [], heroUsed: false });
  let flashes = 0, wipes = 0, blurs = 0, zx = 0, lastPal = null;
  const roles = backdrop.assignRoles({ scenes }, dice);

  scenes.forEach((S, i) => {
    const bd = backdrop.scene(roles[i], S.backdrop && S.backdrop.style, assets.palette, plan.product, dice, i);
    const bg0 = bd.c0, bg1 = bd.c1, ink = inkFor(bg0, null), accent = bd.accent;
    const tr = oneOf(S.transition_in, TRANSITIONS, i ? 'cut' : 'cut');
    S.tr = i ? tr : 'cut';
    zx += i === 0 ? 0 : (S.tr === 'glide' ? 700 : 3200);
    zones.push({ c0: bg0, c1: bg1, shape: bd.shape, angle: bd.angle, ox: bd.ox, oy: bd.oy, x: zx, y: 0 });
    lastPal = { ink, accent, c0: bg0 };
    const pal = { c0: bg0, c1: bg1, ink, accent };
    const ctx = { t0: S.t0, t1: S.t1, dur: S.dur, pal, packs: assets.packs, props: (assets.props || []).map((id) => ({ id })), brand: plan.brand, cta: plan.cta, seed: 3 + i * 17, out: out(i), v: vary.forScene(dice, i) };
    const A0 = ARCH[oneOf(S.archetype, IDS, 'showcase')];
    try { A0.build(S.params || {}, ctx); } catch (e) { console.warn('[promo2] archetype ' + S.archetype + ' failed: ' + String(e.message).slice(0, 120)); }
    try { addExtras(ctx, S.extras); } catch (e) { /* extras never break a scene */ }
    // LAW (density): a scene has at most maxLayersPerScene layers: the extras and the small effects go first
    const lim = LAWS.density.maxLayersPerScene; if (ctx.out.layers.length > lim) { const keep = ctx.out.layers.filter((l) => l.z !== 4 || l.kind === 'sprite' || l.kind === 'scatter'); ctx.out.layers = keep.slice(0, lim); }
    beats.push({ t0: S.t0, t1: S.t1, zone: i, ...(i && S.tr !== 'glide' ? { cut: true } : {}) });
    // transitions (drawn over both scenes around the cut)
    if (i) {
      const dirn = oneOf(S.dir, ['left', 'right', 'up', 'down'], i % 2 ? 'left' : 'right');
      if (S.tr === 'flash' && flashes < LAWS.density.maxFlash) { flashes++; layers.push({ kind: 'flash', color: '#ffffff', alpha: 0.85, t0: +(S.t0 - 0.12).toFixed(2), t1: +(S.t0 + 0.16).toFixed(2), z: 7 }); cues.push({ t: +(S.t0 - 0.1).toFixed(2), kind: 'whoosh' }); }
      else if (S.tr === 'wipe' && wipes < LAWS.density.maxWipe) { wipes++; layers.push({ kind: 'wipe', dir: dirn, n: 2, color: bg0, color2: accent, t0: +(S.t0 - 0.3).toFixed(2), t1: +(S.t0 + 0.3).toFixed(2), z: 7 }); cues.push({ t: +(S.t0 - 0.3).toFixed(2), kind: 'whoosh' }); }
      else if (S.tr === 'zoomblur' && blurs < LAWS.density.maxZoomBlur) { blurs++; layers.push({ kind: 'zoomblur', amp: 0.35, t0: +(S.t0 - 0.25).toFixed(2), t1: +(S.t0 + 0.25).toFixed(2), z: 7 }); cues.push({ t: +(S.t0 - 0.25).toFixed(2), kind: 'whoosh' }); }
      else if (S.tr === 'brandflash' && blurs < LAWS.density.maxZoomBlur) {   // the brand slams in huge under a zoom blur (Goli's logo flash)
        blurs++; const bl = String(plan.brand || '').toUpperCase().split(' ').slice(0, 2), bc = Math.max(...bl.map((q) => q.length), 1);
        layers.push({ kind: 'text', lines: bl, x: 0.5, y: 0.5, size: fitSize(bc, 'giant') * (bl.length > 1 ? 0.85 : 1), font: 'anton', color: '#ffffff', upper: true, r: 0, track: 0, align: 'center', in: { kind: 'pop', dur: 0.25 }, t0: +(S.t0 - 0.5).toFixed(2), t1: +(S.t0 + 0.3).toFixed(2), z: 7, front: true, shadow: true });
        layers.push({ kind: 'zoomblur', amp: 0.5, t0: +(S.t0 - 0.45).toFixed(2), t1: +(S.t0 + 0.3).toFixed(2), z: 7 }); cues.push({ t: +(S.t0 - 0.5).toFixed(2), kind: 'impact' }); }
      else if (S.tr === 'iris') { layers.push({ kind: 'iris', color: bg0, x: 0.5, y: 0.5, t0: +(S.t0 - 0.6).toFixed(2), t1: +S.t0.toFixed(2), z: 7 }); cues.push({ t: +(S.t0 - 0.6).toFixed(2), kind: 'whoosh' }); }
    }
    // the pack's path: an invisible jump to this scene's first pose, so it never slides across a cut
    const hw = ctx.out.hero.slice().sort((a, b) => a.t - b.t);
    if (i > 0) heroWay.push({ t: S.t0, x: 1.6, y: 0.5, w: 0.5, r: 0, o: 0 });
    if (hw.length) {
      const f = hw[0]; heroWay.push({ t: +(f.t - 0.002).toFixed(3), x: f.x, y: f.y, w: f.w, r: f.r, o: 0 }, { ...f, o: 1 });
      hw.slice(1).forEach((k, j) => heroWay.push(k)); heroWay[heroWay.length - 1].o = 1; heroWay[heroWay.length - 1].t = Math.min(heroWay[heroWay.length - 1].t, +(S.t1 - 0.02).toFixed(3));
    }
    ctx.out.layers.forEach((l) => layers.push(l)); ctx.out.cam.forEach((c) => cam.push(c)); ctx.out.cues.forEach((c) => cues.push(c));
    summaries.push(`${i + 1}. ${S.archetype} (${S.t0}-${S.t1} s, ${S.tr})`);
  });

  // ---- the brand shows inside the LAST scene (there is no separate end card): a quiet lockup is added when the scene did not already carry the name
  { const last = scenes[scenes.length - 1], shown = showName(plan.brand, plan.product), w0 = String(shown || '').split(' ')[0].toLowerCase();
    const has = layers.some((l) => l.kind === 'text' && l.t0 >= last.t0 - 0.3 && l.lines.join(' ').toLowerCase().includes(w0));
    if (!has && lastPal) layers.push({ kind: 'text', lines: [String(shown || '').toUpperCase()], x: 0.5, y: 0.93, size: fitSize(Math.max(4, String(shown || '').length), 'line') * 1.1, font: vary.forScene(dice, scenes.length - 1).font('head'), color: lastPal.ink, upper: true, r: 0, track: 0.12, align: 'center', in: { kind: 'pop', dur: 0.4 }, t0: +(last.t0 + 0.9).toFixed(2), t1: D, front: true, shadow: true, z: 6 }); }
  // ---- the main pack: ONE continuous track
  const way = heroWay.sort((a, b) => a.t - b.t);
  if (way.length >= 1) {
    if (way.length === 1) way.push({ ...way[0], t: +(way[0].t + 0.1).toFixed(3) });
    const base = 0.5, keys = way.map((k) => { const q = { t: k.t, x: k.x, y: k.y, s: +(k.w / base).toFixed(3), r: k.r, ...(k.blur !== undefined ? { blur: k.blur } : {}), ...(k.e ? { e: k.e } : {}), ...(k.o !== undefined ? { o: k.o } : {}), ...(k.sx !== undefined ? { sx: k.sx } : {}), ...(k.sy !== undefined ? { sy: k.sy } : {}) }; return q; });
    layers.push({ kind: 'sprite', src: 'hero', main: true, t0: keys[0].t, t1: D, x: keys[0].x, y: keys[0].y, w: base, r: 0, keys, idle: { kind: 'drift', amp: 0.008, speed: 1 }, shadow: true, z: 3 });
  }
  // ---- other pack sprites (variants): waypoints in width -> scale keys
  layers.forEach((l) => { if (l.kind === 'sprite' && l.pack && l.keys) { const b = l.keys[0].w || l.w || 0.5; l.w = b; l.keys = l.keys.map((k) => { const q = { ...k, s: +((k.w || b) / b).toFixed(3) }; delete q.w; return q; }); l.z = 3; } });

  // ---- laws that look across the whole promo
  const lay = enforceGlobal(layers, D);
  // draw order: z (behind -> in front), stable
  const ordered = lay.map((l, i) => [l.z !== undefined ? l.z : kindZ(l.kind), i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  ordered.forEach((l) => { delete l.z; delete l.isBrand; });
  return { engine: 2, dice, brand: plan.brand, product: plan.product, props: plan.props, duration: D, mimic: plan.mimic, ideas: summaries, zones, beats, layers: ordered, cam: dedupeCam(cam), sound: { music: plan.sound && plan.sound.music || 'pulse', cues: dedupeCues(cues, D) }, pan: 0.8 };
}

function enforceGlobal(layers, D) {
  let out = layers.slice();
  // LAW (density): at most maxLayersTotal layers, dropping the most decorative first
  const dec = (l) => (l.kind === 'burst' ? 0 : l.kind === 'scatter' ? 1 : ['rings', 'rays', 'wave', 'stripes', 'dots'].includes(l.kind) ? 2 : 9);
  while (out.length > LAWS.density.maxLayersTotal) { const i = out.map((l, k) => [dec(l), k]).sort((a, b) => a[0] - b[0] || b[1] - a[1])[0][1]; if (dec(out[i]) === 9) break; out.splice(i, 1); }
  // LAW (density): at most 2 scatters at once (drawn per frame), waves at most maxWaves
  const sc = out.filter((l) => l.kind === 'scatter').sort((a, b) => a.t0 - b.t0), keep = [];
  sc.forEach((s) => { if (keep.filter((k) => k.t1 > s.t0 && k.t0 < s.t1).length < LAWS.props.maxScatterAtOnce) keep.push(s); });
  out = out.filter((l) => l.kind !== 'scatter' || keep.includes(l));
  let w = 0; out = out.filter((l) => l.kind !== 'wave' || ++w <= LAWS.density.maxWaves);
  // LAW (type): a word stays at least minHold seconds; at most maxWordsTotal words in all (the smallest lines go first)
  out.forEach((l) => { if (l.kind === 'text' && l.t1 - l.t0 < LAWS.type.minHold) l.t1 = +Math.min(D, l.t0 + LAWS.type.minHold).toFixed(2); });
  let words = 0; const texts = out.filter((l) => l.kind === 'text' && !l.repeat && !l.tone).map((l) => [l, l.lines.join(' ').split(/\s+/).filter(Boolean).length]).sort((a, b) => b[0].size - a[0].size);
  const drop = new Set(); texts.forEach(([l, n]) => { if (words + n > LAWS.type.maxWordsTotal && !l.front) drop.add(l); else words += n; });
  return out.filter((l) => !drop.has(l));
}
function dedupeCam(cam) { const seen = new Set(); return cam.filter((c) => { const k = c.kind + Math.round(c.t * 4); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12); }
function dedupeCues(cues, D) { const seen = new Set(); return cues.filter((c) => c.t >= 0 && c.t < D).filter((c) => { const k = c.kind + Math.round(c.t * 5); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t).slice(0, 26); }

module.exports = { compile, fitDurations, TRANSITIONS };
