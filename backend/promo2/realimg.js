'use strict';
/*
 * REAL PRODUCT PHOTOS. The product in a promo must be the real product, not an AI drawing of it.
 * Sources, in order: (1) the photos the client uploaded, (2) product photos found on the client's own website, (3) real packaged-goods photos from Open Food Facts (a public,
 * community database; CC BY-SA, so a credit is returned for the job info), (4) nothing: the caller falls back to an AI picture only as a last resort.
 * A real photo is cut out from its background (flood fill from the border), and its colours are read so the scene backdrops can match the product.
 */
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const UA = 'SmartClips/1.0 (product promo maker; contact: globevoyage.app@gmail.com)';
async function getJson(url, ms = 15000) { const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
async function getBuf(url, ms = 20000) { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('HTTP ' + r.status); const b = Buffer.from(await r.arrayBuffer()); if (b.length < 2000 || b.length > 12 * 1024 * 1024) throw new Error('bad image size'); return b; }

// ------------------------------------------------------------------ Open Food Facts (packaged food and drinks)
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
const overlap = (a, b) => { const A = new Set(words(a)), B = words(b); return B.length ? B.filter((w) => A.has(w)).length / Math.max(1, Math.min(A.size, B.length)) : 0; };
async function offFind(query, brandHint, limit = 24) {
  const j = await getJson('https://search.openfoodfacts.org/search?q=' + encodeURIComponent(query) + '&page_size=' + limit + '&fields=code,product_name,brands,image_front_url,images');
  const hits = (j.hits || []).filter((h) => h.image_front_url && h.product_name);
  return hits.map((h) => ({ code: h.code, name: h.product_name, brands: [].concat(h.brands || []).join(', '), url: h.image_front_url, score: overlap(h.product_name + ' ' + [].concat(h.brands || []).join(' '), query) + (brandHint ? overlap([].concat(h.brands || []).join(' '), brandHint) : 0) })).sort((a, b) => b.score - a.score);
}
const fullUrl = (u) => u.replace(/\.(400|200|100)\.jpg$/, '.full.jpg');

// ------------------------------------------------------------------ cut-out of a real photo
/** flood fill from the border: the background is what connects to the border and looks like it. Returns { buf (PNG with alpha), aspect, quality } or null when the photo has a busy background. */
async function cutoutReal(buf) {
  const im = await loadImage(buf), k = Math.min(1, 1500 / Math.max(im.width, im.height)), w = Math.max(60, Math.round(im.width * k)), h = Math.max(60, Math.round(im.height * k));
  const c = createCanvas(w, h), g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h), d = img.data, N = w * h;
  // background colour = median of the border pixels; how much the border varies tells how busy the background is
  const bx = [], by = [], bz = [], push = (x, y) => { const i = (y * w + x) * 4; bx.push(d[i]); by.push(d[i + 1]); bz.push(d[i + 2]); };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); } for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; }, m = [med(bx), med(by), med(bz)];
  const dist = (i) => Math.sqrt((d[i] - m[0]) ** 2 + (d[i + 1] - m[1]) ** 2 + (d[i + 2] - m[2]) ** 2);
  let disp = 0; for (let t = 0; t < bx.length; t++) disp += Math.sqrt((bx[t] - m[0]) ** 2 + (by[t] - m[1]) ** 2 + (bz[t] - m[2]) ** 2); disp /= bx.length;
  if (disp > 24) return null;                                          // not a clean studio-style photo (a busy or shadowed background): a flood fill cannot separate it well
  const tol = Math.max(26, Math.min(64, 24 + disp * 1.3)), bg = new Uint8Array(N), q = new Int32Array(N); let qh = 0, qt = 0;
  const seed = (x, y) => { const p = y * w + x; if (!bg[p] && dist(p * 4) < tol) { bg[p] = 1; q[qt++] = p; } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); } for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (qh < qt) { const p = q[qh++], x = p % w, y = (p / w) | 0; for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) { if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const n = ny * w + nx; if (bg[n]) continue; const i = n * 4; if (dist(i) < tol * 1.15) { bg[n] = 1; q[qt++] = n; } } }
  // the object = everything not background; keep its largest connected part, fill nothing outside it
  const lab = new Int32Array(N), sizes = [0]; let L = 0;
  for (let s0 = 0; s0 < N; s0++) { if (bg[s0] || lab[s0]) continue; L++; sizes[L] = 0; let a = 0, b = 0; q[b++] = s0; lab[s0] = L; while (a < b) { const p = q[a++]; sizes[L]++; const x = p % w, y = (p / w) | 0; for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) { if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const n = ny * w + nx; if (!bg[n] && !lab[n]) { lab[n] = L; q[b++] = n; } } } }
  let best = 0; for (let i = 1; i <= L; i++) if (sizes[i] > sizes[best]) best = i;
  if (!best) return null; const cover = sizes[best] / N; if (cover < 0.05 || cover > 0.93) return null;
  const alpha = new Uint8ClampedArray(N); let minx = w, maxx = 0, miny = h, maxy = 0;
  for (let p = 0; p < N; p++) if (lab[p] === best) { alpha[p] = 255; const x = p % w, y = (p / w) | 0; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  // 1px feather so the edge is soft, not stair-stepped
  const soft = new Uint8ClampedArray(N); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const p = y * w + x; soft[p] = (alpha[p] * 4 + alpha[p - 1] + alpha[p + 1] + alpha[p - w] + alpha[p + w] + alpha[p - w - 1] * 0 ) / 8 * (8 / 8); }
  for (let p = 0; p < N; p++) { const a = Math.max(0, Math.min(255, (soft[p] - 40) * 1.35)); d[p * 4 + 3] = alpha[p] ? Math.max(a, 0) : 0; }
  g.putImageData(img, 0, 0);
  const pad = Math.round(Math.max(maxx - minx, maxy - miny) * 0.015), x0 = Math.max(0, minx - pad), y0 = Math.max(0, miny - pad), cw = Math.min(w - x0, maxx - minx + 2 * pad), ch = Math.min(h - y0, maxy - miny + 2 * pad);
  const out = createCanvas(cw, ch), og = out.getContext('2d'); og.drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
  const fill = sizes[best] / Math.max(1, (maxx - minx + 1) * (maxy - miny + 1));   // how much of its bounding box the object fills: a tilted or ragged cut-out fills less
  return { buf: out.toBuffer('image/png'), aspect: cw / ch, quality: { cover, disp, fill, score: (1 - disp / 24) * 0.5 + Math.min(1, fill / 0.8) * 0.5 } };
}

