const { clamp01, lerp } = require('./easing');
const { deriveDarkBackgroundTint, deriveBoldGradientTint, deriveLightBackgroundTint } = require('./colorUtils');

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

const BASE_PARTICLE_COUNT = 35;
let particleSeeds = null;
let particleSeedsWorldWidth = 0;

/**
 * Particles now live across the WHOLE world extent, not one screen -
 * seeded once per render (deterministic), count scales modestly with
 * world size (capped) so a long video doesn't need proportionally
 * more particles forever. This is what makes the background feel
 * continuous as the camera pans instead of the old behavior where
 * every scene's particle field started over.
 */
function getParticleSeeds(worldWidth) {
  if (particleSeeds && particleSeedsWorldWidth === worldWidth) return particleSeeds;
  let seed = 1337;
  function rand() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const screenWidths = Math.max(1, worldWidth / 720);
  const count = Math.min(140, Math.round(BASE_PARTICLE_COUNT * Math.sqrt(screenWidths)));
  particleSeeds = Array.from({ length: count }, () => ({
    worldX: rand() * worldWidth,
    y: rand(), depth: rand(), phase: rand() * Math.PI * 2,
  }));
  particleSeedsWorldWidth = worldWidth;
  return particleSeeds;
}

/**
 * softEditorial/boldGraphic opt OUT of the grid/scanline/data-chip HUD
 * chrome entirely (wrong register for either) - but that left them
 * with almost nothing continuously moving (boldGraphic in particular
 * has showParticles:false too), reading as genuinely static/bland next
 * to reference footage where something is always in motion. This is
 * the calmer-register equivalent: a few slow, softly curving lines
 * drifting across the frame - elegant at low opacity for softEditorial,
 * a bit bolder for boldGraphic's punchier identity - not a HUD grid,
 * but never fully still either.
 */
