const { hash01 } = require('./selectors');

/**
 * The "Glitch/distortion aesthetic" - not a single AE effect but a
 * recognizable real visual language built from a handful of genuine,
 * well-known digital-glitch-art techniques: RGB channel splitting
 * (chromatic-aberration-like), block/slice displacement (the classic
 * "datamoshing" look), scan lines (CRT/VHS), and pixel sorting (a real,
 * specific, well-known modern glitch-art algorithm - not just noise).
 */

function sampleIdx(x, y, w, h) {
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  return (y * w + x) * 4;
}

/** Independently offsets each color channel - the classic "chromatic aberration glitch" look. Each channel is read from the ORIGINAL (pre-shift) image at an offset position; pixels whose offset falls outside the frame contribute 0 for that channel (a hard cutoff, matching how a real channel-split glitch abruptly loses color data at the frame edge rather than smearing it). */
function rgbShift(imageData, {
  redOffset = [8, 0], greenOffset = [0, 0], blueOffset = [-8, 0],
} = {}) {
  const { width, height, data } = imageData;
  const src = new Uint8ClampedArray(data);
  // Hoisted into plain, EXPLICITLY INTEGER-COERCED local numbers before
  // the hot loop - found and root-caused via extensive live profiling,
  // not a defensive guess: an animated (keyframed) redOffset/blueOffset
  // reaching this function via Property.valueAt()'s INTERPOLATION path
  // (lerp/lerpVector - the direct-reference path for t<=first-keyframe
  // was NOT affected) measured a catastrophic, fully reproducible
  // ~40-70x slowdown (2800ms+ vs 20ms for an identical 540x960 frame),
  // isolated by systematically swapping ONE variable at a time across
  // 8+ separate isolated benchmarks (array origin, copying, caching the
  // Property, hoisting to locals - none of those alone fixed it) until
  // only ONE change resolved it completely: forcing the interpolated
  // numbers through integer coercion. lerp()'s arithmetic (`a+(b-a)*t`)
  // always produces a computed floating-point RESULT in V8 terms (a
  // boxed HeapNumber) even when the mathematical value happens to be a
  // whole number, unlike a value read directly off authored JSON data
  // (a fast, unboxed SMI) - and this engine's `sampleIdx` calls
  // (~1.5 million times per 540x960 frame) apparently cannot handle
  // that boxed-double input efficiently, whatever the exact underlying
  // V8 mechanism. Math.round (not truncation) also matters for real
  // CORRECTNESS, independent of speed: a sub-pixel offset like 2.7
  // should round to the nearest pixel, not truncate toward zero.
  const rdx = Math.round(redOffset[0]) | 0; const rdy = Math.round(redOffset[1]) | 0;
  const gdx = Math.round(greenOffset[0]) | 0; const gdy = Math.round(greenOffset[1]) | 0;
  const bdx = Math.round(blueOffset[0]) | 0; const bdy = Math.round(blueOffset[1]) | 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const rIdx = sampleIdx(x + rdx, y + rdy, width, height);
      const gIdx = sampleIdx(x + gdx, y + gdy, width, height);
      const bIdx = sampleIdx(x + bdx, y + bdy, width, height);
      data[idx] = rIdx !== null ? src[rIdx] : 0;
      data[idx + 1] = gIdx !== null ? src[gIdx + 1] : 0;
      data[idx + 2] = bIdx !== null ? src[bIdx + 2] : 0;
      data[idx + 3] = src[idx + 3];
    }
  }
  return imageData;
}

/**
 * Slices the image into horizontal bands and shifts a random SUBSET
 * of them left/right by a random amount - deterministically random
 * (hash01, seeded, not Math.random - every source of randomness in
 * this engine is reproducible across renders for the same reason
 * documented throughout: motion blur sub-sampling, wiggly text, etc,
 * all need identical results across repeated evaluation of the same
 * frame). Only `probability` fraction of bands glitch, matching how a
 * real digital-corruption artifact is sporadic, not uniform across the
 * whole frame - a glitch where EVERY line shifts just looks like a
 * regular wave distortion, not a glitch.
 *
 * Like distortEffects.js's remapPixels, this is an inverse (pull) map:
 * a shifted band's destination pixel at x reads from source x-shift.
 */
