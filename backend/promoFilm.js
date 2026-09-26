'use strict';
/*
 * PRODUCT PROMO: a short (under 13 s, AI-chosen length) motion-graphics spot for a PHYSICAL product (a snack, a drink, a pack of anything), in the style of the best social product promos:
 * a real product hero on a vivid backdrop, giant kinetic type, ingredients flying in, patterns and rings, almost no words, no voice.
 *
 * NOTHING HERE IS A TEMPLATE. The AI designs each promo as a "motion script" out of primitives (sprites with in / out / idle motion and free keyframes, text with reveal
 * styles and stacked repeats, shapes, ingredient scatter, product patterns, camera punch / shake, one vivid backdrop zone per beat). siteTemplate/promo.html only PLAYS that script.
 * This module: the designer prompt, the validator that repairs whatever the AI got wrong (so a promo can never be broken or unreadable), the picture plan for the
 * hero product and its props, the cut-out, and the sound.
 */
const fs = require('fs');
const path = require('path');

const FONTS = { anton: 'tall heavy condensed (headlines)', bebas: 'tall clean condensed caps', archivo: 'wide ultra-bold', oswald: 'bold condensed', league: 'very tall condensed', bowlby: 'chunky rounded fat display', rubik: 'heavy friendly rounded', pacifico: 'brush script (playful)', lobster: 'bold retro script', caveat: 'handwritten marker', poppins: 'clean geometric bold (small lines)', inter: 'neutral ultra-bold', playfair: 'elegant heavy serif', bricolage: 'modern quirky grotesque', fjalla: 'punchy condensed' };
const IN_KINDS = ['pop', 'drop', 'slideL', 'slideR', 'slideU', 'slideD', 'spin', 'zoom', 'fade', 'stretch', 'focus', 'wipeL', 'wipeR', 'wipeU', 'wipeD', 'iris', 'none'];
const TEXT_IN = ['slam', 'rise', 'pop', 'fade', 'slideL', 'slideR', 'drop'];
const IDLE = ['float', 'wobble', 'spin', 'pulse', 'drift', 'none'];
const SHAPES = ['circle', 'rect', 'rings', 'wave', 'rays', 'dots', 'stripes', 'burst', 'wipe', 'flash'];
const EASES = ['linear', 'inCubic', 'outCubic', 'inOutCubic', 'outQuint', 'outExpo', 'outBack', 'outBounce', 'outElastic'];

const PROMO_SYSTEM = 'You are an award-winning motion-graphics director and animator who makes product launch spots for TikTok and Reels. You invent every promo from scratch and you reply with ONE JSON object only.';

const BLENDS = ['screen', 'multiply', 'overlay', 'lighter', 'soft-light', 'hard-light', 'color-dodge'];
const CAM_KINDS = ['punch', 'shake', 'zoom', 'roll', 'pan'];
const CUE_KINDS = ['whoosh', 'impact', 'tick', 'sparkle', 'riser'];

