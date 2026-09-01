const { createCanvas } = require('@napi-rs/canvas');
const { hash01 } = require('./selectors');
const { toneWeights } = require('./colorGrading');
const { clamp01 } = require('./mathUtils');

/**
 * Noise & Grain: addNoise (simple, uniform per-pixel), addGrain (real
 * film-grain simulation), and Fractal Noise (a genuine, classic 2D
 * Perlin gradient noise implementation with fractal Brownian motion
 * octave summation - the actual algorithmic basis AE's own Fractal
 * Noise effect is built on, not a simplified stand-in for it).
 */

function clampByte(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * A real Gaussian-distributed random value via the Box-Muller
 * transform - the standard technique for turning two independent
 * uniform random numbers into a genuinely normally-distributed one
 * (not just clamped/averaged uniform noise). Film grain's actual
 * intensity distribution is much closer to Gaussian than uniform
 * (most grains are near-average density, with fewer strong outliers),
 * which is why real grain simulation tools use this and a flat random
 * spread looks visibly "off" by comparison. Deterministic (via
 * selectors.js's already-verified hash01), not Math.random - matching
 * every other source of randomness in this engine.
 */
function gaussianRandom(seedA, seedB) {
  const u1 = Math.max(hash01(seedA), 1e-6); // avoid log(0)
  const u2 = hash01(seedB);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * AE's Add Grain: real per-pixel Gaussian noise, with two things a
 * naive "add random noise" implementation misses:
 * 1. Grain SIZE: real film grain isn't single-pixel noise - grains
 *    have physical extent. Generated at a coarser resolution
 *    (width/height divided by `size`) and each destination pixel reads
 *    its containing coarse cell's value (nearest-neighbor upsampling,
 *    matching grain's actual blocky/clumped look rather than a smooth
 *    gradient a bilinear upsample would introduce).
 * 2. Tonal weighting: real film grain is most visible in SHADOWS and
 *    least visible in bright highlights (a real photochemical property
 *    of film) - reuses colorGrading.js's toneWeights directly (the
 *    same shadows/midtones/highlights weighting Color Balance uses),
 *    a genuine, deliberate cross-effect reuse rather than a separate
 *    ad-hoc falloff curve.
 */
function addGrain(imageData, { intensity = 0.15, size = 1, seed = 0 } = {}) {
  const { width, height, data } = imageData;
  const grainW = Math.max(1, Math.round(width / size));
  const grainH = Math.max(1, Math.round(height / size));
  const grainBuf = new Float32Array(grainW * grainH);
  for (let i = 0; i < grainBuf.length; i++) {
    grainBuf[i] = gaussianRandom(i * 12.9898 + seed * 3.7 + 1, i * 78.233 + seed * 91.7 + 1);
  }

  for (let y = 0; y < height; y++) {
    const gy = Math.min(grainH - 1, Math.floor((y * grainH) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(grainW - 1, Math.floor((x * grainW) / width));
      const g = grainBuf[gy * grainW + gx];
      const idx = (y * width + x) * 4;
      const luma = (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255;
      const [sw, mw, hw] = toneWeights(luma);
      const toneScale = sw * 1.2 + mw * 1.0 + hw * 0.6; // shadows most affected, highlights least - matches real film behavior
      const delta = g * intensity * 255 * toneScale;
      data[idx] = clampByte(Math.round(data[idx] + delta));
      data[idx + 1] = clampByte(Math.round(data[idx + 1] + delta));
      data[idx + 2] = clampByte(Math.round(data[idx + 2] + delta));
    }
  }
  return imageData;
}

/** AE's simpler Noise effect: flat uniform noise (no tonal weighting, no grain-size clumping), optionally monochrome (same delta on all 3 channels, vs `false` giving each channel independent noise). */
function addNoise(imageData, { amount = 20, monochrome = false, seed = 0 } = {}) {
  const { width, height, data } = imageData;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const base = x * 12.9898 + y * 78.233 + seed * 3.1;
      if (monochrome) {
        const n = (hash01(base) - 0.5) * 2 * amount;
        data[idx] = clampByte(Math.round(data[idx] + n));
        data[idx + 1] = clampByte(Math.round(data[idx + 1] + n));
        data[idx + 2] = clampByte(Math.round(data[idx + 2] + n));
      } else {
        data[idx] = clampByte(Math.round(data[idx] + (hash01(base) - 0.5) * 2 * amount));
        data[idx + 1] = clampByte(Math.round(data[idx + 1] + (hash01(base + 17.3) - 0.5) * 2 * amount));
        data[idx + 2] = clampByte(Math.round(data[idx + 2] + (hash01(base + 34.7) - 0.5) * 2 * amount));
      }
    }
  }
  return imageData;
}

// ---------------------------------------------------------------------
// Fractal Noise: a genuine, classic 2D Perlin gradient noise
// implementation - the real algorithm (Ken Perlin's, including his
// 2002 "Improving Noise" fade curve fix), not a simplified stand-in.
// ---------------------------------------------------------------------

/** A deterministic (hash01-driven, not Math.random) permutation table via Fisher-Yates - the same seeded-shuffle technique selectors.js's seededPermutation already uses, reimplemented here at the 256-entry size Perlin noise specifically needs, doubled to 512 to avoid index-wrapping checks in the inner hot loop. */
function buildPermutation(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(hash01(i * 7.919 + seed * 13.37) * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

// The 8 principal gradient directions used for 2D Perlin noise (a
// standard, real simplification of Perlin's original 3D gradient set,
// specifically valid for 2D - each is a unit-length-or-45-degree
// direction, giving well-distributed gradient coverage).
const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** Ken Perlin's IMPROVED fade curve from "Improving Noise" (2002): 6t^5-15t^4+10t^3 - the real formula (not a plain smoothstep/3t^2-2t^3) specifically chosen because its second derivative is also zero at t=0 and t=1, eliminating a visible second-derivative discontinuity the original 1985 Perlin noise had at cell boundaries. */
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function gradDot(perm, ix, iy, x, y) {
  const idx = perm[(ix + perm[iy & 255]) & 255] % 8;
  const [gx, gy] = GRAD2[idx];
  return gx * x + gy * y;
}

/** Real 2D Perlin noise at a single point - bilinear interpolation (via the improved fade curve, not a plain lerp) of the 4 surrounding grid corners' gradient dot products. Output is approximately in -1..1 (not strictly bounded for this gradient set, but close enough that callers remapping to 0-1 rarely see clipping). */
function perlin2D(perm, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const sx = fade(x - x0), sy = fade(y - y0);
  const n00 = gradDot(perm, x0, y0, x - x0, y - y0);
  const n10 = gradDot(perm, x1, y0, x - x1, y - y0);
  const n01 = gradDot(perm, x0, y1, x - x0, y - y1);
  const n11 = gradDot(perm, x1, y1, x - x1, y - y1);
  const ix0 = n00 + sx * (n10 - n00);
  const ix1 = n01 + sx * (n11 - n01);
  return ix0 + sy * (ix1 - ix0);
}

/** Fractal Brownian motion (fBm): sums several OCTAVES of the same Perlin noise at increasing frequency (lacunarity) and decreasing amplitude (persistence) - the real, standard technique behind every "natural-looking" procedural noise texture (clouds, marble, terrain), not just one noise call scaled up. Normalized by the total amplitude summed so the result stays roughly -1..1 regardless of octave count. */
function fractalNoise2D(perm, x, y, {
  octaves = 5, persistence = 0.5, lacunarity = 2, scale = 0.02,
} = {}) {
  let amplitude = 1, frequency = 1, sum = 0, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    sum += perlin2D(perm, x * scale * frequency, y * scale * frequency) * amplitude;
    maxAmp += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return maxAmp > 0 ? sum / maxAmp : 0;
}

/** Generates a fresh canvas of fractal (fBm Perlin) noise, remapped from its native -1..1 range into a gradient between colorA (low) and colorB (high) - matching AE's own Fractal Noise effect, which is fundamentally "grayscale coherent noise" that gets colorized/used as a matte. */
function fractalNoise(width, height, opts = {}) {
  const {
    seed = 0, octaves = 5, persistence = 0.5, lacunarity = 2, scale = 0.02, colorA = '#000000', colorB = '#ffffff',
  } = opts;
  const perm = buildPermutation(seed);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const [ar, ag, ab] = hexToRgb(colorA);
  const [br, bg, bb] = hexToRgb(colorB);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = fractalNoise2D(perm, x, y, {
        octaves, persistence, lacunarity, scale,
      });
      const t = clamp01((n + 1) / 2);
      const i = (y * width + x) * 4;
      imgData.data[i] = clampByte(Math.round(ar + (br - ar) * t));
      imgData.data[i + 1] = clampByte(Math.round(ag + (bg - ag) * t));
      imgData.data[i + 2] = clampByte(Math.round(ab + (bb - ab) * t));
      imgData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

module.exports = {
  addGrain, addNoise, fractalNoise, perlin2D, fractalNoise2D, buildPermutation, gaussianRandom,
};