function drawDriftLines(ctx, globalT, width, height, accentColor, count, opacity) {
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < count; i++) {
    const speed = 6 + i * 2.5;
    const cycle = height + 300;
    const yBase = (((globalT * speed + i * 180) % cycle) + cycle) % cycle - 150;
    const waveAmp = 36 + i * 14;
    ctx.globalAlpha = opacity * (0.5 + 0.35 * Math.sin(i * 2.3));
    ctx.beginPath();
    ctx.moveTo(-60, yBase);
    ctx.quadraticCurveTo(width * 0.5, yBase + Math.sin(globalT * 0.25 + i * 1.3) * waveAmp, width + 60, yBase - 40);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAtmosphere(ctx, globalT, width, height, accentColor, system, backgroundMood) {
  drawGradientBase(ctx, width, height, system, accentColor, backgroundMood);
  // Glow blob and grain both read as "moody dark texture" - fine on a
  // dark resolved background, but a blurred glow reads as a smudge
  // and grain reads as dirt on a light one. Now driven by the actual
  // resolved mood, not a fixed per-system flag, since any system can
  // resolve to either mood now.
  const resolvedMood = backgroundMood || system.defaultBackgroundMood || 'dark';
  const isLight = resolvedMood === 'light';
  if (system.showGlowBlob && !isLight) drawGlowBlob(ctx, globalT, width, height, accentColor);
  if (system.flatBlockAccent) drawFlatBlocks(ctx, globalT, width, height, accentColor);
  if (system.showDriftLines) drawDriftLines(ctx, globalT, width, height, accentColor, system.driftLineCount || 3, system.driftLineOpacity || 0.12);
  drawVignette(ctx, width, height, system);
  if (!isLight && system.name !== 'boldGraphic') drawGrain(ctx, globalT, width, height);
}

/**
 * Called separately from drawAtmosphere, WITHIN the camera-transformed
 * block (see renderEngine.js) - these particles exist at fixed WORLD
 * positions and pan with the camera like real objects in the world,
 * unlike the gradient/vignette/grain above which stay locked to the
 * screen as lighting/lens effects.
 */
function drawWorldParticles(ctx, globalT, worldWidth, height, accentColor, system) {
  if (!system.showParticles) return;
  const seeds = getParticleSeeds(worldWidth);
  ctx.save();

  const alphaMul = system.name === 'softEditorial' ? 0.5 : 1;
  const groups = { accent: [], muted: [] };

  for (const p of seeds) {
    const speed = lerp(0.004, 0.02, p.depth);
    const size = lerp(1, 3, p.depth);
    const driftX = Math.sin(globalT * speed * 20 + p.phase) * 20 * p.depth;
    const driftY = (globalT * speed * 15 + p.y * height) % (height + 40) - 20;
    const isAccent = system.name === 'hudTerminal' && p.depth > 0.75;
    (isAccent ? groups.accent : groups.muted).push({ x: p.worldX + driftX, y: driftY, size, depth: p.depth });
  }

  for (const [key, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    ctx.beginPath();
    for (const pt of list) {
      // Accent particles render bigger and blurred - real soft glowing
      // embers, confirmed safe and correct in earlier testing.
      const emberSize = key === 'accent' ? pt.size * 2.4 : pt.size;
      ctx.moveTo(pt.x + emberSize, pt.y);
      ctx.arc(pt.x, pt.y, emberSize, 0, Math.PI * 2);
    }
    const avgDepth = list.reduce((s, p) => s + p.depth, 0) / list.length;
    ctx.save();
    if (key === 'accent') {
      ctx.filter = 'blur(3px)';
      ctx.globalAlpha = lerp(0.25, 0.55, avgDepth) * alphaMul;
    } else {
      ctx.globalAlpha = lerp(0.04, 0.13, avgDepth) * alphaMul;
    }
    ctx.fillStyle = key === 'accent' ? accentColor : system.mutedTextColor;
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawGlowBlob(ctx, globalT, width, height, accentColor) {
  const x = width * 0.5 + Math.sin(globalT * 0.15) * width * 0.15;
  const y = height * 0.3 + Math.cos(globalT * 0.1) * height * 0.08;
  // Slow "breathing" intensity, not a fixed constant - real graded
  // footage never sits at exactly one brightness for a whole video.
  // Period of ~11s so it never syncs suspiciously with the 20s camera
  // cycle or any scene's own duration.
  const breathe = 0.5 + Math.sin(globalT * (Math.PI * 2 / 11)) * 0.5;
  ctx.save();
  ctx.filter = 'blur(80px)';
  ctx.globalAlpha = lerp(0.08, 0.16, breathe);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(x, y, 180, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'none';
  ctx.restore();
}

function drawGradientBase(ctx, width, height, system, accentColor, backgroundMood) {
  // Real background color AND lightness variety now - hue always
  // comes from the video's own accent color, and mood (dark vs
  // light) is a genuine per-video choice instead of every system
  // being mathematically locked to one lightness class forever.
  let inner = system.bgColorInner;
  let outer = system.bgColorOuter;
  if (system.supportsBackgroundMood && accentColor) {
    const resolvedMood = backgroundMood || system.defaultBackgroundMood || 'dark';
    const tint = resolvedMood === 'light'
      ? deriveLightBackgroundTint(accentColor)
      : resolvedMood === 'bold'
        ? deriveBoldGradientTint(accentColor)
        : deriveDarkBackgroundTint(accentColor);
    inner = tint.inner;
    outer = tint.outer;
  }
  const grad = ctx.createRadialGradient(
    width / 2, height * 0.35, 0,
    width / 2, height * 0.35, height * 0.9
  );
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
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
  // Complete rebuild - this was two flat, hard-edged color blocks
  // with an abrupt cut against a pure-black center, confirmed
  // directly by rendering it in isolation and looking. Real gradients
  // now, on both the side accents AND the center panel (previously
  // only hudTerminal ever got a background tint at all), plus a soft
  // feathered transition instead of a hard vertical seam.
  ctx.save();
  const slide = Math.sin(globalT * 0.2) * 20;

  const leftW = width * 0.22 + slide;
  const leftGrad = ctx.createLinearGradient(0, 0, leftW, 0);
  leftGrad.addColorStop(0, accentColor);
  leftGrad.addColorStop(1, shadeColor(accentColor, -0.35));
  ctx.fillStyle = leftGrad;
  ctx.fillRect(0, 0, leftW, height);

  const rightW = width * 0.12;
  const rightGrad = ctx.createLinearGradient(width - rightW, 0, width, 0);
  rightGrad.addColorStop(0, shadeColor(accentColor, -0.35));
  rightGrad.addColorStop(1, accentColor);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = rightGrad;
  ctx.fillRect(width - rightW, 0, rightW, height);
  ctx.globalAlpha = 1;

  // Feathered seam instead of a hard cut, on both boundaries.
  const featherW = 40;
  [leftW, width - rightW].forEach((seamX) => {
    const feather = ctx.createLinearGradient(seamX - featherW / 2, 0, seamX + featherW / 2, 0);
    feather.addColorStop(0, 'rgba(0,0,0,0)');
    feather.addColorStop(0.5, 'rgba(0,0,0,0.25)');
    feather.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = feather;
    ctx.fillRect(seamX - featherW / 2, 0, featherW, height);
  });
  ctx.restore();
}

/**
 * Lightens (positive amount) or darkens (negative) a hex color by a
 * fraction - simple, safe, no external dependency, used to build a
 * two-stop gradient from a single accent color.
 */
function shadeColor(hex, amount) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  const adjust = (c) => Math.max(0, Math.min(255, Math.round(c + (amount > 0 ? (255 - c) * amount : c * amount))));
  r = adjust(r); g = adjust(g); b = adjust(b);
  return `rgb(${r},${g},${b})`;
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
  // Same breathing principle as the glow blob, different period (7s
  // vs 11s) so the two never move in lockstep with each other.
  const breathe = 0.5 + Math.sin(globalT * (Math.PI * 2 / 7)) * 0.5;
  ctx.globalAlpha = lerp(0.03, 0.07, breathe);
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

module.exports = { drawAtmosphere, drawWorldParticles };