function promoPrompt(brief) {
  return `Direct and animate a short vertical (9:16) motion-graphics promo (you choose its length, anything from 6 to 12.4 seconds: as long as your idea needs and not a second of padding; spots like the references run 5-16 s) for the PHYSICAL product in this brief. It must have the energy of the best product spots on TikTok and Reels (Lay's, Goli, Pluckk, BerryWhite, McDonald's, Wendy's): the real product is the hero and something new and surprising happens every half second. No voice, almost no words, never a company story or a list of features: show the product and how it makes people feel, and end on the product with the brand name.

BRIEF:
${brief}

HOW THOSE SPOTS WORK (study it, then INVENT your own; never repeat a stock recipe, no two promos may feel alike, and the ideas below are only a menu of ingredients, not a sequence to follow):
- The HERO does almost all the moving. It whips across the whole frame at speed with motion blur, slams in, spins, tumbles, flips, stretches and squashes, lands out of a blur into sharp focus, bounces, hangs and drifts, is thrown out of frame and something takes its place. Sometimes there are several copies of it (a row, a ring, a stack, a wall) animating in sequence, or it grows to fill the screen, or shrinks into a badge.
- When it lands or passes, OTHER THINGS REACT: liquid or crumb splashes, ingredients thrown from behind it, a flash, shockwave rings, stickers popping, a word slamming, a colour wipe sweeping the screen to change scene, the camera punching in.
- Type is graphic: one giant word behind the product (stacked, outlined, scrolling, tone-on-tone, or running vertically up the side), tiny tracked lines, words arriving one by one; text has its own keyframes and can move, spin, stretch.
- Backdrops are calm: one colour family, flat or softly graded, or a hard colour change through a wipe or flash, with rings, rays, dots, waves as quiet moving furniture. The product carries the motion.
- The camera is a performer: punch-ins on impacts, shakes, a slow push, a roll, a fast zoom into the pack.
- Surprises are what make them memorable: an unexpected move, an odd scale, a glitchy repeat, a pack that opens like a book, props that orbit, a beat that freezes then releases. Decide yours.

FIVE REAL SPOTS AND WHAT ACTUALLY HAPPENS IN THEM (learn the LEVEL of motion; invent your own, never copy them):
- Berry White (12 s, energy drink): ONE calm green backdrop the whole time and a giant word running vertically up the side. A water splash sweeps the bottom at 0.4 s; the can, tilted about 30 degrees, whips in from the lower left with a lemon and lime wedges flying alongside, crosses the entire frame diagonally, rolls slowly while water erupts around it, slides out to the right in a blur, comes back from below out of a blur into focus, settles left of centre at about 60% of the screen width while round stickers ("100% organic") pop onto it and leaves drift; a glassy water swirl passes over it; a white flash-cut, and it sharpens again.
- Pluckk (10 s, juices): flat pastel colour blocks wipe across the screen to change scene every 2 s (mint, peach, dusty pink, green); each bottle enters diagonally, rotated 20-30 degrees, at speed from a corner, decelerates into place, and is replaced by the next bottle sliding in from the opposite corner; tiny text fills the gaps; then the bottles multiply into a spinning radial ring around a word, and finally a grid of every flavour pops in one by one.
- Lay's (10 s): deep red backdrop, concentric rings pulsing outward the whole time; the bag drops in tilted with a camera punch, big chips and dip bowls fly in and out from the frame edges (cropped by the frame), tiny "new look" text; the bag shrinks away and three bags rise as a row; a logo badge pops.
- Goli (12 s): hot pink; a giant outlined "NEW" stacked like a wall behind the bottle; the bottle slams in from above with motion blur, rotates and settles while gummies float around at large scale; callout icons with hairline connectors appear one by one; the pack opens into a gift box.
- Unicity (10 s): packs at rotated angles fill the whole frame, a lemon slice rolls in, a stat pops with sparkle circles, wave shapes wipe the bottom.

YOU WRITE A "MOTION SCRIPT" from these primitives (there are no templates; the renderer plays exactly what you write). Coordinates x, y, cx, cy are fractions of the screen (0,0 top-left, 1,1 bottom-right; values outside 0..1 are off-screen, which is how things enter and leave); w and sizes are fractions of the screen WIDTH; times are seconds from 0. Layers are drawn in the order you write them (later = on top of earlier).
FORMAT: THE HERO is ONE continuous track, "hero": {"path":[waypoints], "shadow":true|false, "glow":{...}, "idle":{...}}. Each waypoint {"t","x","y","w","r","blur","sx","sy","o","e"} (w = the pack's width as a fraction of the screen width: it rests at 0.4-0.6, can swell past 1.0 for a zoom-through or shrink to a badge; r = tilt in degrees; e = easing of the move ARRIVING at that waypoint). The first waypoint is where and when it first appears (put it off-screen to fly in), the last pose holds until the end; it leaves the screen by moving outside 0..1 or with o:0. Write 6 to 14 waypoints: it is the star and it travels the whole frame. Never split the hero into separate layers (extra copies of it, for a row or a ring, go in "layers" with src "hero").
FORMAT: every PROP carries its own appearances: "props":[{"name","look","uses":[{"kind":"scatter","t0":1,"t1":3,"n":8,"size":[0.16,0.36],"from":"burst","seed":5}, {"kind":"sprite","t0":2,"t1":4,"x":0.8,"y":0.2,"w":0.3,"keys":[...]}]}] (a use is a scatter, a sprite or a pattern; its src is filled in for you). Every prop needs at least one use, and they are big.
FORMAT: "layers" holds everything else, as FLAT objects, each with a "kind" key and its fields directly on it (never nested under a "sprite" or "text" key), for example:
{"kind":"text","t0":1,"t1":3,"x":0.5,"y":0.3,"size":0.2,"font":"anton","color":"#ffffff","lines":["WORD"],"in":{"kind":"slam","dur":0.4}}
{"kind":"pattern","src":"hero","sub":"ring","t0":4,"t1":6,"cx":0.5,"cy":0.5,"w":0.2,"rings":2,"spin":30}
{"kind":"flash","t0":2,"t1":2.25,"color":"#ffffff","alpha":0.8}
"zones" and "beats" are arrays. A layer only EXISTS between its t0 and t1, so give a layer t0..t1 covering every moment it is visible (a word must stay at least 1 s to be read); DRAW ORDER: backdrop shapes and giant words (size 0.16 and up, unless front:true) are BEHIND the hero, the hero is above them, props, bursts and copies above the hero, small lines (and front:true words) above those, and wipes and flashes over everything; In a SPRITE's keys, "w" is its width at that moment as a fraction of the screen width (the hero rests at 0.4-0.6; it can swell to 1.0 or more for a zoom-through and shrink to a badge), so it can grow and shrink between keys.
EVERY layer: beat (optional index), t0, t1, alpha, blend ("screen","multiply","overlay","lighter","soft-light"), keys.
KEYS: "keys":[{"t","x","y","w" (sprites: width as a fraction of the screen width) or "s" (text and shapes: scale, 1 = as written),"sx","sy" (stretch / squash multipliers, 1 = none),"r" (rotation in degrees, absolute),"o" (opacity),"blur" (pixels),"e" (easing of the move that ARRIVES at this key)}]. Between keys the layer is interpolated; eases: ${EASES.join(', ')}. If a layer has keys, make its first key's t equal to the layer's t0 and give it the layer's x, y, w. Any number of keys (up to 16): whip across, stop, rebound, exit. The same sprite may appear in SEVERAL layers, each with its own keys.
- "sprite" (in layers or in a prop's uses): src "hero" or "prop0".."prop4". x, y, w, r, shadow (false to drop it), glow {color, blur}, blur (px), idle {kind, amp, speed} (kinds ${IDLE.join(', ')}), in {kind, dur, delay, from, turns} (kinds ${IN_KINDS.join(', ')}; "focus" = blurred to sharp, "wipeL/wipeR/wipeU/wipeD/iris" = mask reveals), out {kind, dur}.
- "text": lines ["WORD","WORD"], x, y, size (0.03 tiny .. 0.36 giant), font, color, upper, track (letter spacing), r (any rotation; 90 or -90 runs a word vertically up the side), align, stroke {color, w}, fill (false = outline only), tone (true = a shade off the backdrop, tone-on-tone), shadow, glow {color, blur}, blur, in {kind, dur, stag} (kinds ${TEXT_IN.join(', ')}; words arrive one by one), out {kind}, repeat {n, dy, speed} (the same word stacked n times, scrolling: the wall behind a product). Fonts: ${Object.entries(FONTS).map(([k, v]) => k + ' (' + v + ')').join('; ')}.
- "scatter": pieces flying around: src (one prop id or a list, "hero" allowed), n (1-16), cx, cy, spread, size [min,max], from ("burst" | "corners" | "edges" | "top" | "sides"), seed, spin, stag, avoid (true keeps them off the product).
- "pattern": src repeated as a pattern: sub ("radial" | "grid" | "ring"), cx, cy, w, spin, rings, cols, rows, stag, alpha.
- shapes: kind one of ${SHAPES.join(', ')}: circle {x,y,size,color}; rect {x,y,w,h,radius,color}; rings {x,y,n,gap,width,speed,color,color2}; wave {y,amp,wl,speed,color,side}; rays {x,y,n,speed,color}; dots {gap,dot,speed,color}; stripes {w,speed,color,r}; burst {x,y,n,color,color2,life}; wipe {dir:"left|right|up|down", n (stacked bands), color, color2, t0, t1} = a colour block sweeping across the whole screen in 0.3 to 1 s (use it to change scene); flash {color, alpha, t0, t1} (a flash lasts 0.1 to 0.5 s: t1 is just after t0; never write a long flash). Shapes take in/out/idle/keys too.
- "cam": [{t, kind, ...}] kinds: punch {amp, dur}, shake {amp, dur}, zoom {to, dur, hold, back} (zoom to a scale and back), roll {amp, dur}, pan {dx, dy, dur}.
- "zones": the backdrop: {c0 (bright centre), c1 (edge), shape "radial"|"linear"} (make c1 equal to c0 for a flat colour). "beats": 1 to 5 windows {t0, t1, zone} that tile 0..duration; the camera glides across the board between zones, so give them the same colours for one calm backdrop, or different colours for a scene change. Saturated colours that make the product POP.
- "sound": {"music": "pulse" | "warm pad" | "tense" | "dark drone", "cues": [{"t", "kind": ${CUE_KINDS.map((k) => '"' + k + '"').join(' | ')}}]}: put a cue exactly on every whoosh, landing and hit you animated.

RULES (a promo that breaks these looks cheap): USE EVERY PROP you define (each one appears in at least one scatter, sprite or pattern), big; at least FOUR distinct things happen in every beat, and nothing sits still for more than half a second; the hero is on screen within 1.2 s and travels a lot (not a shuffle: whole-frame moves), with different easing each time; props are BIG (w 0.16-0.5) and bleed off the frame edges; use different motion for every element and never copy a layer; the whole promo has AT MOST 16 words, only words from the brief or that describe the taste, feel or look; text stays clear of the product's face unless it is a giant word BEHIND it (write it earlier); the last beat shows the product with the BRAND NAME big and at most 3 words of call to action. No prices, no claims you cannot see. Up to 40 layers.

Return ONE JSON object with these keys, in this order:
"ideas": 3 to 5 sentences, one per beat, in your own words: the SPECIFIC unique things that happen in that beat (what the hero does, what reacts to it, what the type and the camera do, how the scene changes). Write them first, then implement exactly them.
"brand" (as in the brief, max 24 characters), "product": {"name", "kind" (what it physically is: "canned soft drink", "bag of potato chips"...), "look" (how the pack looks for an image AI: shape, materials, the two or three colours, label art WITHOUT any text, max 30 words), "colors" ["#rrggbb","#rrggbb"]}, "props": 2 to 5 objects {"name", "look" (one thing that belongs to the product - an ingredient, a splash, a piece, a leaf, a crumb - described for an image AI, no text, max 18 words)}, "duration" (6 to 12.4, in seconds, your choice), "zones", "beats", "layers", "cam", "sound".
Output the JSON object only.`;
}

