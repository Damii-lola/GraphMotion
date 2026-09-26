'use strict';
/*
 * THE DIRECTOR: one small AI call that reads the brief and CHOOSES: which reference to follow, the scenes (an archetype for each, how long, the backdrop and accent colours, how the scene begins),
 * and every parameter of every scene (the words, fonts, tilt, side, entrance, which pack shot, which props, extras of its own). It never writes coordinates or keyframes: the engine's compiler does
 * that under the laws, so the result is always clean. The plan is reviewed against the laws once (the AI fixes what the review found).
 */
const { LAWS, clamp, num, isHex, fixHex, rgb, dist, cleanWord, oneOf } = require('./laws');
const { ARCH, IDS } = require('./archetypes');
const { TRANSITIONS } = require('./compile');
const vary = require('./vary');

const SYSTEM = 'You are an award-winning motion-graphics director who plans product launch spots for TikTok and Reels by studying real reference spots. You reply with ONE JSON object only.';

const REFS = `REFERENCE SPOTS and the scene sequences they use (follow ONE for this product, adapt freely; each has its own pace):
R1 Goli multivitamin (12 s): its HOOK is fixed: typed (a small left-aligned line like "Meet the All New", blur-in) -> wall (a word like NEW; the pack whips across it) -> then ONE or TWO of: showcase (the pack tilted big, kicker + 2-line title, tiny cheer words, blurred true) | callouts (a sentence + 4-5 labels like Non-GMO / Gluten-Free / Kosher / Vegan).
R2 Goli sleep (12 s): typed (a question) -> showcase (pack rises) -> cheer | ingredients -> wall (SO YUMMY).
R3 Berry White (12 s): showcase (vertical word) -> showcase (other side) -> cheer.
R4 Pluckk (10 s, colour wipes every 2 s): parade -> typed -> ring -> ingredients.
R5 Lay's (6 s): rings_drop (with row) -> endcard.
R6 Unicity (9 s): showcase -> typed (scribble) -> typed.
R7 McDonald's (10 s): word_pack -> endcard (a solid brand-colour card).
R8 Wendy's (5 s): hook_slice -> wall.
R9 Sunbake (5 s): wall (script word) -> showcase.
R10 Canva lemon (8 s): hook_slice -> hook_slice (word swaps, iris transitions) -> disc_pack.`;

const LAW_TEXT = `LAWS (the engine enforces them; plan with them):
- 3 or 4 scenes (never more), each 1.8-4 s, total 6-12.3 s; no archetype more than twice. There is NO separate end card: the video ends inside its last real scene, which carries the brand name (use "endcard" only if your reference has one).
- Backdrops: EVERY scene has its own gradient, built from the colours of the real product. You choose a ROLE for each scene (neighbouring scenes must differ) and a gradient style; the engine takes the colours from the product photo so the backdrop always matches it: role = primary (the product's main colour) | secondary | complement (its opposite) | analogous (its neighbour hue) | dark | light | duo (two of its colours); style = radial | linear.
- The product pictures are REAL photos supplied by the engine: do not describe how the pack looks; leave product.variants empty (other real pack shots, if the engine has them, are available as hero2 / hero3).
- Type is a main character: at least two scenes carry a giant word (hook_slice, word_pack, wall, showcase with "vertical", disc_pack with "word").
- The pack is ABSENT in at least one scene (hook_slice, wall with pack none, typed with pack none, ingredients with pack none) so type or another product can take over.
- Use the extra pack shots (hero2 / hero3) in some scenes if you define product variants.
- At most 26 words in the whole promo; words are short; brand name and a 3-word call to action at the end.
- Allowed fonts: ${['anton', 'bebas', 'league', 'oswald', 'fjalla', 'archivo', 'bowlby', 'rubik'].join(', ')} (caps), poppins / inter / bricolage (small text), pacifico / lobster / caveat (script).`;

function catalogue() {
  return IDS.map((id) => `- "${id}": ${ARCH[id].about}\n    params: ${Object.entries(ARCH[id].params).map(([k, v]) => `${k} = ${v}`).join('; ')}`).join('\n');
}

