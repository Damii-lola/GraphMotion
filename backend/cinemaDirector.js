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
const SPEC_MODEL = process.env.SITEGEN_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const CAMERAS = ['push', 'pull', 'pan-left', 'pan-right', 'crane-up', 'crane-down', 'orbit', 'handheld'];
const TRANSITIONS = ['cut', 'flow', 'iris', 'liquid', 'burst', 'pan', 'ink', 'glitch', 'zoomthrough', 'shatter'];
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
  return `Direct a cinematic vertical short (music-video energy, NOT a website and NOT a slideshow) for this company. Everything must be specific to THIS brand: its attitude, products, numbers and world. Write like an ad-agency creative director: punchy, surprising, never generic.

COMPANY BRIEF:
${brief}

You have this toolbox. Choose from it with intent.
camera moves: ${CAMERAS.join(', ')}
transitions (warp pixels between beats): ${TRANSITIONS.join(', ')}
kinetic text effects: ${TEXT_FX.join(', ')}  (rise = emerges from a baseline, carve = revealed by a sweep of light, pop = slams in with a blur, scatter = letters fly together, glitch = digital tear, drip = letters fall and bounce, focus = racks into sharpness)
particle motif (ONE signature physics for the whole film): ${MOTIFS.join(', ')}
colour grade mood: ${MOODS.join(', ')}
typography look: metal (heavy-metal/punk/gothic/dark humour), luxury, tech, playful, clean
music style: dark drone, pulse, warm pad, tense

Return ONE JSON object:
{
 "brand": "", "tagline": "", "cta": "button label, 2-4 words",
 "look": one typography look, "accent": "#RRGGBB one bold signature colour (never grey)", "bg": "#RRGGBB near-black",
 "grade": {"mood": one mood, "contrast": 1.0-1.35, "saturation": 0.6-1.2, "grain": 0.2-0.9},
 "motif": {"type": one motif, "density": 0.2-0.8},
 "music": {"style": one music style, "bpm": 84-140, "key": "A"|"C"|"D"|"E"|"F"|"G"},
 "imageStyle": "6-10 words: ONE consistent photographic look for every image",
 "images": [ {"id":"short_id","prompt":"vivid cinematic scene, max 24 words, subject centred, no text, no logos, no faces"} ],
 "beats": [ {
   "image": "an id from images",
   "dur": seconds 1.3-3.4,
   "camera": one camera move, "camAmount": 0.10-0.34,
   "focus": [x, y] each 0-1, the point the eye and camera go to,
   "dof": 0-0.9 depth of field strength, "dofFocus": 0-1, "rack": "in" | "out" | "none",
   "text": {"lines":[{"t":"1-4 WORDS","s":"xl|l|m|s","a":false}], "fx": one text effect, "x":0.5, "y":0.25-0.78, "align":"left"|"center"|"right", "delay":0.1-0.5, "behind": false},
   "transition": {"type": one transition, "dur": 0.3-0.9}
 } ]
}

DIRECTING RULES (these matter more than anything):
- 9 to 12 beats, total 24-32 seconds. It is a short film with a hook, escalation, product moments, proof and a payoff - not sections of a web page.
- Beat 1 hooks in under 2.6s with the boldest line. Vary the rhythm: mix fast beats (1.3-1.8s) with slower holds (2.6-3.4s). Never make all beats similar in length.
- Something new every 2-3 seconds: new image or a new camera move, a different transition, a different text effect. Do not use the same transition twice in a row. Use at least 5 different transitions, 5 camera moves and 4 text effects across the film.
- Story arc: hook -> the world and attitude of the brand -> product reveal 1 -> product reveal 2 -> scale / proof with real numbers -> mission or impact -> payoff with the brand name and call to action.
- Text is a character, not a caption. Most beats have TWO lines: a huge hook line (1-3 words, size "xl") and a smaller line (size "m" or "s", 2-6 words) that carries a concrete brand fact (a product name, flavour, number, mission). Never repeat a headline or line of text in two beats. Give each beat a different y and align. Put "behind": true on one or two beats where the text should sit behind foreground objects.
- 6 to 8 DIFFERENT images, and every image must be used. You may reuse one image a second time in a later beat only as a detail shot with a different focus and camera. Each image "prompt" must be rich (18-26 words) like a cinematographer's shot description: subject, setting, light, lens/atmosphere, colour. Product beats: a hero shot of the product on a dramatic surface, centred and rim-lit.
- Use real brand facts from the brief in the text: product names, flavours, numbers. The last beat = the brand name / call to action.
- transition on the last beat is ignored but must be present.
Output the JSON object only.`;
}

// ------------------------------------------------------------- validation / repair
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const str = (v, d = '', n = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);

