'use strict';
/*
 * THE DIRECTOR: one small AI call that reads the brief and CHOOSES: which reference to follow, the scenes (an archetype for each, how long, the backdrop and accent colours, how the scene begins),
 * and every parameter of every scene (the words, fonts, tilt, side, entrance, which pack shot, which props, extras of its own). It never writes coordinates or keyframes: the engine's compiler does
 * that under the laws, so the result is always clean. The plan is reviewed against the laws once (the AI fixes what the review found).
 */
const { LAWS, clamp, num, isHex, fixHex, rgb, dist, cleanWord, oneOf } = require('./laws');
const { ARCH, IDS } = require('./archetypes');
const { TRANSITIONS } = require('./compile');

const SYSTEM = 'You are an award-winning motion-graphics director who plans product launch spots for TikTok and Reels by studying real reference spots. You reply with ONE JSON object only.';

const REFS = `REFERENCE SPOTS and the scene sequences they use (follow ONE of them for this product, adapt freely; each has its own pace):
R1 Goli multivitamin (12 s, pink): typed -> wall (NEW wall, pack whips across) -> showcase (tilted pack + big blurred gummies) -> callouts -> endcard.
R2 Goli sleep (12 s, purple): typed (a question) -> showcase (pack rises) -> cheer -> ingredients -> wall (SO YUMMY) -> callouts -> endcard.
R3 Berry White (12 s, ONE calm backdrop): showcase (vertical word) -> showcase (other side) -> cheer -> endcard.
R4 Pluckk (10 s, colour wipes every 2 s): parade -> typed -> ring -> ingredients -> endcard.
R5 Lay's (6 s, red): rings_drop (with row) -> endcard.
R6 Unicity (9 s, pastel): showcase -> typed (scribble) -> typed -> endcard.
R7 McDonald's (10 s, yellow): word_pack -> endcard (a solid brand-colour card).
R8 Wendy's (5 s, red): hook_slice -> wall -> endcard.
R9 Sunbake (5 s, dark): wall (script word) -> showcase -> endcard.
R10 Canva lemon (8 s): hook_slice -> hook_slice (word swaps, "iris" transitions) -> disc_pack -> endcard.`;

const LAW_TEXT = `LAWS (the engine enforces them; plan with them):
- 4 to 6 scenes, each 1.6-4 s, total 6-12.4 s; the LAST scene is "endcard"; no archetype more than twice.
- Every scene has its OWN backdrop colour (clearly different saturated colours; only R3 keeps one colour); "accent" must stand out from the backdrop.
- Type is a main character: at least two scenes carry a giant word (hook_slice, word_pack, wall, showcase with "vertical", disc_pack with "word").
- The pack is ABSENT in at least one scene (hook_slice, wall with pack none, typed with pack none, ingredients with pack none) so type or another product can take over.
- Use the extra pack shots (hero2 / hero3) in some scenes if you define product variants.
- At most 26 words in the whole promo; words are short; brand name and a 3-word call to action at the end.
- Allowed fonts: ${['anton', 'bebas', 'league', 'oswald', 'fjalla', 'archivo', 'bowlby', 'rubik'].join(', ')} (caps), poppins / inter / bricolage (small text), pacifico / lobster / caveat (script).`;

function catalogue() {
  return IDS.map((id) => `- "${id}": ${ARCH[id].about}\n    params: ${Object.entries(ARCH[id].params).map(([k, v]) => `${k} = ${v}`).join('; ')}`).join('\n');
}

function directorPrompt(brief) {
  return `Plan a short vertical (9:16) motion-graphics promo (6 to 12.4 seconds) for the PHYSICAL product in this brief, as a faithful re-creation for THIS product of one reference spot. No voice, almost no words.

BRIEF:
${brief}

${REFS}

SCENE ARCHETYPES (pick a sequence of them; choose every parameter yourself: words, fonts, colours, tilt, side, entrances, which pack shot, how many props, extras):
${catalogue()}

${LAW_TEXT}

Return ONE JSON object:
{"mimic": {"ref": "R1".."R10", "why": "one sentence"},
 "brand": (as in the brief, max 24 letters),
 "cta": (call to action, max 3 words),
 "product": {"name","kind" (what it physically is),"look" (how the pack looks for an image AI: shape, materials, 2-3 colours, label art WITHOUT any text, max 30 words),"colors":["#rrggbb","#rrggbb"],"variants":[0-2 OTHER SHOTS of the product: {"name","look"} (another flavour or colour, an open box, a multipack)]},
 "props": [2-3 ingredients / pieces: {"name","look" (one thing, for an image AI, no text, max 18 words)}] (prop0, prop1, prop2 in order),
 "sound": {"music": "pulse" | "warm pad" | "tense" | "dark drone"},
 "scenes": [{"archetype": one of ${IDS.map((x) => '"' + x + '"').join(', ')}, "dur": seconds, "backdrop": {"c0": bright centre colour, "c1": edge colour (the same colour twice = flat)}, "accent": "#rrggbb", "transition_in": "cut" | "flash" | "wipe" | "zoomblur" | "iris" | "glide" (how this scene BEGINS; the first scene: "cut"), "dir": "left" | "right" | "up" | "down" (for a wipe), "params": {that archetype's parameters}, "extras": [0-3 free extra layers of your own: {"kind":"text|scatter|burst|rings|circle|oval|line","u0":secs into the scene,"u1":secs,...}]}]}
Output the JSON object only.`;
}