function directorPrompt(brief, dice) {
  return `Plan a short vertical (9:16) motion-graphics promo (6 to 12.4 seconds) for the PHYSICAL product in this brief, as a faithful re-creation for THIS product of one reference spot. No voice, almost no words.

BRIEF:
${brief}

${REFS}

SCENE ARCHETYPES (pick a sequence of them; choose every parameter yourself: words, fonts, colours, tilt, side, entrances, which pack shot, how many props, extras):
${catalogue()}

${LAW_TEXT}

${dice ? vary.dicePrompt(dice) + '\n\n' : ''}Return ONE JSON object:
{"mimic": {"ref": "R1".."R10", "why": "one sentence"},
 "brand": (as in the brief, max 24 letters),
 "cta": (call to action, max 3 words),
 "product": {"name","kind" (what it physically is),"look" (how the pack looks for an image AI: shape, materials, 2-3 colours, label art WITHOUT any text, max 30 words),"colors":["#rrggbb","#rrggbb"],"variants":[0-2 OTHER SHOTS of the product: {"name","look"} (another flavour or colour, an open box, a multipack)]},
 "props": [2-3 ingredients / pieces: {"name","look" (one thing, for an image AI, no text, max 18 words)}] (prop0, prop1, prop2 in order),
 "sound": {"music": "pulse" | "warm pad" | "tense" | "dark drone"},
 "scenes": [{"archetype": one of ${IDS.map((x) => '"' + x + '"').join(', ')}, "dur": seconds, "backdrop": {"role": "primary" | "secondary" | "complement" | "analogous" | "dark" | "light" | "duo", "style": "radial" | "linear"}, "transition_in": "cut" | "flash" | "wipe" | "zoomblur" | "iris" | "glide" | "brandflash" (how this scene BEGINS; the first scene: "cut"), "dir": "left" | "right" | "up" | "down" (for a wipe), "params": {that archetype's parameters}, "extras": [0-3 free extra layers of your own: {"kind":"text|scatter|burst|rings|circle|oval|line","u0":secs into the scene,"u1":secs,...}]}]}
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
  if (S.length < LAWS.structure.scenesMin) iss.push('Only ' + S.length + ' scenes: write 3 or 4.');
  if (S.length > 4) iss.push('Too many scenes (' + S.length + '): write 3 or 4.');
  for (let i = 1; i < S.length; i++) if (S[i - 1].backdrop && S[i].backdrop && S[i - 1].backdrop.role && S[i - 1].backdrop.role === S[i].backdrop.role) iss.push('Scenes ' + i + ' and ' + (i + 1) + ' have the same backdrop role: give neighbouring scenes different roles.');
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
  let scenes = (Array.isArray(S.scenes) ? S.scenes : []).filter((s) => s && typeof s === 'object').slice(0, LAWS.structure.scenesMax).map((s) => ({ archetype: oneOf(String(s.archetype || '').toLowerCase(), IDS, 'showcase'), dur: num(s.dur, 2.4, 1.4, 4.2), backdrop: { role: oneOf(s.backdrop && s.backdrop.role, ['primary', 'secondary', 'complement', 'analogous', 'dark', 'light', 'duo'], undefined), style: oneOf(s.backdrop && s.backdrop.style, ['radial', 'linear'], undefined) }, accent: isHex(s.accent) ? fixHex(s.accent) : null, transition_in: oneOf(s.transition_in, TRANSITIONS, 'cut'), dir: oneOf(s.dir, ['left', 'right', 'up', 'down'], 'left'), params: s.params && typeof s.params === 'object' ? s.params : {}, extras: Array.isArray(s.extras) ? s.extras.slice(0, LAWS.density.maxExtrasPerScene) : [] }));
  if (!scenes.length) scenes = [{ archetype: 'hook_slice', dur: 2, backdrop: {}, params: { lines: brand }, transition_in: 'cut', extras: [] }, { archetype: 'showcase', dur: 3, backdrop: {}, params: {}, transition_in: 'wipe', extras: [] }];
  scenes[0].transition_in = 'cut';
  const mimic = { ref: /^R(10|[1-9])$/i.test(String(S.mimic && S.mimic.ref || '').trim()) ? String(S.mimic.ref).trim().toUpperCase() : '', why: cleanWord(S.mimic && S.mimic.why, 200) };
  // THE R1 HOOK IS A TEMPLATE (it is what makes the reference work): a small left-aligned typed line with blur-in, then the word wall with the pack whipping across it
  if (mimic.ref === 'R1') {
    const typed = scenes.find((x) => x.archetype === 'typed'), wall = scenes.find((x) => x.archetype === 'wall'), rest = scenes.filter((x) => x !== typed && x !== wall && x.archetype !== 'endcard' && x.archetype !== 'hook_slice');
    const teaser = (typed && typed.params && [].concat(typed.params.lines || []).join(' ')) || '', hookOk = /(meet|introducing|new|say hello|hello|discover|welcome|ever|ready)/i.test(teaser) && teaser.length <= 60 && !/[•|]/.test(teaser);   // the hook must be a teaser like "Meet the all new ...", not a benefit list
    const s0 = { ...(typed || scenes[0]), archetype: 'typed', dur: 1.5, transition_in: 'cut', params: { ...(typed ? typed.params : {}), lines: hookOk ? typed.params.lines : ['Meet the all new ' + (product.name || brand)], variant: 'left', style: 'blurin', wave: 'false', energy: 'true', emphasis: String(brand || '').split(' ')[0].slice(0, 10), scribble: 'true', pack: 'none' } };
    const s1 = { ...(wall || scenes[1] || scenes[0]), archetype: 'wall', dur: 2.4, transition_in: 'flash', params: { ...(wall ? wall.params : {}), word: (wall && wall.params && wall.params.word) || 'NEW', variant: 'grid', pack: 'hero', action: 'cross', pieces: 4 } };
    scenes = [s0, s1, ...rest.slice(0, 2)];
  }
  if (scenes.length > 4) scenes = scenes.slice(0, 4);
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
async function plan({ brief, call, ctx = {}, dice }) {
  let first = null, problems = null, prev = null, lastErr = null;
  for (let t = 0; t < 2; t++) {
    try {
      const txt = await call(SYSTEM, directorPrompt(brief, dice) + (problems ? '\n\nYOUR FIRST PLAN (JSON):\n' + JSON.stringify(prev) + '\n\nA REVIEW FOUND THESE PROBLEMS; rewrite the whole plan fixing every one:\n' + problems.map((x, k) => (k + 1) + '. ' + x).join('\n') : ''), { maxTokens: 3600, temperature: 1.0, what: t ? 'director (review)' : 'director' });
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
