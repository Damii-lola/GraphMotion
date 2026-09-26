'use strict';
/*
 * ENGINE 2, the whole pipeline: director (one small AI call) -> pictures (only what the plan uses) -> compiler (the laws) -> the page that plays it.
 */
const fs = require('fs');
const path = require('path');
const director = require('./director');
const vary = require('./vary');
const { compile } = require('./compile');
const promoFilm = require('../promoFilm');   // picture tools shared with engine 1: chroma-key cut-out, brand printing, prompts, sound mix
const klein = require('../kleinClient');
const neurons = require('../neuronBudget');
const realimg = require('./realimg');

// at most 3 pictures painted at once (a burst of parallel requests stalls the image service)
const queue = []; let running = 0;
const limit = (fn) => new Promise((res, rej) => { const go = () => { running++; Promise.resolve().then(fn).then(res, rej).finally(() => { running--; const n = queue.shift(); if (n) n(); }); }; if (running < 3) go(); else queue.push(go); });

/** clean vector props for real-photo videos (no AI-painted bottles that have nothing to do with the product): citrus wheels, glossy discs and sparkles in the product's own colours */
function vectorProp(i, colours) {
  const { createCanvas } = require('@napi-rs/canvas'), c = createCanvas(400, 400), g = c.getContext('2d'), col = colours[i % colours.length] || '#ffb020', kind = ['wheel', 'disc', 'spark'][i % 3];
  const rgbOf = (h) => [1, 3, 5].map((k) => parseInt(String(h).slice(k, k + 2), 16) || 200), [r0, g0, b0] = rgbOf(col), sh = (k) => 'rgb(' + [r0, g0, b0].map((v) => Math.round(Math.min(255, v * k))).join(',') + ')';
  if (kind === 'wheel') {
    g.fillStyle = sh(0.8); g.beginPath(); g.arc(200, 200, 190, 0, 7); g.fill(); g.fillStyle = 'rgba(255,255,255,0.92)'; g.beginPath(); g.arc(200, 200, 172, 0, 7); g.fill(); g.fillStyle = sh(1.15); g.beginPath(); g.arc(200, 200, 156, 0, 7); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 9; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(200, 200); g.lineTo(200 + Math.cos(a) * 156, 200 + Math.sin(a) * 156); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.95)'; g.beginPath(); g.arc(200, 200, 16, 0, 7); g.fill();
  } else if (kind === 'disc') {
    const gr = g.createRadialGradient(150, 140, 20, 200, 200, 190); gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.3, sh(1.1)); gr.addColorStop(1, sh(0.55)); g.fillStyle = gr; g.beginPath(); g.arc(200, 200, 185, 0, 7); g.fill();
  } else {
    g.fillStyle = sh(1.05); g.beginPath(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 - Math.PI / 2, rr = k % 2 ? 60 : 190; g.lineTo(200 + Math.cos(a) * rr, 200 + Math.sin(a) * rr); } g.closePath(); g.fill(); g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.arc(200, 200, 34, 0, 7); g.fill();
  }
  return { buf: c.toBuffer('image/png'), aspect: 1 };
}

