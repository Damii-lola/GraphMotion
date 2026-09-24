'use strict';
/*
 * The AI DIRECTOR. Given a company brief it writes a motion script for the cinema engine
 * (backend/siteTemplate2): a sequence of visual BEATS - each with its own photograph, camera move,
 * kinetic typography, transition, rhythm and sound cues - plus the look (fonts, grade, particle motif)
 * and the soundtrack. Nothing here is a fixed layout: the model decides the story, the pacing and
 * which of the engine's tools serves each moment. Code only validates and repairs (never trust a
 * model with durations, contrast or vocabulary).
 */
const { callCloudflareRaw } = require('./cloudflareClient');
const { cuesFromSpec } = require('./siteAudio');
const neurons = require('./neuronBudget');
const SPEC_MODEL = process.env.SITEGEN_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct'; // ~4x cheaper per token than the 70B and good at structured writing

const CAMERAS = ['push', 'pull', 'pan-left', 'pan-right', 'crane-up', 'crane-down', 'orbit', 'handheld'];
const TRANSITIONS = ['cut', 'morph', 'fly', 'twist', 'ripple', 'flash', 'iris', 'glitch'];
const TEXT_FX = ['rise', 'carve', 'pop', 'scatter', 'glitch', 'drip', 'focus'];
const MOTIFS = ['none', 'embers', 'dust', 'rain', 'snow', 'sparks', 'bubbles'];
const MOODS = ['teal-orange', 'mono-red', 'gold', 'cold-blue', 'neon', 'natural', 'mono'];
const LOOKS = {
  metal: { displayFont: 'Anton', displayWeight: 400, bodyFont: 'Barlow', upper: true },
  luxury: { displayFont: 'Playfair Display', displayWeight: 700, bodyFont: 'Inter', upper: false },
  tech: { displayFont: 'Unbounded', displayWeight: 700, bodyFont: 'Inter', upper: false },
  playful: { displayFont: 'Bricolage Grotesque', displayWeight: 800, bodyFont: 'Bricolage Grotesque', upper: false },
  clean: { displayFont: 'Bricolage Grotesque', displayWeight: 700, bodyFont: 'Inter', upper: false },
};

// ------------------------------------------------------------- colour helpers (WCAG)
const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (r) => '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = (r) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r[0]) + 0.7152 * f(r[1]) + 0.0722 * f(r[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function pushContrast(rgb, bg, min) { let c = rgb.slice(); for (let k = 0; k < 40 && contrast(c, bg) < min; k++) c = c.map((v) => v + (255 - v) * 0.12); return c; }

// ------------------------------------------------------------- prompt
const SYSTEM = 'You are an award-winning film director, motion designer and sound designer making a 25-30 second cinematic short for a brand. You reply with ONE JSON object only.';

function directorPrompt(brief) {
  return `Direct a cinematic vertical short for this company (music-video energy, not a website). Be specific to THIS brand: real products, numbers, attitude. Punchy, surprising, never generic.

BRIEF:
${brief}

CORE IDEA: every scene has ONE unique hero object at the centre of the frame. When a scene ends the camera locks on its hero and THAT OBJECT TRANSFORMS INTO THE NEXT SCENE'S HERO, which grows into the next scene (like a paper plane that becomes a boat). Pick heroes that rhyme visually with the next one and tell the brand's story in order.

Choices: camera: ${CAMERAS.join(', ')}. transition: morph, fly, twist, ripple, flash, iris (glitch or cut at most once). text fx: ${TEXT_FX.join(', ')}. motif: ${MOTIFS.join(', ')}. mood: ${MOODS.join(', ')}. look: metal, luxury, tech, playful, clean. music: dark drone, pulse, warm pad, tense.

Reply with ONE compact JSON object:
{"brand":"","tagline":"","cta":"2-4 words","look":"","accent":"#RRGGBB bold, not grey","bg":"#RRGGBB near-black","mood":"","motif":"","music":"","imageStyle":"6-10 words, one photographic look for every image",
"beats":[{"hero":"one physical object","size":0.2-0.4,"image":"shot description, 18-26 words: the hero large and centred in its environment, light, lens, colour; no text/logos/faces","dur":2.4-3.6,"camera":"","focus":[0.4-0.6,0.4-0.6],"text":[["HOOK 1-3 WORDS","xl"],["a concrete brand fact, 2-6 words","m"]],"fx":"","y":0.15-0.28 or 0.72-0.85,"align":"left|center|right","transition":["type",0.8-1.2]}]}

RULES: exactly 7 beats (24-26s total): hook, world/attitude, 2 product reveals, proof with real numbers, mission, payoff (brand name + call to action). Every beat: its own hero, image and text - never repeat one. Use 4+ different transitions, 5+ camera moves, 4+ text fx. Text lines: real brand facts (names, flavours, numbers). Last beat transition is ignored but present. JSON only.`;
}

