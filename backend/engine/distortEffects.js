const { createCanvas } = require('@napi-rs/canvas');
const { clamp01 } = require('./mathUtils');

/**
 * AE's Distort category: every one of these effects is fundamentally
 * the same operation - "for each DESTINATION pixel, decide which
 * SOURCE coordinate to sample from" - so this file builds ONE real,
 * correct shared primitive (remapPixels, with true bilinear sampling)
 * and every named distort effect below is just a different mapping
 * function supplied to it, the same "one real primitive, several named
 * effects on top" pattern this session has used repeatedly (shapePath's
 * roundedPolygonFromVertices, maskAlpha's rasterizeMask, etc).
 *
 * Every mapping function here is written as the INVERSE map (dest ->
 * src), which is the standard, correct way to warp an image without
 * leaving holes - iterating destination pixels and looking up where to
 * sample guarantees every destination pixel gets a value; the opposite
 * approach (iterating source pixels and scattering them to destination
 * positions) leaves gaps wherever the forward mapping stretches space.
 */

/**
 * Real bilinear interpolation of a fractional (x,y) position from raw
 * ImageData - the standard, correct 4-neighbor weighted average, not
 * nearest-neighbor sampling (which would look visibly blocky/aliased
 * on any distortion with sub-pixel displacement). Returns [0,0,0,0]
 * (transparent) for any position that can't be fully bracketed by 4
 * real source pixels, rather than clamping to the edge - a distorted
 * image should reveal transparency where it pulls in content from
 * beyond the source's own bounds, not smear the edge pixel outward.
 */
function sampleBilinear(data, width, height, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height) return [0, 0, 0, 0];
  const fx = x - x0, fy = y - y0;
  const idx = (xx, yy) => (yy * width + xx) * 4;
  const p00 = idx(x0, y0), p10 = idx(x1, y0), p01 = idx(x0, y1), p11 = idx(x1, y1);
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = data[p00 + c] * (1 - fx) + data[p10 + c] * fx;
    const bottom = data[p01 + c] * (1 - fx) + data[p11 + c] * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/**
 * The shared distort primitive: for every pixel of a NEW canvas the
 * same size as sourceCanvas, calls mapFn(x,y) to get the source
 * coordinate to sample (bilinearly) from, and writes that sampled
 * color. mapFn returning [x,y] unchanged is the identity (no distortion)
 * for that pixel - every effect below relies on that to cleanly express
 * "beyond my radius/region, just pass through untouched."
 */
function remapPixels(sourceCanvas, mapFn) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const srcData = sourceCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const outCanvas = createCanvas(w, h);
  const outCtx = outCanvas.getContext('2d');
  const outImg = outCtx.createImageData(w, h);
  const outData = outImg.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = mapFn(x, y);
      const [r, g, b, a] = sampleBilinear(srcData, w, h, sx, sy);
      const i = (y * w + x) * 4;
      outData[i] = r; outData[i + 1] = g; outData[i + 2] = b; outData[i + 3] = a;
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Twirl: rotates pixels around `center` by an angle that's maximum at
 * the center and fades smoothly to zero at `radius` (smoothstep, not a
 * hard cutoff, so the boundary doesn't show a visible seam). Computed
 * as the INVERSE rotation (by -twistAmount) applied to the destination
 * offset, since remapPixels needs dest->src, not src->dest.
 */
function twirl(sourceCanvas, { center = null, radius = 200, angle = 90 } = {}) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const c = center || [w / 2, h / 2];
  const angleRad = (angle * Math.PI) / 180;
  return remapPixels(sourceCanvas, (x, y) => {
    const dx = x - c[0], dy = y - c[1];
    const dist = Math.hypot(dx, dy);
    if (dist >= radius) return [x, y];
    const twist = angleRad * smoothstep(radius, 0, dist);
    const ct = Math.cos(twist), st = Math.sin(twist);
    // Inverse of rotate-by-(+twist): rotate the destination offset by -twist.
    const srcDx = ct * dx + st * dy;
    const srcDy = -st * dx + ct * dy;
    return [c[0] + srcDx, c[1] + srcDy];
  });
}

/**
 * Bulge / Spherize (also covers Pinch/Punch as the same formula with
 * `power` on the other side of 1): remaps each destination pixel's
 * normalized distance-from-center (0-1 within `radius`) to
 * norm^power. power>1 makes DESTINATION pixels near the center sample
 * from an even SMALLER source radius - stretching central source
 * content outward to fill more of the frame, i.e. a magnifying bulge.
 * 0<power<1 does the reverse (pulls edge content inward - a pinch).
 * power=1 is the exact identity (verified in the test suite).
 */
