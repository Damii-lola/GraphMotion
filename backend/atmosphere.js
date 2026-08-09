const { clamp01, lerp } = require('./easing');

/**
 * Every function here now takes `system` (a config object from
 * visualSystems.js) and branches its behavior on it - same safe,
 * benchmarked primitives underneath (particles via fillRect/arc, grain
 * via sparse speckles, glow via ctx.filter blur on a shape - never
 * drawImage-of-canvas, confirmed leaky and removed permanently), but
 * genuinely different output depending on which system is active.
 * hudTerminal keeps exactly the look this file always had; the other
 * two systems turn off/replace pieces of it rather than just
 * recoloring the same elements.
 */

const PARTICLE_COUNT = 70;
let particleSeeds = null;

function getParticleSeeds() {
  if (particleSeeds) return particleSeeds;
  let seed = 1337;
  function rand() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  particleSeeds = Array.from({ length: PARTICLE_COUNT }, () => ({
    x: rand(), y: rand(), depth: rand(), phase: rand() * Math.PI * 2,
  }));
  return particleSeeds;
}

function drawAtmosphere(ctx, globalT, width, height, accentColor, system) {
  drawGradientBase(ctx, width, height, system);
  if (system.showGlowBlob) drawGlowBlob(ctx, globalT, width, height, accentColor);
  if (system.showParticles) drawParticles(ctx, globalT, width, height, accentColor, system);
  if (system.flatBlockAccent) drawFlatBlocks(ctx, globalT, width, height, accentColor);
  drawVignette(ctx, width, height, system);
  // Grain reads as "video texture" on the dark HUD look but would
  // just look like dirt on a light editorial background or muddy a
  // flat poster-graphic block - only draw it for hudTerminal.
  if (system.name === 'hudTerminal') drawGrain(ctx, globalT, width, height);
}

function drawGlowBlob(ctx, globalT, width, height, accentColor) {
  const x = width * 0.5 + Math.sin(globalT * 0.15) * width * 0.15;
  const y = height * 0.3 + Math.cos(globalT * 0.1) * height * 0.08;
  ctx.save();
  ctx.filter = 'blur(80px)';
  ctx.globalAlpha = 0.12;
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(x, y, 180, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'none';
  ctx.restore();
}

function drawGradientBase(ctx, width, height, system) {
  const grad = ctx.createRadialGradient(
    width / 2, height * 0.35, 0,
    width / 2, height * 0.35, height * 0.9
  );
  grad.addColorStop(0, system.bgColorInner);
  grad.addColorStop(1, system.bgColorOuter);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

/**
 * boldGraphic's signature move: instead of soft glowing particles, a
 * few large FLAT saturated color blocks anchored at frame edges - no
 * gradient, no blur, no glow. Reads as poster/graphic-design, not a
 * dimmer version of the HUD look.
 */
function drawFlatBlocks(ctx, globalT, width, height, accentColor) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = accentColor;
  const slide = Math.sin(globalT * 0.2) * 20;
  ctx.fillRect(0, 0, width * 0.22 + slide, height);
  ctx.globalAlpha = 0.85;
  ctx.fillRect(width - (width * 0.12), 0, width * 0.12, height);
  ctx.restore();
}

function drawParticles(ctx, globalT, width, height, accentColor, system) {
  const seeds = getParticleSeeds();
  ctx.save();
  for (const p of seeds) {
    const speed = lerp(0.004, 0.02, p.depth);
    const size = lerp(1, 3, p.depth);
    // softEditorial: calmer, dimmer, no accent-color particles at all
    // (pure neutral dust motes, not "HUD data points").
    const alphaMul = system.name === 'softEditorial' ? 0.5 : 1;
    const baseAlpha = lerp(0.04, 0.13, p.depth) * alphaMul;

    const driftX = Math.sin(globalT * speed * 20 + p.phase) * 20 * p.depth;
    const driftY = (globalT * speed * 15 + p.y * height) % (height + 40) - 20;

    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = (system.name === 'hudTerminal' && p.depth > 0.75) ? accentColor : system.mutedTextColor;
    ctx.beginPath();
    ctx.arc(p.x * width + driftX, driftY, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawVignette(ctx, width, height, system) {
  if (system.vignetteStrength <= 0) return;
  const grad = ctx.createRadialGradient(
    width / 2, height / 2, height * 0.35,
    width / 2, height / 2, height * 0.75
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${system.vignetteStrength})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

function drawGrain(ctx, globalT, width, height) {
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#FFFFFF';
  let seed = Math.floor(globalT * 1000) % 100000;
  function rand() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  for (let i = 0; i < 90; i++) {
    ctx.fillRect(rand() * width, rand() * height, 1, 1);
  }
  ctx.restore();
}

module.exports = { drawAtmosphere };