/** A second pass: the AI is shown its own draft and what is thin about it, and rewrites the whole script. */
function revisePrompt(brief, draft, issues) {
  return `${promoPrompt(brief)}

YOUR FIRST DRAFT of this script (JSON):
${JSON.stringify(draft)}

A REVIEW OF THE DRAFT (a director watched it and found these problems):
${issues.map((s, i) => (i + 1) + '. ' + s).join('\n')}

Rewrite the WHOLE script (the same JSON format, same keys) fixing every problem, keeping what works, and adding more invention: more unexpected moves, bigger hero travel, more reactions when the hero lands. Output the JSON object only.`;
}

// ------------------------------------------------------------------ validation: the AI's script is repaired for safety (ranges, spelling, sources), never redesigned
const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim());
const fixHex = (v, d) => (isHex(v) ? '#' + v.trim().replace('#', '').toLowerCase() : d);
const num = (v, d, lo, hi) => { v = +v; if (!Number.isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); };
const rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const cleanStr = (v, n) => String(v == null ? '' : v).replace(/[<>"\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

function motionIO(o, kinds, dDur) {
  if (!o || typeof o !== 'object') return undefined;
  const k = oneOf(o.kind, kinds, null); if (!k) return undefined;
  return { kind: k, dur: num(o.dur, dDur, 0.05, 2), ...(o.delay !== undefined ? { delay: num(o.delay, 0, 0, 8) } : {}), ...(o.stag !== undefined ? { stag: num(o.stag, 0.09, 0, 0.5) } : {}), ...(o.turns !== undefined ? { turns: num(o.turns, 1, 0.25, 6) } : {}), ...(o.from !== undefined ? { from: num(o.from, 3, 0.2, 40) } : {}), ...(o.ease ? { ease: oneOf(o.ease, EASES, undefined) } : {}) };
}
const glowOf = (g) => (g && typeof g === 'object' ? { color: fixHex(g.color, '#ffffff'), blur: num(g.blur, 30, 4, 80) } : undefined);
function keysOf(arr, D, max, baseW) {
  if (!Array.isArray(arr)) return undefined;
  const ks = arr.filter((k) => k && Number.isFinite(+k.t)).slice(0, max).map((k) => ({ t: +num(k.t, 0, 0, D).toFixed(3), ...(k.x !== undefined ? { x: num(k.x, 0.5, -3, 4) } : {}), ...(k.y !== undefined ? { y: num(k.y, 0.5, -3, 4) } : {}), ...(baseW && k.w !== undefined ? { s: +num(num(k.w, baseW, 0.03, 3) / baseW, 1, 0.05, 8).toFixed(3) } : k.s !== undefined ? { s: num(k.s, 1, 0.05, 6) } : {}), ...(k.sx !== undefined ? { sx: num(k.sx, 1, 0.1, 4) } : {}), ...(k.sy !== undefined ? { sy: num(k.sy, 1, 0.1, 4) } : {}), ...(k.r !== undefined ? { r: num(k.r, 0, -1440, 1440) } : {}), ...(k.o !== undefined ? { o: num(k.o, 1, 0, 1) } : {}), ...(k.blur !== undefined ? { blur: num(k.blur, 0, 0, 40) } : {}), ...(k.e ? { e: oneOf(k.e, EASES, 'inOutCubic') } : {}) })).sort((a, b) => a.t - b.t);
  return ks.length >= 2 ? ks : undefined;
}

/** Turn the AI's raw script into a safe, playable promo (throws only if there is nothing to play at all). */
function normalizePromo(raw, ctx = {}) {
  const S = raw && typeof raw === 'object' ? raw : {};
  const brand = cleanStr(S.brand || ctx.brand || 'Brand', 24).toUpperCase() || 'BRAND';
  const D = num(S.duration, 9, 5.5, 12.4);
  const P = S.product && typeof S.product === 'object' ? S.product : {};
  const colors = (Array.isArray(P.colors) ? P.colors : []).filter(isHex).map((c) => fixHex(c)).slice(0, 2);
  const product = { name: cleanStr(P.name, 60) || brand, kind: cleanStr(P.kind, 50) || 'product pack', look: cleanStr(P.look, 260) || 'a premium retail pack', colors: colors.length ? colors : ['#ff5c1a', '#ffd23f'] };
  const props = (Array.isArray(S.props) ? S.props : []).slice(0, 5).map((p) => ({ name: cleanStr(p && p.name, 40), look: cleanStr(p && p.look, 200) })).filter((p) => p.look);
  while (props.length < 2) props.push({ name: 'splash', look: 'a fresh splash of the product, glossy droplets' });
  const assets = [{ id: 'hero' }, ...props.map((_, i) => ({ id: 'prop' + i }))], okSrc = new Set(assets.map((a) => a.id));
  const ideas = (Array.isArray(S.ideas) ? S.ideas : []).map((s) => cleanStr(s, 260)).filter(Boolean).slice(0, 6);

  // zones: the AI's colours (a flat colour when c0 = c1), only a dull grey is repaired; positions on the board are a gentle seeded walk
  const pc = colors.length ? rgb(colors[0]) : [255, 92, 26];
  const seedH = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  let rs = seedH(brand + product.name); const rand = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
  let zin = (Array.isArray(S.zones) ? S.zones : S.zones && typeof S.zones === 'object' ? [S.zones] : []).filter((z) => z && typeof z === 'object').slice(0, 6); if (!zin.length) zin = [{}];
  const zones = []; let px = 0, py = 0;
  zin.forEach((z, i) => {
    let c0 = rgb(fixHex(z.c0, toHex(mix(pc, [255, 255, 255], 0.2)))), c1 = rgb(fixHex(z.c1, toHex(mix(pc, [10, 10, 30], 0.45))));
    if (Math.max(...c0) - Math.min(...c0) < 28 && Math.max(...c0) < 235) c0 = mix(c0, pc, 0.6);      // a dull grey is not a backdrop
    if ((0.299 * c0[0] + 0.587 * c0[1] + 0.114 * c0[2]) / 255 > 0.86) { c0 = mix(c0, pc, 0.55); c1 = mix(c1, pc, 0.35); }   // near-white: the product and the words would vanish
    if (i > 0) { const a = rand() * Math.PI * 2, d = 450 + rand() * 350; px = Math.round(px + Math.cos(a) * d); py = Math.round(py + Math.sin(a) * d); }
    zones.push({ c0: toHex(c0), c1: toHex(c1), shape: z.shape === 'linear' ? 'linear' : 'radial', x: px, y: py });
  });
  // beats: 1 to 5 contiguous windows covering 0..D
  let bIn = (Array.isArray(S.beats) ? S.beats : S.beats && typeof S.beats === 'object' ? [S.beats] : []).filter((b) => b && typeof b === 'object').slice(0, 5);
  if (!bIn.length) bIn = [{}, {}, {}];
  const nb = bIn.length, cuts = [0];
  for (let i = 0; i < nb - 1; i++) { const want = Number.isFinite(+bIn[i].t1) ? +bIn[i].t1 : (D * (i + 1)) / nb; cuts.push(Math.max(cuts[i] + 0.8, Math.min(D - 0.8 * (nb - 1 - i), want))); }
  cuts.push(D);
  const beats = bIn.map((b, i) => ({ t0: +cuts[i].toFixed(2), t1: +cuts[i + 1].toFixed(2), zone: Math.max(0, Math.min(zones.length - 1, Number.isInteger(+b.zone) ? +b.zone : Math.min(i, zones.length - 1))) }));

  // layers
  const fontIds = Object.keys(FONTS), layers = []; let words = 0;
  const beatIdx = (v) => (v === 'all' ? 'all' : Number.isInteger(+v) && +v >= 0 && +v < nb ? +v : undefined);
  const timing = (L, o) => {
    let t0 = num(L.t0, undefined, 0, D), t1 = num(L.t1, undefined, 0, D); let b = beatIdx(L.beat);
    if (t0 === undefined) t0 = b !== undefined && b !== 'all' ? beats[b].t0 : 0;
    if (t1 === undefined || t1 <= t0 + 0.15) t1 = b !== undefined && b !== 'all' ? beats[b].t1 + 0.3 : D;
    o.t0 = +Math.min(t0, D - 0.3).toFixed(2); o.t1 = +Math.min(D, t1).toFixed(2);
    if (typeof b === 'number' && (o.t0 < beats[b].t0 - 0.3 || o.t1 > beats[b].t1 + 0.6)) b = undefined;   // it outlives its beat: it stays on the screen, not on the board
    if (typeof b === 'number') o.beat = b;
    if (L.blend) { const bl = oneOf(L.blend, BLENDS, null); if (bl) o.blend = bl; }
    return o;
  };
  const extraIn = [];
  if (S.hero && typeof S.hero === 'object' && Array.isArray(S.hero.path) && S.hero.path.length) {
    const wp = S.hero.path.filter((k) => k && typeof k === 'object' && Number.isFinite(+k.t)).sort((a, b) => a.t - b.t), p0 = wp[0];
    if (p0) extraIn.push({ kind: 'sprite', src: 'hero', t0: p0.t, t1: D, x: p0.x, y: p0.y, w: p0.w, r: 0, keys: wp.length >= 2 ? wp.map((k) => Object.assign({}, k, { r: k.r })) : undefined, shadow: S.hero.shadow, glow: S.hero.glow, idle: S.hero.idle, blur: p0.blur });
  }
  (Array.isArray(S.props) ? S.props : []).slice(0, 5).forEach((p, i) => { (p && Array.isArray(p.uses) ? p.uses : []).slice(0, 4).forEach((u) => { if (u && typeof u === 'object') extraIn.push(Object.assign({}, u, { src: 'prop' + i, kind: ['scatter', 'sprite', 'pattern'].includes(u.kind) ? u.kind : 'scatter' })); }); });
  (Array.isArray(S.layers) ? S.layers : []).concat(extraIn).slice(0, 56).forEach((L0) => {
    if (!L0 || typeof L0 !== 'object') return;
    let L = L0;
    for (const nk of ['sprite', 'text', 'scatter', 'pattern', 'shape']) if (L0[nk] && typeof L0[nk] === 'object' && !Array.isArray(L0[nk])) { L = Object.assign({}, L0, L0[nk], nk === 'shape' ? {} : { kind: nk }); if (!L.kind) L.kind = 'shape'; delete L[nk]; break; }
    for (const nk of ['glow', 'shadow']) if (L[nk] === null) delete L[nk];
    let kind = String(L.kind || '');
    if (kind === 'shape' && SHAPES.includes(L.type)) kind = L.type;
    if (kind === 'sprite') {
      const src = okSrc.has(L.src) ? L.src : null; if (!src) return;
      const o = timing(L, { kind, src, x: num(L.x, 0.5, -3, 4), y: num(L.y, 0.5, -3, 4), w: num(L.w, src === 'hero' ? 0.5 : 0.22, 0.04, src === 'hero' ? 1.2 : 0.9), r: num(L.r, 0, -720, 720) });
      const i = motionIO(L.in, IN_KINDS, 0.5), out = motionIO(L.out, IN_KINDS, 0.35), idle = L.idle && oneOf(L.idle.kind, IDLE, null) ? { kind: L.idle.kind, amp: num(L.idle.amp, 0.02, 0, 0.15), speed: num(L.idle.speed, 1, 0.2, 4) } : undefined;
      if (i) o.in = i; if (out) o.out = out; if (idle) o.idle = idle;
      if (L.shadow === false) o.shadow = false; if (L.blur !== undefined) o.blur = num(L.blur, 0, 0, 40); const gl = glowOf(L.glow); if (gl) o.glow = gl;
      const ks = keysOf(L.keys, D, 16, o.w); if (ks) o.keys = ks;
      if (src === 'hero') {                                                                    // a product this small cannot be seen: repair the scale, not the choreography
        const eff = o.keys ? o.keys.map((k) => o.w * (k.s !== undefined ? k.s : 1)) : [o.w], srt = eff.filter((v) => v > 0).sort((a, b) => a - b), md = srt.length ? srt[Math.floor(srt.length / 2)] : o.w;
        if (md < 0.4) o.w = +Math.min(1.2, o.w * (0.48 / md)).toFixed(3);     // every key scales with it
      }
      layers.push(o);
    } else if (kind === 'text') {
      const lines = (Array.isArray(L.lines) ? L.lines : [L.text]).map((s) => cleanStr(s, 30)).filter(Boolean).slice(0, 3); if (!lines.length) return;
      const wc = lines.join(' ').split(' ').filter(Boolean).length; if (words + wc > 18) return; words += wc;      // the promo stays nearly wordless
      const o = timing(L, { kind, lines, x: num(L.x, 0.5, -0.5, 1.5), y: num(L.y, 0.5, -0.5, 1.5), size: num(L.size, 0.1, 0.03, 0.38), font: oneOf(L.font, fontIds, 'anton'), color: fixHex(L.color, '#ffffff'), upper: L.upper !== false, track: num(L.track, 0, -0.05, 0.5), r: num(L.r, 0, -400, 400), align: oneOf(L.align, ['center', 'left', 'right'], 'center') });
      o.in = L.in && oneOf(L.in.kind, TEXT_IN, null) ? { kind: L.in.kind, dur: num(L.in.dur, 0.45, 0.1, 1.5), stag: num(L.in.stag, 0.09, 0, 0.5) } : { kind: 'rise', dur: 0.45, stag: 0.09 };
      const out = motionIO(L.out, IN_KINDS, 0.3); if (out) o.out = out;
      if (L.stroke && typeof L.stroke === 'object') o.stroke = { color: fixHex(L.stroke.color, '#000000'), w: num(L.stroke.w, 0.03, 0.01, 0.06) };
      if (L.shadow) o.shadow = true; if (L.tone) o.tone = true; if (L.front) o.front = true; if (L.fill === false) o.fill = false; if (L.alpha !== undefined) o.alpha = num(L.alpha, 1, 0.1, 1);
      if (L.blur !== undefined) o.blur = num(L.blur, 0, 0, 30); const gl = glowOf(L.glow); if (gl) o.glow = gl;
      if (L.repeat && typeof L.repeat === 'object') o.repeat = { n: num(L.repeat.n, 5, 2, 11) | 0, dy: num(L.repeat.dy, 0.92, 0.5, 1.5), speed: num(L.repeat.speed, 0.04, 0, 0.3) };
      const ks = keysOf(L.keys, D, 12); if (ks) o.keys = ks;
      layers.push(o);
    } else if (kind === 'scatter') {
      const srcList = (Array.isArray(L.src) ? L.src : [L.src]).filter((s) => okSrc.has(s)); if (!srcList.length) return;
      let sz = Array.isArray(L.size) && L.size.length === 2 ? [num(L.size[0], 0.16, 0.04, 0.6), num(L.size[1], 0.3, 0.05, 0.8)] : [0.16, 0.3]; if (sz[1] < sz[0]) sz = [sz[1], sz[0]];
      layers.push(timing(L, { kind, src: srcList, n: num(L.n, 8, 1, 16) | 0, cx: num(L.cx, 0.5, -0.5, 1.5), cy: num(L.cy, 0.5, -0.5, 1.5), spread: num(L.spread, 0.42, 0.1, 1.2), size: sz, from: oneOf(L.from, ['burst', 'corners', 'edges', 'top', 'sides'], 'burst'), seed: num(L.seed, 3, 1, 999) | 0, spin: num(L.spin, 240, 0, 900), stag: num(L.stag, 0.35, 0, 1.2), ...(L.avoid ? { avoid: true } : {}) }));
    } else if (kind === 'pattern') {
      const src = okSrc.has(L.src) ? L.src : 'hero';
      layers.push(timing(L, { kind, src, sub: oneOf(L.sub, ['radial', 'grid', 'ring'], 'radial'), cx: num(L.cx, 0.5, -0.5, 1.5), cy: num(L.cy, 0.5, -0.5, 1.5), w: num(L.w, 0.14, 0.04, 0.5), spin: num(L.spin, 30, -360, 360), rings: num(L.rings, 3, 1, 5) | 0, cols: num(L.cols, 4, 1, 8) | 0, rows: num(L.rows, 6, 1, 12) | 0, stag: num(L.stag, 0.02, 0, 0.1), alpha: num(L.alpha, 0.7, 0.1, 0.9) }));
    } else if (SHAPES.includes(kind)) {
      const o = timing(L, { kind, x: num(L.x, 0.5, -1.5, 2.5), y: num(L.y, 0.5, -1.5, 2.5), color: fixHex(L.color, '#ffffff'), alpha: num(L.alpha, 1, 0.03, 1), r: num(L.r, 0, -720, 720) });
      if (L.color2) o.color2 = fixHex(L.color2, o.color);
      ['size', 'w', 'h', 'radius', 'n', 'gap', 'width', 'speed', 'amp', 'wl', 'thick', 'dot', 'life', 'seed'].forEach((k) => { if (L[k] !== undefined) o[k] = num(L[k], 0, -5, 200); });
      if (L.side) o.side = oneOf(L.side, ['top', 'bottom'], 'bottom');
      if (kind === 'wipe') { o.dir = oneOf(L.dir, ['left', 'right', 'up', 'down'], 'left'); o.t1 = +Math.min(o.t1, o.t0 + 1.4).toFixed(2); }
      if (kind === 'flash') o.t1 = +Math.min(o.t1, o.t0 + 0.6).toFixed(2);          // a flash is an instant, whatever the AI wrote for t1
      const i = motionIO(L.in, IN_KINDS, 0.5), out = motionIO(L.out, IN_KINDS, 0.35), idle = L.idle && oneOf(L.idle.kind, IDLE, null) ? { kind: L.idle.kind, amp: num(L.idle.amp, 0.02, 0, 0.15), speed: num(L.idle.speed, 1, 0.2, 4) } : undefined;
      if (i) o.in = i; if (out) o.out = out; if (idle) o.idle = idle;
      const ks = keysOf(L.keys, D, 12); if (ks) o.keys = ks;
      layers.push(o);
    }
  });
  // safety: a word must be readable, a flash is brief and rare
  layers.forEach((l) => { if (l.kind === 'text') { const need = 1.0; if (l.t1 - l.t0 < need) l.t1 = +Math.min(D, l.t0 + need).toFixed(2); if (l.t0 + need > D) l.t0 = +Math.max(0, D - need).toFixed(2); } else if (l.kind === 'sprite' || l.kind === 'scatter') { if (l.t1 - l.t0 < 0.5) l.t1 = +Math.min(D, l.t0 + 0.5).toFixed(2); } });
  { let fl = 0; for (let i = layers.length - 1; i >= 0; i--) if (layers[i].kind === 'flash') { fl++; if (fl > 3) layers.splice(i, 1); } }
  // draw order (a rendering rule, not a design): backdrop shapes and giant words behind the hero, the hero, props / bursts / copies above it, small lines above those, wipes and flashes over everything
  { const rank = (l) => (['flash', 'wipe'].includes(l.kind) ? 6 : ['circle', 'rect', 'rings', 'wave', 'rays', 'dots', 'stripes'].includes(l.kind) ? 0 : l.kind === 'pattern' ? 1 : l.kind === 'text' ? (l.front || l.size < 0.16 ? 5 : 2) : l.kind === 'sprite' && l.src === 'hero' && !l.copy ? 3 : 4); const first = layers.findIndex((l) => l.kind === 'sprite' && l.src === 'hero');
    const arr = layers.map((l, i) => [rank(l), i === first ? -1 : i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]); layers.length = 0; arr.forEach((l) => layers.push(l)); }
  // guarantees (content, not design): the product exists and is on screen early; the brand name closes the promo
  const heroLayers = layers.filter((l) => l.kind === 'sprite' && l.src === 'hero');
  if (!heroLayers.length) layers.push({ kind: 'sprite', src: 'hero', beat: 'all', t0: 0.3, t1: D, x: 0.5, y: 0.52, w: 0.5, r: -10, in: { kind: 'pop', dur: 0.6 }, idle: { kind: 'float', amp: 0.012, speed: 1 } });
  const lastBeat = beats[nb - 1];
  const hasBrand = layers.some((l) => l.kind === 'text' && l.t1 >= D - 0.4 && l.lines.join(' ').toUpperCase().includes(brand.split(' ')[0]));
  if (!hasBrand) layers.push({ kind: 'text', beat: nb - 1, t0: +(lastBeat.t0 + 0.5).toFixed(2), t1: D, lines: [brand.length > 12 && brand.includes(' ') ? brand.split(' ').slice(0, 2).join(' ') : brand], x: 0.5, y: 0.88, size: brand.length > 10 ? 0.11 : 0.15, font: 'anton', color: '#ffffff', upper: true, track: 0, r: 0, align: 'center', in: { kind: 'slam', dur: 0.4, stag: 0.14 }, shadow: true, front: true });
  const cam = (Array.isArray(S.cam) ? S.cam : []).filter((c) => c && Number.isFinite(+c.t) && CAM_KINDS.includes(c.kind)).slice(0, 12).map((c) => ({ t: num(c.t, 0.5, 0, D - 0.2), kind: c.kind, amp: num(c.amp, c.kind === 'shake' ? 8 : c.kind === 'roll' ? 5 : 0.06, 0, c.kind === 'shake' ? 24 : c.kind === 'roll' ? 25 : 0.15), dur: num(c.dur, 0.3, 0.1, 3), ...(c.kind === 'zoom' ? { to: num(c.to, 1.25, 0.6, 2.5), hold: num(c.hold, 0, 0, 4), back: num(c.back, 0, 0, 3) } : {}), ...(c.kind === 'pan' ? { dx: num(c.dx, 0, -0.5, 0.5), dy: num(c.dy, 0, -0.5, 0.5) } : {}) }));
  const music = oneOf(S.sound && S.sound.music, ['pulse', 'warm pad', 'tense', 'dark drone'], 'pulse');
  const cues = (S.sound && Array.isArray(S.sound.cues) ? S.sound.cues : []).filter((c) => c && Number.isFinite(+c.t) && CUE_KINDS.includes(c.kind)).slice(0, 24).map((c) => ({ t: num(c.t, 0, 0, D), kind: c.kind }));
  return { brand, product, props, assets, duration: +D.toFixed(2), ideas, zones, beats, layers, cam, sound: { music, cues }, pan: 0.8 };
}

/**
 * The director's review: measurable things that make a promo feel thin or cheap next to the references. The result goes BACK TO THE AI (revisePrompt) to fix in its own way;
 * nothing here changes the design.
 */
function critique(promo) {
  const issues = [], D = promo.duration, L = promo.layers;
  const heroes = L.filter((l) => l.kind === 'sprite' && l.src === 'hero');
  // 1. how far the product travels
  let travel = 0, sweeps = 0, moves = 0;
  heroes.forEach((h) => { const K = h.keys || []; for (let i = 1; i < K.length; i++) { const a = K[i - 1], b = K[i]; if (a.x === undefined || b.x === undefined) continue; const d = Math.hypot((b.x - a.x), (b.y - (a.y !== undefined ? a.y : b.y)) * 1.78), dt = Math.max(0.05, b.t - a.t); travel += d; moves++; if (d > 0.7 && dt < 0.9) sweeps++; } });
  if (travel < 3) issues.push(`The hero travels only ${travel.toFixed(1)} screen-widths in total. In the reference spots it whips across the whole frame several times, enters and leaves at speed, with different easing each time. Give the hero many more, bigger keyframed moves (at least 3 whole-frame sweeps).`);
  else if (sweeps < 2) issues.push('The hero drifts but never really whips across the frame. Add fast sweeps (a move of most of the screen in under 0.8 s, easing outExpo / inCubic) with blur keys on the fast parts.');
  const heroAtT = (t) => { let vis = false, w = 0; heroes.forEach((h) => { if (t < h.t0 || t > h.t1) return; let x = h.x, y = h.y, sc = 1; const K = h.keys; if (K && K.length && t >= K[0].t) { let a = K[0], b = K[K.length - 1]; for (let i = 0; i < K.length - 1; i++) if (t >= K[i].t && t <= K[i + 1].t) { a = K[i]; b = K[i + 1]; break; } const u = a === b ? 1 : Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t))); const iv = (k, d) => { const va = a[k] !== undefined ? a[k] : d, vb = b[k] !== undefined ? b[k] : va; return va + (vb - va) * u; }; x = iv('x', x); y = iv('y', y); sc = iv('s', 1); } if (x > -0.1 && x < 1.1 && y > -0.1 && y < 1.1) { vis = true; w = Math.max(w, h.w * sc); } }); return { vis, w }; };
  let gapStart = null; const gaps = [];
  for (let t = 0.2; t <= D - 0.2; t += 0.1) { const v = heroAtT(t).vis; if (!v && gapStart === null) gapStart = t; if (v && gapStart !== null) { if (t - gapStart > 0.7) gaps.push([gapStart, t]); gapStart = null; } }
  if (gapStart !== null && D - gapStart > 0.7) gaps.push([gapStart, D]);
  if (gaps.length) issues.push('The hero is missing from the screen during ' + gaps.slice(0, 3).map((g) => g[0].toFixed(1) + '-' + g[1].toFixed(1) + ' s').join(', ') + '. Layers exist only between their t0 and t1: extend the hero layer (or add another) so the product is on screen nearly all the time, especially in the last beat with the brand name.');
  let bigMax = 0; for (let t = 0.3; t <= D; t += 0.2) bigMax = Math.max(bigMax, heroAtT(t).w);
  if (bigMax < 0.4) issues.push('The hero never gets big: its width should reach at least 0.45 of the screen width at rest.');
  promo.beats.forEach((b, i) => { const z = promo.zones[b.zone]; if (!z) return; const c = rgb(z.c0), mn = Math.min(...c), mxv = Math.max(...c); if (mn > 215 && mxv - mn < 40) issues.push(`Beat ${i + 1}'s backdrop is almost white or grey, so the product and the words vanish. Use a saturated colour behind them.`); });
  const firstHero = Math.min(...heroes.map((h) => (h.keys && h.keys.length ? Math.min(h.t0, h.keys[0].t) : h.t0)));
  if (firstHero > 1.3) issues.push(`The hero is not on screen until ${firstHero.toFixed(1)} s. It must be visible (or clearly arriving) within 1.2 s.`);
  // 2. density per beat
  promo.beats.forEach((b, i) => {
    const n = L.filter((l) => l.t0 < b.t1 - 0.2 && l.t1 > b.t0 + 0.2 && l.beat !== 'all' && !(l.kind === 'sprite' && l.src === 'hero')).length;
    if (n < 4) issues.push(`Beat ${i + 1} (${b.t0}-${b.t1} s) has only ${n} things besides the hero. It needs at least 4 distinct events: reactions when the hero lands, props, a giant word, a shape, a flash or wipe.`);
  });
  // 3. variety of techniques
  const tech = new Set();
  L.forEach((l) => { tech.add(l.kind); if (l.keys && l.keys.some((k) => k.blur)) tech.add('blurkeys'); if (l.keys && l.keys.some((k) => k.sx !== undefined || k.sy !== undefined)) tech.add('squash'); if (l.blend) tech.add('blend'); if (l.glow) tech.add('glow'); if (l.repeat) tech.add('repeat'); if (l.r && Math.abs(l.r) > 60 && l.kind === 'text') tech.add('verticaltext'); if (l.tone) tech.add('tone'); if (l.fill === false) tech.add('outline'); if (l.in && l.in.kind) tech.add('in:' + l.in.kind); });
  promo.cam.forEach((c) => tech.add('cam:' + c.kind));
  if (tech.size < 12) issues.push(`Only ${tech.size} distinct techniques are used. Add more variety: squash and stretch keys, blur keys, a colour wipe or flash between beats, camera zoom or roll, outline or vertical giant type, glow or blend layers, copies of the hero.`);
  // 4. scale of props
  const smallProps = L.filter((l) => (l.kind === 'scatter' && l.size[1] < 0.2) || (l.kind === 'sprite' && l.src !== 'hero' && l.w < 0.14));
  if (smallProps.length) issues.push('Some props are tiny. Props must be big (w 0.16-0.5) and bleed off the frame edges.');
  // 5. copy-paste
  const sig = (l) => JSON.stringify({ k: l.kind, s: l.src, f: l.from, n: l.n, z: l.size, sh: l.lines, x: l.x, y: l.y, w: l.w, k2: l.keys ? l.keys.length : 0, c: l.color });
  const seen = new Map(); L.forEach((l) => { const k = sig(l); seen.set(k, (seen.get(k) || 0) + 1); });
  if ([...seen.values()].some((c) => c >= 3)) issues.push('You repeat the same layer three or more times (copy-paste). Every layer must differ in motion, size, timing and direction.');
  // 6. text over the product's face
  const heroAt = (t) => { const h = heroes.find((x) => x.keys && x.keys.length && t >= x.keys[0].t) || heroes[0]; if (!h) return null; const K = h.keys; let x = h.x, y = h.y, s = 1; if (K && K.length) { let a = K[0], b = K[K.length - 1]; for (let i = 0; i < K.length - 1; i++) if (t >= K[i].t && t <= K[i + 1].t) { a = K[i]; b = K[i + 1]; break; } const u = a === b ? 1 : Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t))); const iv = (k, d) => { const va = a[k] !== undefined ? a[k] : d, vb = b[k] !== undefined ? b[k] : va; return va + (vb - va) * u; }; x = iv('x', x); y = iv('y', y); s = iv('s', 1); } return { x, y, w: h.w * s, h: h.w * s * 2.0 * 720 / 1280 }; };
  const covered = L.filter((l) => l.kind === 'text' && l.size < 0.12 && !l.front && Math.abs(l.r || 0) < 30).filter((l) => { const p = heroAt((l.t0 + l.t1) / 2); return p && Math.abs(l.x - p.x) < p.w * 0.4 && Math.abs(l.y - p.y) < p.h * 0.4; });
  if (covered.length) issues.push(`A small line of text ("${covered[0].lines.join(' ')}") sits on top of the product's face. Move it into free space or make it a giant word BEHIND the product (written earlier).`);
  const usedSrc = new Set(); L.forEach((l) => { (Array.isArray(l.src) ? l.src : [l.src]).forEach((x) => usedSrc.add(x)); });
  const unused = promo.props.map((p, i) => 'prop' + i).filter((id) => !usedSrc.has(id));
  if (unused.length) issues.push('These props have no "uses" and never appear on screen: ' + unused.join(', ') + '. Give every prop uses (scatter pieces, flying sprites or patterns), big.');
  if (promo.sound.cues.length < 4) issues.push('Sound cues: place a whoosh at every fast sweep, an impact at every landing and a tick on every word slam (sound.cues), at least 6.');
  return issues.slice(0, 7);
}