function normalize(raw, brandFallback) {
  const S = raw && typeof raw === 'object' ? raw : {};
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
  // images (unique ids, 4-8)
  const seen = new Set();
  (Array.isArray(S.images) ? S.images : []).forEach((im, k) => {
    if (!im) return; const id = str(im.id, 'img' + k, 20).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (seen.has(id) || spec.images.length >= 8) return; seen.add(id);
    spec.images.push({ id, prompt: str(im.prompt, spec.brand + ' atmosphere', 220) });
  });
  if (!spec.images.length) spec.images.push({ id: 'hero', prompt: `${spec.brand} atmosphere, ${spec.imageStyle}` });
  const ids = spec.images.map((i) => i.id);
  // beats
  let src = Array.isArray(S.beats) ? S.beats.filter((b) => b && typeof b === 'object') : [];
  src = src.slice(0, 13);
  let prevType = null;
  src.forEach((b, k) => {
    const last = k === src.length - 1;
    const lines = (b.text && Array.isArray(b.text.lines) ? b.text.lines : []).map((l) => (typeof l === 'string' ? { t: l, s: 'l', a: false } : l)).filter((l) => l && str(l.t)).slice(0, 3)
      .map((l, li) => ({ t: str(l.t, '', 30), s: pick(l.s, ['xl', 'l', 'm', 's'], li === 0 ? 'xl' : 'm'), a: !!l.a }));
    const delay = num(b.text && b.text.delay, 0.05, 0.6, 0.2);
    let ttype = pick(b.transition && b.transition.type, TRANSITIONS, 'flow');
    if (ttype === prevType) ttype = TRANSITIONS[(TRANSITIONS.indexOf(ttype) + 3) % TRANSITIONS.length];
    prevType = ttype;
    const trd = last ? 0.3 : num(b.transition && b.transition.dur, 0.3, 0.95, 0.6);
    // the words must be readable: in + hold ≥ 1.1s before the transition starts
    const minDur = lines.length ? delay + 1.15 + trd : 1.2 + trd;
    const beat = {
      image: ids.includes(b.image) ? b.image : ids[k % ids.length],
      dur: Math.min(3.8, Math.max(num(b.dur, 1.2, 3.6, 2.2), minDur)),
      camera: pick(b.camera, CAMERAS, CAMERAS[k % CAMERAS.length]), camAmount: num(b.camAmount, 0.08, 0.36, 0.2),
      focus: [num(b.focus && b.focus[0], 0.15, 0.85, 0.5), num(b.focus && b.focus[1], 0.15, 0.85, 0.5)],
      dof: num(b.dof, 0, 0.95, 0.4), dofFocus: num(b.dofFocus, 0, 1, 0.5), rack: pick(b.rack, ['in', 'out', 'none'], 'none'),
      transition: { type: ttype, dur: trd },
      sfx: [],
    };
    if (lines.length) {
      beat.text = { lines, fx: pick(b.text.fx, TEXT_FX, 'rise'), x: num(b.text.x, 0.1, 0.9, 0.5), y: num(b.text.y, 0.22, 0.8, 0.62), align: pick(b.text.align, ['left', 'center', 'right'], 'left'), delay, behind: !!b.text.behind, upper: spec.theme.upper };
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
  if (B.length < 9) out.push('only ' + B.length + ' beats - I need 9 to 12');
  if (total < 23) out.push('the film is only ' + total.toFixed(0) + ' seconds - I need 24 to 32 (lengthen holds, add beats)');
  if (spec.images.length < 6) out.push('only ' + spec.images.length + ' images - I need 6 to 8 different ones');
  const unused = spec.images.filter((i) => !used.has(i.id)).length; if (unused) out.push(unused + ' images are never used in a beat');
  const words = spec.images.reduce((t, i) => t + i.prompt.split(/\s+/).length, 0) / spec.images.length;
  if (words < 14) out.push('image prompts are too short (' + words.toFixed(0) + ' words on average) - write 18-26 word cinematographer shot descriptions');
  const texts = B.flatMap((b) => (b.text ? b.text.lines.map((l) => l.t.trim().toLowerCase()) : []));
  const dup = texts.filter((t, k) => texts.indexOf(t) !== k); if (dup.length) out.push('text is repeated across beats ("' + dup[0] + '") - every line must be unique');
  const withFact = B.filter((b) => b.text && b.text.lines.length >= 2).length; if (withFact < Math.ceil(B.length * 0.5)) out.push('too many beats have a single line - give most beats a huge hook line PLUS a smaller line with a concrete brand fact');
  if (!texts.some((t) => /\d/.test(t))) out.push('no numbers anywhere in the text - use real figures from the brief');
  const distinct = (f) => new Set(B.map(f)).size;
  if (distinct((b) => b.transition.type) < 5) out.push('use at least 5 different transitions');
  if (distinct((b) => b.camera) < 5) out.push('use at least 5 different camera moves');
  if (distinct((b) => b.text && b.text.fx) < 4) out.push('use at least 4 different text effects');
  return out;
}

async function directFilm(brief, brandFallback) {
  let best = null, err = null, feedback = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prompt = directorPrompt(String(brief).slice(0, 2600)) + (feedback ? '\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED BY THE CREATIVE DIRECTOR FOR: ' + feedback + '. Fix every point and output the full JSON again.' : '');
      const txt = await callCloudflareRaw(SYSTEM, prompt, { jsonMode: true, maxTokens: 4600, temperature: 0.85, model: SPEC_MODEL, timeoutMs: 150000 });
      const spec = normalize(typeof txt === 'string' ? JSON.parse(txt) : txt, brandFallback); // throws if unusable
      const issues = qualityIssues(spec);
      if (!best || issues.length < best.issues.length) best = { spec, issues };
      if (!issues.length) break;
      feedback = issues.join('; ');
    } catch (e) { err = e; }
  }
  if (!best) throw new Error('The AI director could not produce a film plan: ' + (err && err.message));
  best.spec.directorNotes = best.issues; // whatever the final cut still lacks, for the record
  return best.spec;
}

module.exports = { directFilm, normalize, directorPrompt, LOOKS };
