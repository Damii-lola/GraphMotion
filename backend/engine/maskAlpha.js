const { createCanvas } = require('@napi-rs/canvas');
const { clamp01 } = require('./mathUtils');

/**
 * Masks, in AE, are vector paths that shape a layer's OWN visibility -
 * architecturally the same operation as a track matte (batch 3):
 * rasterize a shape to an alpha buffer, then cut the target down to it
 * via destination-in. The difference is only where the shape comes
 * from (a path defined ON this layer, vs. a whole separate layer) and
 * that several masks can combine before being applied once. This file
 * builds that alpha buffer; layerStack.js's applyMask (batch 3) is
 * reused as-is to actually apply it - no new "apply" logic needed.
 *
 * Confirmed directly before writing this (same discipline as every
 * batch): ctx.filter blur genuinely spreads alpha coverage outward in
 * proportion to its radius (a hard edge lands at ~50% alpha exactly at
 * its original position for a symmetric blur), and 'xor' compositing
 * matches true Porter-Duff XOR exactly. Both are load-bearing here.
 */

/**
 * Rasterizes ONE mask to a pure alpha buffer (fillStyle is irrelevant
 * - only the resulting shape's alpha matters to everything downstream).
 * `drawPath(ctx)` just needs to define and fill/stroke a shape.
 *
 * `expansion` (AE's Mask Expansion) grows (positive) or shrinks
 * (negative) the shape's boundary. There's no true polygon-offset
 * here (a real Minkowski-sum implementation is substantial machinery
 * on its own) - this uses the standard, legitimate approximation:
 * blur the hard edge outward by roughly the expansion amount, then
 * re-threshold it back to a hard edge at a LOW cut (recovers a
 * boundary further OUT, i.e. grown) or HIGH cut (recovers a boundary
 * further IN, i.e. shrunk). Not exact for sharp corners, but correct
 * in the way that matters for a feathered/organic mask boundary,
 * which is the overwhelmingly common real use case.
 *
 * `feather` (AE's Mask Feather) softens the final edge the same way
 * real feathering IS blur - applied last, after any expansion.
 */
function rasterizeMask(drawPath, width, height, { feather = 0, expansion = 0 } = {}) {
  const hard = createCanvas(width, height);
  const hardCtx = hard.getContext('2d');
  hardCtx.fillStyle = '#ffffff';
  hardCtx.strokeStyle = '#ffffff';
  drawPath(hardCtx);

  let working = hard;

  if (expansion !== 0) {
    // Calibrated directly against this canvas build's real blur
    // behavior (not guessed): measured a hard edge blurred at radius
    // 10px landing at ~16% alpha exactly 10px outside the original
    // edge, and (by the symmetry of a gaussian error-function
    // transition) correspondingly near ~84% at 10px inside it - i.e.
    // blurRadius == |expansion| already lands the 15%/85% threshold
    // crossings at approximately the right offset. An earlier *1.6
    // factor here over-blurred relative to that measurement, eroding
    // well past the intended shrink distance - confirmed directly: a
    // 40px-wide shape shrunk by only 10px lost its ENTIRE interior
    // instead of shrinking by ~10px, because a radius-16 blur is
    // already enough to erode 20px in from the edge on its own.
    const blurRadius = Math.abs(expansion);
    const blurred = createCanvas(width, height);
    const blurredCtx = blurred.getContext('2d');
    blurredCtx.filter = `blur(${blurRadius}px)`;
    blurredCtx.drawImage(working, 0, 0);

    const threshold = expansion > 0 ? 0.15 : 0.85;
    const imgData = blurredCtx.getImageData(0, 0, width, height);
    for (let i = 3; i < imgData.data.length; i += 4) {
      imgData.data[i] = (imgData.data[i] / 255) > threshold ? 255 : 0;
    }
    const thresholded = createCanvas(width, height);
    thresholded.getContext('2d').putImageData(imgData, 0, 0);
    working = thresholded;
  }

  if (feather > 0) {
    const feathered = createCanvas(width, height);
    const featheredCtx = feathered.getContext('2d');
    featheredCtx.filter = `blur(${feather}px)`;
    featheredCtx.drawImage(working, 0, 0);
    working = feathered;
  }

  return working;
}

function perPixelAlphaCombine(accCanvas, nextCanvas, width, height, fn) {
  const accCtx = accCanvas.getContext('2d');
  const accData = accCtx.getImageData(0, 0, width, height);
  const nextData = nextCanvas.getContext('2d').getImageData(0, 0, width, height);
  for (let i = 3; i < accData.data.length; i += 4) {
    accData.data[i] = fn(accData.data[i], nextData.data[i]);
  }
  accCtx.putImageData(accData, 0, 0);
}

// Each of AE's mask combination modes maps to either a native,
// mathematically-exact canvas composite operation, or (Lighten/
// Darken, which have no native alpha-only max/min operator) explicit
// per-pixel math. Not approximated where an exact native op exists.
const MASK_MODE_HANDLERS = {
  add: (acc, next) => { acc.getContext('2d').drawImage(next, 0, 0); }, // plain source-over IS Porter-Duff "over" for alpha coverage, which is what AE's Add mode itself uses
  subtract: (acc, next) => { const c = acc.getContext('2d'); c.save(); c.globalCompositeOperation = 'destination-out'; c.drawImage(next, 0, 0); c.restore(); },
  intersect: (acc, next) => { const c = acc.getContext('2d'); c.save(); c.globalCompositeOperation = 'destination-in'; c.drawImage(next, 0, 0); c.restore(); },
  difference: (acc, next) => { const c = acc.getContext('2d'); c.save(); c.globalCompositeOperation = 'xor'; c.drawImage(next, 0, 0); c.restore(); },
  lighten: (acc, next, w, h) => perPixelAlphaCombine(acc, next, w, h, Math.max),
  darken: (acc, next, w, h) => perPixelAlphaCombine(acc, next, w, h, Math.min),
};

/**
 * Combines an ordered list of mask definitions - each
 * {drawPath, feather, expansion, opacity, mode} - into one final alpha
 * buffer, exactly as AE evaluates a layer's mask list top-to-bottom,
 * each new mask combined into the running result via its own mode.
 */
function combineMasks(maskDefs, width, height) {
  if (!maskDefs || maskDefs.length === 0) return null;
  let acc = null;
  maskDefs.forEach((def, i) => {
    let layer = rasterizeMask(def.drawPath, width, height, { feather: def.feather || 0, expansion: def.expansion || 0 });
    if (def.opacity !== undefined && def.opacity < 1) {
      const scaled = createCanvas(width, height);
      const sCtx = scaled.getContext('2d');
      sCtx.globalAlpha = clamp01(def.opacity);
      sCtx.drawImage(layer, 0, 0);
      layer = scaled;
    }
    if (i === 0) { acc = layer; return; }
    const handler = MASK_MODE_HANDLERS[def.mode || 'add'] || MASK_MODE_HANDLERS.add;
    handler(acc, layer, width, height);
  });
  return acc;
}

module.exports = { rasterizeMask, combineMasks, MASK_MODE_HANDLERS };