// ------------------------------------------------------------------ plan repair (safety) and review (the laws)
const cdist = (a, b) => dist(rgb(fixHex(a, '#888888')), rgb(fixHex(b, '#888888')));
function usesPack(S, id) { const p = S.params || {}; const a = [p.pack].concat(Array.isArray(p.packs) ? p.packs : []); if (S.archetype === 'endcard' || S.archetype === 'showcase' || S.archetype === 'word_pack' || S.archetype === 'callouts' || S.archetype === 'cheer' || S.archetype === 'disc_pack' || S.archetype === 'rings_drop') return (a[0] || 'hero') === id || a.includes(id); return a.includes(id); }
function packAbsent(S) { const p = S.params || {}; if (S.archetype === 'hook_slice') return true; if (['typed', 'wall', 'ingredients'].includes(S.archetype)) return !p.pack || p.pack === 'none' || p.action === 'absent'; return false; }
function giantScene(S) { const p = S.params || {}; return ['hook_slice', 'word_pack', 'wall'].includes(S.archetype) || (S.archetype === 'showcase' && !!p.vertical) || (S.archetype === 'disc_pack' && !!p.word); }

/** LAW review of a plan (measurable things); the AI fixes what it finds */
function checkPlan(plan) {
  const iss = [], S = plan.scenes || [], ref = String((plan.mimic && plan.mimic.ref) || '').toUpperCase();
  if (S.length < LAWS.structure.scenesMin) iss.push('Only ' + S.length + ' scenes: write 4 to 6.');
  if (S.length && S[S.length - 1].archetype !== 'endcard') iss.push('The last scene must be "endcard".');
  if (ref !== 'R3') for (let i = 1; i < S.length; i++) if (cdist(S[i - 1].backdrop && S[i - 1].backdrop.c0, S[i].backdrop && S[i].backdrop.c0) < 90) iss.push('Scenes ' + i + ' and ' + (i + 1) + ' have almost the same backdrop colour: pick clearly different saturated colours.');
  if (S.filter(giantScene).length < LAWS.structure.giantTypeScenesMin) iss.push('Type must be a main character: at least two scenes need a giant word (hook_slice, word_pack, wall, showcase with "vertical", disc_pack with "word").');
  if (!S.some(packAbsent)) iss.push('The pack is in every scene: use at least one scene without the pack (hook_slice, typed with pack "none", wall with pack "none", ingredients with pack "none").');
  const count = {}; S.forEach((s) => { count[s.archetype] = (count[s.archetype] || 0) + 1; }); Object.entries(count).forEach(([k, n]) => { if (n > LAWS.structure.maxSameArchetype) iss.push('"' + k + '" is used ' + n + ' times: at most 2.'); });
  const vars = (plan.product && plan.product.variants) || [];
  if (vars.length && !S.some((s) => usesPack(s, 'hero2') || usesPack(s, 'hero3'))) iss.push('You defined product variants but no scene uses hero2 / hero3.');
  return iss;
}

