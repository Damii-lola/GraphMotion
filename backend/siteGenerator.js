'use strict';
/*
 * AI ad generator: company details -> a 9:16 social-media video AD, built as an HTML page the recorder films.
 *
 *   1. Cloudflare Workers AI (one JSON call) writes the AD SCRIPT: hook -> pain -> solution -> feature -> proof -> CTA,
 *      six 3.5 s scenes, one idea and <= 7 caption words each, with sticker stats and an image prompt per scene.
 *   2. Photographs come from the client's own uploads first (free), Cloudflare Flux fills the remaining scenes.
 *   3. The script is validated / repaired in code (never trust the model with contrast, fonts, word counts, facts) and
 *      injected into backend/siteTemplate/ad.html -> a self-contained folder: index.html + images/*.webp + site.json + audio.wav.
 *
 * The playbook this follows (hook in <= 1 s, safe zones, word-by-word kinetic captions, logo early + CTA end card, sound on
 * AND muted) is written down in docs/AD_PLAYBOOK.md.
 * The page exposes window.__BEATS / __jumpToProgress / __PACE / __assetsReady / __audio, which is what siteRecorder.js films.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');
const { callCloudflareRaw } = require('./cloudflareClient');
const neurons = require('./neuronBudget');
const flow = require('./flowSpec');
const SPEC_MODEL = process.env.SITEGEN_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct'; // ~4x cheaper per token than the 70B; one call per ad
const SCENE_SECONDS = 3.5;

// ------------------------------------------------------------- colour helpers (WCAG)
const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (r) => '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = (r) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r[0]) + 0.7152 * f(r[1]) + 0.0722 * f(r[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// ------------------------------------------------------------- look -> fonts + sound
const LOOKS = {
  metal: { displayFont: 'Anton', displayWeight: 400, bodyFont: 'Barlow', upper: true, music: 'tense' },
  luxury: { displayFont: 'Playfair Display', displayWeight: 700, bodyFont: 'Inter', upper: false, music: 'warm pad' },
  tech: { displayFont: 'Unbounded', displayWeight: 700, bodyFont: 'Inter', upper: false, music: 'pulse' },
  playful: { displayFont: 'Bricolage Grotesque', displayWeight: 800, bodyFont: 'Bricolage Grotesque', upper: false, music: 'pulse' },
  clean: { displayFont: 'Bricolage Grotesque', displayWeight: 800, bodyFont: 'Inter', upper: false, music: 'warm pad' },
};
// Vertical, single-subject, bold and bright: what performs in a phone feed. The shader crops the (square) render to 9:16, so the subject must sit in the middle.
const IMAGE_SUFFIX = ', bold commercial photograph for a social media ad, ONE clear subject in the centre, vertical composition, vibrant saturated colour, crisp dramatic lighting, shallow depth of field, clean uncluttered background, no text, no letters, no logos, no watermark';
const IDS = ['hook', 'pain', 'solution', 'feature', 'proof', 'cta'];
const USER_IMAGE_ORDER = [2, 0, 3, 4, 5, 1]; // where the client's own photos go first: product scene, then the hook, then the rest

// ------------------------------------------------------------- the brief
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function buildBrief({ name, details, focus, notes }) {
  return [`Company: ${clip(name, 60)}`, `Company details: ${String(details || '').trim().slice(0, 2400)}`, `MAIN FOCUS of this ad: ${clip(focus, 2400)}`, notes ? `Notes from the client: ${clip(notes, 2400)}` : ''].filter(Boolean).join('\n');
}

// ------------------------------------------------------------- the ad script from the model
const SYSTEM = `You are a performance-marketing creative director who writes vertical social-media video ads (TikTok, Instagram Reels, YouTube Shorts). You reply with ONE JSON object only.`;

const adMixMenu = () => require('./adMix').menu();
/** The AI picks its own sound effects: it is shown the library of real recordings (id, character, length) and chooses per moment. */
function soundBlock() {
  const m = adMixMenu(); if (!m) return '';
  return `SOUND. Pick REAL sound effects by id from this library (the whooshes play very quietly under the picture - choose the one whose character fits each dive):
${m}
Set "sfx" inside each transition to a whoosh id (vary them), and add a top-level "sound": {"music": "warm pad" | "pulse" | "tense" | "dark drone" (the bed that fits the brand), "tick": id (a caption landing), "sparkle": id (sticker pops and the button), "riser": id (into the end card), "impact": id (the end card landing)}.

`;
}
function briefPrompt(brief) {
  return `Write a 21-second vertical (9:16) social-media video AD for the company below. It is NOT a website: six scenes of 3.5 seconds, each ONE idea shown as a big caption over a full-screen photograph. Write like a top ad-agency copywriter: specific to THIS company, spoken and punchy, never generic filler. Use only facts, names and numbers that appear in the brief - never invent statistics, awards or prices.

COMPANY BRIEF:
${brief}

SCENES, in this exact order (ids fixed): 1 "hook" - stops the scroll in the first second (a bold claim, a surprising fact from the brief, a sharp question, a relatable moment; never a greeting or just the company name). 2 "pain" - the problem or desire the viewer has. 3 "solution" - the product as the answer. 4 "feature" - the single strongest benefit. 5 "proof" - credibility from the brief (number, scale, result, guarantee). 6 "cta" - the closing call to action, built around the MAIN FOCUS.

THE FLOW (the most important part). The ad is ONE continuous camera move through six images, never six slides with effects between them. Study how the best scroll-driven 3D-website shorts do it: an aeroplane window fills the screen, the camera flies INTO the window, the sky outside becomes the whole screen and rushes past, and the next scene emerges out of the clouds - nothing stops, nothing cuts, the end of every scene literally becomes the beginning of the next. Another: a face made of strands dissolves into fibres that swirl into a glowing ring which becomes the next object. Another: one mountain island keeps its shape while the light changes dawn to dusk and the camera never stops gliding. You control the flow with three things:
(1) CHAIN THE IMAGES. Write every imagePrompt as the continuation of the previous one: same palette and light, and the main subject of image N+1 sits exactly where the camera dives into image N (dive into a bottle's neck -> next image is a macro of the liquid in that same spot; dive into a window -> next image is what is outside it).
(2) EVERY SCENE HAS A CAMERA MOVE that never rests: "move": {"zoom": -0.24..0.24 (+ pushes in, - pulls out), "pan": [-0.15..0.15, -0.04..0.04], "roll": -3..3 degrees}. Vary it scene to scene.
(3) EVERY TRANSITION is the camera diving through the current image while the next one is already opening inside it. There are 5 transitions (scene 1->2 ... 5->6) in "transitions": {"focus": [x, y] where in the frame (0..1, y from the top) the camera dives - the thing that should open: a hole, a glow, the product, "zoom": 0.3..1.8 how violently it rushes, "spin": -25..25 degrees, "blur": 0..1 motion blur, "warp": 0..1 liquid distortion of the opening's edge, "glow": 0..1 light bloom, "chroma": 0..1 colour split, "soft": 0.03..0.35 edge softness, "overlap": 0.28..0.5 share of the scene the dive lasts, "mask": "..." optional}. Invent each one for THIS story; never repeat the same numbers or shape twice in a row; calm luxury brands = low blur/warp/spin, aggressive brands = high.
MASK = a GLSL float expression that shapes the opening. Variables: p (vec2: position relative to the dive point, screen height = 1, x right, y up), q (0..1 progress), t (seconds). The next image shows where the expression is NEGATIVE. Style examples (invent your own, do not copy): "length(p)-1.6*q" a circle opening; "abs(p.y)-2.0*q+0.15*sin(p.x*9.0+t*3.0)" a rippling slit widening; "length(p*vec2(1.0,0.5))-1.7*q" an ellipse; "abs(p.x)+abs(p.y)-1.9*q" a diamond. By q=1 it must cover |p|<=1.8. Allowed: p q t, numbers WITH a decimal point, + - * / ( ) . , and the functions sin cos abs length min max pow smoothstep mix clamp fract atan sqrt exp vec2. Leave "" for the plain circle.

${soundBlock()}Return ONE JSON object with these keys:
"brand", "tagline" (max 7 words), "look" (metal = heavy-metal / punk / gothic / dark-humour brands; luxury; tech; playful; clean), "accent" (ONE bold signature colour #RRGGBB - the brand's own if the brief names one; never grey), "bg" (near-black #RRGGBB), "imageStyle" (6-10 words: ONE consistent photographic look), "cta" (button label, 2-4 words), "link" (website or @handle ONLY if it appears in the brief, else ""),
"scenes": EXACTLY 6 objects, each: "id", "tag" (1-3 word pill label like "POV", "Real talk", "The proof"; "" for cta), "headline" (2-7 words, hard limit; | for a line break; wrap the 1-2 key words in *asterisks*), "sub" (optional line, max 9 words, else ""), "sticker" ({"n":"number or word, max 7 chars","l":"label, max 3 words"} for solution/feature/proof only when the brief gives a real number or fact, else null), "imagePrompt" (max 22 words, ONE subject, no text, no logos, no faces), "move" (see 2), "tone" ("dark" except at most one), "fx" ({"ripple":0-1,"mist":0-1,"rays":0-1}),
"transitions": EXACTLY 5 objects (see 3)${adMixMenu() ? ', "sound" (see SOUND)' : ''}.
Output the JSON object only.`;
}