// ------------------------------------------------------------- validation / repair
const parseJson = (txt) => { if (txt && typeof txt === 'object') return txt; const t = String(txt || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, ''); const i = t.indexOf('{'), j = t.lastIndexOf('}'); return JSON.parse(i >= 0 && j > i ? t.slice(i, j + 1) : t); };
/** Accept both the compact reply format above and the older verbose one. */
function expand(raw) {
  const S = raw && typeof raw === 'object' ? { ...raw } : {};
  if (typeof S.mood === 'string') S.grade = { mood: S.mood }; if (typeof S.motif === 'string') S.motif = { type: S.motif }; if (typeof S.music === 'string') S.music = { style: S.music };
  S.beats = (Array.isArray(S.beats) ? S.beats : []).map((b, k) => {
    if (!b || typeof b !== 'object') return b; const o = { ...b };
    if (typeof o.hero === 'string') o.hero = { label: o.hero, r: o.size }; if (typeof o.image === 'string') o.image = { prompt: o.image };
    if (Array.isArray(o.text)) o.text = { lines: o.text.map((l) => (Array.isArray(l) ? { t: l[0], s: l[1] } : l)), fx: o.fx, y: o.y, align: o.align, behind: k === 2 || k === 5 };
    if (Array.isArray(o.transition)) o.transition = { type: o.transition[0], dur: o.transition[1] };
    if (o.dof === undefined) o.dof = 0.35 + 0.25 * (k % 3) / 2; if (o.rack === undefined) o.rack = ['in', 'none', 'out'][k % 3];
    return o;
  });
  return S;
}
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const str = (v, d = '', n = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);

