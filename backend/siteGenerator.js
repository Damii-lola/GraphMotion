'use strict';
/*
 * AI website generator: brief -> cinematic scroll-driven single page.
 *
 *   1. Cloudflare Workers AI (small llama, JSON mode) art-directs the page as a JSON "site spec":
 *      brand, look, six scenes (copy, layout, tone, motion) and one image prompt per scene.
 *   2. Cloudflare Flux draws one background photograph per scene.
 *   3. The spec is validated / repaired in code (never trust the model with contrast, fonts or counts)
 *      and injected into backend/siteTemplate/index.html - the same WebGL flowing-background engine
 *      the AquaForge page uses - producing a self-contained folder: index.html + images/*.webp + site.json.
 *
 * The output page exposes window.__BEATS / __jumpToProgress / __PACE / __assetsReady, which is exactly
 * what siteRecorder.js needs to turn it into a video.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');
const { callCloudflareRaw } = require('./cloudflareClient');
const SPEC_MODEL = process.env.SITEGEN_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // art direction needs real copywriting + JSON discipline; one call per site

// ------------------------------------------------------------- colour helpers (WCAG)
const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (r) => '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = (r) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r[0]) + 0.7152 * f(r[1]) + 0.0722 * f(r[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** Move `rgb` toward white (dir=1) or black (dir=-1) until it reaches `min` contrast against `bg`. */
function pushContrast(rgb, bg, min, dir) {
  let c = rgb.slice();
  for (let k = 0; k < 40 && contrast(c, bg) < min; k++) c = c.map((v) => v + (dir > 0 ? (255 - v) : -v) * 0.12);
  return c;
}

// ------------------------------------------------------------- look -> fonts
const LOOKS = {
  metal: { displayFont: 'Anton', displayWeight: 400, bodyFont: 'Barlow', upper: true },
  luxury: { displayFont: 'Playfair Display', displayWeight: 700, bodyFont: 'Inter', upper: false },
  tech: { displayFont: 'Unbounded', displayWeight: 700, bodyFont: 'Inter', upper: false },
  playful: { displayFont: 'Bricolage Grotesque', displayWeight: 800, bodyFont: 'Bricolage Grotesque', upper: false },
  clean: { displayFont: 'Bricolage Grotesque', displayWeight: 700, bodyFont: 'Inter', upper: false },
};
const IMAGE_SUFFIX = ', wide cinematic photograph, dramatic rim lighting, volumetric fog, deep contrast, epic scale, film grain, shallow depth of field, no text, no letters, no logos, no watermark';

// ------------------------------------------------------------- spec from the model
const SYSTEM = `You are an art director for cinematic, scroll-driven brand websites (think award-winning Awwwards sites). You reply with ONE JSON object only.`;

function briefPrompt(brief) {
  return `Design a six-scene cinematic one-page site for this company. Write like a top ad-agency copywriter: specific to THIS company (its real products, numbers, voice, attitude), never generic filler. Every field below must be filled with real content - no placeholders, no "...".

COMPANY BRIEF:
${brief}

Return ONE JSON object with these keys:
"brand" (company name), "tagline", "look" (one of: metal = heavy-metal / punk / gothic / dark-humour brands; luxury; tech; playful; clean), "accent" (ONE bold signature colour as #RRGGBB - if the brand is black-and-white pick a stark signature accent such as blood red, never grey), "bg" (near-black #RRGGBB), "imageStyle" (6-10 words describing ONE consistent photographic look for every image), "cta" (button label, 2-4 words),
"scenes": an array of EXACTLY 6 objects, ids in this order: "hero", "story", "product1", "product2", "proof", "join".
Each scene object has: "id", "kicker" (2-5 words, small label above the headline), "title" (2-9 words; use a | character where the headline should break onto a new line), "body" (one sentence, max 22 words), "stats" (array of 2-3 objects {"n":"big number or word, max 8 chars","l":"tiny label"} for scenes story, product1, product2, proof taken from the brief; [] for hero and join), "imagePrompt" (a vivid cinematic photographic scene, max 22 words, a place / object / mood that fits THIS scene; no text, no logos, no faces), "tone" ("dark" for every scene except at most one), "align" ("left" or "right", alternating), "valign" ("bottom" for hero, otherwise "center" or "top"), "fx" ({"ripple":0-1 water shimmer,"mist":0-1 fog,"rays":0-1 light shafts}).
Scene roles: hero = the brand promise; story = who we are / why we exist; product1 and product2 = the two most exciting products; proof = scale, impact or values; join = call to action.
Output the JSON object only.`;
}

