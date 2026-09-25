'use strict';
/*
 * NODE FILM: the ad is a designed 3D motion-graphics film, not photographs. Every scene is a gradient WORLD with ONE hero object (a "node") floating in it;
 * the page (siteTemplate/ad.html, node mode) changes scene by moving the node, spinning it 720 degrees and/or turning the world into a wireframe and back.
 *
 * This module holds everything on the generator side:
 *   - the director prompt (nodes + worlds + which node/world each scene uses),
 *   - normalising that answer (the code, not the model, guarantees valid colours, indices and placement),
 *   - making the node pictures: the image AI paints ONE isolated object on white, the code cuts it out (flood fill from the border),
 *   - procedural fallback nodes (glossy orb / cube / ring / badge), so a refused or failed picture never costs the film.
 */
const fs = require('fs');
const path = require('path');

const NODE_FLOW = `MOTION-GRAPHICS FILM (the most important part). The picture of this ad is NOT photographs. It is a designed 3D motion-graphics film in the style of the best product-launch videos and scroll-driven 3D websites: every scene is a colourful gradient WORLD with ONE hero object - the NODE - floating in front of it. No photos, no people, no rooms, no offices.
(1) THE NODES. Write 3 nodes (ids 1, 2 and 3; node 0 is the company's own logo mark, which the code makes). Each node is ONE simple, iconic, instantly recognisable object described as a FLAT 2D illustration: what it is, drawn with bold simple shapes and 2-4 RICH SATURATED flat colours (never white, grey or black), like a sticker or a modern app icon. It must be about THIS company: its product itself, what it makes or does, or a bold physical symbol of its promise (a rocket for launching, a key for access, a lightning bolt for speed, a sprout for growth, a shield for safety, a coin for saving, a paper plane for sending). Never a generic laptop, phone, desk, person or office. NO text, letters, numbers or logos on a node, and never a whole scene: one object, floating.
(2) THE WORLDS. Write 3 background PICTURES that an image AI will paint behind the hero: {"prompt": ..., "a": near-black #RRGGBB, "b": dark tone #RRGGBB, "c": a glow colour #RRGGBB}. Each "prompt" describes a wide, atmospheric, cinematic ENVIRONMENT that belongs to THIS company's own world and to the mood of the scenes that use it (for a coffee brand a misty roastery at dawn; for an app builder a softly lit creative studio with glowing screens far out of focus; for a shoe brand a dawn trail through trees; for a bank a calm glass lobby at dusk), 25-35 words: the place, the light, the colour palette, the mood. Deep soft focus, no people, NO text or signs, nothing sharp or specific in the centre (the hero object sits there). Three clearly different places or moods, so a change of world is felt. a, b, c are fallback colours in the same palette.
(3) SIX SCENES, each with a node ("node": 0-3) and a world ("bg": 0-2). The hook uses node 0 or your most striking node. Across the 5 transitions use ALL THREE kinds of change: SAME node in a NEW world (the node glides across the frame while the world turns to a wireframe and re-forms); SAME world with a DIFFERENT node (the node spins 720 degrees and turns into the next node through a wireframe); EVERYTHING different (the whole frame morphs). Never the same kind twice in a row. Order the nodes so they tell the story: the problem, the product, the payoff.
(4) PLACEMENT. Each scene gives "s" (the node's size as a fraction of the frame width, 0.45-0.75; the hook and the end card are the biggest) and "r" (a tilt in degrees, -14 to 14). The caption sits at "pos" and the code keeps the node clear of it.`;

const NODE_KEYS = `Return ONE JSON object with these keys:
"brand", "tagline" (max 7 words), "look" (metal = heavy-metal / punk / gothic / dark-humour brands; luxury; tech; playful; clean), "accent" (ONE bold signature colour #RRGGBB - the brand's own if the brief names one; never grey), "bg" (near-black #RRGGBB), "cta" (button label, 2-4 words), "link" (website or @handle ONLY if it appears in the brief, else ""),
"nodes": EXACTLY 3 objects {"name": "the object in 2-3 words, e.g. paper plane", "prompt": "THE OBJECT FIRST, then material and colour, max 22 words, e.g. a paper plane, polished chrome with a blue tint"},
"bgs": EXACTLY 3 objects {"prompt","a","b","c"} (see THE WORLDS),
"scenes": EXACTLY 6 objects, each: "id", "tag" (a 1-3 word LABEL pill like "POV", "Real talk", "The proof" - a label, not the start of a sentence, never ending in "..."; "" for cta), "headline" (an ARRAY of 2-6 word strings, ONE WORD PER ELEMENT, e.g. ["Your","*idea*","starts","|","to","glow"]; a lone "|" element is a line break; wrap the 1-2 key words in *asterisks*), "sub" (optional line, max 8 words, else ""), "sticker" ({"n":"number or word, max 7 chars","l":"label, max 3 words"} for solution/feature/proof only when the brief gives a real number or fact, else null), "node" (0-3), "bg" (0-2), "s", "r", "pos" ("bm" bottom centre, "bl" bottom left, "br" bottom right, "tl" top left, "tm" top centre - never the middle; vary it), "tone" ("dark"),
"transitions": EXACTLY 5 objects, each just {"sfx": a whoosh id from SOUND}@@SND@@.
Output the JSON object only.`;