function normalize(raw, brandFallback) {
  const S = expand(raw);
  const look = LOOKS[S.look] ? S.look : 'clean';
  const bgRgb = (hex2rgb(S.bg) || [11, 11, 13]).map((v) => Math.min(v, 34));
  let acc = hex2rgb(S.accent) || [255, 92, 26];
  if (Math.max(...acc) - Math.min(...acc) < 40) acc = lum(acc) < 0.4 ? [242, 242, 242] : acc;
  const spec = {
    brand: str(S.brand, brandFallback || 'Brand', 40), tagline: str(S.tagline, '', 60), cta: str(S.cta, 'Get started', 26),
    imageStyle: str(S.imageStyle, 'dark cinematic photography', 100),
    theme: {
      look, ...LOOKS[look], bg: rgb2hex(bgRgb), accent: rgb2hex(acc),
      accentInk: contrast(acc, [255, 255, 255]) >= contrast(acc, [10, 10, 10]) ? '#ffffff' : '#0a0a0a',
      accentLight: rgb2hex(pushContrast(acc, [16, 20, 26], 7)),
    },
    grade: { mood: pick(S.grade && S.grade.mood, MOODS, 'natural'), contrast: num(S.grade && S.grade.contrast, 0.9, 1.4, 1.15), saturation: num(S.grade && S.grade.saturation, 0.5, 1.3, 0.95), grain: num(S.grade && S.grade.grain, 0, 1, 0.5) },
    motif: { type: pick(S.motif && S.motif.type, MOTIFS, 'dust'), density: num(S.motif && S.motif.density, 0.1, 0.85, 0.4) },
    music: { style: pick(S.music && S.music.style, ['dark drone', 'pulse', 'warm pad', 'tense', 'none'], 'dark drone'), bpm: num(S.music && S.music.bpm, 70, 150, 100), key: pick(S.music && S.music.key, ['A', 'C', 'D', 'E', 'F', 'G', 'B'], 'A') },
    images: [], beats: [],
  };
  // images: one per beat (from beat.image.prompt); a legacy top-level images[] list is still understood
  const seen = new Set();
  (Array.isArray(S.images) ? S.images : []).forEach((im, k) => {
    if (!im) return; const id = str(im.id, 'img' + k, 20).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (seen.has(id) || spec.images.length >= 8) return; seen.add(id);
    spec.images.push({ id, prompt: str(im.prompt, spec.brand + ' atmosphere', 220) });
  });
  const ids = spec.images.map((i) => i.id);
  const beatSrc = Array.isArray(S.beats) ? S.beats.filter((x) => x && typeof x === 'object').slice(0, 11) : [];
  beatSrc.forEach((bb, k) => { if (bb.image && typeof bb.image === 'object' && str(bb.image.prompt)) { const id = 'b' + k; if (!spec.images.some((im) => im.id === id)) spec.images.push({ id, prompt: str(bb.image.prompt, '', 260), hero: str(bb.hero && bb.hero.label, '', 80) }); } });
  if (!spec.images.length) spec.images.push({ id: 'hero', prompt: `${spec.brand} atmosphere, ${spec.imageStyle}` });
  const allIds = spec.images.map((i) => i.id);
  // beats
  const src = beatSrc;
  let prevType = null;
  src.forEach((b, k) => {
    const last = k === src.length - 1;
    const lines = (b.text && Array.isArray(b.text.lines) ? b.text.lines : []).map((l) => (typeof l === 'string' ? { t: l, s: 'l', a: false } : l)).filter((l) => l && str(l.t)).slice(0, 3)
      .map((l, li) => ({ t: str(l.t, '', 30), s: pick(l.s, ['xl', 'l', 'm', 's'], li === 0 ? 'xl' : 'm'), a: !!l.a }));
    const delay = num(b.text && b.text.delay, 0.05, 0.6, 0.2);
    let ttype = pick(b.transition && b.transition.type, TRANSITIONS, 'morph');
    if (ttype === prevType) ttype = TRANSITIONS[(TRANSITIONS.indexOf(ttype) + 3) % TRANSITIONS.length];
    prevType = ttype;
    const trd = last ? 0.3 : num(b.transition && b.transition.dur, 0.6, 1.3, 0.9);
    // the words must be readable: in + hold ≥ 1.1s before the transition starts
    const minDur = lines.length ? delay + 1.15 + trd : 1.2 + trd;
    const beat = {
      image: b.image && typeof b.image === 'object' ? 'b' + k : (allIds.includes(b.image) ? b.image : allIds[k % allIds.length]),
      hero: { label: str(b.hero && b.hero.label, '', 80), r: num(b.hero && b.hero.r, 0.14, 0.42, 0.28) },
      dur: Math.min(3.8, Math.max(num(b.dur, 1.2, 3.6, 2.2), minDur)),
      camera: pick(b.camera, CAMERAS, CAMERAS[k % CAMERAS.length]), camAmount: num(b.camAmount, 0.08, 0.36, 0.2),
      focus: [num(b.focus && b.focus[0], 0.36, 0.64, 0.5), num(b.focus && b.focus[1], 0.36, 0.64, 0.5)], // the hero sits near the middle, where the image generator puts it
      dof: num(b.dof, 0, 0.95, 0.4), dofFocus: num(b.dofFocus, 0, 1, 0.5), rack: pick(b.rack, ['in', 'out', 'none'], 'none'),
      transition: { type: ttype, dur: trd },
      sfx: [],
    };
    if (lines.length) {
      let ty = num(b.text.y, 0.14, 0.86, 0.75); if (Math.abs(ty - beat.focus[1]) < 0.22) ty = beat.focus[1] < 0.5 ? 0.76 : 0.24; // never write over the hero
      beat.text = { lines, fx: pick(b.text.fx, TEXT_FX, 'rise'), x: num(b.text.x, 0.1, 0.9, 0.5), y: ty, align: pick(b.text.align, ['left', 'center', 'right'], 'left'), delay, behind: !!b.text.behind, upper: spec.theme.upper };
    }
    spec.beats.push(beat);
  });
  if (spec.beats.length < 6) throw new Error('The director returned too few beats (' + spec.beats.length + ')');
  const lastB = spec.beats[spec.beats.length - 1]; lastB.dur = Math.max(lastB.dur, 2.8);
  // a short film needs room to breathe: if the plan came out under ~24s, stretch every beat proportionally (max +30%)
  const total = spec.beats.reduce((t, b) => t + b.dur, 0);
  if (total < 24) { const k = Math.min(1.3, 24.5 / total); spec.beats.forEach((b) => { b.dur = +(b.dur * k).toFixed(2); }); }
  spec.cues = cuesFromSpec(spec);
  return spec;
}

