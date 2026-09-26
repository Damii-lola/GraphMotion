'use strict';
/*
 * ENGINE 2, the whole pipeline: director (one small AI call) -> pictures (only what the plan uses) -> compiler (the laws) -> the page that plays it.
 */
const fs = require('fs');
const path = require('path');
const director = require('./director');
const { compile } = require('./compile');
const promoFilm = require('../promoFilm');   // picture tools shared with engine 1: chroma-key cut-out, brand printing, prompts, sound mix
const klein = require('../kleinClient');
const neurons = require('../neuronBudget');

// at most 3 pictures painted at once (a burst of parallel requests stalls the image service)
const queue = []; let running = 0;
const limit = (fn) => new Promise((res, rej) => { const go = () => { running++; Promise.resolve().then(fn).then(res, rej).finally(() => { running--; const n = queue.shift(); if (n) n(); }); }; if (running < 3) go(); else queue.push(go); });

function paintAll(plan, needs, say) {
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
  needs.packs.forEach((id) => { jobs[id] = pack(id, id === 'hero' ? plan.product.look : plan.product.variants[+id.slice(4) - 2].look); jobs[id].catch(() => {}); });
  needs.props.forEach((id) => { const i = +id.slice(4); jobs[id] = prop(i, plan.props[i]); jobs[id].catch(() => {}); });
  return jobs;
}

function renderPage(spec) {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'siteTemplate', 'promo2.html'), 'utf8');
  return tpl.replace('/*__SITE_JSON__*/null', () => JSON.stringify(spec).replace(/</g, '\\u003c')).replace('{{TITLE}}', () => spec.brand.replace(/[<>&]/g, ''));
}

/** generate({ brief, company, outDir, say, call, planOnly }): call(system, prompt, {maxTokens, temperature, what}) -> text */
async function generate({ brief, company, outDir, say = () => {}, call, planOnly }) {
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  say('Directing your promo', 0.05);
  const { plan, issues } = await director.plan({ brief, call, ctx: { brand: company && company.name } });
  const needs = director.neededAssets(plan);
  const spec = { kind: 'promo', engine: 2, brand: plan.brand, tagline: '', cta: '', link: '', theme: { look: 'clean', accent: plan.scenes[0].backdrop.c0, accentInk: '#000000', bg: plan.scenes[0].backdrop.c1 }, scenes: [], review: { engine: 2, mimic: plan.mimic, issues, plan: { scenes: plan.scenes.map((s) => ({ archetype: s.archetype, dur: s.dur, tr: s.transition_in, params: s.params })) } } };
  if (planOnly) { spec.promo = compile(plan, { packs: { hero: { aspect: 0.5 }, ...(needs.packs.includes('hero2') ? { hero2: { aspect: 0.5 } } : {}), ...(needs.packs.includes('hero3') ? { hero3: { aspect: 0.5 } } : {}) }, props: needs.props }); fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2)); return { outDir, spec }; }
  say('Painting your product', 0.15);
  const jobs = paintAll(plan, needs), packs = {}, propIds = [], assetsOut = [];
  for (const [id, pr] of Object.entries(jobs)) {
    const r = await pr;
    fs.writeFileSync(path.join(outDir, 'images', id + '.png'), r.buf); assetsOut.push({ id, file: 'images/' + id + '.png', aspect: r.aspect });
    if (id.startsWith('prop')) propIds.push(id); else packs[id] = { aspect: r.aspect };
    if (id === 'hero') say('Painting the ingredients', 0.4);
  }
  const promo = compile(plan, { packs, props: propIds });
  promo.assets = assetsOut.sort((a, b) => (a.id === 'hero' ? -1 : b.id === 'hero' ? 1 : a.id.localeCompare(b.id)));
  spec.promo = promo;
  say('Scoring the sound', 0.85);
  try { spec.audio = await promoFilm.promoAudio(promo, outDir); } catch (e) { console.warn('[promo2] soundtrack skipped:', e.message); }
  say('Building the promo', 0.95);
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(spec));
  fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2));
  say('Done', 1);
  return { outDir, spec };
}

module.exports = { generate, renderPage, compile, director };