// ------------------------------------------------------------------ the colours of the product
/** dominant colours of a cut-out picture: up to 3 clearly different hues (weighted by saturation and area), plus whether the pack is basically neutral (white / silver / black) */
async function paletteOf(buf) {
  const im = await loadImage(buf), s = 96 / Math.max(im.width, im.height), w = Math.max(8, Math.round(im.width * s)), h = Math.max(8, Math.round(im.height * s)), c = createCanvas(w, h), g = c.getContext('2d'); g.drawImage(im, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, B = 24, acc = Array.from({ length: B }, () => ({ w: 0, r: 0, g: 0, b: 0 })); let neutral = 0, total = 0, nr = 0, ng = 0, nb = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue; total++;
    const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), v = mx, dl = mx - mn, sat = mx ? dl / mx : 0;
    if (sat < 0.25 || v < 0.15) { neutral++; nr += d[i]; ng += d[i + 1]; nb += d[i + 2]; continue; }
    let h2 = 0; if (dl) h2 = mx === r ? ((gg - b) / dl) % 6 : mx === gg ? (b - r) / dl + 2 : (r - gg) / dl + 4; h2 = (h2 * 60 + 360) % 360;
    const k = Math.floor(h2 / (360 / B)) % B, wt = sat * (0.4 + v * 0.6); acc[k].w += wt; acc[k].r += d[i] * wt; acc[k].g += d[i + 1] * wt; acc[k].b += d[i + 2] * wt;
  }
  const hexf = (r, gg, b) => '#' + [r, gg, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const order = acc.map((a, i) => [a.w, i]).sort((a, b) => b[0] - a[0]).filter((x) => x[0] > 0), picked = [];
  for (const [wt, i] of order) { if (picked.length >= 3) break; if (picked.some((p) => { const dd = Math.abs(p.i - i); return Math.min(dd, B - dd) < 3; })) continue; picked.push({ i, wt, hex: hexf(acc[i].r / wt, acc[i].g / wt, acc[i].b / wt) }); }
  const colourful = total ? picked.reduce((a, p) => a + p.wt, 0) / total : 0;
  return { colors: picked.map((p) => p.hex), neutral: colourful < 0.12 || !picked.length, neutralHex: neutral ? hexf(nr / neutral, ng / neutral, nb / neutral) : null };
}

