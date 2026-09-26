'use strict';
/*
 * THE VARIATION SYSTEM: ten videos that follow the same reference must come out DIFFERENT in everything (structure, layout, type, motion, colour, timing), not only in brand and product.
 * A "dice roll" made for every video decides its creative direction (mood, pacing, colour story, type personality, motion personality, decoration, twist): it is shown to the AI director
 * (so its plan differs) AND used by the compiler to fill in everything the plan leaves open, so even two identical plans compile differently.
 */
const { clamp, rgb, hex, toHsl, fromHsl } = require('./laws');

const hashStr = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rngFrom = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pickR = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const shuffle = (rng, list) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- TYPE PERSONALITIES: which fonts a video uses for giant words, headings, small text and script
const TYPE_P = {
  'condensed poster': { giant: ['anton', 'bebas', 'league', 'fjalla'], head: ['anton', 'oswald', 'bebas'], small: ['poppins', 'inter'], script: ['caveat', 'pacifico'] },
  'wide heavy': { giant: ['archivo', 'bowlby', 'rubik'], head: ['archivo', 'rubik', 'bowlby'], small: ['poppins', 'bricolage'], script: ['pacifico', 'lobster'] },
  'friendly rounded': { giant: ['rubik', 'bowlby', 'fjalla'], head: ['rubik', 'bowlby'], small: ['bricolage', 'poppins'], script: ['pacifico', 'caveat'] },
  'editorial': { giant: ['playfair', 'oswald', 'league'], head: ['playfair', 'oswald'], small: ['inter', 'bricolage'], script: ['lobster', 'pacifico'] },
  'retro script mix': { giant: ['lobster', 'bowlby', 'oswald'], head: ['lobster', 'oswald', 'anton'], small: ['poppins', 'inter'], script: ['lobster', 'pacifico', 'caveat'] },
  'street tall': { giant: ['league', 'bebas', 'oswald'], head: ['league', 'fjalla', 'oswald'], small: ['inter', 'poppins'], script: ['caveat'] },
};
// ---- MOTION PERSONALITIES: durations, eases and amplitudes of the moves
const MOTION_P = {
  snappy: { enter: 0.45, eases: ['outExpo', 'outBack'], drift: 0.02, punch: 0.06, hold: 0.9 },
  smooth: { enter: 0.85, eases: ['inOutCubic', 'outQuint'], drift: 0.035, punch: 0.03, hold: 1.2 },
  bouncy: { enter: 0.65, eases: ['outBounce', 'outBack', 'outElastic'], drift: 0.03, punch: 0.08, hold: 1.0 },
  sweeping: { enter: 0.75, eases: ['outExpo', 'inOutCubic'], drift: 0.05, punch: 0.04, hold: 1.1 },
  punchy: { enter: 0.38, eases: ['outBack', 'outExpo'], drift: 0.015, punch: 0.1, hold: 0.8 },
};
const MOODS = ['playful and loud', 'clean and premium', 'retro warm', 'neon night', 'fresh and natural', 'street and edgy', 'soft pastel', 'bold sports energy', 'cosy handmade', 'glossy pop'];
const PACING = { fast: { scenes: [4, 4], secs: '1.8-2.6 s per scene' }, medium: { scenes: [3, 4], secs: '2.6-3.5 s per scene' }, 'slow then punch': { scenes: [3, 4], secs: 'a longer opening scene, then quicker ones' } };
const STORIES = ['analogous neighbours', 'complementary pair', 'triad pops', 'dark base with one neon accent', 'light and dark alternating', 'warm to cool'];
const DECOR = ['rays', 'rings', 'dots', 'stripes', 'waves', 'none', 'circles'];
const TWISTS = ['one scene shows the pack cropped huge by the frame', 'one scene has NO pack, only type and shapes', 'a word repeats as a wall behind something', 'the pack spins a full turn once', 'a scene where type hits on the beat one word at a time', 'a big colour block wipes the scene', 'tiny type and one giant word in the same scene', 'props orbit or rain instead of bursting', 'the end card is quiet after a loud middle', 'a vertical word runs up the side', 'the camera pushes in slowly through a whole scene', 'a hand-drawn scribble or arrow is drawn on'];

/** the dice roll of one video */
function roll(seed) {
  const r = rngFrom(seed), typeName = pickR(r, Object.keys(TYPE_P)), motionName = pickR(r, Object.keys(MOTION_P)), pacingName = pickR(r, Object.keys(PACING));
  const decor = shuffle(r, DECOR).slice(0, 2), twists = shuffle(r, TWISTS).slice(0, 2), sc = PACING[pacingName].scenes;
  return { seed, mood: pickR(r, MOODS), pacing: pacingName, pacingNote: PACING[pacingName].secs, scenesTarget: sc[0] + Math.floor(r() * (sc[1] - sc[0] + 1)), story: pickR(r, STORIES), type: typeName, motion: motionName, decor, twists, hueShift: Math.round((r() - 0.5) * 60), satBias: 0.85 + r() * 0.15, tiltSign: r() < 0.5 ? -1 : 1 };
}
/** the dice roll as a paragraph for the director's prompt */
const dicePrompt = (d) => `THIS VIDEO'S CREATIVE DIRECTION (a dice roll: follow it, it is what makes this video different from every other video that follows the same reference):
- mood: ${d.mood}; pacing: ${d.pacing} (${d.pacingNote}); write exactly ${d.scenesTarget} scenes.
- colour story: ${d.story}; type personality: ${d.type}; motion personality: ${d.motion}.
- twists to include: ${d.twists.join('; ')}.
Choose different archetypes, orders, words and parameters than you would by default: never reuse the reference's exact sequence when another arrangement of the same kind of scenes fits better.`;

/** the helper the archetypes use inside a scene: fonts, motion, decoration and random choices, all from the video's dice and its own scene stream */
function forScene(dice, i) {
  const rng = rngFrom(dice.seed * 31 + i * 977 + 13), T = TYPE_P[dice.type] || TYPE_P['condensed poster'], M = MOTION_P[dice.motion] || MOTION_P.snappy;
  return {
    rng, dice, motion: M,
    pick: (list) => pickR(rng, list),
    chance: (p) => rng() < p,
    range: (a, b) => a + rng() * (b - a),
    /** LAW-safe font for a role: the type personality of this video decides (the AI's pick is honoured only when it belongs to the personality) */
    font: (role, want) => { const set = role === 'giant' ? T.giant : role === 'head' ? T.head : role === 'script' ? T.script : T.small; return set.includes(want) ? want : pickR(rng, set); },
    decor: () => pickR(rng, dice.decor),
    ease: () => pickR(rng, M.eases),
    entrance: () => pickR(rng, dice.motion === 'sweeping' ? ['whip', 'whip', 'rise', 'spin'] : dice.motion === 'bouncy' ? ['drop', 'pop', 'spin', 'rise'] : dice.motion === 'smooth' ? ['rise', 'whip', 'pop'] : ['whip', 'drop', 'spin', 'rise', 'pop']),
  };
}

/** LAW-safe colour variation: hue shift and saturation bias of a backdrop colour, per video (brand-colour backdrops keep their hue when `keep`) */
function shiftColour(hexc, dice, keep) {
  if (keep) return hexc;
  const [h, s, l] = toHsl(rgb(hexc)); return hex(fromHsl([(h + dice.hueShift + 360) % 360, clamp(s * dice.satBias, 0.6, 1), l]));
}

module.exports = { hashStr, rngFrom, pickR, shuffle, roll, dicePrompt, forScene, shiftColour, TYPE_P, MOTION_P };
