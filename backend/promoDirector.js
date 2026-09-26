'use strict';
/*
 * STAGED DESIGN OF A PRODUCT PROMO: a DIRECTOR plans the scenes (mimicking one of the reference spots), then one ANIMATOR call per scene writes just that scene's layers, in parallel,
 * each held to its own scene brief. One model writing a whole 40-layer script in one go copy-pasted itself (the same word, size and corner in every scene); a focused call per scene does not.
 * Nothing here is a template: every value in every layer is written by the AI. The result is assembled into the raw script promoFilm.normalizePromo() already understands.
 */
const promoFilm = require('./promoFilm');

const REF_LIB = (() => { const p = promoFilm.promoPrompt(''); const a = p.indexOf('REFERENCE LIBRARY:'), b = p.indexOf('YOU WRITE A "MOTION SCRIPT"'); return a >= 0 && b > a ? p.slice(a, b).trim() : ''; })();
const DIRECTOR_SYSTEM = 'You are an award-winning motion-graphics director who plans product launch spots for TikTok and Reels by studying real reference spots. You reply with ONE JSON object only.';
const ANIMATOR_SYSTEM = 'You are a motion-graphics animator. You turn one scene brief into precise layers and keyframes. You reply with ONE JSON object only.';

function directorPrompt(brief) {
  return `Plan a short vertical (9:16) motion-graphics promo (you choose the length, 6 to 12.4 seconds) for the PHYSICAL product in this brief. It must be a faithful re-creation, for THIS product, of one of the reference spots below: same number of scenes, roughly the same timings, the same kind of transitions, type moves, hero moves and reactions. No voice, almost no words (at most 24), never a company story; end on the pack with the brand name.

BRIEF:
${brief}

${REF_LIB}

Return ONE JSON object with these keys, in this order:
"mimic": {"ref": "R1" to "R10", "scenes": [one sentence per scene: what you copy from that reference here]},
"brand" (as in the brief, max 24 characters),
"product": {"name", "kind" (what it physically is), "look" (how the pack looks for an image AI: shape, materials, two or three colours, label art WITHOUT any text, max 30 words), "colors" ["#rrggbb","#rrggbb"], "variants": [0 to 2 OTHER SHOTS of the product for other scenes: {"name","look"} (another flavour or colour, an open box, a multipack, a close-up)]},
"props": 2 to 4 objects {"name","look" (one ingredient / splash / piece / leaf, described for an image AI, no text, max 18 words)},
"duration" (6 to 12.4),
"scenes": 3 to 6 objects that tile 0..duration: {"t0","t1","backdrop": {"c0" (bright centre colour), "c1" (edge colour)} (saturated, or the same colour twice for a flat backdrop), "cut": how the scene BEGINS: "hard" | "wipe" | "flash" | "zoomblur" | "glide", "summary": 2 sentences: what happens in this scene, "hero": what the main pack does here (enters from where, how it moves and tilts, where it leaves to) or "absent", "other_shots": which variants / props appear and how, "type": the exact words and how they move (giant sliced word, a wall of one repeated word, small sentences typed word by word, a vertical word, script cheer words, callouts with drawn lines...), "reactions": what reacts when the pack lands or passes, "camera": punches, shakes, zoom},
"sound": {"music": "pulse" | "warm pad" | "tense" | "dark drone"}.
Rules: every scene has a DIFFERENT composition; the main pack leaves the screen entirely in at least one scene (type, a wall or another product takes over); the type is a main character in at least half of the scenes; at least four things happen in every scene; the last scene ends on the pack and the brand name. Output the JSON object only.`;
}