// ------------------------------------------------------------------ finding the photos
/**
 * acquire({ name, brand, userPhotos, sitePhotos, wantVariants }) -> { main, variants[], source, credit } or null
 * each picture is { buf (PNG cut-out), aspect, name?, source }
 */
async function acquire({ name, brand, userPhotos = [], sitePhotos = [], wantVariants = 2, log = console.log }) {
  const cands = [];   // { r (cut-out), name, source }
  const tryCut = async (buf, label, source) => { try { const r = await cutoutReal(buf); if (r) cands.push({ ...r, name: label, source }); else log('[photos] ' + source + ' photo of "' + label + '" is not a clean studio-style photo: skipped'); } catch (e) { log('[photos] cut-out failed for ' + source + ': ' + String(e.message).slice(0, 80)); } };
  for (const b of userPhotos.slice(0, 3)) await tryCut(b, name, 'client upload');
  for (const b of sitePhotos.slice(0, 5)) await tryCut(b, name, 'client website');
  let credit = null;
  const haveOwn = cands.length > 0;
  if (!haveOwn || wantVariants > 0) {
    try {
      const q = [brand, name].filter(Boolean).join(' '), hits = await offFind(q, brand, 30), nameWords = words(name).filter((w) => !['can', 'bottle', 'pack', 'box'].includes(w));
      const mainOk = (h) => !nameWords.length || nameWords.filter((w) => words(h.name + ' ' + h.brands).includes(w)).length / nameWords.length >= 0.75;
      const pool = hits.filter((h) => h.score >= 0.5).slice(0, 12); log('[photos] Open Food Facts: ' + hits.length + ' hits, ' + pool.length + ' candidates for "' + q + '"');
      const got = await Promise.all(pool.map(async (h) => { try { let b; try { b = await getBuf(fullUrl(h.url)); } catch (_) { b = await getBuf(h.url); } const r = await cutoutReal(b); return r ? { ...r, name: h.name, source: 'Open Food Facts', main: mainOk(h) } : null; } catch (e) { return null; } }));
      const clean = got.filter(Boolean).filter((x) => x.quality.score >= 0.6).sort((a, b) => b.quality.score - a.quality.score);
      log('[photos] ' + clean.length + ' clean studio-style photos found in Open Food Facts');
      if (!haveOwn) { const m = clean.find((x) => x.main) || null; if (m) { cands.push(m); credit = 'Product photos: Open Food Facts contributors (CC BY-SA)'; } }
      const seen = new Set(cands.map((c) => words(c.name).join(' ')));
      for (const x of clean) { if (cands.length >= 1 + wantVariants) break; const k = words(x.name).join(' '); if (seen.has(k) || cands.includes(x)) continue; seen.add(k); if (cands.length) { cands.push(x); credit = 'Product photos: Open Food Facts contributors (CC BY-SA)'; } }
    } catch (e) { log('[photos] Open Food Facts unavailable: ' + String(e.message).slice(0, 80)); }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (a.source === 'Open Food Facts') - (b.source === 'Open Food Facts') || b.quality.score - a.quality.score);   // the client's own photos come first
  const main = cands[0], pal = await paletteOf(main.buf);
  return { main, variants: cands.slice(1, 1 + wantVariants), palette: pal, credit };
}

module.exports = { acquire, cutoutReal, paletteOf, offFind };