/** What a creative director would reject. Returned as plain sentences so they can be fed straight back to the model. */
function qualityIssues(spec) {
  const out = [], B = spec.beats;
  const total = B.reduce((t, b) => t + b.dur, 0), used = new Set(B.map((b) => b.image));
  if (B.length < 6) out.push('only ' + B.length + ' beats - I need 7');

  if (spec.images.length < B.length) out.push('every beat needs its own image and its own hero object (' + spec.images.length + ' images for ' + B.length + ' beats)');
  const heroes = B.map((b) => (b.hero && b.hero.label || '').toLowerCase()); if (heroes.some((h) => !h)) out.push('every beat needs a hero object label'); if (new Set(heroes).size < heroes.length) out.push('hero objects repeat - every scene needs its own unique hero object');
  const words = spec.images.reduce((t, i) => t + i.prompt.split(/\s+/).length, 0) / spec.images.length;
  if (words < 14) out.push('image prompts are too short (' + words.toFixed(0) + ' words on average) - write 18-26 word cinematographer shot descriptions');
  const texts = B.flatMap((b) => (b.text ? b.text.lines.map((l) => l.t.trim().toLowerCase()) : []));
  const dup = texts.filter((t, k) => texts.indexOf(t) !== k); if (dup.length) out.push('text is repeated across beats ("' + dup[0] + '") - every line must be unique');
  const withFact = B.filter((b) => b.text && b.text.lines.length >= 2).length; if (withFact < Math.ceil(B.length * 0.5)) out.push('too many beats have a single line - give most beats a huge hook line PLUS a smaller line with a concrete brand fact');
  if (!texts.some((t) => /\d/.test(t))) out.push('no numbers anywhere in the text - use real figures from the brief');
  const distinct = (f) => new Set(B.map(f)).size;
  if (distinct((b) => b.transition.type) < 4) out.push('use at least 4 different transitions');
  if (distinct((b) => b.camera) < 5) out.push('use at least 5 different camera moves');
  if (distinct((b) => b.text && b.text.fx) < 4) out.push('use at least 4 different text effects');
  return out;
}

const SEVERE = /only \d+ beats|hero object|own image/;
async function directFilm(brief, brandFallback) {
  let best = null, err = null, feedback = '';
  const MAX_ATTEMPTS = +process.env.SITEGEN_MAX_ATTEMPTS || 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const prompt = directorPrompt(String(brief).slice(0, 2600)) + (feedback ? '\n\nYOUR PREVIOUS ATTEMPT WAS UNUSABLE: ' + feedback + '. Fix it and output the full JSON again.' : '');
      const est = neurons.estText(SPEC_MODEL, prompt.length + SYSTEM.length, 1700);
      neurons.charge(est, 'director call', 7 * neurons.estImage()); // refuses BEFORE spending if the film could no longer be finished inside its ceiling
      let usage = null, txt;
      try { txt = await callCloudflareRaw(SYSTEM, prompt, { jsonMode: true, maxTokens: 1900, temperature: 0.8, model: SPEC_MODEL, timeoutMs: 120000, onUsage: (u) => { usage = u; } }); }
      catch (e) { if (!/response_format|json/i.test(String(e.message))) throw e; txt = await callCloudflareRaw(SYSTEM, prompt, { jsonMode: false, maxTokens: 1900, temperature: 0.8, model: SPEC_MODEL, timeoutMs: 120000, onUsage: (u) => { usage = u; } }); }
      neurons.settleText(SPEC_MODEL, est, usage, 'director call');
      const spec = normalize(parseJson(txt), brandFallback); // throws if unusable
      const issues = qualityIssues(spec);
      if (!best || issues.length < best.issues.length) best = { spec, issues };
      if (!issues.some((i) => SEVERE.test(i))) break; // minor style notes are kept in directorNotes - never worth another paid call
      feedback = issues.filter((i) => SEVERE.test(i)).join('; ');
    } catch (e) { err = e; if (/Neuron guard/.test(String(e.message))) break; }
  }
  if (!best) throw new Error('The AI director could not produce a film plan: ' + (err && err.message));
  best.spec.directorNotes = best.issues;
  return best.spec;
}

module.exports = { directFilm, normalize, directorPrompt, LOOKS };