function paintAll(plan, needs, real) {
  const key = promoFilm.pickKey(plan.product.colors), brand = plan.brand, jobs = {};
  const shell = { product: plan.product };
  const pack = (id, look) => limit(async () => {
    const hp = promoFilm.heroPrompt(shell, key, look);
    neurons.charge(neurons.estKlein(true), 'product picture ' + id);
    const tries = [() => klein.generate(hp), () => klein.generate(hp + ' No text on it.'), () => klein.generate(`${plan.product.kind}, ${look}, product photography, isolated on a plain flat pure ${key.name} (${key.hex}) background, no text`)];
    let res = null, lastErr = null;
    for (let t = 0; t < tries.length && !res; t++) { try { res = await promoFilm.cutout(await tries[t]()); } catch (e) { lastErr = e; console.warn(`[promo2] ${id} attempt ${t + 1} failed: ${String(e.message).slice(0, 110)}`); if (/429|4006|allocation|not set/i.test(String(e.message))) throw e; } }
    if (!res) throw new Error('The product picture could not be made: ' + (lastErr && lastErr.message));
    return { buf: await promoFilm.stampBrand(res.buf, brand), aspect: res.aspect };
  });
  const prop = (i, pr) => limit(async () => {
    let res = null; neurons.charge(neurons.estKlein(false), 'prop ' + (i + 1));
    for (let t = 0; t < 2 && !res; t++) { try { res = await promoFilm.cutout(await klein.generate(t ? `${pr.name || 'an ingredient'}, macro product photography, isolated on a plain flat pure ${key.name} (${key.hex}) background, no text` : promoFilm.propPrompt(pr, key), { width: 512, height: 512 })); } catch (e) { console.warn(`[promo2] prop ${i + 1} attempt ${t + 1} failed: ${String(e.message).slice(0, 100)}`); if (/429|4006|allocation/i.test(String(e.message))) throw e; } }
    if (!res) { neurons.refund(neurons.estKlein(false), 'prop ' + (i + 1) + ' (stand-in used)'); return promoFilm.fallbackProp(plan.product.colors[i % plan.product.colors.length]); }
    return res;
  });
  const realPack = (id) => { const r = id === 'hero' ? real.main : real.variants[+id.slice(4) - 2]; return Promise.resolve({ buf: r.buf, aspect: r.aspect }); };   // a real photo: no painting, no brand stamp (the pack already carries its own print)
  needs.packs.forEach((id) => { jobs[id] = real ? realPack(id) : pack(id, id === 'hero' ? plan.product.look : plan.product.variants[+id.slice(4) - 2].look); jobs[id].catch(() => {}); });
  const vcols = real ? ((real.palette && real.palette.colors) || []).concat(['#ffd23f', '#ff6b6b', '#4ecdc4']).slice(0, 4) : null;
  needs.props.forEach((id) => { const i = +id.slice(4); jobs[id] = real ? Promise.resolve(vectorProp(i, vcols)) : prop(i, plan.props[i]); jobs[id].catch(() => {}); });
  return jobs;
}

/** the picture model isolates the exact product of a real photo (busy background) on a flat key colour; then the usual cut-out */
async function isolatePhoto(buf, plan) {
  const key = promoFilm.pickKey(plan.product.colors);
  neurons.charge(neurons.estKlein(true), 'isolate product photo');
  const iso = await klein.edit(`Show exactly this product (same packaging, same printed text, logo and colours, unchanged), the WHOLE product fully visible, alone, upright, front view, centred, filling most of the frame, with no hands and nothing in front of it, isolated on a plain flat pure ${key.name} (${key.hex}) background, no other objects, no shadow.`, buf);
  const r = await promoFilm.cutout(iso); return r ? { buf: r.buf, aspect: r.aspect } : null;
}

/** REAL product photos: the client's own upload, their website / product link, or a clean studio photo from Open Food Facts; a busy client photo is isolated by the picture model. Returns null when there is none (then the packs are painted). */
async function realPhotos(plan, company, say) {
  const userPhotos = (company && company.userPhotos) || [], sitePhotos = (company && company.sitePhotos) || [];
  let got = null;
  try { got = await realimg.acquire({ name: plan.product.name, brand: plan.brand, kind: plan.product.kind, userPhotos, sitePhotos, wantVariants: 2, isolate: (b) => isolatePhoto(b, plan) }); } catch (e) { console.warn('[promo2] real photo search failed: ' + String(e.message).slice(0, 100)); }
  if (!got && (userPhotos.length || sitePhotos.length)) {                                   // the client's photo has a busy background: ask the picture model to isolate the exact product
    const src = userPhotos[0] || sitePhotos[0], key = promoFilm.pickKey(plan.product.colors);
    try {
      say('Isolating your product photo', 0.12); neurons.charge(neurons.estKlein(true), 'isolate product photo');
      const iso = await klein.edit(`Show exactly this product (same packaging, same printed text, logo and colours, unchanged), the WHOLE product fully visible, alone, upright, front view, centred, filling most of the frame, with no hands and nothing in front of it, isolated on a plain flat pure ${key.name} (${key.hex}) background, no other objects, no shadow.`, src);
      const r = await promoFilm.cutout(iso);
      if (r) { const buf = r.buf; got = { main: { buf, aspect: r.aspect }, variants: [], palette: await realimg.paletteOf(buf), credit: null }; }
    } catch (e) { console.warn('[promo2] isolating the client photo failed: ' + String(e.message).slice(0, 100)); if (/429|4006|allocation|not set/i.test(String(e.message))) throw e; }
  }
  return got;
}