const PRIMITIVES = `PRIMITIVES (coordinates x, y are fractions of the screen, 0,0 top-left, values outside 0..1 are off-screen; widths and sizes are fractions of the screen WIDTH; times are absolute seconds):
Layers are FLAT objects with a "kind": {"kind":"text","t0","t1","x","y","size" (0.04 tiny .. 0.36 giant),"font","color","lines":["WORD"],"in":{"kind":"slam|rise|pop|fade|slideL|slideR|drop|slice","dur","stag"},"r" (rotation; 90 or -90 = vertical),"tone" (true = shade off the backdrop),"fill":false (outline),"repeat":{"n","dy","speed"} (a WALL of the same word, rows scrolling),"stroke":{"color","w"},"shadow"}. Fonts: ${Object.keys(promoFilm.FONTS).join(', ')}.
{"kind":"sprite","src":"hero2"|"hero3"|"prop0".."prop3","t0","t1","x","y","w","r","blur","glow":{color,blur},"keys":[{"t","x","y","w","r","blur","sx","sy","o","e"}],"in":{"kind":"pop|drop|spin|zoom|fade|stretch|focus|wipeL|wipeR|wipeU|wipeD|iris","dur"},"idle":{"kind":"float|wobble|spin|pulse|drift"}}  (keys: w = width at that moment, e = easing arriving: linear inCubic outCubic inOutCubic outQuint outExpo outBack outBounce outElastic; sx/sy stretch and squash)
{"kind":"scatter","src":["prop0","hero2"],"t0","t1","n","size":[min,max] (each piece 0.16-0.5),"from":"burst|corners|edges|top|sides","seed","spin"}   {"kind":"pattern","src":"hero","sub":"radial|grid|ring","t0","t1","cx","cy","w","rings","spin","alpha"}
Shapes: {"kind":"rings|rays|wave|stripes|dots|circle|rect|burst", ...} (rings {x,y,n,gap,width,speed,color,color2,alpha}; wave {y,amp,wl,speed,color,side}; circle {x,y,size,color, keys}; burst {x,y,n,color,color2,life}); {"kind":"wipe","dir":"left|right|up|down","n","color","color2","t0","t1" (0.3-1 s)}; {"kind":"flash","color","alpha","t0","t1" (0.1-0.5 s)}; {"kind":"zoomblur","amp","t0","t1" (0.2-0.7 s)}; {"kind":"line","x1","y1","x2","y2","cx","cy","color","arrow":true,"width":0.006,"dur","t0","t1"} (hairline / arrow drawn on); {"kind":"oval","x","y","w","h","color","width","dur","t0","t1"} (hand-drawn ring).
Every layer also takes "blend" ("screen","multiply","overlay","lighter","soft-light") and "alpha". A layer only exists between its t0 and t1: words stay at least 1 s. Draw order: shapes and giant words behind the hero, the hero above them, props/bursts above the hero, small lines above those, wipes and flashes over everything.
"hero" (the MAIN pack) is a list of waypoints for THIS scene only: [{"t","x","y","w" (0.4-0.6 at rest; up to 1.5 for a zoom-through),"r" (tilt, degrees),"blur","sx","sy","e"}]. To take it off-screen use x or y outside 0..1 (e.g. x -0.6 or 1.6). Whip in FAST (0.3-0.8 s, outExpo), rest, drift, leave FAST (inCubic).
"cam": [{"t","kind":"punch|shake|zoom|roll|pan", "amp","dur", (zoom: "to","hold","back")}]. "cues": [{"t","kind":"whoosh|impact|tick|sparkle|riser"}] on every move and hit.`;

function animatorPrompt(plan, i, ctx, problems) {
  const S = plan.scenes[i], prev = plan.scenes[i - 1], next = plan.scenes[i + 1];
  const props = plan.props.map((p, k) => `prop${k} = ${p.name}`).join('; '), vars = (plan.product.variants || []).map((v, k) => `hero${k + 2} = ${v.name}`).join('; ') || 'none';
  return `You animate ONE scene (${i + 1} of ${plan.scenes.length}) of a vertical product promo for "${plan.brand}" (${plan.product.kind}; ${plan.product.look}). Colours: ${plan.product.colors.join(', ')}. Props: ${props}. Other product shots: ${vars}. The main pack is "hero" (its path is written by the "hero" waypoints).

THE WHOLE PLAN, one line per scene (for context):
${plan.scenes.map((s, k) => `${k + 1}. ${s.t0}-${s.t1} s [${s.cut}] ${s.summary}`).join('\n')}

YOUR SCENE ${i + 1}: window ${S.t0} to ${S.t1} s, begins with a "${S.cut}" cut/transition (write that transition layer yourself, from ${Math.max(0, +(S.t0 - 0.25).toFixed(2))} s).
backdrop: ${JSON.stringify(S.backdrop)}
summary: ${S.summary}
main pack: ${S.hero}
other shots and props: ${S.other_shots}
type: ${S.type}
reactions: ${S.reactions}
camera: ${S.camera}
${prev ? 'The previous scene ended with: ' + prev.hero : 'This is the first scene.'} ${next ? 'The next scene begins with: ' + next.hero + ' (' + next.cut + ')' : 'This is the last scene: it ends on the pack and the brand name "' + plan.brand + '".'}

${PRIMITIVES}

Write EXACTLY what the brief says, with real numbers, using at least 8 layers and 3 or more hero waypoints (unless the pack is "absent": then one off-screen waypoint at ${S.t0}). Giant words are size 0.26-0.36 (or a repeat wall / sliced / vertical); pieces and props are big (0.16-0.5) and cropped by the frame edges; different motion and easing for every element; nothing sits still for more than half a second; times stay inside ${Math.max(0, +(S.t0 - 0.3).toFixed(2))} to ${+(S.t1 + 0.3).toFixed(2)} s except the transition layer.${problems && problems.length ? '\n\nYOUR PREVIOUS ANSWER HAD THESE PROBLEMS, FIX ALL OF THEM:\n' + problems.map((x, k) => (k + 1) + '. ' + x).join('\n') : ''}
Return ONE JSON object: {"hero": [waypoints], "layers": [layers], "cam": [...], "cues": [...]}. Output the JSON object only.`;
}