/** Cut at a word boundary (never mid-word); a single over-long word is cut hard. */
const clipWords = (s, n) => { s = String(s || '').trim(); if (s.length <= n) return s; const cut = s.slice(0, n + 1).replace(/\s+\S*$/, ''); return (cut || s.slice(0, n)).trim(); };
/** Sticker numbers must fit their badge: 1,000,000 -> 1M, 25,000 -> 25K; anything else that is too long is dropped rather than cut in half. */
function stickerNumber(v) {
  v = String(v == null ? '' : v).trim();
  if (v.length <= 8) return v;
  const num = /^[\d.,]+$/.test(v) ? parseFloat(v.replace(/,/g, '')) : NaN;
  if (Number.isFinite(num)) { const c = num >= 1e9 ? [num / 1e9, 'B'] : num >= 1e6 ? [num / 1e6, 'M'] : [num / 1e3, 'K']; return (Math.round(c[0] * 10) / 10) + c[1]; }
  return '';
}
const words = (s) => String(s || '').replace(/[*|]/g, ' ').split(/\s+/).filter(Boolean);
/** Headline repair: <= 7 words, balanced *highlight* markers, at least one highlighted word. */
function cleanHeadline(raw, fallback) {
  let t = String(raw == null ? '' : raw).replace(/\n/g, '|').replace(/\s+/g, ' ').trim().replace(/\*([^*]+)\*([.,!?:;]+)/g, '*$1$2*'); // punctuation stays glued to its (highlighted) word
  if ((t.match(/\*/g) || []).length % 2) t = t.replace(/\*/g, '');
  const toks = t.split(/(\s+)/), out = []; let n = 0;
  for (const tok of toks) { if (/^\s+$/.test(tok)) { out.push(tok); continue; } const w = tok.replace(/[*|]/g, ''); if (!w) { out.push(tok); continue; } if (++n > 7) break; out.push(tok); }
  t = out.join('').trim() || fallback;
  if (!t.includes('*')) { const ws = words(t); const pick = ws.slice().sort((a, b) => b.length - a.length)[0] || ws[ws.length - 1]; if (pick) t = t.replace(pick, `*${pick}*`); }
  return t.slice(0, 80);
}