function renderPage(spec) {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'siteTemplate', 'promo2.html'), 'utf8');
  return tpl.replace('/*__SITE_JSON__*/null', () => JSON.stringify(spec).replace(/</g, '\\u003c')).replace('{{TITLE}}', () => spec.brand.replace(/[<>&]/g, ''));
}

/** generate({ brief, company, outDir, say, call, planOnly }): call(system, prompt, {maxTokens, temperature, what}) -> text */
async function generate({ brief, company, outDir, say = () => {}, call, planOnly }) {
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  say('Directing your promo', 0.05);
  const dice = vary.roll(vary.hashStr((company && company.name || '') + '|' + Date.now() + '|' + Math.random()));   // this video's creative direction: nothing else is shared with any other video
  const { plan, issues } = await director.plan({ brief, call, ctx: { brand: company && company.name }, dice });
  plan.dice = dice;
  const real = planOnly ? null : await realPhotos(plan, company, say);   // real pictures of the product, or null (then the packs are painted)
  if (real) plan.product.variants = real.variants.map((v) => ({ look: v.name || '' }));
  const needs = director.neededAssets(plan);
  const spec = { kind: 'promo', engine: 2, brand: plan.brand, tagline: '', cta: '', link: '', theme: { look: 'clean', accent: plan.scenes[0].backdrop.c0, accentInk: '#000000', bg: plan.scenes[0].backdrop.c1 }, scenes: [], review: { engine: 2, real: null, dice, mimic: plan.mimic, issues, plan: { scenes: plan.scenes.map((s) => ({ archetype: s.archetype, dur: s.dur, tr: s.transition_in, params: s.params })) } } };
  if (planOnly) { spec.promo = compile(plan, { packs: { hero: { aspect: 0.5 }, ...(needs.packs.includes('hero2') ? { hero2: { aspect: 0.5 } } : {}), ...(needs.packs.includes('hero3') ? { hero3: { aspect: 0.5 } } : {}) }, props: needs.props }); fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2)); return { outDir, spec }; }
  say(real ? 'Preparing your product photos' : 'Painting your product', 0.15);
  const jobs = paintAll(plan, needs, real), packs = {}, propIds = [], assetsOut = [];
  for (const [id, pr] of Object.entries(jobs)) {
    const r = await pr;
    fs.writeFileSync(path.join(outDir, 'images', id + '.png'), r.buf); assetsOut.push({ id, file: 'images/' + id + '.png', aspect: r.aspect });
    if (id.startsWith('prop')) propIds.push(id); else packs[id] = { aspect: r.aspect };
    if (id === 'hero') say('Painting the ingredients', 0.4);
  }
  const promo = compile(plan, { packs, props: propIds, palette: real ? real.palette : await realimg.paletteOf(fs.readFileSync(path.join(outDir, 'images', 'hero.png'))).catch(() => null) });
  if (real && real.credit) { promo.credit = real.credit; spec.credit = real.credit; }
  promo.assets = assetsOut.sort((a, b) => (a.id === 'hero' ? -1 : b.id === 'hero' ? 1 : a.id.localeCompare(b.id)));
  spec.promo = promo;
  spec.review.real = real ? { source: real.credit || 'client', variants: real.variants.length, palette: real.palette } : false;
  say('Scoring the sound', 0.85);
  try { spec.audio = await promoFilm.promoAudio(promo, outDir); } catch (e) { console.warn('[promo2] soundtrack skipped:', e.message); }
  say('Building the promo', 0.95);
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(spec));
  fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2));
  say('Done', 1);
  return { outDir, spec };
}

module.exports = { generate, renderPage, compile, director };