function bulge(sourceCanvas, { center = null, radius = 200, power = 1.6 } = {}) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const c = center || [w / 2, h / 2];
  return remapPixels(sourceCanvas, (x, y) => {
    const dx = x - c[0], dy = y - c[1];
    const dist = Math.hypot(dx, dy);
    if (dist >= radius || dist === 0) return [x, y];
    const norm = dist / radius;
    const scale = (norm ** power) / norm;
    return [c[0] + dx * scale, c[1] + dy * scale];
  });
}

/**
 * Ripple: displaces each pixel along its OWN radial direction from
 * `center` by a sine wave of `dist`, optionally decaying with an
 * exponential falloff so the ripple weakens further from center - a
 * real, standard real-time-ripple-shader technique. Using the SAME
 * sine formula for the inverse map as the intended forward effect is
 * a deliberate, honestly-scoped simplification (the mathematically
 * exact inverse of a sine displacement has no closed form) - for
 * amplitude small relative to wavelength this is visually correct and
 * is what essentially every real-time ripple implementation does.
 */
function rippleWarp(sourceCanvas, {
  center = null, amplitude = 10, wavelength = 40, phase = 0, decay = 0,
} = {}) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const c = center || [w / 2, h / 2];
  return remapPixels(sourceCanvas, (x, y) => {
    const dx = x - c[0], dy = y - c[1];
    const dist = Math.hypot(dx, dy) || 1;
    const decayFactor = decay > 0 ? Math.exp(-dist * decay) : 1;
    const displacement = amplitude * decayFactor * Math.sin(((dist / wavelength) * Math.PI * 2) - phase);
    return [x + (dx / dist) * displacement, y + (dy / dist) * displacement];
  });
}

/** Wave Warp: a directional "flag wave" - each row (horizontal mode) or column (vertical mode) is offset by a sine wave of its own position along the perpendicular axis. */
function waveWarp(sourceCanvas, {
  amplitude = 10, wavelength = 60, phase = 0, direction = 'horizontal',
} = {}) {
  return remapPixels(sourceCanvas, (x, y) => {
    if (direction === 'horizontal') {
      const dx = amplitude * Math.sin(((y / wavelength) * Math.PI * 2) + phase);
      return [x + dx, y];
    }
    const dy = amplitude * Math.sin(((x / wavelength) * Math.PI * 2) + phase);
    return [x, y + dy];
  });
}

/**
 * Displacement Map: a SECOND image's channels drive per-pixel
 * displacement - AE's own convention (128/255 gray = zero
 * displacement, 0 = maximum negative, 255 = maximum positive) is
 * matched exactly: raw channel value remapped from 0-255 to -1..1
 * around a 0.5 midpoint, then scaled by maxDisplacement. The map is
 * itself resampled (nearest-neighbor - a coarse displacement map
 * doesn't need bilinear precision the way real color content does) if
 * its size differs from the source.
 *
 * Like every effect in this file, the returned [dx,dy] is added to the
 * DESTINATION coordinate to find the SOURCE to pull from (remapPixels'
 * inverse-map contract) - so a map with a strong POSITIVE X value at a
 * given destination pixel makes that pixel pull color from FURTHER in
 * +X, which reads on screen as the image content shifting in the
 * OPPOSITE (-X) direction. This is the standard "pull map" convention
 * for displacement/distortion maps (not a "push" map), consistent with
 * twirl/bulge/ripple above, all of which are also inverse maps - not
 * an arbitrary choice specific to this one effect.
 */
function displacementMap(sourceCanvas, mapCanvas, {
  maxDisplacement = 20, xChannel = 'r', yChannel = 'g',
} = {}) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const mw = mapCanvas.width, mh = mapCanvas.height;
  const mapData = mapCanvas.getContext('2d').getImageData(0, 0, mw, mh).data;
  const channelIndex = {
    r: 0, g: 1, b: 2, a: 3,
  };
  const xi = channelIndex[xChannel], yi = channelIndex[yChannel];

  return remapPixels(sourceCanvas, (x, y) => {
    const mx = Math.min(mw - 1, Math.max(0, Math.round((x * mw) / w)));
    const my = Math.min(mh - 1, Math.max(0, Math.round((y * mh) / h)));
    const idx = (my * mw + mx) * 4;
    const dx = ((mapData[idx + xi] / 255) - 0.5) * 2 * maxDisplacement;
    const dy = ((mapData[idx + yi] / 255) - 0.5) * 2 * maxDisplacement;
    return [x + dx, y + dy];
  });
}

module.exports = {
  remapPixels, sampleBilinear, twirl, bulge, rippleWarp, waveWarp, displacementMap,
};