const flowSeed = (n) => flow.hashStr(n);
function normalizeSpec(raw, brand, opts = {}) {
  const S = raw && typeof raw === 'object' ? raw : {};
  const str = (v, d = '', n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);
  const num01 = (v, d) => { v = +v; return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d; };
  const src = Array.isArray(S.scenes) ? S.scenes : [];
  const look = LOOKS[S.look] ? S.look : 'clean';
  const bgRgb = hex2rgb(S.bg) || [11, 11, 13];
  const bg = rgb2hex(bgRgb.map((v) => Math.min(v, 40))); // keep the page colour genuinely dark
  let accRgb = hex2rgb(S.accent) || [255, 92, 26];
  if (Math.max(...accRgb) - Math.min(...accRgb) < 40) accRgb = lum(accRgb) < 0.4 ? [242, 242, 242] : accRgb; // a grey accent is invisible: use stark off-white
  const name = clip(opts.brand || S.brand || brand || 'Brand', 40);
  const briefText = String(opts.brief || '');
  let link = str(S.link, '', 60);
  if (link && !briefText.toLowerCase().includes(link.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''))) link = ''; // only a link the client actually gave us
  const spec = {
    kind: 'ad', seed: flowSeed(name), brand: name, tagline: str(S.tagline, '', 60), cta: str(S.cta, 'Learn more', 24), link,
    imageStyle: str(S.imageStyle, 'bold vibrant commercial photography', 90),
    theme: {
      look, ...LOOKS[look], bg,
      accent: rgb2hex(accRgb),
      accentInk: contrast(accRgb, [255, 255, 255]) >= contrast(accRgb, [10, 10, 10]) ? '#ffffff' : '#0a0a0a', // readable text on every accent block (highlight, sticker, button)
    },
    scenes: [],
  };
  const seed = flow.hashStr(name);
  let lightUsed = 0;
  IDS.forEach((id, k) => {
    const s = src.find((x) => x && x.id === id) || src[k] || {};
    const fx = s.fx && typeof s.fx === 'object' ? s.fx : {};
    const tone = s.tone === 'light' && lightUsed < 1 && k > 0 && k < 5 ? 'light' : 'dark';
    if (tone === 'light') lightUsed++;
    let sticker = null;
    if (s.sticker && typeof s.sticker === 'object' && (s.sticker.n || s.sticker.l) && k >= 2 && k <= 4) { const n = stickerNumber(s.sticker.n), l = clipWords(str(s.sticker.l, '', 80), 28); if (n || l) sticker = { n, l }; }
    const sub = words(str(s.sub, '', 120)).slice(0, 10).join(' ');
    spec.scenes.push({
      id,
      tag: k === 5 ? '' : clipWords(str(s.tag, '', 80), 22),
      headline: cleanHeadline(s.headline || s.title, k === 5 ? `Try *${name}* today` : `*${name}*`),
      sub, sticker,
      imagePrompt: str(s.imagePrompt, `${name} atmosphere, ${spec.imageStyle}`, 200),
      tone,
      fx: { ripple: num01(fx.ripple, 0.12), mist: num01(fx.mist, 0.25), rays: num01(fx.rays, 0) },
      move: flow.normalizeMove(s.move, seed, k),
    });
  });
  const trs = Array.isArray(S.transitions) ? S.transitions : [];
  spec.transitions = IDS.slice(1).map((_, i) => flow.normalizeTransition(trs[i], seed, i));
  const snd = S.sound && typeof S.sound === 'object' ? S.sound : {}, sid = (v) => (typeof v === 'string' ? v.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) : '');
  spec.sound = { music: ['warm pad', 'pulse', 'tense', 'dark drone'].includes(snd.music) ? snd.music : '', tick: sid(snd.tick), sparkle: sid(snd.sparkle), riser: sid(snd.riser), impact: sid(snd.impact) };
  return spec;
}

