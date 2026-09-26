'use strict';
/*
 * PRODUCT PROMO: a ~9 second motion-graphics spot for a PHYSICAL product (a snack, a drink, a pack of anything), in the style of the best social product promos:
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
const IN_KINDS = ['pop', 'drop', 'slideL', 'slideR', 'slideU', 'slideD', 'spin', 'zoom', 'fade', 'stretch', 'none'];
const TEXT_IN = ['slam', 'rise', 'pop', 'fade', 'slideL', 'slideR', 'drop'];
const IDLE = ['float', 'wobble', 'spin', 'pulse', 'drift', 'none'];
const SHAPES = ['circle', 'rect', 'rings', 'wave', 'rays', 'dots', 'stripes', 'burst'];
const EASES = ['linear', 'inCubic', 'outCubic', 'inOutCubic', 'outQuint', 'outExpo', 'outBack', 'outBounce', 'outElastic'];

const PROMO_SYSTEM = 'You are a motion-graphics director who designs 9-second product promo spots for social media. You reply with ONE JSON object only.';

function promoPrompt(brief) {
  return `Design a 9-second vertical (9:16) product promo for the PHYSICAL product in the brief below. It must feel like the best snack and drink launch spots on TikTok and Reels: the real product as a big hero on a vivid, saturated backdrop, ONE giant word of type, ingredients and pieces flying around it, moving rings / waves / patterns, a punchy camera, and almost no words. NEVER tell the company's story or list features like an explainer: show off the PRODUCT and how it makes people feel, in 3 or 4 tiny beats, and end on the product with the brand name.

BRIEF (the product, the brand and what to promote):
${brief}

YOU DESIGN EVERYTHING - there are no templates. You write a "motion script" from these primitives; the renderer plays exactly what you write. Coordinates x, y, cx, cy are fractions of the screen (0,0 = top-left, 1,1 = bottom-right); widths (w) and sizes are fractions of the screen WIDTH; times are seconds from 0. Layers are drawn in the order you write them (later = on top).
PRIMITIVES ("kind"):
- "sprite": a picture. src is "hero" (the product pack shot) or "prop0".."prop3" (your props). Fields: beat (0..n-1, or "all" so it stays through every beat), t0, t1, x, y, w, r (rotation degrees), in {kind, dur, delay}, out {kind, dur}, idle {kind, amp, speed}, keys [{t, x, y, s (scale), r, o (opacity), e (ease)}]. in/out kinds: ${IN_KINDS.join(', ')}. idle kinds: ${IDLE.join(', ')}. ease names: ${EASES.join(', ')}. "keys" are free keyframes (their r is EXTRA rotation added on top of the sprite's r): use them to fly the hero from one place to another between beats. The first key should equal the pose the sprite has after arriving (x, y as written, s 1, r 0); before it the sprite does its "in" arrival.
- "text": lines ["WORD","WORD"], beat, t0, t1, x, y, size (0.04 tiny .. 0.34 giant), font, color, upper, track (letter spacing), r (rotation degrees; 90 or -90 runs a giant word vertically up the side of the screen, behind the product), align, stroke {color, w}, shadow (true/false), in {kind, dur, stag} (kinds: ${TEXT_IN.join(', ')}; words arrive one by one), out {kind}, tone (true = the word is a shade lighter/darker than the backdrop: tone-on-tone, the classic giant word behind a product), alpha, front (true = draw over the product), repeat {n, dy, speed}: the same word stacked n times, the copies outlined and fading away from the middle (the "NEW NEW NEW" wall behind a product). Fonts: ${Object.entries(FONTS).map(([k, v]) => k + ' (' + v + ')').join('; ')}.
- "scatter": pieces flying around the hero. src (one prop id or a list), n (1-16), beat, t0, t1, cx, cy, spread, size [min,max], from ("burst" out of the centre, "corners" = big pieces cropped by the frame corners and edges, "edges", "top", "sides"), seed, spin, stag.
- "pattern": src repeated as a pattern. sub ("radial" rings of copies, "grid", "ring"), t0, t1, cx, cy, w, spin, rings, cols, rows, stag, alpha.
- shapes (the moving furniture of the backdrop): kind one of ${SHAPES.join(', ')}. circle {x,y,size,color}; rect {x,y,w,h,radius,color}; rings {x,y,n,gap,width,speed,color,color2} (concentric rings pulsing outward); wave {y,amp,wl,speed,color,side:"top"|"bottom"}; rays {x,y,n,speed,color}; dots {gap,dot,speed,color}; stripes {w,speed,color,r}; burst {x,y,n,color,color2,life}. All shapes take beat, t0, t1, alpha, in / out / idle / keys like sprites.
CAMERA: "cam": [{t, kind:"punch"|"shake", amp, dur}] (a punch is a quick zoom bump: use one when the hero slams in).
BACKDROP: "zones": one per beat, {c0, c1, shape:"radial"}: c0 is the vivid bright centre colour, c1 the deeper edge colour; the camera glides across the board from zone to zone between beats. Choose colours that make the product POP (usually the product's own colour family or its strong opposite), and make consecutive zones clearly different.
DESIGN RULES (a promo that breaks these looks empty and cheap):
1. RICH BEATS: every beat layers at least FIVE things: a moving backdrop shape (rings / rays / wave / stripes / dots / a pattern of the product's own pieces), ONE giant word (size 0.2-0.34; tone-on-tone with "repeat" stacked behind the product looks best, or a bold slam in a saturated colour with a shadow), the hero, big props from a "scatter" (size [0.18, 0.4], from "corners" / "burst" / "sides" so they are cropped by the frame edges), and optionally one tiny line (size 0.035-0.05). Never write the same scatter or the same shape twice: change the from, the seed, the size, the font, the motion in every beat.
2. THE HERO IS THE STAR AND IT FLIES: in every beat the product sweeps in FAST from off-screen (from a different side each beat), decelerates into its pose TILTED (r 8-25 degrees, either way), drifts slowly while it holds, then flies out off-screen as the next beat begins. You choreograph this with "hero_path": one entry per beat {beat, from, x, y, s, r, to}: "from" and "to" are where it comes in from / leaves to ("left","right","top","bottom","topleft","topright","bottomleft","bottomright", and "none" for the last beat), x, y, s, r are its resting pose (x, y 0.25-0.75, s 0.8-1.25, r tilt). The renderer flies it along that path with motion blur; do NOT write keys for the hero sprite. The other elements (props, small lines, bursts, splashes) fire when the hero LANDS; the giant words and backdrop shapes are already there.
3. Text stays clear of the product: giant words sit BEHIND it (write them before the hero) and may be overlapped; a tiny line goes in the free space above or below the hero. AT MOST 14 words in total, only words that come from the brief or describe the taste, feel or look. 3 or 4 beats of 2-3 s that tile 0..duration with no gaps.
4. BACKDROP: it barely moves and stays in ONE colour family for the whole promo (the product's own colour or its strong opposite, saturated): the hero is what moves. Zones: give the colours of the first zone; later zones only shift slightly.
5. The last beat: the product plus the BRAND NAME big (0.14-0.2) placed low with the hero moved up and smaller, plus at most 3 words of call to action. No prices, no claims you cannot see. Never tell a company story.

A COMPLETE EXAMPLE for a different product (strawberry milk in a plastic bottle). Show this level of richness and layering, but design YOUR promo for the brief above with its own words (never reuse the example's words, and choose your own hero_path: different sides, poses and tilts than the example's), colours, props, fonts and choreography:
{"brand":"BERRY MOO","product":{"name":"Berry Moo strawberry milk","kind":"plastic bottle of strawberry milk","look":"a slim glossy pink plastic bottle with a white cap and a big strawberry illustration","colors":["#ff6fa5","#ffffff"]},"props":[{"name":"strawberry","look":"a fresh whole strawberry with a green leaf"},{"name":"splash","look":"a creamy pink milk splash frozen mid-air"},{"name":"heart","look":"a glossy pink candy heart"}],"duration":9,"zones":[{"c0":"#ff8fb8","c1":"#c2185b"},{"c0":"#ff7aa8","c1":"#b3134f"},{"c0":"#ff9cc2","c1":"#a01248"},{"c0":"#ff6f9f","c1":"#8a0f3f"}],"beats":[{"t0":0,"t1":2.3,"zone":0},{"t0":2.3,"t1":4.6,"zone":1},{"t0":4.6,"t1":6.9,"zone":2},{"t0":6.9,"t1":9,"zone":3}],"layers":[
{"kind":"rings","beat":0,"t0":0,"t1":2.7,"x":0.5,"y":0.55,"color":"#ffffff","color2":"#ffb3d1","n":8,"gap":0.14,"width":0.05,"speed":0.5,"alpha":0.35},
{"kind":"text","beat":0,"t0":0.1,"t1":2.7,"x":0.5,"y":0.5,"font":"anton","size":0.3,"color":"#ffffff","tone":true,"lines":["BERRY"],"repeat":{"n":7,"dy":0.85,"speed":0.05},"in":{"kind":"slam","dur":0.35}},
{"kind":"sprite","src":"hero","beat":"all","w":0.5,"idle":{"kind":"drift","amp":0.012,"speed":1}},
{"kind":"scatter","src":["prop0","prop1"],"beat":0,"n":8,"t0":0.5,"t1":2.7,"cx":0.5,"cy":0.55,"spread":0.5,"size":[0.16,0.3],"from":"burst","seed":7,"spin":320},
{"kind":"text","beat":0,"t0":1.2,"t1":2.6,"x":0.5,"y":0.1,"font":"poppins","size":0.045,"color":"#ffffff","track":0.16,"lines":["new"],"in":{"kind":"rise","dur":0.4}},
{"kind":"wave","beat":1,"t0":2.3,"t1":4.9,"y":0.8,"color":"#ff9d00","amp":0.03,"wl":0.8,"speed":0.4,"side":"bottom"},
{"kind":"stripes","beat":1,"t0":2.3,"t1":4.9,"w":0.1,"speed":0.08,"color":"#ffffff","alpha":0.12,"r":20},
{"kind":"text","beat":1,"t0":2.6,"t1":4.6,"x":0.32,"y":0.28,"font":"bowlby","size":0.24,"color":"#ffffff","lines":["SO","CREAMY"],"shadow":true,"r":-4,"in":{"kind":"slam","dur":0.35,"stag":0.14}},
{"kind":"scatter","src":["prop0","prop2"],"beat":1,"n":7,"t0":2.7,"t1":4.9,"cx":0.5,"cy":0.55,"spread":0.5,"size":[0.2,0.38],"from":"corners","seed":31,"spin":200},
{"kind":"pattern","src":"prop2","sub":"radial","beat":2,"t0":4.6,"t1":7.1,"cx":0.34,"cy":0.5,"w":0.13,"spin":40,"rings":3,"alpha":0.55},
{"kind":"rays","beat":2,"t0":4.6,"t1":7.1,"x":0.34,"y":0.5,"n":16,"speed":8,"color":"#ffffff","alpha":0.14},
{"kind":"text","beat":2,"t0":4.8,"t1":6.9,"x":0.62,"y":0.82,"font":"archivo","size":0.2,"color":"#ffe14a","lines":["PINK","PERFECT"],"stroke":{"color":"#0b3d91","w":0.05},"in":{"kind":"drop","dur":0.5,"stag":0.15}},
{"kind":"burst","beat":3,"t0":6.9,"t1":8.2,"x":0.5,"y":0.42,"color":"#ffffff","color2":"#ffb3d1","n":26,"seed":5,"life":1},
{"kind":"text","beat":3,"t0":7.1,"t1":9,"x":0.5,"y":0.8,"font":"anton","size":0.18,"color":"#ffffff","lines":["BERRY MOO"],"shadow":true,"front":true,"in":{"kind":"slam","dur":0.4,"stag":0.15}},
{"kind":"text","beat":3,"t0":7.9,"t1":9,"x":0.5,"y":0.92,"font":"poppins","size":0.04,"color":"#ffffff","track":0.14,"lines":["grab one"],"in":{"kind":"fade","dur":0.5}}],
"hero_path":[{"beat":0,"from":"bottomleft","x":0.5,"y":0.56,"s":1,"r":-12,"to":"right"},{"beat":1,"from":"left","x":0.66,"y":0.55,"s":1.1,"r":16,"to":"top"},{"beat":2,"from":"bottom","x":0.34,"y":0.5,"s":1.05,"r":-14,"to":"left"},{"beat":3,"from":"topright","x":0.5,"y":0.42,"s":0.9,"r":6,"to":"none"}],"cam":[{"t":7.4,"kind":"shake","amp":9,"dur":0.35}],"sound":{"music":"pulse"}}

Return ONE JSON object with these keys:
"brand" (the brand name exactly as in the brief, max 24 characters), "product": {"name", "kind" (what it physically is: "canned soft drink", "bag of potato chips", "chocolate bar"...), "look" (how the pack looks for an image AI: shape, materials, the two or three colours, label art WITHOUT any text, max 30 words), "colors" ["#rrggbb","#rrggbb"] (its two main colours)}, "props": 2 to 4 objects {"name", "look" (one thing that belongs to the product - an ingredient, a slice, a piece, a splash, a crumb - described for an image AI, no text, max 18 words)}, "duration" (8 to 10), "zones" (one per beat), "beats": [{"t0","t1","zone"}], "layers" (the motion script), "hero_path" (one per beat, see rule 2), "cam", "sound": {"music": "pulse" | "warm pad" | "tense" | "dark drone"}.
Output the JSON object only.`;
}

// ------------------------------------------------------------------ validation: the AI's script is repaired, never trusted
const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim());
const fixHex = (v, d) => (isHex(v) ? '#' + v.trim().replace('#', '').toLowerCase() : d);
const num = (v, d, lo, hi) => { v = +v; if (!Number.isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); };
const rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const hueShift = (c, deg) => {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360; const l = (mx + mn) / 2, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0, s2 = Math.max(0.75, sat), a = s2 * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const cleanStr = (v, n) => String(v == null ? '' : v).replace(/[<>"\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

function motionIO(o, kinds, dDur) {
  if (!o || typeof o !== 'object') return undefined;
  const k = oneOf(o.kind, kinds, null); if (!k) return undefined;
  return { kind: k, dur: num(o.dur, dDur, 0.1, 1.6), ...(o.delay !== undefined ? { delay: num(o.delay, 0, 0, 6) } : {}), ...(o.stag !== undefined ? { stag: num(o.stag, 0.09, 0, 0.4) } : {}), ...(o.turns !== undefined ? { turns: num(o.turns, 1, 0.25, 4) } : {}), ...(o.ease ? { ease: oneOf(o.ease, EASES, undefined) } : {}) };
}

/**
 * The richness pass: a promo that came back thin is filled out with the same kinds of things the designer would have used, drawn in that promo's own colours
 * (a moving backdrop shape in every beat, a hero that travels and tilts, scatter that is never a copy of the last beat's), then the layers are put in a sane draw order:
 * backdrop shapes, giant words, patterns, the hero, the other pictures, the scattered pieces, and small lines on top.
 */