const parse = (txt) => { const s = typeof txt === 'string' ? txt : JSON.stringify(txt); return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); };
const words = (s) => String(s || '').toLowerCase();

/** what a scene brief promises, checked against what the animator wrote (measurable things only) */
function sceneIssues(S, out) {
  const issues = [], L = Array.isArray(out.layers) ? out.layers.filter((l) => l && typeof l === 'object') : [], H = Array.isArray(out.hero) ? out.hero : [];
  const T = L.filter((l) => l.kind === 'text'), ty = words(S.type), heroBrief = words(S.hero);
  if (L.length < 6) issues.push(`Only ${L.length} layers: write at least 8 (reactions, props, shapes, type, transition).`);
  if (T.length === 0 && ty && !/^(none|no |-)/.test(ty)) issues.push('The brief has type but you wrote no text layer.');
  if (/giant|wall|slice|vertical|big/.test(ty) && !T.some((l) => +l.size >= 0.24 || l.repeat || (l.in && l.in.kind === 'slice') || Math.abs(+l.r || 0) > 60)) issues.push('The brief asks for a giant / wall / sliced / vertical word: write one with size 0.26-0.36, or a "repeat" wall, or "in":{"kind":"slice"}, or "r":90.');
  if (/wall/.test(ty) && !T.some((l) => l.repeat)) issues.push('The brief asks for a WALL of a repeated word: use "repeat":{"n":8,"dy":0.9,"speed":0.06} on a text layer (tone:true or fill:false).');
  if (/typed|type.*word by word|sentence/.test(ty) && !T.some((l) => +l.size <= 0.07 && l.in && ['rise', 'fade'].includes(l.in.kind))) issues.push('The brief asks for small typed sentences: a small text (size 0.04-0.06) with "in":{"kind":"rise","stag":0.25}.');
  if (/callout|connector|arrow|line/.test(ty + ' ' + words(S.reactions)) && !L.some((l) => l.kind === 'line')) issues.push('The brief asks for callouts / drawn lines: write "line" layers (with arrow:true).');
  if (!/absent/.test(heroBrief) && H.length < 2) issues.push('The main pack needs at least 3 waypoints in "hero" for this scene.');
  if (/absent|leaves|exits|out of frame|off-screen|off screen/.test(heroBrief) && !H.some((k) => k && (k.x < -0.2 || k.x > 1.2 || k.y < -0.2 || k.y > 1.2))) issues.push('The main pack must leave the screen in this scene: a waypoint with x or y outside 0..1 (e.g. x 1.6).');
  if (/hero2|variant|other shot|flavou?r|box|multipack|close-up/.test(words(S.other_shots)) && !L.some((l) => /^hero[23]$/.test(l.src) || (Array.isArray(l.src) && l.src.some((x) => /^hero[23]$/.test(x))))) issues.push('The brief uses another product shot: place hero2 / hero3 (sprites, scatter or a pattern).');
  return issues;
}