// ------------------------------------------------------------- images
async function flux(prompt) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !tok) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: prompt.slice(0, 900), steps: neurons.FLUX_STEPS }), // ~44.8 neurons per step per image (measured)
  });
  const j = await r.json();
  if (!j.result || !j.result.image) throw new Error('image generation failed: ' + JSON.stringify(j.errors || j).slice(0, 220));
  return Buffer.from(j.result.image, 'base64');
}
const runFfmpeg = (args, wantStdout) => new Promise((resolve, reject) => {
  const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'] });
  const chunks = []; let err = '';
  if (wantStdout) ff.stdout.on('data', (d) => chunks.push(d));
  ff.stderr.on('data', (d) => { err += d; });
  ff.on('close', (c) => (c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('image conversion failed: ' + err.slice(-200)))));
});
const toWebp = (inFile, outFile, maxW = 1280) => runFfmpeg(['-i', inFile, '-vf', `scale='min(${maxW},iw)':-2`, '-quality', '82', outFile]);

/** Light or dark card behind the logo so it is legible whatever colours the logo is made of. */
async function logoPlate(file) {
  const px = await runFfmpeg(['-i', file, '-vf', 'scale=24:24', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], true);
  let a = 0, w = 0, ls = 0, corner = 0, cn = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const al = px[i + 3] / 255, l = lum([px[i], px[i + 1], px[i + 2]]), p = i / 4, x = p % 24, y = Math.floor(p / 24);
    a += al; w += al; ls += l * al;
    if ((x < 3 || x > 20) && (y < 3 || y > 20)) { corner += l; cn++; }
  }
  const cover = a / (px.length / 4), body = w ? ls / w : 0.5;
  if (cover > 0.97) return corner / Math.max(1, cn) > 0.45 ? 'light' : 'dark'; // opaque logo: the card matches the logo's own background
  return body > 0.45 ? 'dark' : 'light';                                       // transparent logo: the card contrasts the logo's colour
}