// ------------------------------------------------------------------ pictures: the hero pack shot and the props, painted on a key colour, then cut out
const KEYS = [['#ff00ff', 'magenta'], ['#00ff00', 'green'], ['#00b8ff', 'cyan blue'], ['#ff8a00', 'orange']];
/** the chroma-key colour that is furthest from the product's own colours (an object is never lost into its background) */
function pickKey(colors) {
  const cs = (colors || []).map((c) => rgb(fixHex(c, '#888888')));
  let best = KEYS[0], bd = -1;
  for (const k of KEYS) { const d = cs.length ? Math.min(...cs.map((c) => dist(c, rgb(k[0])))) : 200; if (d > bd) { bd = d; best = k; } }
  return { hex: best[0], name: best[1] };
}
function heroPrompt(promo, key) {
  const p = promo.product;
  return `A single ${p.kind}, ${p.look}, front view, premium product photography, studio lighting, sharp focus, vivid colour, the whole product fully in frame and centered, with a plain smooth empty label area in the middle of the pack (no text, no letters, no logo anywhere on it), isolated on a plain flat pure ${key.name} (${key.hex}) chroma-key background, no shadow, no ground, no other objects. The reference image is the brand name: print exactly this brand name, spelled identically letter for letter, large and clear on the front of the pack, as the only text on it.`;
}
function propPrompt(prop, key) {
  return `${prop.look}, macro product photography, vivid colour, sharp focus, one single object fully in frame and centered, isolated on a plain flat pure ${key.name} (${key.hex}) chroma-key background, no shadow, no ground, no text, no letters`;
}