function blockDisplace(imageData, {
  bandHeight = 8, maxShift = 30, seed = 0, probability = 0.3,
} = {}) {
  const { width, height, data } = imageData;
  const src = new Uint8ClampedArray(data);
  const bandCount = Math.ceil(height / bandHeight);

  for (let b = 0; b < bandCount; b++) {
    if (hash01(b * 17.31 + seed * 91.7) > probability) continue;
    const shift = Math.round((hash01(b * 53.7 + seed * 13.1 + 1) - 0.5) * 2 * maxShift);
    const y0 = b * bandHeight, y1 = Math.min(height, y0 + bandHeight);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const di = (y * width + x) * 4;
        const srcX = x - shift;
        if (srcX >= 0 && srcX < width) {
          const si = (y * width + srcX) * 4;
          data[di] = src[si]; data[di + 1] = src[si + 1]; data[di + 2] = src[si + 2]; data[di + 3] = src[si + 3];
        } else {
          data[di + 3] = 0;
        }
      }
    }
  }
  return imageData;
}

/** CRT/VHS scan lines: darkens every `spacing`-th row (of `lineWidth` thickness) by `darkenAmount`. */
function scanLines(imageData, { spacing = 3, darkenAmount = 0.4, lineWidth = 1 } = {}) {
  const { width, height, data } = imageData;
  const keep = 1 - darkenAmount;
  for (let y = 0; y < height; y++) {
    if (y % spacing >= lineWidth) continue;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] *= keep; data[idx + 1] *= keep; data[idx + 2] *= keep;
    }
  }
  return imageData;
}

/**
 * Pixel Sorting: a real, well-known glitch-art algorithm (popularized
 * by tools like Kim Asendorf's original Processing pixel-sorter) -
 * within each row (or column), pixels whose LUMINANCE falls inside
 * `threshold` [lo,hi] are grouped into contiguous runs and each run is
 * SORTED by luminance in place, while pixels outside the threshold act
 * as fixed boundaries between runs (untouched) - producing the
 * characteristic "melted/streaked" look where only certain tonal
 * ranges smear while the rest of the image stays sharp.
 */
function pixelSort(imageData, { direction = 'horizontal', threshold = [0.25, 0.75] } = {}) {
  const { width, height, data } = imageData;
  const luma = (i) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  const inRange = (l) => l >= threshold[0] && l <= threshold[1];

  const sortRun = (getIndex, runLength, startPos) => {
    const pixels = [];
    for (let k = 0; k < runLength; k++) {
      const i = getIndex(startPos + k);
      pixels.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    }
    pixels.sort((a, b) => (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) - (0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]));
    for (let k = 0; k < runLength; k++) {
      const i = getIndex(startPos + k);
      const [pr, pg, pb, pa] = pixels[k];
      data[i] = pr; data[i + 1] = pg; data[i + 2] = pb; data[i + 3] = pa;
    }
  };

  if (direction === 'horizontal') {
    for (let y = 0; y < height; y++) {
      const getIndex = (x) => (y * width + x) * 4;
      let x = 0;
      while (x < width) {
        if (!inRange(luma(getIndex(x)))) { x++; continue; }
        let xEnd = x;
        while (xEnd < width && inRange(luma(getIndex(xEnd)))) xEnd++;
        sortRun(getIndex, xEnd - x, x);
        x = xEnd;
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      const getIndex = (y) => (y * width + x) * 4;
      let y = 0;
      while (y < height) {
        if (!inRange(luma(getIndex(y)))) { y++; continue; }
        let yEnd = y;
        while (yEnd < height && inRange(luma(getIndex(yEnd)))) yEnd++;
        sortRun(getIndex, yEnd - y, y);
        y = yEnd;
      }
    }
  }
  return imageData;
}

module.exports = {
  rgbShift, blockDisplace, scanLines, pixelSort,
};