// ------------------------------------------------------------- sound: a bed + a few restrained cues locked to the picture
async function adAudio(spec, dir) {
  const { synth } = require('./siteAudio');
  const adMix = require('./adMix'), lib = adMix.library();
  const S = SCENE_SECONDS, n = spec.scenes.length, end = (n - 1) * S;
  const sound = spec.sound || {};
  const music = { style: sound.music || spec.theme.music || 'warm pad', key: 'A', bpm: (sound.music || spec.theme.music) === 'tense' ? 120 : 112 };
  if (!lib.list.length) {   // no recorded effects installed: the synthesised fallback, with the whooshes kept quiet
    const cues = [];
    spec.scenes.forEach((sc, i) => {
      cues.push({ t: i * S + 0.08, kind: 'tick', gain: 0.5 });
      if (sc.sticker) cues.push({ t: i * S + 0.72, kind: 'tick', gain: 0.6 });
      if (i < n - 1) cues.push({ t: (i + 1) * S - 1.0, kind: 'whoosh', dur: 1.0, gain: 0.09 });
    });
    cues.push({ t: end - 1.1, kind: 'riser', dur: 1.1, gain: 0.3 }, { t: end + 0.02, kind: 'impact', gain: 0.5 }, { t: end + 0.02, kind: 'sub', gain: 0.4 }, { t: end + 1.1, kind: 'tick', gain: 0.6 });
    fs.writeFileSync(path.join(dir, 'audio.wav'), synth({ duration: n * S + 1, cues: cues.filter((c) => c.t >= 0), music }));
    return 'audio.wav';
  }
  // real recordings, placed on the picture: the AI chose which one for each moment (spec.sound / spec.transitions[i].sfx); anything it left out or got wrong is filled from the library
  const pick = (kind, id, salt) => { const l = lib.of(kind); if (!l.length) return null; return lib.byId[id] && lib.byId[id].kind === kind ? lib.byId[id] : l[((spec.seed || 0) + salt) % l.length]; };
  const G = adMix.GAIN, ev = [], at = (x) => path.join(adMix.LIB, x.file);
  const tick = pick('tick', sound.tick, 0), spark = pick('sparkle', sound.sparkle, 1), riser = pick('riser', sound.riser, 2), hit = pick('impact', sound.impact, 3);
  spec.scenes.forEach((sc, i) => {
    if (tick) ev.push({ file: at(tick), at: i * S + 0.08, gain: G.tick });
    if (sc.sticker && spark) ev.push({ file: at(spark), at: i * S + 0.72, gain: G.sparkle });
    if (i < n - 1) {
      const tr = spec.transitions[i], w = pick('whoosh', tr.sfx, i), mid = (i + 1 - tr.overlap / 2) * S, d = w ? w.seconds : 1;
      if (w) ev.push({ file: at(w), at: Math.max(0, mid - d * 0.45), gain: G.whoosh });   // centred on the dive, at 20 % volume
    }
  });
  if (riser) ev.push({ file: at(riser), at: Math.max(0, end - riser.seconds), gain: G.riser });
  if (hit) ev.push({ file: at(hit), at: end + 0.02, gain: G.impact });
  if (spark) ev.push({ file: at(spark), at: end + 1.1, gain: G.sparkle });
  const bed = adMix.tmpFile('.wav'), out = path.join(dir, 'audio.wav');
  fs.writeFileSync(bed, synth({ duration: n * S + 1, cues: [], music }));
  try { await adMix.mix({ bedWav: bed, events: ev, outWav: out }); } finally { fs.rmSync(bed, { force: true }); }
  return 'audio.wav';
}

