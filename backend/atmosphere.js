const { clamp01, lerp } = require('./easing');

/**
 * Every scene currently sat on flat #0A0A0B with nothing else - the
 * single biggest reason the output reads as "text on a void" instead
 * of "a designed environment". This module is the fix: a gradient
 * base (implies a light source instead of dead flat color), a vignette
 * (frames attention, implies a lens), procedural grain (kills banding
 * on the glow/gradient combo, gives black actual texture instead of
 * reading as a flat digital fill), and a slow-drifting particle field
 * (the environment is never fully static - "static backgrounds get
 * scrolled past").
 *
 * Deterministic per-frame: particle positions are seeded from a fixed
 * list computed once, not Math.random() per frame, so drift is smooth
 * and repeatable rather than flickering noise.
 */

const PARTICLE_COUNT = 28;
let particleSeeds = null;

function getParticleSeeds() {
  if (particleSeeds) return particleSeeds;
  // Simple deterministic PRNG (mulberry32) so the same seed always
  // produces the same particle field - reproducible renders, no
  // per-frame randomness causing flicker.
  let seed = 1337;
  function rand() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  particleSeeds = Array.from({ length: PARTICLE_COUNT }, () => ({
    x: rand(),
    y: rand(),
    depth: rand(), // 0 = far/background (slow, dim, small), 1 = near (faster, brighter, bigger)
    phase: rand() * Math.PI * 2,
  }));
  return particleSeeds;
}

/**
 * Draws the full atmosphere: gradient base, drifting particles,
 * vignette, grain - in that back-to-front order. `globalT` is the
 * video's overall elapsed time in seconds (not scene-local), so the
 * particle drift and subtle camera push are continuous across scene
 * cuts rather than resetting each scene, which is part of what makes
 * disconnected beats read as one continuous "world" instead of eight
 * separate exports stitched together.
 */
function drawAtmosphere(ctx, globalT, width, height, accentColor) {
  drawGradientBase(ctx, width, height);
  drawParticles(ctx, globalT, width, height, accentColor);
  drawVignette(ctx, width, height);
  drawGrain(ctx, globalT, width, height);
}

function drawGradientBase(ctx, width, height) {
  // Near-black, not pure #000 (pure black crushes/bands on phone
  // screens per the notes) with a very faint implied light source
  // from upper area, instead of one flat fill color.
  const grad = ctx.createRadialGradient(
    width / 2, height * 0.35, 0,
    width / 2, height * 0.35, height * 0.9
  );
  grad.addColorStop(0, '#141416');
  grad.addColorStop(1, '#08080A');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

function drawParticles(ctx, globalT, width, height, accentColor) {
  const seeds = getParticleSeeds();
  ctx.save();
  for (const p of seeds) {
    // Depth cue: far particles drift slower and stay dimmer/smaller,
    // near particles move more and read brighter/bigger - parallax
    // and atmospheric-perspective cues from a single loop.
    const speed = lerp(0.004, 0.02, p.depth);
    const size = lerp(1, 3, p.depth);
    const baseAlpha = lerp(0.04, 0.13, p.depth);

    const driftX = Math.sin(globalT * speed * 20 + p.phase) * 20 * p.depth;
    const driftY = (globalT * speed * 15 + p.y * height) % (height + 40) - 20;

    const x = p.x * width + driftX;
    const y = driftY;

    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = p.depth > 0.75 ? accentColor : '#FFFFFF';
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawVignette(ctx, width, height) {
  const grad = ctx.createRadialGradient(
    width / 2, height / 2, height * 0.35,
    width / 2, height / 2, height * 0.75
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

// Grain: a small tile of noise regenerated occasionally (not every
// frame - too expensive at full-canvas resolution for little visual
// gain) and stamped across the frame at low opacity.
let grainTile = null;
let grainTileCanvas = null;

function getGrainTile(createCanvasFn) {
  if (grainTile) return grainTile;
  const size = 128;
  grainTileCanvas = createCanvasFn(size, size);
  const gctx = grainTileCanvas.getContext('2d');
  const imgData = gctx.createImageData(size, size);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const v = Math.random() * 255;
    imgData.data[i] = v;
    imgData.data[i + 1] = v;
    imgData.data[i + 2] = v;
    imgData.data[i + 3] = 255;
  }
  gctx.putImageData(imgData, 0, 0);
  grainTile = grainTileCanvas;
  return grainTile;
}

function drawGrain(ctx, globalT, width, height) {
  const { createCanvas } = require('@napi-rs/canvas');
  const tile = getGrainTile(createCanvas);
  const size = 128;

  ctx.save();
  ctx.globalAlpha = 0.035;
  ctx.globalCompositeOperation = 'overlay';
  // Offset the tile pattern per-frame so grain reads as film-like
  // motion rather than a static printed texture.
  const offsetX = (globalT * 47) % size;
  const offsetY = (globalT * 31) % size;
  for (let x = -size; x < width + size; x += size) {
    for (let y = -size; y < height + size; y += size) {
      ctx.drawImage(tile, x + offsetX, y + offsetY);
    }
  }
  ctx.restore();
}

module.exports = { drawAtmosphere };
