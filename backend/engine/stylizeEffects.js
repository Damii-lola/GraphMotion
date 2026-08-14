const { gaussianBlur } = require('./blurEffects');

/**
 * Stylize: Find Edges (real Sobel gradient), Emboss (directional
 * difference kernel), Posterize (level quantization), Mosaic (block
 * averaging), and Glow (threshold + blur + real screen-blend - reuses
 * blurEffects.js's gaussianBlur directly rather than a second blur
 * implementation, the same cross-file reuse discipline as textExtrude
 * reusing layerStyles/maskAlpha, or noiseEffects reusing colorGrading).
 */

function clampInt(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampByte(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

/**
 * The real Sobel operator kernels - the standard, textbook gradient-
 * estimation kernels for edge detection. Each approximates the image's
 * horizontal (SOBEL_X) or vertical (SOBEL_Y) intensity derivative via
 * a weighted 3x3 window, with the center row/column double-weighted
 * for noise resistance - that specific 1-2-1 weighting is what
 * distinguishes a Sobel kernel from a plain central-difference kernel.
 */
const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/** AE's Find Edges: real Sobel gradient magnitude sqrt(Gx^2+Gy^2) at every pixel, on the grayscale (luminance) image - the standard, mathematically correct edge-strength measure, not a guessed highlight-the-boundary approximation. `invert` flips to dark-edges-on-light (matching AE's own toggle). */
function findEdges(imageData, { invert = false } = {}) {
  const { width, height, data } = imageData;
  const src = new Uint8ClampedArray(data);
  const gray = (i) => 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let gx = 0, gy = 0, k = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sx = clampInt(x + kx, 0, width - 1), sy = clampInt(y + ky, 0, height - 1);
          const v = gray((sy * width + sx) * 4);
          gx += v * SOBEL_X[k];
          gy += v * SOBEL_Y[k];
          k++;
        }
      }
      const mag = Math.min(255, Math.hypot(gx, gy));
      const val = invert ? 255 - mag : mag;
      const idx = (y * width + x) * 4;
      data[idx] = val; data[idx + 1] = val; data[idx + 2] = val;
    }
  }
  return imageData;
}

/** AE's Emboss: a directional-difference kernel - each pixel becomes the (strength-scaled) luminance difference between two points offset in opposite directions along `angle`, centered on neutral gray (128). Rounds the offset to the nearest of the 8 principal directions for the classic, clean emboss look (a true sub-pixel-angle offset would just blur the result, not sharpen the directional relief). */
function emboss(imageData, { strength = 1, angle = 135 } = {}) {
  const { width, height, data } = imageData;
  const src = new Uint8ClampedArray(data);
  const gray = (i) => 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
  const rad = (angle * Math.PI) / 180;
  const dx = Math.round(Math.cos(rad)), dy = Math.round(Math.sin(rad));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = clampInt(x - dx, 0, width - 1), y0 = clampInt(y - dy, 0, height - 1);
      const x1 = clampInt(x + dx, 0, width - 1), y1 = clampInt(y + dy, 0, height - 1);
      const diff = (gray((y1 * width + x1) * 4) - gray((y0 * width + x0) * 4)) * strength;
      const val = clampByte(Math.round(128 + diff));
      const idx = (y * width + x) * 4;
      data[idx] = val; data[idx + 1] = val; data[idx + 2] = val;
    }
  }
  return imageData;
}

/** AE's Posterize: quantizes each channel to `levels` evenly-spaced values (2 = pure black/white per channel, matching AE's own minimum). */
function posterize(imageData, { levels = 4 } = {}) {
  const { data } = imageData;
  const n = Math.max(2, levels);
  const step = 255 / (n - 1);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clampByte(Math.round(Math.round(data[i] / step) * step));
    data[i + 1] = clampByte(Math.round(Math.round(data[i + 1] / step) * step));
    data[i + 2] = clampByte(Math.round(Math.round(data[i + 2] / step) * step));
  }
  return imageData;
}

/** AE's Mosaic: averages every blockSize x blockSize block into one flat color - real block-pixelation, not a blur (a blur softens edges continuously; mosaic produces hard block boundaries with genuinely uniform color inside each block). */
function mosaic(imageData, { blockSize = 10 } = {}) {
  const { width, height, data } = imageData;
  const b = Math.max(1, blockSize);
  for (let by = 0; by < height; by += b) {
    const yEnd = Math.min(height, by + b);
    for (let bx = 0; bx < width; bx += b) {
      const xEnd = Math.min(width, bx + b);
      let r = 0, g = 0, bl = 0, a = 0, count = 0;
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          const i = (y * width + x) * 4;
          r += data[i]; g += data[i + 1]; bl += data[i + 2]; a += data[i + 3]; count++;
        }
      }
      r = Math.round(r / count); g = Math.round(g / count); bl = Math.round(bl / count); a = Math.round(a / count);
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          const i = (y * width + x) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = bl; data[i + 3] = a;
        }
      }
    }
  }
  return imageData;
}

/**
 * AE's Stylize > Glow: extracts pixels ABOVE `threshold` luminance
 * (scaled by how far above threshold they are, so a barely-bright
 * pixel contributes a faint glow and a fully-white pixel contributes a
 * strong one - not a hard cutoff mask), blurs that extracted bright
 * layer (reusing blurEffects.js's gaussianBlur directly), and composites
 * it back over the ORIGINAL image using the real "screen" blend
 * formula (1-(1-a)(1-b) per channel - the same mathematically correct
 * formula layerStack.js's BLEND_MODE_MAP already implements via
 * canvas's native 'screen' operator, computed directly here since this
 * operates on raw ImageData rather than compositing two canvases).
 * This is a genuinely different mechanism from batch 4's Outer Glow
 * layer style (which glows a layer's own ALPHA silhouette boundary) -
 * Stylize Glow glows based on the image's own BRIGHTNESS content,
 * which is why it can make an already-rendered photo's bright windows
 * or highlights bloom, something an alpha-based glow cannot do.
 */
function autoGlow(imageData, { threshold = 0.7, blurRadius = 15, intensity = 1 } = {}) {
  const { width, height, data } = imageData;
  const brightData = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const factor = luma > threshold ? (luma - threshold) / (1 - threshold) : 0;
    brightData[i] = data[i] * factor;
    brightData[i + 1] = data[i + 1] * factor;
    brightData[i + 2] = data[i + 2] * factor;
    brightData[i + 3] = 255;
  }
  const brightImgData = { data: brightData, width, height };
  gaussianBlur(brightImgData, { radius: blurRadius });

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const base = data[i + c] / 255;
      const glow = (brightData[i + c] / 255) * intensity;
      data[i + c] = clampByte(Math.round((1 - (1 - base) * (1 - glow)) * 255));
    }
  }
  return imageData;
}

module.exports = {
  findEdges, emboss, posterize, mosaic, autoGlow,
};