/** repair whatever the AI wrote into a plan the compiler can always play */
function normalizePlan(raw, ctx = {}) {
  const S = raw && typeof raw === 'object' ? raw : {};
  const brand = cleanWord(S.brand || ctx.brand || 'Brand', 24).toUpperCase() || 'BRAND', cta = cleanWord(S.cta, 24).split(' ').slice(0, 3).join(' ');
  const P = S.product && typeof S.product === 'object' ? S.product : {}, cols = (Array.isArray(P.colors) ? P.colors : []).filter(isHex).map((c) => fixHex(c)).slice(0, 2);
  const product = { name: cleanWord(P.name, 60) || brand, kind: cleanWord(P.kind, 50) || 'product pack', look: cleanWord(P.look, 260) || 'a premium retail pack', colors: cols.length ? cols : ['#ff5c1a', '#ffd23f'], variants: (Array.isArray(P.variants) ? P.variants : []).slice(0, 2).map((v) => ({ name: cleanWord(v && v.name, 40), look: cleanWord(v && v.look, 240) })).filter((v) => v.look) };
  const props = (Array.isArray(S.props) ? S.props : []).slice(0, 3).map((p) => ({ name: cleanWord(p && p.name, 40), look: cleanWord(p && p.look, 200) })).filter((p) => p.look); while (props.length < 2) props.push({ name: 'splash', look: 'a fresh splash of the product, glossy droplets' });
  let scenes = (Array.isArray(S.scenes) ? S.scenes : []).filter((s) => s && typeof s === 'object').slice(0, LAWS.structure.scenesMax).map((s) => ({ archetype: oneOf(String(s.archetype || '').toLowerCase(), IDS, 'showcase'), dur: num(s.dur, 2.4, 1.4, 4.2), backdrop: { c0: fixHex(s.backdrop && s.backdrop.c0, '#ff7a00'), c1: fixHex(s.backdrop && s.backdrop.c1, fixHex(s.backdrop && s.backdrop.c0, '#c23b00')) }, accent: isHex(s.accent) ? fixHex(s.accent) : null, transition_in: oneOf(s.transition_in, TRANSITIONS, 'cut'), dir: oneOf(s.dir, ['left', 'right', 'up', 'down'], 'left'), params: s.params && typeof s.params === 'object' ? s.params : {}, extras: Array.isArray(s.extras) ? s.extras.slice(0, LAWS.density.maxExtrasPerScene) : [] }));
  if (!scenes.length) scenes = [{ archetype: 'hook_slice', dur: 2, backdrop: { c0: '#ff7a00', c1: '#c23b00' }, params: { lines: brand }, transition_in: 'cut', extras: [] }, { archetype: 'showcase', dur: 3, backdrop: { c0: '#00b8ff', c1: '#0059a8' }, params: {}, transition_in: 'wipe', extras: [] }];
  if (scenes[scenes.length - 1].archetype !== 'endcard') { if (scenes.length >= LAWS.structure.scenesMax) scenes.pop(); scenes.push({ archetype: 'endcard', dur: 2.4, backdrop: { c0: cols[0] || '#ff5c1a', c1: cols[0] || '#ff5c1a' }, accent: null, transition_in: 'flash', dir: 'left', params: { cta }, extras: [] }); }
  scenes[0].transition_in = 'cut';
  const mimic = { ref: /^R(10|[1-9])$/i.test(String(S.mimic && S.mimic.ref || '').trim()) ? String(S.mimic.ref).trim().toUpperCase() : '', why: cleanWord(S.mimic && S.mimic.why, 200) };
  return { mimic, brand, cta: cta || '', product, props, sound: { music: oneOf(S.sound && S.sound.music, ['pulse', 'warm pad', 'tense', 'dark drone'], 'pulse') }, scenes };
}

/** which pictures the plan needs: the packs it uses and the props it uses (nothing else is painted) */
function neededAssets(plan) {
  const packs = new Set(['hero']), props = new Set();
  plan.scenes.forEach((s) => { const p = s.params || {}; [p.pack].concat(Array.isArray(p.packs) ? p.packs : []).forEach((x) => { if (/^hero[23]$/.test(x || '')) packs.add(x); });
    if (s.archetype === 'ingredients') (Array.isArray(p.items) ? p.items : []).forEach((it) => props.add('prop' + Math.round(num(it && it.prop, 0, 0, 2))));
    if ((s.archetype === 'showcase' && num(p.props, 5, 0, 7) >= 2) || (s.archetype === 'rings_drop' && num(p.props, 4, 0, 6) >= 2)) plan.props.forEach((_, i) => props.add('prop' + i));
    (s.extras || []).forEach((e) => { if (e && e.kind === 'scatter') plan.props.forEach((_, i) => props.add('prop' + i)); }); });
  const nv = plan.product.variants.length; return { packs: [...packs].filter((id) => id === 'hero' || +id.slice(4) - 2 < nv), props: [...props].filter((id) => +id.slice(4) < plan.props.length) };
}

/** plan({ brief, call, ctx }) -> normalised plan (one review round with the AI) */
async function plan({ brief, call, ctx = {} }) {
  let first = null, problems = null, prev = null, lastErr = null;
  for (let t = 0; t < 2; t++) {
    try {
      const txt = await call(SYSTEM, directorPrompt(brief) + (problems ? '\n\nYOUR FIRST PLAN (JSON):\n' + JSON.stringify(prev) + '\n\nA REVIEW FOUND THESE PROBLEMS; rewrite the whole plan fixing every one:\n' + problems.map((x, k) => (k + 1) + '. ' + x).join('\n') : ''), { maxTokens: 3600, temperature: 0.9, what: t ? 'director (review)' : 'director' });
      const s = String(typeof txt === 'string' ? txt : JSON.stringify(txt)).replace(/<think>[\s\S]*?<\/think>/g, ''), raw = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)), p = normalizePlan(raw, ctx), iss = checkPlan(p);
      if (!first) first = p;
      console.log('[promo2] director' + (t ? ' (review)' : '') + ': ' + (iss.length ? iss.length + ' issue(s): ' + iss.map((x) => x.slice(0, 60)).join(' | ') : 'clean'));
      if (!iss.length || t === 1) return { plan: p, issues: iss, first: first };
      prev = raw; problems = iss;
    } catch (e) { lastErr = e; console.warn('[promo2] director try ' + (t + 1) + ' failed: ' + String(e.message).slice(0, 140)); if (/Neuron guard|429|allocation/i.test(String(e.message))) throw e; }
  }
  if (first) return { plan: first, issues: checkPlan(first), first };
  throw new Error('The director could not plan the promo: ' + (lastErr && lastErr.message));
}

module.exports = { SYSTEM, directorPrompt, normalizePlan, checkPlan, neededAssets, plan };