/**
 * The hero's flight: for every beat it sweeps in FAST from off-screen (decelerating into its pose, tilted), drifts while it holds, then flies out as the next beat starts.
 * The AI chooses the sides and the resting poses ("hero_path"); this turns them into keyframes. Returns the moments the hero lands (other elements fire then).
 */
function heroChoreo(hero, beats, D, path, rand) {
  const nb = beats.length, DIRS = ['left', 'right', 'top', 'bottom', 'topleft', 'topright', 'bottomleft', 'bottomright'];
  const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top', topleft: 'bottomright', topright: 'bottomleft', bottomleft: 'topright', bottomright: 'topleft' };
  const off = (dir, p) => {
    const jy = Math.max(0.15, Math.min(0.85, p.y + (rand() - 0.5) * 0.5)), jx = Math.max(0.15, Math.min(0.85, p.x + (rand() - 0.5) * 0.5));
    return dir === 'left' ? [-0.62, jy] : dir === 'right' ? [1.62, jy] : dir === 'top' ? [jx, -0.5] : dir === 'bottom' ? [jx, 1.5] : dir === 'topleft' ? [-0.6, -0.45] : dir === 'topright' ? [1.6, -0.45] : dir === 'bottomleft' ? [-0.6, 1.45] : [1.6, 1.45];
  };
  const start = Math.floor(rand() * DIRS.length), sign = rand() < 0.5 ? 1 : -1;
  const defX = [0.5, 0.68, 0.32, 0.5], defY = [0.56, 0.5, 0.55, 0.42], defS = [1, 1.1, 1.05, 0.9], defR = [-12, 15, -13, 6];
  const poses = [];
  for (let b = 0; b < nb; b++) {
    const p = path[b] || {}, last = b === nb - 1;
    poses.push({ from: p.from || DIRS[(start + b * 3) % DIRS.length], x: p.x !== undefined ? p.x : (defX[b] !== undefined ? defX[b] : 0.5), y: p.y !== undefined ? p.y : (defY[b] !== undefined ? defY[b] : 0.5), s: p.s !== undefined ? p.s : (defS[b] || 1), r: p.r !== undefined ? p.r : (defR[b] || 0) * sign, to: last ? 'none' : p.to || undefined });
  }
  poses.forEach((p, b) => { if (b < nb - 1 && (!p.to || p.to === 'none')) p.to = opposite[poses[b + 1].from]; });
  const ks = [], arrive = [];
  poses.forEach((p, b) => {
    const B = beats[b].t0, tStart = b === 0 ? 0.1 : B - 0.02, tArr = b === 0 ? 1.1 : B + 0.85, [sx, sy] = off(p.from, p), spin = (b % 2 ? -1 : 1) * 55, dd = b % 2 ? -1 : 1;
    ks.push({ t: +tStart.toFixed(2), x: +sx.toFixed(3), y: +sy.toFixed(3), s: +(p.s * 1.15).toFixed(3), r: +(p.r + spin).toFixed(1) });
    ks.push({ t: +tArr.toFixed(2), x: p.x, y: p.y, s: p.s, r: p.r, e: 'outCubic' }); arrive.push(tArr);
    const tOut = b < nb - 1 ? beats[b + 1].t0 - 0.4 : D;
    if (tOut > tArr + 0.35) ks.push({ t: +tOut.toFixed(2), x: +(p.x + dd * 0.06).toFixed(3), y: +(p.y - 0.03).toFixed(3), s: +(p.s * 1.07).toFixed(3), r: +(p.r + dd * 11).toFixed(1), e: 'inOutCubic' });
    if (b < nb - 1 && p.to && p.to !== 'none') { const [ex, ey] = off(p.to, p); ks.push({ t: +(beats[b + 1].t0 - 0.02).toFixed(2), x: +ex.toFixed(3), y: +ey.toFixed(3), s: +(p.s * 1.1).toFixed(3), r: +(p.r + dd * 45).toFixed(1), e: 'inCubic' }); }
  });
  hero.keys = ks.map((k, i) => [k, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map((x) => x[0]);
  hero.r = 0; hero.t0 = 0.1; hero.t1 = D; hero.beat = 'all'; delete hero.in; delete hero.out; hero.x = poses[0].x; hero.y = poses[0].y;
  hero.idle = { kind: 'drift', amp: 0.012, speed: 1 };
  return arrive;
}

function richen(layers, beats, zones, D, rand, heroPath, camOut) {
  const nb = beats.length, inBeat = (l, b) => l.beat === b || (l.beat === undefined && l.t0 >= beats[b].t0 - 0.01 && l.t0 < beats[b].t1) || (l.beat === 'all');
  // 1. a real moving shape or product pattern behind every beat
  for (let b = 0; b < nb; b++) {
    const has = layers.some((l) => l.beat !== 'all' && inBeat(l, b) && ((SHAPES.includes(l.kind) && l.kind !== 'burst' && (l.alpha === undefined || l.alpha >= 0.15)) || l.kind === 'pattern'));
    if (has) continue;
    const z = zones[b], c0 = rgb(z.c0), pale = toHex(mix(c0, [255, 255, 255], 0.6)), soft = toHex(mix(c0, [255, 255, 255], 0.3));
    const pool = ['rings', 'rays', 'wave', 'stripes', 'dots'].filter((k) => !layers.some((l) => l.kind === k && l.beat === b - 1));
    const k = pool[Math.floor(rand() * pool.length)], o = { kind: k, beat: b, t0: beats[b].t0, t1: +(beats[b].t1 + 0.35).toFixed(2), x: 0.5, y: 0.55, color: pale, color2: soft, alpha: 0.32, r: 0 };
    if (k === 'rings') Object.assign(o, { n: 8, gap: 0.14, width: 0.05, speed: 0.5 });
    else if (k === 'rays') Object.assign(o, { n: 16, speed: 8, alpha: 0.16 });
    else if (k === 'wave') Object.assign(o, { y: 0.82, amp: 0.03, wl: 0.8, speed: 0.4, side: 'bottom', alpha: 0.9, color: toHex(mix(rgb(z.c1), [255, 255, 255], 0.08)) });
    else if (k === 'stripes') Object.assign(o, { w: 0.1, speed: 0.08, alpha: 0.12, r: 20 });
    else Object.assign(o, { gap: 0.08, dot: 0.014, speed: 0.03, alpha: 0.28 });
    layers.push(o);
  }
  // 2. scatter must differ from beat to beat (same seed, same origin = a copy-paste)
  const seen = new Set(), froms = ['burst', 'corners', 'sides', 'edges', 'top'];
  layers.filter((l) => l.kind === 'scatter').forEach((l, i) => { let key = l.from + ':' + l.seed; if (seen.has(key) || seen.has(l.from + ':' + l.src.join())) { l.from = froms[(froms.indexOf(l.from) + 1 + i) % froms.length]; l.seed = (l.seed * 7 + 13 * (i + 1)) % 999 + 1; } seen.add(l.from + ':' + l.seed); seen.add(l.from + ':' + l.src.join()); });
  // 2b. every beat has big pieces flying around the hero (props are the ingredients: they are what makes a beat feel alive)
  const propIds = layers.filter((l) => l.kind === 'scatter').flatMap((l) => l.src), allProps = [...new Set(propIds)];
  const srcAll = allProps.length ? allProps : ['prop0', 'prop1'];
  for (let b = 0; b < nb; b++) {
    if (layers.some((l) => l.kind === 'scatter' && l.beat === b)) continue;
    const from = b === nb - 1 ? 'corners' : froms[(b * 2 + Math.floor(rand() * 2)) % 3];
    layers.push({ kind: 'scatter', beat: b, t0: +(beats[b].t0 + 0.25).toFixed(2), t1: +(beats[b].t1 + 0.35).toFixed(2), src: srcAll, n: from === 'corners' ? 6 : 8, cx: 0.5, cy: 0.55, spread: 0.5, size: [0.2, 0.38], from, seed: 1 + Math.floor(rand() * 900), spin: 240, stag: 0.35 });
  }
  // 3. the hero FLIES: sweeps in fast from off-screen, lands tilted, drifts, flies out; everything else fires when it lands
  const hero = layers.find((l) => l.kind === 'sprite' && l.src === 'hero');
  if (hero) {
    const arrive = heroChoreo(hero, beats, D, heroPath || [], rand);
    layers.forEach((l) => {
      if (l === hero || typeof l.beat !== 'number') return;
      const fire = l.kind === 'scatter' || l.kind === 'burst' || l.kind === 'sprite' || (l.kind === 'text' && !l.tone && !l.repeat);
      const ta = arrive[l.beat]; if (!fire || ta === undefined) return;
      if (l.t0 < ta - 0.05) { l.t0 = +(ta - 0.05).toFixed(2); if (l.t1 < l.t0 + 0.9) l.t1 = +Math.min(D, l.t0 + 0.9).toFixed(2); }
    });
    const shakes = camOut.filter((c) => c.kind === 'shake'); camOut.length = 0; arrive.forEach((t) => camOut.push({ t: +Math.min(D - 0.3, t - 0.05).toFixed(2), kind: 'punch', amp: 0.05, dur: 0.3 })); shakes.forEach((c) => camOut.push(c));
  }
  // 3b. the closing brand line is drawn over everything (props never cover the name)
  layers.filter((l) => l.kind === 'text' && l.t1 >= D - 0.3 && l.t0 >= beats[nb - 1].t0 - 0.01).sort((a, b) => b.size - a.size).slice(0, 1).forEach((l) => { l.front = true; });
  // 4. draw order
  const rank = (l) => (SHAPES.includes(l.kind) && l.kind !== 'burst' ? 0 : l.kind === 'pattern' ? 1 : l.kind === 'text' && !l.front && (l.size >= 0.15 || l.repeat) ? 2 : l === hero ? 4 : l.kind === 'sprite' ? 5 : l.kind === 'scatter' || l.kind === 'burst' ? 6 : 7);
  const sorted = layers.map((l, i) => [rank(l), i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  layers.length = 0; sorted.forEach((l) => layers.push(l));
}

/** Turn the AI's raw script into a safe, playable promo (throws only if there is nothing to play at all). */
function normalizePromo(raw, ctx = {}) {
  const S = raw && typeof raw === 'object' ? raw : {};
  const brand = cleanStr(S.brand || ctx.brand || 'Brand', 24).toUpperCase() || 'BRAND';
  const D = num(S.duration, 9, 7.5, 10.5);
  const P = S.product && typeof S.product === 'object' ? S.product : {};
  const colors = (Array.isArray(P.colors) ? P.colors : []).filter(isHex).map((c) => fixHex(c)).slice(0, 2);
  const product = { name: cleanStr(P.name, 60) || brand, kind: cleanStr(P.kind, 50) || 'product pack', look: cleanStr(P.look, 260) || 'a premium retail pack', colors: colors.length ? colors : ['#ff5c1a', '#ffd23f'] };
  const props = (Array.isArray(S.props) ? S.props : []).slice(0, 4).map((p) => ({ name: cleanStr(p && p.name, 40), look: cleanStr(p && p.look, 200) })).filter((p) => p.look);
  while (props.length < 2) props.push({ name: 'splash', look: 'a fresh splash of the product, glossy droplets' });
  // the assets the layers may refer to
  const assets = [{ id: 'hero' }, ...props.map((_, i) => ({ id: 'prop' + i }))], okSrc = new Set(assets.map((a) => a.id));

  // beats: 3 or 4 contiguous windows covering 0..D
  let beatsIn = (Array.isArray(S.beats) ? S.beats : []).filter((b) => b && typeof b === 'object').slice(0, 4);
  if (beatsIn.length < 3) beatsIn = [{}, {}, {}];
  const nb = beatsIn.length, cuts = [0];
  const raws = beatsIn.map((b, i) => (Number.isFinite(+b.t1) ? +b.t1 : (D * (i + 1)) / nb));
  for (let i = 0; i < nb - 1; i++) cuts.push(Math.max(cuts[i] + 1.6, Math.min(D - 1.6 * (nb - 1 - i), raws[i])));
  cuts.push(D);
  const beats = beatsIn.map((b, i) => ({ t0: +cuts[i].toFixed(2), t1: +cuts[i + 1].toFixed(2), zone: i }));

  // zones: vivid, distinct, different from the last; positions on the board are set here (a seeded random walk, like GraphMotion)
  const zin = Array.isArray(S.zones) ? S.zones : [];
  const pc = colors.length ? rgb(fixHex(colors[0])) : [255, 92, 26];
  const seedH = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  let rs = seedH(brand + product.name); const rand = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
  const zones = []; let px = 0, py = 0;
  for (let i = 0; i < nb; i++) {
    const z = zin[i] && typeof zin[i] === 'object' ? zin[i] : {};
    let c0 = rgb(fixHex(z.c0, toHex(mix(pc, [255, 255, 255], 0.25 + 0.1 * i)))), c1 = rgb(fixHex(z.c1, toHex(mix(pc, [10, 10, 30], 0.5))));
    if (Math.max(...c0) - Math.min(...c0) < 55) c0 = mix(c0, pc, 0.6);                        // washed-out greys are not a backdrop: keep the centre vivid
    if (lum(c1) > lum(c0)) [c0, c1] = [c1, c0];                                               // bright centre, deeper edge
    if (i > 0) { const b0 = rgb(zones[0].c0), b1 = rgb(zones[0].c1), off = [0, 22, -18, 10][i] || 0, k = 0.1 * i * (i % 2 ? 1 : -1); c0 = hueShift(b0, off); c1 = hueShift(b1, off); c0 = k > 0 ? mix(c0, [255, 255, 255], k) : mix(c0, [0, 0, 0], -k); }   // one colour family for the whole promo: later zones only shift a little
    if (i > 0) { const a = rand() * Math.PI * 2, d = 350 + rand() * 350; px = Math.round(px + Math.cos(a) * d); py = Math.round(py + Math.sin(a) * d); }
    zones.push({ c0: toHex(c0), c1: toHex(c1), shape: 'radial', x: px, y: py });
  }

  // layers
  const fontIds = Object.keys(FONTS), layers = []; let words = 0;
  const beatIdx = (v) => (v === 'all' ? 'all' : Number.isInteger(+v) && +v >= 0 && +v < nb ? +v : undefined);
  const timing = (L, o) => { let t0 = num(L.t0, undefined, 0, D), t1 = num(L.t1, undefined, 0, D); const b = beatIdx(L.beat); if (t0 === undefined) t0 = b !== undefined && b !== 'all' ? beats[b].t0 : 0; if (t1 === undefined || t1 <= t0 + 0.25) t1 = b !== undefined && b !== 'all' ? beats[b].t1 + 0.35 : D; o.t0 = +Math.min(t0, D - 0.4).toFixed(2); o.t1 = +Math.min(D, t1).toFixed(2); if (b !== undefined) o.beat = b; return o; };
  (Array.isArray(S.layers) ? S.layers : []).slice(0, 30).forEach((L) => {
    if (!L || typeof L !== 'object') return;
    let kind = String(L.kind || '');
    if (kind === 'shape' && SHAPES.includes(L.type)) kind = L.type;                        // "shape" + type is the same thing as the kind itself
    if (kind === 'sprite') {
      const src = okSrc.has(L.src) ? L.src : null; if (!src) return;
      const o = timing(L, { kind, src, x: num(L.x, 0.5, -0.2, 1.2), y: num(L.y, 0.5, -0.2, 1.2), w: num(L.w, src === 'hero' ? 0.5 : 0.22, src === 'hero' ? 0.4 : 0.05, src === 'hero' ? 0.85 : 0.6), r: num(L.r, 0, -360, 360) });
      const i = motionIO(L.in, IN_KINDS, 0.5), out = motionIO(L.out, IN_KINDS, 0.35), idle = L.idle && oneOf(L.idle.kind, IDLE, null) ? { kind: L.idle.kind, amp: num(L.idle.amp, 0.02, 0, 0.12), speed: num(L.idle.speed, 1, 0.2, 3) } : undefined;
      if (i) o.in = i; if (out) o.out = out; if (idle) o.idle = idle;
      if (Array.isArray(L.keys)) { const ks = L.keys.filter((k) => k && Number.isFinite(+k.t)).slice(0, 8).map((k) => ({ t: num(k.t, 0, 0, D), ...(k.x !== undefined ? { x: num(k.x, 0.5, -0.5, 1.5) } : {}), ...(k.y !== undefined ? { y: num(k.y, 0.5, -0.5, 1.5) } : {}), ...(k.s !== undefined ? { s: num(k.s, 1, 0.2, 3) } : {}), ...(k.r !== undefined ? { r: num(k.r, 0, -720, 720) } : {}), ...(k.o !== undefined ? { o: num(k.o, 1, 0, 1) } : {}), ...(k.e ? { e: oneOf(k.e, EASES, 'inOutCubic') } : {}) })).sort((a, b) => a.t - b.t); if (ks.length >= 2) o.keys = ks; }
      layers.push(o);
    } else if (kind === 'text') {
      let lines = (Array.isArray(L.lines) ? L.lines : [L.text]).map((s) => cleanStr(s, 30)).filter(Boolean).slice(0, 3); if (!lines.length) return;
      const wc = lines.join(' ').split(' ').filter(Boolean).length; if (words + wc > 16) return; words += wc;      // the promo stays nearly wordless
      const o = timing(L, { kind, lines, x: num(L.x, 0.5, 0.05, 0.95), y: num(L.y, 0.5, 0.05, 0.95), size: num(L.size, 0.1, 0.03, 0.36), font: oneOf(L.font, fontIds, 'anton'), color: fixHex(L.color, '#ffffff'), upper: L.upper !== false, track: num(L.track, 0, -0.05, 0.4), r: num(L.r, 0, -95, 95), align: oneOf(L.align, ['center', 'left', 'right'], 'center') });
      const i = L.in && oneOf(L.in.kind, TEXT_IN, null) ? { kind: L.in.kind, dur: num(L.in.dur, 0.45, 0.15, 1.2), stag: num(L.in.stag, 0.09, 0, 0.4) } : { kind: 'rise', dur: 0.45, stag: 0.09 }; o.in = i;
      const out = motionIO(L.out, IN_KINDS, 0.3); if (out) o.out = out;
      if (L.stroke && typeof L.stroke === 'object') o.stroke = { color: fixHex(L.stroke.color, '#000000'), w: num(L.stroke.w, 0.03, 0.01, 0.12) };
      if (L.shadow) o.shadow = true;
      if (L.tone) o.tone = true; if (L.front) o.front = true; if (L.alpha !== undefined) o.alpha = num(L.alpha, 1, 0.15, 1);
      if (L.repeat && typeof L.repeat === 'object') o.repeat = { n: num(L.repeat.n, 5, 2, 11) | 0, dy: num(L.repeat.dy, 0.92, 0.6, 1.4), speed: num(L.repeat.speed, 0.04, 0, 0.2) };
      layers.push(o);
    } else if (kind === 'scatter') {
      const srcList = (Array.isArray(L.src) ? L.src : [L.src]).filter((s) => okSrc.has(s) && s !== 'hero'); if (!srcList.length) return;
      let sz = Array.isArray(L.size) && L.size.length === 2 ? [num(L.size[0], 0.18, 0.04, 0.5), num(L.size[1], 0.32, 0.05, 0.6)] : [0.18, 0.32];
      sz = [Math.max(0.15, sz[0]), Math.max(0.28, sz[1], sz[0] + 0.08)];
      layers.push(timing(L, { kind, src: srcList, n: Math.max(5, num(L.n, 8, 1, 16) | 0), cx: num(L.cx, 0.5, 0, 1), cy: num(L.cy, 0.5, 0, 1), spread: num(L.spread, 0.42, 0.15, 0.9), size: sz, from: oneOf(L.from, ['burst', 'corners', 'edges', 'top', 'sides'], 'burst'), seed: num(L.seed, 3, 1, 999) | 0, spin: Math.max(120, num(L.spin, 240, 0, 720)), stag: num(L.stag, 0.35, 0, 1) }));
    } else if (kind === 'pattern') {
      const src = okSrc.has(L.src) ? L.src : 'hero';
      layers.push(timing(L, { kind, src, sub: oneOf(L.sub, ['radial', 'grid', 'ring'], 'radial'), cx: num(L.cx, 0.5, 0, 1), cy: num(L.cy, 0.5, 0, 1), w: num(L.w, 0.14, 0.05, 0.4), spin: num(L.spin, 30, -180, 180), rings: num(L.rings, 3, 1, 5) | 0, cols: num(L.cols, 4, 1, 6) | 0, rows: num(L.rows, 6, 1, 10) | 0, stag: num(L.stag, 0.02, 0, 0.08), alpha: num(L.alpha, 0.7, 0.1, 0.75) }));
    } else if (SHAPES.includes(kind)) {
      const o = timing(L, { kind, x: num(L.x, 0.5, -0.5, 1.5), y: num(L.y, 0.5, -0.5, 1.5), color: fixHex(L.color, '#ffffff'), alpha: num(L.alpha, 1, 0.05, 1), r: num(L.r, 0, -360, 360) });
      if (L.color2) o.color2 = fixHex(L.color2, o.color);
      ['size', 'w', 'h', 'radius', 'n', 'gap', 'width', 'speed', 'amp', 'wl', 'thick', 'dot', 'life', 'seed'].forEach((k) => { if (L[k] !== undefined) o[k] = num(L[k], 0, -5, 200); });
      if (L.side) o.side = oneOf(L.side, ['top', 'bottom'], 'bottom');
      const i = motionIO(L.in, IN_KINDS, 0.5), out = motionIO(L.out, IN_KINDS, 0.35); if (i) o.in = i; if (out) o.out = out;
      layers.push(o);
    }
  });
  // guarantees: the product is on screen early and stays for most of the promo; the brand name closes it
  const heroLayers = layers.filter((l) => l.kind === 'sprite' && l.src === 'hero');
  if (!heroLayers.length) layers.push({ kind: 'sprite', src: 'hero', beat: 'all', t0: 0.4, t1: D, x: 0.5, y: 0.52, w: 0.5, r: 0, in: { kind: 'pop', dur: 0.6 }, idle: { kind: 'float', amp: 0.012, speed: 1 } });
  else if (Math.min(...heroLayers.map((l) => l.t0)) > 1.3) heroLayers[0].t0 = 0.6;
  const lastBeat = beats[nb - 1];
  const hasBrand = layers.some((l) => l.kind === 'text' && l.t1 >= D - 0.3 && l.lines.join(' ').toUpperCase().includes(brand.split(' ')[0]));
  if (!hasBrand) layers.push({ kind: 'text', beat: nb - 1, t0: +(lastBeat.t0 + 0.5).toFixed(2), t1: D, lines: [brand.length > 12 && brand.includes(' ') ? brand.split(' ').slice(0, 2).join(' ') : brand], x: 0.5, y: 0.86, size: brand.length > 10 ? 0.11 : 0.15, font: 'anton', color: '#ffffff', upper: true, track: 0, r: 0, align: 'center', in: { kind: 'slam', dur: 0.4, stag: 0.14 }, shadow: true });
  const cam = (Array.isArray(S.cam) ? S.cam : []).filter((c) => c && Number.isFinite(+c.t)).slice(0, 6).map((c) => ({ t: num(c.t, 0.5, 0, D - 0.3), kind: c.kind === 'shake' ? 'shake' : 'punch', amp: num(c.amp, c.kind === 'shake' ? 8 : 0.06, 0, c.kind === 'shake' ? 16 : 0.12), dur: num(c.dur, 0.3, 0.15, 0.8) }));
  if (!cam.length) cam.push({ t: Math.min(D - 0.5, (heroLayers[0] ? heroLayers[0].t0 : 0.4) + 0.15), kind: 'punch', amp: 0.06, dur: 0.3 });
  const DIRS = ['left', 'right', 'top', 'bottom', 'topleft', 'topright', 'bottomleft', 'bottomright'];
  const heroPath = (Array.isArray(S.hero_path) ? S.hero_path : []).filter((h) => h && typeof h === 'object').slice(0, 4).map((h) => ({ from: oneOf(h.from, DIRS, undefined), to: oneOf(h.to, DIRS.concat('none'), undefined), x: num(h.x, undefined, 0.2, 0.8), y: num(h.y, undefined, 0.3, 0.7), s: num(h.s, undefined, 0.75, 1.3), r: num(h.r, undefined, -28, 28) }));
  richen(layers, beats, zones, D, rand, heroPath, cam);
  const music = oneOf(S.sound && S.sound.music, ['pulse', 'warm pad', 'tense', 'dark drone'], 'pulse');
  return { brand, product, props, assets, duration: +D.toFixed(2), zones, beats, layers, cam, sound: { music }, pan: 0.9 };
}

/**
 * The layout pass, run once the product picture exists (so its real proportions are known): small lines and the brand name must never sit on the product.
 * A line that would overlap the hero is moved into the free space above or below it; if the closing brand line has no room, the hero is moved up and made smaller in the last beat.
 */
function layoutPass(promo, aspect) {
  const D = promo.duration, W = 720, H = 1280, ar = aspect > 0.05 ? aspect : 0.6;
  const hero = promo.layers.find((l) => l.kind === 'sprite' && l.src === 'hero'); if (!hero) return promo;
  const pose = (t) => {
    const K = hero.keys; let x = hero.x, y = hero.y, s = 1;
    if (K && K.length && t >= K[0].t) { let a = K[0], b = K[K.length - 1]; for (let i = 0; i < K.length - 1; i++) if (t >= K[i].t && t <= K[i + 1].t) { a = K[i]; b = K[i + 1]; break; } const u = a === b ? 1 : Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t))); const iv = (k, d) => { const va = a[k] !== undefined ? a[k] : d, vb = b[k] !== undefined ? b[k] : va; return va + (vb - va) * u; }; x = iv('x', x); y = iv('y', y); s = iv('s', 1); }
    return { x, y, s };
  };
  const heroBox = (t) => { const p = pose(t), w = hero.w * p.s, h = (w * W / ar) / H, tilt = 1.12; return { x0: p.x - w * tilt / 2, x1: p.x + w * tilt / 2, y0: p.y - h * tilt / 2, y1: p.y + h * tilt / 2 }; };
  // the hero never takes more than ~62% of the screen height (a giant word next to it must stay readable)
  const h1 = (hero.w * W / ar) / H; if (h1 > 0.58) hero.w = +(hero.w * 0.58 / h1).toFixed(3);
  const sMax = (0.58 / ((hero.w * W / ar) / H)); (hero.keys || []).forEach((k) => { if (k.s !== undefined) k.s = +Math.min(k.s, sMax).toFixed(3); });
  const FW = { anton: 0.48, bebas: 0.42, league: 0.38, oswald: 0.5, fjalla: 0.48, archivo: 0.68, bowlby: 0.66, rubik: 0.62, poppins: 0.66, inter: 0.64, playfair: 0.6, bricolage: 0.6, pacifico: 0.5, lobster: 0.5, caveat: 0.46 };
  const textBox = (l, x, y, size) => { const chars = Math.max(...l.lines.map((q) => q.length)), w = Math.min(0.92, chars * size * (FW[l.font] || 0.55) * (1 + (l.track || 0))), h = l.lines.length * size * 1.08 * (W / H); return { x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2, w, h }; };
  const inter = (a, b) => { const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); return iw > 0 && ih > 0 ? iw * ih : 0; };
  const overlapHero = (l, x, y, size) => { const tb = textBox(l, x, y, size); let m = 0, n = 0; for (let t = l.t0; t <= l.t1 + 1e-6; t += 0.2) { m += inter(tb, heroBox(t)); n++; } return n ? m / n / Math.max(1e-6, tb.w * tb.h) : 0; };   // share of the line covered by the product
  const flat = (l) => l.kind === 'text' && !l.repeat, order = promo.layers.filter(flat).sort((a, b) => b.size - a.size);
  const clampX = (l, x, size) => { const w = textBox(l, x, 0.5, size).w; return Math.max(w / 2 + 0.035, Math.min(1 - w / 2 - 0.035, x)); };
  const isFrontLine = (l) => l.front || l.size < 0.15;
  for (const l of order) {
    const big = !isFrontLine(l), limit = big ? 0.1 : 0.02;                                 // a giant word may be partly behind the product; a small line may not
    let best = { c: overlapHero(l, l.x, l.y, l.size), x: l.x, y: l.y, size: l.size };
    for (let shrink = 0; shrink < 3 && best.c > limit; shrink++) {
      const size = l.size * [1, 0.86, 0.74][shrink], tb = textBox(l, 0.5, 0.5, size), ys = big ? [l.y, 0.14, 0.86, 0.3, 0.7] : [l.y, 0.07, 0.11, 0.15, 0.89, 0.93, 0.85, 0.2, 0.8], xs = [l.x, 1 - l.x, 0.3, 0.7];
      for (const y of ys) { if (y - tb.h / 2 < 0.02 || y + tb.h / 2 > 0.98) continue; for (const x0 of xs) { const x = clampX(l, x0, size), c = overlapHero(l, x, y, size); if (c < best.c - 1e-6 || (c <= limit && best.c > limit)) best = { c, x, y, size }; if (best.c <= limit) break; } if (best.c <= limit) break; }
      if (best.c <= limit) break;
    }
    if (best.x !== l.x || best.y !== l.y || best.size !== l.size) { l.x = +best.x.toFixed(3); l.y = +best.y.toFixed(3); l.size = +best.size.toFixed(3); }
  }
  // lines that share a moment must not sit on each other: the smaller one moves to the nearest free band or is dropped
  const kept = [], drop = new Set();
  for (const l of order) {
    const clash = (x, y) => kept.some((k) => k.t0 < l.t1 && l.t0 < k.t1 && inter(textBox(k, k.x, k.y, k.size), textBox(l, x, y, l.size)) > 0);
    if (!clash(l.x, l.y)) { kept.push(l); continue; }
    let ok = false; const tb = textBox(l, 0.5, 0.5, l.size);
    for (const y of [0.07, 0.11, 0.15, 0.2, 0.86, 0.9, 0.94, 0.8, 0.3, 0.7]) { if (y - tb.h / 2 < 0.02 || y + tb.h / 2 > 0.98) continue; if (!clash(l.x, y) && overlapHero(l, l.x, y, l.size) <= (isFrontLine(l) ? 0.02 : 0.1)) { l.y = y; ok = true; break; } }
    if (ok) kept.push(l); else drop.add(l);
  }
  promo.layers = promo.layers.filter((l) => !drop.has(l));
  // the closing brand line must have the hero clear of it: if the hero still sits on it, move the hero up and make it smaller for the last beat
  const lb = promo.beats[promo.beats.length - 1], brandL = promo.layers.filter((l) => l.kind === 'text' && l.t1 >= D - 0.3 && l.t0 >= lb.t0 - 0.01).sort((a, b) => b.size - a.size)[0];
  if (brandL && overlapHero(brandL, brandL.x, brandL.y, brandL.size) > 0.02) {
    const tb = textBox(brandL, brandL.x, brandL.y, brandL.size), top = 0.07, bot = tb.y0 - 0.02, availH = Math.max(0.3, bot - top), hh = (hero.w * W / ar) / H, sNeed = Math.min(1, availH / (hh * 1.12)), cy = top + availH / 2, cur = pose(lb.t0 + 0.05);
    (hero.keys || []).forEach((k) => { if (k.t >= lb.t0 + 0.3) { k.y = +cy.toFixed(3); k.s = +Math.min(k.s, sNeed).toFixed(3); } });
  }
  return promo;
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
  return `A single ${p.kind}, ${p.look}, front view, premium product photography, studio lighting, sharp focus, vivid colour, the whole product fully in frame and centered, isolated on a plain flat pure ${key.name} (${key.hex}) chroma-key background, no shadow, no ground, no other objects. The reference image is the brand name: print exactly this brand name, spelled identically letter for letter, large and clear on the front of the pack, as the only text on it.`;
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
  const hits = [...new Set(promo.layers.filter((l) => l.kind === 'text' && l.in && (l.in.kind === 'slam' || l.in.kind === 'pop')).map((l) => +l.t0.toFixed(1)))].slice(0, 5);
  if (!lib.list.length) {
    const cues = []; promo.beats.forEach((b, i) => { if (i) cues.push({ t: b.t0 - 0.35, kind: 'whoosh', dur: 0.6, gain: 0.12 }); });
    if (hero) cues.push({ t: hero.t0, kind: 'impact', gain: 0.5 }, { t: hero.t0, kind: 'sub', gain: 0.35 }); hits.forEach((t) => cues.push({ t, kind: 'tick', gain: 0.5 }));
    cues.push({ t: D - 1.0, kind: 'tick', gain: 0.6 });
    fs.writeFileSync(path.join(dir, 'audio.wav'), synth({ duration: D + 1, cues: cues.filter((c) => c.t >= 0), music }));
    return 'audio.wav';
  }
  const pick = (kind, salt) => { const l = lib.of(kind); return l.length ? l[((promo.zones.length * 7) + salt) % l.length] : null; };
  const G = adMix.GAIN, ev = [], at = (x) => path.join(adMix.LIB, x.file);
  const whoosh = pick('whoosh', 0), tick = pick('tick', 1), hit = pick('impact', 2), spark = pick('sparkle', 3), riser = pick('riser', 4);
  promo.beats.forEach((b, i) => { if (i && whoosh) ev.push({ file: at(whoosh), at: Math.max(0, b.t0 - 0.4), gain: G.whoosh * 1.6 }); });
  if (hero && hit) ev.push({ file: at(hit), at: hero.t0, gain: G.impact });
  hits.forEach((t) => { if (tick) ev.push({ file: at(tick), at: t, gain: G.tick }); });
  if (riser) ev.push({ file: at(riser), at: Math.max(0, D - 1.5 - riser.seconds * 0.5), gain: G.riser * 0.8 });
  if (spark) ev.push({ file: at(spark), at: D - 0.9, gain: G.sparkle });
  const bed = adMix.tmpFile('.wav'), out = path.join(dir, 'audio.wav');
  fs.writeFileSync(bed, synth({ duration: D + 1, cues: [], music }));
  try { await adMix.mix({ bedWav: bed, events: ev, outWav: out, end }); } finally { fs.rmSync(bed, { force: true }); }
  return 'audio.wav';
}

/** A stand-in prop (a glossy disc in the product's colour) for when the image AI refuses or fails a prop: the promo is never lost over one ingredient. */
function fallbackProp(hex) {
  const { createCanvas } = cv(), c = createCanvas(400, 400), g = c.getContext('2d'), col = rgb(fixHex(hex, '#ff7a00'));
  const gr = g.createRadialGradient(150, 140, 20, 200, 200, 190); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.35, 'rgb(' + col.join(',') + ')'); gr.addColorStop(1, 'rgb(' + col.map((v) => Math.round(v * 0.55)).join(',') + ')');
  g.fillStyle = gr; g.beginPath(); g.arc(200, 200, 185, 0, Math.PI * 2); g.fill();
  return { buf: c.toBuffer('image/png'), aspect: 1 };
}

module.exports = { layoutPass, fallbackProp, PROMO_SYSTEM, promoPrompt, normalizePromo, pickKey, heroPrompt, propPrompt, wordmarkCard, cutout, promoAudio, FONTS };