let canvasLib = null;
const cv = () => canvasLib || (canvasLib = require('@napi-rs/canvas'));
/** The brand name drawn with a real font: the image AI COPIES this onto the pack (image models cannot spell a brand from scratch). */
function wordmarkCard(name) {
  try {
    const { createCanvas, GlobalFonts } = cv();
    const font = path.join(__dirname, 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
    if (fs.existsSync(font) && !GlobalFonts.has('WordmarkFont')) GlobalFonts.registerFromPath(font, 'WordmarkFont');
    const W = 900, H = 360, c = createCanvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    let px = 190; g.font = px + 'px WordmarkFont, Arial Black, sans-serif';
    while (g.measureText(name).width > W * 0.86 && px > 40) { px -= 6; g.font = px + 'px WordmarkFont, Arial Black, sans-serif'; }
    g.fillStyle = '#0a0a0a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, W / 2, H / 2 + px * 0.04);
    return c.toBuffer('image/png');
  } catch (e) { console.warn('[wordmark] could not draw the brand card:', e.message); return null; }
}

/**
 * Cut an object out of a plain key-colour background: sample the border colour, flood-fill from every border pixel, also drop key-coloured pixels the flood could not reach
 * (holes), remove the coloured halo around the outline, soften the rim, crop to the object. Returns { buf (PNG with alpha), aspect }.
 */
async function cutout(buf, tol = 72) {
  const { loadImage, createCanvas } = cv();
  const img = await loadImage(buf), W = img.width, H = img.height;
  const c = createCanvas(W, H), g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const id = g.getImageData(0, 0, W, H), d = id.data;
  const bs = []; for (let x = 0; x < W; x += 3) bs.push(x, (H - 1) * W + x); for (let y = 0; y < H; y += 3) bs.push(y * W, y * W + W - 1);
  const med = (ch) => { const v = bs.map((p) => d[p * 4 + ch]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [med(0), med(1), med(2)];
  const near = (p, t) => { const dr = d[p * 4] - bg[0], dg = d[p * 4 + 1] - bg[1], db = d[p * 4 + 2] - bg[2]; return Math.sqrt(dr * dr + dg * dg + db * db) < t; };
  const gone = new Uint8Array(W * H), stack = [];
  const push = (p) => { if (!gone[p] && near(p, tol)) { gone[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) { const p = stack.pop(), x = p % W, y = (p / W) | 0; if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W); }
  const strict = tol * 0.6; for (let p = 0; p < W * H; p++) if (!gone[p] && near(p, strict)) gone[p] = 1;
  // the halo the image AI paints around an object carries the key colour: within a few pixels of the removed area, key-leaning pixels go too
  const distMap = new Uint8Array(W * H).fill(255); let q = [];
  for (let p = 0; p < W * H; p++) if (gone[p]) { distMap[p] = 0; q.push(p); }
  for (let step = 1; step <= 5 && q.length; step++) { const nq = []; for (const p of q) { const x = p % W, y = (p / W) | 0; for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (n >= 0 && distMap[n] === 255) { distMap[n] = step; nq.push(n); } } q = nq; }
  for (let p = 0; p < W * H; p++) if (!gone[p] && distMap[p] <= 5 && near(p, tol * 1.25)) gone[p] = 1;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; let a = gone[p] ? 0 : 255;
    if (!gone[p]) { const rim = (x > 0 && gone[p - 1]) || (x < W - 1 && gone[p + 1]) || (y > 0 && gone[p - W]) || (y < H - 1 && gone[p + W]); if (rim) a = 130; }
    d[p * 4 + 3] = a; if (a) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX <= minX || maxY <= minY || (maxX - minX) * (maxY - minY) < W * H * 0.02) throw new Error('cutout found no object');
  g.putImageData(id, 0, 0);
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04), cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad), cw = Math.min(W - cx, maxX - minX + 1 + 2 * pad), ch = Math.min(H - cy, maxY - minY + 1 + 2 * pad);
  const out = createCanvas(cw, ch), og = out.getContext('2d'); og.drawImage(c, cx, cy, cw, ch, 0, 0, cw, ch);
  return { buf: out.toBuffer('image/png'), aspect: cw / ch };
}

// ------------------------------------------------------------------ sound: a bed and punchy hits placed on the beats; no voice
async function promoAudio(promo, dir) {
  const { synth } = require('./siteAudio');
  const adMix = require('./adMix'), lib = adMix.library(), D = promo.duration, end = Math.max(2, D - 1.6);
  const music = { style: promo.sound.music || 'pulse', key: 'A', bpm: 124 };
  const hero = promo.layers.find((l) => l.kind === 'sprite' && l.src === 'hero');
  let cues = (promo.sound.cues || []).filter((c) => c.t >= 0 && c.t < D);
  if (cues.length < 3) {                                      // the AI wrote (almost) no cues: derive them from the motion it wrote
    cues = promo.beats.slice(1).map((b) => ({ t: Math.max(0, b.t0 - 0.35), kind: 'whoosh' }));
    if (hero) cues.push({ t: hero.keys && hero.keys.length ? hero.keys[0].t + 0.5 : hero.t0, kind: 'impact' });
    promo.layers.filter((l) => l.kind === 'text' && l.in && (l.in.kind === 'slam' || l.in.kind === 'pop')).slice(0, 5).forEach((l) => cues.push({ t: l.t0, kind: 'tick' }));
    cues.push({ t: D - 1.4, kind: 'riser' }, { t: D - 0.9, kind: 'sparkle' });
  }
  if (!lib.list.length) {
    const cs = cues.map((c) => ({ t: c.t, kind: c.kind === 'sparkle' ? 'tick' : c.kind, dur: c.kind === 'whoosh' ? 0.6 : c.kind === 'riser' ? 1.0 : undefined, gain: c.kind === 'impact' ? 0.5 : c.kind === 'whoosh' ? 0.12 : 0.5 }));
    fs.writeFileSync(path.join(dir, 'audio.wav'), synth({ duration: D + 1, cues: cs, music }));
    return 'audio.wav';
  }
  const G = adMix.GAIN, ev = [], at = (x) => path.join(adMix.LIB, x.file), used = {};
  cues.slice(0, 24).forEach((c, i) => { const l = lib.of(c.kind); if (!l.length) return; const n = used[c.kind] = (used[c.kind] || 0) + 1, f = l[(promo.zones.length * 7 + n * 3 + i) % l.length]; ev.push({ file: at(f), at: Math.max(0, c.kind === 'riser' ? c.t - f.seconds * 0.5 : c.t), gain: (G[c.kind] || 0.3) * (c.kind === 'whoosh' ? 1.6 : 1) }); });
  const bed = adMix.tmpFile('.wav'), out = path.join(dir, 'audio.wav');
  fs.writeFileSync(bed, synth({ duration: D + 1, cues: [], music }));
  try { await adMix.mix({ bedWav: bed, events: ev, outWav: out, end }); } finally { fs.rmSync(bed, { force: true }); }
  return 'audio.wav';
}


/**
 * Print the brand on the pack: the image AI cannot be trusted to spell a brand (it wrote "CITUS BURST" and, another time, nothing), so the pack is painted with a blank label
 * and the brand is drawn onto it with a real font, wrapped around the pack like print on a cylinder (squeezed toward the edges), in an ink that reads on the label colour.
 */
async function stampBrand(buf, brand) {
  try {
    const { loadImage, createCanvas, GlobalFonts } = cv();
    const font = path.join(__dirname, 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
    if (fs.existsSync(font) && !GlobalFonts.has('WordmarkFont')) GlobalFonts.registerFromPath(font, 'WordmarkFont');
    const im = await loadImage(buf), w = im.width, h = im.height, c = createCanvas(w, h), g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    // a smooth label band over the middle of the pack: it hides any text the image AI wrote there (it likes to add its own name), in the pack's own colour, shaded round the cylinder
    { const y0 = Math.round(h * 0.27), bh = Math.round(h * 0.46), all = g.getImageData(0, y0, w, bh).data; let r = 0, gg = 0, b = 0, n = 0, minx = w, maxx = 0;
      for (let y = 0; y < bh; y += 3) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (all[i + 3] > 200) { if (x < minx) minx = x; if (x > maxx) maxx = x; } }
      const span = maxx - minx; if (span > 20) {
        for (let y = 0; y < bh; y += 2) for (const fx of [0.2, 0.26, 0.74, 0.8]) { const x = Math.round(minx + span * fx), i = (y * w + x) * 4; if (all[i + 3] > 200) { r += all[i]; gg += all[i + 1]; b += all[i + 2]; n++; } }
        if (n) {
          r /= n; gg /= n; b /= n; const P = createCanvas(w, bh), p = P.getContext('2d'), gr = p.createLinearGradient(minx, 0, maxx, 0), sh = (k) => 'rgb(' + [r, gg, b].map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(',') + ')';
          gr.addColorStop(0, sh(0.66)); gr.addColorStop(0.2, sh(0.92)); gr.addColorStop(0.5, sh(1.08)); gr.addColorStop(0.8, sh(0.92)); gr.addColorStop(1, sh(0.64));
          p.fillStyle = gr; p.fillRect(0, 0, w, bh);
          p.globalCompositeOperation = 'destination-in'; const vg = p.createLinearGradient(0, 0, 0, bh); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.07, 'rgba(0,0,0,1)'); vg.addColorStop(0.93, 'rgba(0,0,0,1)'); vg.addColorStop(1, 'rgba(0,0,0,0)'); p.fillStyle = vg; p.fillRect(0, 0, w, bh);
          g.save(); g.globalCompositeOperation = 'source-atop'; g.drawImage(P, 0, y0); g.restore();
        }
      } }
    // ink colour from what is under the label (opaque pixels in the middle band)
    const d = g.getImageData(Math.round(w * 0.3), Math.round(h * 0.4), Math.round(w * 0.4), Math.round(h * 0.2)).data; let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return buf;
    const lumv = (0.299 * r + 0.587 * gg + 0.114 * b) / n / 255, ink = lumv > 0.55 ? '#0c0c10' : '#ffffff';
    const words = String(brand || '').toUpperCase().split(/\s+/).filter(Boolean), lines = words.length > 1 && brand.length > 9 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [words.join(' ')];
    const T = createCanvas(Math.round(w * 0.9), Math.round(h * 0.3)), t = T.getContext('2d'); let px = Math.round(T.height * 0.5);
    const fit = () => { t.font = px + 'px WordmarkFont, Arial Black, sans-serif'; return Math.max(...lines.map((s) => t.measureText(s).width)); };
    while (fit() > T.width * 0.94 && px > 12) px -= 4;
    t.fillStyle = ink; t.textAlign = 'center'; t.textBaseline = 'middle';
    lines.forEach((s, i) => t.fillText(s, T.width / 2, T.height / 2 + (i - (lines.length - 1) / 2) * px * 1.05));
    // cylinder wrap: each vertical slice of the text is squeezed toward the pack's edges
    const N = 48, cx = w / 2, cy = h * 0.5, half = w * 0.36; g.save(); g.globalAlpha = 0.95;
    for (let i = 0; i < N; i++) {
      const u0 = (i / N) * 2 - 1, u1 = ((i + 1) / N) * 2 - 1, wrap = (u) => Math.sin(u * Math.PI * 0.42) / Math.sin(Math.PI * 0.42);
      const x0 = cx + wrap(u0) * half, x1 = cx + wrap(u1) * half, sx = (i / N) * T.width, sw = T.width / N;
      g.drawImage(T, sx, 0, sw, T.height, x0, cy - T.height / 2, Math.max(1, x1 - x0 + 1.5), T.height);
    }
    g.restore();
    return c.toBuffer('image/png');
  } catch (e) { console.warn('[promo] brand print skipped: ' + e.message); return buf; }
}

/** A stand-in prop (a glossy disc in the product's colour) for when the image AI refuses or fails a prop: the promo is never lost over one ingredient. */
function fallbackProp(hex) {
  const { createCanvas } = cv(), c = createCanvas(400, 400), g = c.getContext('2d'), col = rgb(fixHex(hex, '#ff7a00'));
  const gr = g.createRadialGradient(150, 140, 20, 200, 200, 190); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.35, 'rgb(' + col.join(',') + ')'); gr.addColorStop(1, 'rgb(' + col.map((v) => Math.round(v * 0.55)).join(',') + ')');
  g.fillStyle = gr; g.beginPath(); g.arc(200, 200, 185, 0, Math.PI * 2); g.fill();
  return { buf: c.toBuffer('image/png'), aspect: 1 };
}

module.exports = { stampBrand, fallbackProp, PROMO_SYSTEM, promoPrompt, revisePrompt, critique, normalizePromo, pickKey, heroPrompt, propPrompt, wordmarkCard, cutout, promoAudio, FONTS };
