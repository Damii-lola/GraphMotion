'use strict';
/*
 * BACKDROPS FROM THE PRODUCT: every scene gets its OWN gradient, built from the colours of the real product photo, so the backdrops match the product and change from scene to scene.
 * The director chooses a ROLE per scene (primary, secondary, complement, analogous, dark, light, duo) and a gradient style; the colours come from the product.
 */
const { clamp, rgb, hex, toHsl, fromHsl, isHex } = require('./laws');
const { rngFrom, shuffle } = require('./vary');

const ROLES = ['primary', 'secondary', 'complement', 'analogous', 'dark', 'light', 'duo'];
const rot = (c, deg) => { const [h, s, l] = toHsl(c); return fromHsl([(h + deg + 360) % 360, s, l]); };
const tone = (c, l, sMin) => { const [h, s] = toHsl(c); return fromHsl([h, Math.max(s, sMin), l]); };

/** the product's base colours: the real photo's dominant colours; for a white / silver / black pack, the colour the director suggested (or a fresh one from this video's dice) */
function baseColours(palette, product, dice) {
  const own = (palette && palette.colors || []).filter(isHex), sug = ((product && product.colors) || []).filter(isHex);
  const neutral = !own.length || (palette && palette.neutral);
  const seedHue = (dice && dice.seed ? dice.seed % 360 : 20);
  const p1 = rgb(neutral ? (sug[0] || hex(fromHsl([seedHue, 0.85, 0.5]))) : own[0]);
  const p2 = own[1] && !neutral ? rgb(own[1]) : sug[1] ? rgb(sug[1]) : rot(p1, 38);
  return { p1, p2 };
}

/** a scene's backdrop: { c0, c1 (hex), shape, angle, ox, oy, accent, role } */
function scene(role, style, palette, product, dice, i) {
  const { p1, p2 } = baseColours(palette, product, dice), r = rngFrom((dice.seed || 1) * 7 + i * 131), j = (dice.hueShift || 0) / 4;   // a few degrees per video: never the same twice, still the product's colour
  const P = rot(p1, j), Q = rot(p2, j);
  let c0, c1, accent;
  switch (role) {
    case 'secondary': c0 = tone(Q, 0.5, 0.65); c1 = tone(Q, 0.27, 0.65); accent = tone(rot(Q, 150), 0.6, 0.85); break;
    case 'complement': { const C = rot(P, 180); c0 = tone(C, 0.5, 0.7); c1 = tone(C, 0.27, 0.7); accent = tone(P, 0.58, 0.9); break; }
    case 'analogous': { const C = rot(P, i % 2 ? 36 : -36); c0 = tone(C, 0.52, 0.7); c1 = tone(C, 0.3, 0.7); accent = tone(rot(C, 160), 0.6, 0.85); break; }
    case 'dark': c0 = tone(P, 0.2, 0.55); c1 = tone(P, 0.08, 0.35); accent = tone(rot(P, 12), 0.6, 0.95); break;
    case 'light': c0 = tone(P, 0.93, 0.5); c1 = tone(P, 0.8, 0.5); accent = tone(P, 0.45, 0.85); break;
    case 'duo': c0 = tone(P, 0.52, 0.7); c1 = tone(Q, 0.4, 0.7); accent = tone(rot(P, 165), 0.6, 0.85); break;
    default: c0 = tone(P, 0.52, 0.68); c1 = tone(P, 0.29, 0.68); accent = tone(rot(P, 165), 0.6, 0.85);   // primary
  }
  const linear = style === 'linear' || (style !== 'radial' && r() < 0.35);
  return { c0: hex(c0), c1: hex(c1), accent: hex(accent), shape: linear ? 'linear' : 'radial', angle: linear ? Math.round(30 + r() * 120) : 90, ox: +((r() - 0.5) * 0.5).toFixed(2), oy: +((r() - 0.5) * 0.5).toFixed(2), role: role || 'primary' };
}

/** roles for the scenes: the director's choice; a missing or repeated one is replaced so that neighbouring scenes always differ */
function assignRoles(plan, dice) {
  const r = rngFrom((dice.seed || 1) + 4242), pool = shuffle(r, ['primary', 'complement', 'analogous', 'secondary', 'dark', 'duo']), out = [];
  plan.scenes.forEach((s, i) => {
    let role = ROLES.includes(s.backdrop && s.backdrop.role) ? s.backdrop.role : null;
    if (!role || role === out[i - 1]) role = pool.find((x) => x !== out[i - 1] && !out.includes(x)) || pool.find((x) => x !== out[i - 1]) || 'primary';
    out.push(role);
  });
  return out;
}

module.exports = { ROLES, scene, assignRoles, baseColours };