const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim());
const fixHex = (v, d) => (isHex(v) ? '#' + v.trim().replace('#', '').toLowerCase() : d);
const rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const mixC = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const NODE_POS_Y = { t: 0.62, b: 0.38 };

/** Validate the AI's nodes / worlds / per-scene picks (never trust the model with indices, colours or placement). */
function applyNodePlan(spec, S) {
  const acc = rgb(spec.theme.accent);
  const nodesIn = Array.isArray(S.nodes) ? S.nodes : [];
  spec.nodePrompts = [0, 1, 2].map((i) => {
    const n = nodesIn[i] && typeof nodesIn[i] === 'object' ? nodesIn[i] : {};
    return { name: String(n.name || '').slice(0, 30), prompt: String(n.prompt || '').replace(/["<>]/g, '').slice(0, 220) };
  });
  const bgsIn = Array.isArray(S.bgs) ? S.bgs : [];
  spec.bgs = [0, 1, 2].map((i) => {
    const b = bgsIn[i] && typeof bgsIn[i] === 'object' ? bgsIn[i] : {};
    const bgPrompt = String(b.prompt || '').replace(/["<>]/g, '').slice(0, 320);
    // three worlds always exist and are always usable: a dark base, a mid tone, a bright light - derived from the accent when the AI gave nothing valid
    const hue = (k) => mixC(acc, k === 0 ? [255, 255, 255] : [0, 0, 0], k === 0 ? 0.0 : 0.0);
    let a = isHex(b.a) ? rgb(fixHex(b.a)) : mixC(acc, [8, 8, 16], 0.82 - i * 0.05);
    let m = isHex(b.b) ? rgb(fixHex(b.b)) : mixC(acc, [16, 16, 40], 0.5 - i * 0.08);
    let c = isHex(b.c) ? rgb(fixHex(b.c)) : mixC(acc, [255, 255, 255], 0.15 + i * 0.12);
    a = mixC(a, [5, 6, 12], lum(a) > 0.09 ? 0.86 : 0.55);              // a near-black base: the hero is the light, the stage is dark (captions read, the object pops)
    m = mixC(m, [8, 10, 20], lum(m) > 0.16 ? 0.72 : 0.4);
    if (lum(c) < 0.4) c = mixC(c, [255, 255, 255], 0.4);            // the glow is bright, or it is not a light
    return { a: toHex(a), b: toHex(m), c: toHex(c), prompt: bgPrompt };
  });
  // three glow colours that really differ: if two are within ~35 degrees of hue, the code rotates them apart (a change of world must be SEEN)
  const hueOf = (c) => { const [r, g, b] = c.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  const fromHue = (h, s, l) => { const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0) * 255, f(8) * 255, f(4) * 255]; };
  const base = hueOf(rgb(spec.bgs[0].c));
  for (let i = 1; i < 3; i++) { const h = hueOf(rgb(spec.bgs[i].c)), diff = Math.min(Math.abs(h - hueOf(rgb(spec.bgs[i - 1].c))), 360 - Math.abs(h - hueOf(rgb(spec.bgs[i - 1].c)))); if (diff < 35 || Math.min(Math.abs(h - base), 360 - Math.abs(h - base)) < 35) { spec.bgs[i].c = toHex(fromHue((base + (i === 1 ? 45 : -55) + 360) % 360, 0.85, 0.6)); } }
  const sceneIn = Array.isArray(S.scenes) ? S.scenes : [];
  spec.scenes.forEach((sc, k) => {
    const s = sceneIn.find((x) => x && x.id === sc.id) || sceneIn[k] || {};
    const ni = Number.isInteger(+s.node) ? +s.node : k % 4, bi = Number.isInteger(+s.bg) ? +s.bg : k % 3;
    sc.node = Math.max(0, Math.min(3, ni)); sc.bg = Math.max(0, Math.min(2, bi));
    const size = Math.max(0.42, Math.min(0.78, Number.isFinite(+s.s) ? +s.s : 0.6));
    const top = /^t/.test(sc.pos || '');
    sc.np = { x: 0.5, y: top ? NODE_POS_Y.t : NODE_POS_Y.b, s: k === 0 || k === spec.scenes.length - 1 ? Math.max(size, 0.56) : size, r: Math.max(-14, Math.min(14, Number.isFinite(+s.r) ? +s.r : (k % 2 ? 6 : -6))) };
    if (k === spec.scenes.length - 1) { sc.np.y = 0.27; sc.np.s = Math.min(sc.np.s, 0.4); }   // the end card: the caption, logo pill and button sit under a smaller node
  });
  // the film must contain all three kinds of change; if the AI repeated itself, the code varies the plan (a plan that is the same six times is a slideshow)
  const kind = (a, b) => (a.node === b.node ? (a.bg === b.bg ? 'move' : 'move') : a.bg === b.bg ? 'spin' : 'all');
  const kinds = spec.scenes.slice(1).map((sc, i) => kind(spec.scenes[i], sc));
  const want = ['move', 'spin', 'all', 'move', 'spin'];
  if (new Set(kinds).size < 3 || kinds.some((k, i) => i && k === kinds[i - 1])) {
    spec.scenes.forEach((sc, k) => { const p = [[0, 0], [0, 1], [1, 1], [2, 2], [2, 0], [3, 0]][k]; sc.node = p[0]; sc.bg = p[1]; });
    spec.scenes[5].node = 0;                                          // the end card returns to the brand mark
  }
  return spec;
}

// ------------------------------------------------------------- pictures
let canvasLib = null;
const cv = () => canvasLib || (canvasLib = require('@napi-rs/canvas'));
const rr = (c, x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
const css = (c, a = 1) => `rgba(${c.map((v) => Math.round(v)).join(',')},${a})`;

/** A glossy rounded-square badge with the brand's initial: the node the code can always make. */
function brandBadge(name, accentHex) {
  const { createCanvas } = cv(), c = createCanvas(640, 640), g = c.getContext('2d'), acc = rgb(accentHex);
  const top = mixC(acc, [255, 255, 255], 0.28), bot = mixC(acc, [0, 0, 0], 0.22);
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 40; g.shadowOffsetY = 24;
  const gr = g.createLinearGradient(0, 60, 0, 580); gr.addColorStop(0, css(top)); gr.addColorStop(1, css(bot));
  rr(g, 70, 60, 500, 500, 120); g.fillStyle = gr; g.fill(); g.shadowColor = 'transparent';
  const hl = g.createLinearGradient(0, 60, 0, 300); hl.addColorStop(0, 'rgba(255,255,255,.5)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
  rr(g, 80, 70, 480, 240, 110); g.fillStyle = hl; g.fill();
  const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  try { const { GlobalFonts } = cv(); const f = path.join(__dirname, 'assets', 'fonts', 'ArchivoBlack-Regular.ttf'); if (fs.existsSync(f) && !GlobalFonts.has('NodeFont')) GlobalFonts.registerFromPath(f, 'NodeFont'); } catch (_) { /* default font */ }
  g.font = '300px NodeFont, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = lum(acc) > 0.72 ? '#0a0a0a' : '#ffffff'; g.fillText(letter, 320, 330);
  return c.toBuffer('image/png');
}

/** Procedural glossy objects: the fallback when the image AI refused or failed. kind: 0 orb, 1 cube, 2 ring */
function proceduralNode(kind, accentHex, seed = 0) {
  const { createCanvas } = cv(), c = createCanvas(640, 640), g = c.getContext('2d'), acc = rgb(accentHex);
  const cols = [acc, mixC(acc, [255, 214, 90], 0.55), mixC(acc, [90, 200, 255], 0.55)];
  const col = cols[(kind + seed) % 3];
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 36; g.shadowOffsetY = 22;
  if (kind % 3 === 0) {
    const gr = g.createRadialGradient(250, 230, 30, 320, 320, 250); gr.addColorStop(0, css(mixC(col, [255, 255, 255], 0.65))); gr.addColorStop(0.5, css(col)); gr.addColorStop(1, css(mixC(col, [0, 0, 0], 0.45)));
    g.beginPath(); g.arc(320, 320, 230, 0, Math.PI * 2); g.fillStyle = gr; g.fill();
  } else if (kind % 3 === 1) {
    const P = (x, y) => [320 + x, 320 + y];
    const face = (pts, cc) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fillStyle = css(cc); g.fill(); };
    face([P(0, -230), P(200, -115), P(0, 0), P(-200, -115)], mixC(col, [255, 255, 255], 0.4)); g.shadowColor = 'transparent';
    face([P(-200, -115), P(0, 0), P(0, 230), P(-200, 115)], col); face([P(0, 0), P(200, -115), P(200, 115), P(0, 230)], mixC(col, [0, 0, 0], 0.3));
  } else {
    const gr = g.createLinearGradient(100, 100, 540, 540); gr.addColorStop(0, css(mixC(col, [255, 255, 255], 0.5))); gr.addColorStop(1, css(mixC(col, [0, 0, 0], 0.35)));
    g.lineWidth = 92; g.strokeStyle = gr; g.beginPath(); g.arc(320, 320, 190, 0, Math.PI * 2); g.stroke();
  }
  return c.toBuffer('image/png');
}

/**
 * Cut an object out of a plain background: the border colour is sampled, then a flood fill from every border pixel removes everything connected to it
 * (anything inside the object - a white heart on a pink icon - is kept). The result is cropped to the object, edges softened, returned as PNG + aspect.
 */
async function cutout(buf, tol = 70) {
  const { loadImage, createCanvas } = cv();
  const img = await loadImage(buf), W = img.width, H = img.height;
  const c = createCanvas(W, H), g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const id = g.getImageData(0, 0, W, H), d = id.data;
  // background colour = the median of the border pixels
  const bs = []; for (let x = 0; x < W; x += 3) { bs.push(0 * W + x, (H - 1) * W + x); } for (let y = 0; y < H; y += 3) { bs.push(y * W, y * W + W - 1); }
  const med = (ch) => { const v = bs.map((p) => d[p * 4 + ch]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [med(0), med(1), med(2)];
  const near = (p) => { const dr = d[p * 4] - bg[0], dg = d[p * 4 + 1] - bg[1], db = d[p * 4 + 2] - bg[2]; return Math.sqrt(dr * dr + dg * dg + db * db) < tol; };
  const gone = new Uint8Array(W * H), stack = [];
  const push = (p) => { if (!gone[p] && near(p)) { gone[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) { const p = stack.pop(), x = p % W, y = (p / W) | 0; if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W); }
  // the key colour also disappears where the flood could not reach (the hole of a ring, the gap in a handle), and its spill is cleaned off the edges
  const strict = tol * 0.62;
  for (let p = 0; p < W * H; p++) { if (gone[p]) continue; const dr = d[p * 4] - bg[0], dg = d[p * 4 + 1] - bg[1], db = d[p * 4 + 2] - bg[2]; if (Math.sqrt(dr * dr + dg * dg + db * db) < strict) gone[p] = 1; }
  const greenBg = bg[1] > bg[0] + 40 && bg[1] > bg[2] + 40;
  if (greenBg) for (let p = 0; p < W * H; p++) { if (gone[p]) continue; const r = d[p * 4], g2 = d[p * 4 + 1], b2 = d[p * 4 + 2], cap = Math.max(r, b2); if (g2 > cap) d[p * 4 + 1] = cap + (g2 - cap) * 0.15; }
  // soften the rim: object pixels touching removed pixels get half alpha (removes the halo of the old background)
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; let a = gone[p] ? 0 : 255;
    if (!gone[p]) { const rim = (x > 0 && gone[p - 1]) || (x < W - 1 && gone[p + 1]) || (y > 0 && gone[p - W]) || (y < H - 1 && gone[p + W]); if (rim) a = 120; }
    d[p * 4 + 3] = a;
    if (a) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX <= minX || maxY <= minY || (maxX - minX) * (maxY - minY) < W * H * 0.02) throw new Error('cutout found no object');
  g.putImageData(id, 0, 0);
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06), cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad), cw = Math.min(W - cx, maxX - minX + 1 + 2 * pad), ch = Math.min(H - cy, maxY - minY + 1 + 2 * pad);
  const out = createCanvas(cw, ch), og = out.getContext('2d'); og.drawImage(c, cx, cy, cw, ch, 0, 0, cw, ch);
  return { buf: out.toBuffer('image/png'), aspect: cw / ch };
}

const BG_LOOK = 'cinematic wide atmospheric background photograph, vertical 9:16 composition, deep soft focus and shallow depth of field, moody premium lighting, rich colour, no people, no text, no letters, no signs, no logos, nothing sharp in the centre, calm uncluttered space in the middle';
const NODE_LOOK = 'single object, centered, floating in the air, flat 2D vector illustration, bold simple shapes, crisp clean edges, a few rich saturated flat colours with subtle shading, sticker style icon, high contrast, NOT white and NOT grey and NOT green, isolated on a plain flat pure bright green chroma-key background (#00ff00), no shadow, no ground, no text, no letters, no logo';

module.exports = { BG_LOOK, NODE_FLOW, NODE_KEYS, applyNodePlan, brandBadge, proceduralNode, cutout, NODE_LOOK };