function normalizeSpec(raw, brand) {
  const S = raw && typeof raw === 'object' ? raw : {};
  const str = (v, d = '', n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);
  const num01 = (v, d) => { v = +v; return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d; };
  const IDS = ['hero', 'story', 'product1', 'product2', 'proof', 'join'];
  const src = Array.isArray(S.scenes) ? S.scenes : [];
  const look = LOOKS[S.look] ? S.look : 'clean';
  const bgRgb = hex2rgb(S.bg) || [11, 11, 13];
  const bg = rgb2hex(bgRgb.map((v) => Math.min(v, 40))); // keep the page colour genuinely dark
  let accRgb = hex2rgb(S.accent) || [255, 92, 26];
  if (Math.max(...accRgb) - Math.min(...accRgb) < 40) accRgb = lum(accRgb) < 0.4 ? [242, 242, 242] : accRgb; // a dark grey accent is invisible: use stark off-white
  const spec = {
    brand: str(S.brand, brand || 'Brand', 40), tagline: str(S.tagline, '', 60), cta: str(S.cta, 'Get started', 28),
    imageStyle: str(S.imageStyle, 'dark cinematic photography', 90),
    theme: {
      look, ...LOOKS[look], bg,
      accent: rgb2hex(accRgb),
      accentInk: contrast(accRgb, [255, 255, 255]) >= contrast(accRgb, [10, 10, 10]) ? '#ffffff' : '#0a0a0a', // readable label on the accent button
      accentLight: rgb2hex(pushContrast(accRgb, [16, 20, 26], 7, 1)), // accent as text on dark scenes
      accentDark: rgb2hex(pushContrast(accRgb, [248, 250, 251], 4.6, -1)), // accent as text on the light scene
    },
    scenes: [],
  };
  let lightUsed = 0;
  IDS.forEach((id, k) => {
    const s = src.find((x) => x && x.id === id) || src[k] || {};
    const fx = s.fx && typeof s.fx === 'object' ? s.fx : {};
    let tone = s.tone === 'light' && lightUsed < 1 && k > 0 && k < 5 ? 'light' : 'dark';
    if (tone === 'light') lightUsed++;
    const stats = (Array.isArray(s.stats) ? s.stats : []).filter((x) => x && (x.n || x.l)).slice(0, 3).map((x) => ({ n: str(x.n, '', 14), l: str(x.l, '', 24) }));
    spec.scenes.push({
      id,
      kicker: str(s.kicker, '', 44),
      title: str(s.title, k === 0 ? spec.brand : '...', 90),
      body: str(s.body, '', 170),
      stats: k > 0 && k < 5 ? stats : [],
      imagePrompt: str(s.imagePrompt, `${spec.brand} atmosphere, ${spec.imageStyle}`, 200),
      tone,
      align: k === 0 || k === 5 ? 'left' : s.align === 'right' ? 'right' : k % 2 ? 'right' : 'left',
      valign: k === 0 ? 'bottom' : ['center', 'top', 'bottom'].includes(s.valign) ? s.valign : 'center',
      fx: { ripple: num01(fx.ripple, 0.15), mist: num01(fx.mist, 0.3), rays: num01(fx.rays, 0) },
    });
  });
  return spec;
}

// ------------------------------------------------------------- images
async function flux(prompt) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !tok) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: prompt.slice(0, 900), steps: 6 }),
  });
  const j = await r.json();
  if (!j.result || !j.result.image) throw new Error('image generation failed: ' + JSON.stringify(j.errors || j).slice(0, 220));
  return Buffer.from(j.result.image, 'base64');
}
const toWebp = (inFile, outFile) => new Promise((resolve, reject) => {
  const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-i', inFile, '-vf', "scale='min(1280,iw)':-2", '-quality', '82', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; ff.stderr.on('data', (d) => { err += d; });
  ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('webp conversion failed: ' + err.slice(-200)))));
});

// ------------------------------------------------------------- main
async function generateSite({ brief, outDir, slug, onProgress, spec: given, planOnly }) {
  const say = (stage, progress) => { if (onProgress) onProgress({ stage, progress }); };
  let spec = given;
  if (!spec) {
    say('Art directing the page', 0.05);
    let raw = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      try {
        const txt = await callCloudflareRaw(SYSTEM, briefPrompt(String(brief).slice(0, 2600)), { jsonMode: true, maxTokens: 2200, temperature: 0.8, model: SPEC_MODEL });
        raw = typeof txt === 'string' ? JSON.parse(txt) : txt;
      } catch (e) { lastErr = e; }
    }
    if (!raw) throw new Error('The AI could not produce a site plan: ' + (lastErr && lastErr.message));
    spec = normalizeSpec(raw, slug);
  }
  if (planOnly) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2)); return { outDir, spec }; }
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  try {
    for (let k = 0; k < spec.scenes.length; k++) {
      const sc = spec.scenes[k], webp = path.join(outDir, 'images', sc.id + '.webp');
      if (fs.existsSync(webp) && given) { say(`Image ${k + 1}/${spec.scenes.length} (kept)`, 0.1 + 0.8 * ((k + 1) / spec.scenes.length)); continue; }
      say(`Painting scene ${k + 1} of ${spec.scenes.length}`, 0.1 + 0.8 * (k / spec.scenes.length));
      const png = path.join(tmp, sc.id + '.png');
      fs.writeFileSync(png, await flux(`${sc.imagePrompt}, ${spec.imageStyle}${IMAGE_SUFFIX}`));
      await toWebp(png, webp);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  say('Building the page', 0.95);
  const tpl = fs.readFileSync(path.join(__dirname, 'siteTemplate', 'index.html'), 'utf8');
  const html = tpl.replace('/*__SITE_JSON__*/null', () => JSON.stringify(spec).replace(/</g, '\\u003c')).replace('{{TITLE}}', () => spec.brand.replace(/[<>&]/g, ''));
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2));
  say('Done', 1);
  return { outDir, spec };
}

module.exports = { generateSite, normalizeSpec, briefPrompt, LOOKS };