// ------------------------------------------------------------- the page
function renderPage(spec) {
  const tpl = fs.readFileSync(path.join(__dirname, 'siteTemplate', 'ad.html'), 'utf8');
  return tpl.replace('/*__SITE_JSON__*/null', () => JSON.stringify(spec).replace(/</g, '\\u003c')).replace('{{TITLE}}', () => spec.brand.replace(/[<>&]/g, ''));
}

// ------------------------------------------------------------- main
/**
 * generateSite({ brief | company:{name,details,focus,notes}, logo?: Buffer, images?: Buffer[], outDir, onProgress, spec?, planOnly?, audio? })
 * Cloudflare neurons are only spent on the plan and on the scenes the client did not supply a photo for.
 */
async function generateSite({ brief, company, logo, images = [], outDir, slug, onProgress, spec: given, planOnly, audio = true }) {
  neurons.resetRun();
  const say = (stage, progress) => { if (onProgress) onProgress({ stage, progress }); };
  const text = brief || buildBrief(company || {});
  const userImgs = images.slice(0, IDS.length);
  const fluxCount = given ? 0 : IDS.length - userImgs.length;
  let spec = given;
  if (!spec) {
    say('Writing the ad script', 0.05);
    let raw = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      try {
        const prompt = briefPrompt(text.slice(0, 7800)), est = neurons.estText(SPEC_MODEL, prompt.length + SYSTEM.length, 1400);
        neurons.charge(est, 'ad script', fluxCount * neurons.estImage()); // refuses BEFORE spending if the ad could not be finished inside its ceiling
        let usage = null;
        const txt = await callCloudflareRaw(SYSTEM, prompt, { jsonMode: true, maxTokens: 2000, temperature: 0.8, model: SPEC_MODEL, timeoutMs: 120000, onUsage: (u) => { usage = u; } });
        neurons.settleText(SPEC_MODEL, est, usage, 'ad script');
        raw = typeof txt === 'string' ? JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)) : txt;
      } catch (e) { lastErr = e; }
    }
    if (!raw) throw new Error('The AI could not write the ad script: ' + (lastErr && lastErr.message));
    spec = normalizeSpec(raw, slug, { brand: company && company.name, brief: text });
  }
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  if (planOnly) { fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2)); return { outDir, spec }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  try {
    if (logo && logo.length) {
      say('Placing your logo', 0.08);
      const f = path.join(tmp, 'logo.in'); fs.writeFileSync(f, logo);
      const out = path.join(outDir, 'images', 'logo.webp');
      await toWebp(f, out, 640);
      spec.logo = { file: 'images/logo.webp', plate: await logoPlate(f) };
    }
    const own = {}; userImgs.forEach((b, k) => { own[USER_IMAGE_ORDER[k]] = b; });
    for (let k = 0; k < spec.scenes.length; k++) {
      const sc = spec.scenes[k], webp = path.join(outDir, 'images', sc.id + '.webp'), progress = 0.1 + 0.8 * (k / spec.scenes.length);
      if (fs.existsSync(webp) && given) { say(`Scene ${k + 1}/${spec.scenes.length} image (kept)`, progress); continue; }
      const f = path.join(tmp, sc.id + '.in');
      if (own[k]) { say(`Preparing your photo for scene ${k + 1}`, progress); fs.writeFileSync(f, own[k]); }
      else {
        say(`Painting scene ${k + 1} of ${spec.scenes.length}`, progress);
        neurons.charge(neurons.estImage(), `image ${k + 1}`);
        fs.writeFileSync(f, await flux(`${sc.imagePrompt}, ${spec.imageStyle}${IMAGE_SUFFIX}`));
      }
      await toWebp(f, webp);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  say('Scoring the sound', 0.93);
  if (audio && process.env.SITE_AUDIO !== '0') { try { spec.audio = await adAudio(spec, outDir); } catch (e) { console.warn('[ad] soundtrack skipped:', e.message); } }
  say('Building the ad', 0.97);
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(spec));
  fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2));
  say('Done', 1);
  return { outDir, spec };
}

module.exports = { generateSite, normalizeSpec, briefPrompt, buildBrief, renderPage, LOOKS, IDS, SCENE_SECONDS };