const hexRgb = (h) => { const n = parseInt(String(h || '#888888').replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const cdist = (a, b) => { const x = hexRgb(a), y = hexRgb(b); return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2); };
/** what is wrong with a scene plan, measurably (it goes back to the director, who fixes it in its own way) */
function planIssues(plan) {
  const iss = [], S = Array.isArray(plan.scenes) ? plan.scenes : [], ref = String((plan.mimic && plan.mimic.ref) || '').toUpperCase(), D = +plan.duration || 9;
  if (D > 6 && S.length < 3) iss.push('Only ' + S.length + ' scene(s). The reference spots have 3 to 6 scenes.');
  if (ref !== 'R3') for (let i = 1; i < S.length; i++) { const a = S[i - 1].backdrop || {}, b = S[i].backdrop || {}; if (cdist(a.c0, b.c0) < 90) iss.push('Scenes ' + i + ' and ' + (i + 1) + ' have almost the same backdrop colour. Every scene has its OWN backdrop colour (only R3 keeps one): pick clearly different saturated colours.'); }
  const giant = S.filter((s) => /giant|wall|slice|vertical|big|huge/i.test(String(s.type || ''))).length;
  if (S.length >= 3 && giant < 2) iss.push('Type must be a main character: at least two scenes need a giant / sliced / wall / vertical word (say the exact word and how it moves).');
  if (S.length >= 3 && !S.some((s) => /absent|leaves|exits|off-?screen|out of frame/i.test(String(s.hero || '')))) iss.push('The main pack never leaves the screen: in at least one scene it must be absent or exit so that type or another product takes over.');
  if (S.filter((s) => !String(s.type || '').trim() || /^(none|no )/i.test(String(s.type || ''))).length > Math.floor(S.length / 2)) iss.push('Most scenes have no type. Give most scenes specific words and a specific type move.');
  return iss;
}

/** design({ brief, call, say }): call(system, prompt, {maxTokens, temperature, reasoning}) -> text; returns { raw, plan }. Throws if the director cannot be parsed. */
async function design({ brief, call, say, onPlan }) {
  say && say('Directing your promo', 0.05);
  let plan = null, lastErr = null, prevPlan = null, planProblems = null;
  for (let t = 0; t < 2 && !plan; t++) {
    try {
      const p = parse(await call(DIRECTOR_SYSTEM, directorPrompt(brief) + (planProblems ? '\n\nYOUR FIRST PLAN (JSON):\n' + JSON.stringify(prevPlan) + '\n\nA REVIEW OF IT FOUND THESE PROBLEMS; rewrite the whole plan fixing every one:\n' + planProblems.map((x, k) => (k + 1) + '. ' + x).join('\n') : ''), { maxTokens: 4500, temperature: 0.9, reasoning: 'medium', what: 'director' }));
      if (!p || !Array.isArray(p.scenes) || p.scenes.length < 2) throw new Error('the director wrote no scenes');
      plan = p;
      const pi = planIssues(plan);
      if (pi.length && t === 0) { console.log('[promo] director review: ' + pi.length + ' issue(s): ' + pi.map((x) => x.slice(0, 70)).join(' | ')); prevPlan = p; planProblems = pi; plan = null; continue; }
    } catch (e) { lastErr = e; console.warn('[promo] director try ' + (t + 1) + ' failed: ' + String(e.message).slice(0, 140)); if (/Neuron guard|429|allocation/i.test(String(e.message))) throw e; }
  }
  if (!plan && prevPlan) plan = prevPlan;                                  // the reviewed first plan is still a plan
  if (!plan) throw new Error('The director could not plan the promo: ' + (lastErr && lastErr.message));
  // tidy the plan: scenes tile 0..D
  const D = Math.max(6, Math.min(12.4, +plan.duration || 9)), n = Math.min(6, plan.scenes.length), cuts = [0];
  for (let i = 0; i < n - 1; i++) { const want = Number.isFinite(+plan.scenes[i].t1) ? +plan.scenes[i].t1 : (D * (i + 1)) / n; cuts.push(Math.max(cuts[i] + 1, Math.min(D - (n - 1 - i), want))); }
  cuts.push(D);
  plan.scenes = plan.scenes.slice(0, n).map((s, i) => ({ t0: +cuts[i].toFixed(2), t1: +cuts[i + 1].toFixed(2), backdrop: s.backdrop && s.backdrop.c0 ? s.backdrop : { c0: '#ff7a00', c1: '#c23b00' }, cut: ['hard', 'wipe', 'flash', 'zoomblur', 'glide'].includes(s.cut) ? s.cut : (i ? 'hard' : 'glide'), summary: String(s.summary || ''), hero: String(s.hero || ''), other_shots: String(s.other_shots || ''), type: String(s.type || ''), reactions: String(s.reactions || ''), camera: String(s.camera || '') }));
  plan.duration = D; plan.brand = String(plan.brand || ''); plan.props = Array.isArray(plan.props) ? plan.props.slice(0, 4) : []; plan.product = plan.product || {};
  if (onPlan) onPlan(plan);              // the pictures can start painting while the animators work
  say && say('Animating the scenes', 0.1);
  const outs = await Promise.all(plan.scenes.map(async (S, i) => {
    let problems = null, best = null, bestIssues = null;
    for (let t = 0; t < 2; t++) {
      try {
        const out = parse(await call(ANIMATOR_SYSTEM, animatorPrompt(plan, i, {}, problems), { maxTokens: 5200, temperature: 0.8, reasoning: 'low', what: 'scene ' + (i + 1) }));
        const iss = sceneIssues(S, out);
        if (!best || iss.length < bestIssues.length) { best = out; bestIssues = iss; }
        if (!iss.length) break;
        problems = iss; console.log(`[promo] scene ${i + 1} review: ${iss.length} issue(s): ${iss.map((x) => x.slice(0, 60)).join(' | ')}`);
      } catch (e) { console.warn(`[promo] scene ${i + 1} try ${t + 1} failed: ${String(e.message).slice(0, 120)}`); if (/Neuron guard|429|allocation/i.test(String(e.message))) throw e; }
    }
    return best || { hero: [], layers: [], cam: [], cues: [] };
  }));
  // the same text placement (x, y, size, font) in several scenes is a copy-paste: the later scenes are asked again for a different composition
  const sig = (l) => [l.x, l.y, l.size, l.font].map((v) => (typeof v === 'number' ? Math.round(v * 20) / 20 : v)).join('|'), seenSig = new Map(), redo = new Set();
  outs.forEach((o, i) => { const mine = new Set((o.layers || []).filter((l) => l && l.kind === 'text').map(sig)); mine.forEach((k) => { if (seenSig.has(k) && seenSig.get(k) !== i) redo.add(i); else seenSig.set(k, i); }); });
  const redoScenes = [...redo].slice(0, 3);
  if (redoScenes.length) {
    console.log('[promo] copy-paste type in scenes ' + redoScenes.map((i) => i + 1).join(', ') + ': asking those scenes again');
    await Promise.all(redoScenes.map(async (i) => {
      try {
        const out = parse(await call(ANIMATOR_SYSTEM, animatorPrompt(plan, i, {}, ["Another scene already uses the same text position, size and font as one of yours. Give this scene's type a clearly DIFFERENT composition: a different position, size, font, arrival and rotation than the other scenes (" + [...seenSig.keys()].slice(0, 4).join('; ') + ')']), { maxTokens: 5200, temperature: 0.9, reasoning: 'low', what: 'scene ' + (i + 1) + ' again' }));
        if (out && Array.isArray(out.layers) && out.layers.length >= 4) outs[i] = out;
      } catch (e) { console.warn('[promo] scene ' + (i + 1) + ' rewrite failed: ' + String(e.message).slice(0, 100)); if (/Neuron guard|429|allocation/i.test(String(e.message))) throw e; }
    }));
  }
  // assemble the raw script promoFilm.normalizePromo understands
  const layers = [], hero = [], cam = [], cues = [];
  outs.forEach((o) => { (o.layers || []).forEach((l) => layers.push(l)); (o.hero || []).forEach((k) => hero.push(k)); (o.cam || []).forEach((c) => cam.push(c)); (o.cues || []).forEach((c) => cues.push(c)); });
  const zones = plan.scenes.map((s) => ({ c0: s.backdrop.c0, c1: s.backdrop.c1 || s.backdrop.c0, shape: 'radial' }));
  const beats = plan.scenes.map((s, i) => ({ t0: s.t0, t1: s.t1, zone: i, ...(i && s.cut !== 'glide' ? { cut: true } : {}) }));
  const raw = { mimic: plan.mimic, ideas: plan.scenes.map((s) => s.summary), brand: plan.brand, product: plan.product, props: plan.props, duration: D, zones, beats, layers, hero: { path: hero.filter((k) => k && Number.isFinite(+k.t)).sort((a, b) => a.t - b.t) }, cam, sound: { music: (plan.sound && plan.sound.music) || 'pulse', cues } };
  return { raw, plan };
}

module.exports = { planIssues, design, directorPrompt, animatorPrompt, sceneIssues, DIRECTOR_SYSTEM, ANIMATOR_SYSTEM };
