const { createCanvas } = require('@napi-rs/canvas');
const { clamp01 } = require('./mathUtils');
const { applyMask } = require('./layerStack');

/**
 * Layer styles (drop shadow, glows, inner shadow, stroke) all derive
 * from the SAME thing: a rendered layer's alpha silhouette, recolored/
 * blurred/offset/re-clipped. This is deliberately built on top of
 * layerStack.js's applyMask (batch 3, image-vs-image destination-in,
 * already verified correct) rather than duplicating that logic - inner
 * glow/shadow specifically need "blur a silhouette, then clip it back
 * inside the original shape," which IS just applying the original
 * layer's own alpha as a mask onto the blurred, recolored copy.
 */

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** A copy of `layerCanvas` with its RGB replaced by `color`, alpha shape untouched - the "silhouette" every style below starts from. */
function silhouette(layerCanvas, color) {
  const w = layerCanvas.width, h = layerCanvas.height;
  const [r, g, b] = hexToRgb(color);
  const imgData = layerCanvas.getContext('2d').getImageData(0, 0, w, h);
  for (let i = 0; i < imgData.data.length; i += 4) {
    imgData.data[i] = r; imgData.data[i + 1] = g; imgData.data[i + 2] = b;
  }
  const out = createCanvas(w, h);
  out.getContext('2d').putImageData(imgData, 0, 0);
  return out;
}

function blurCanvas(canvas, radius) {
  if (radius <= 0) return canvas;
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * Drop Shadow: a blurred, offset, recolored silhouette drawn BEHIND
 * the original layer.
 */
function applyDropShadow(layerCanvas, { color = '#000000', opacity = 0.75, blur = 10, offsetX = 8, offsetY = 8 } = {}) {
  const w = layerCanvas.width, h = layerCanvas.height;
  const shadow = blurCanvas(silhouette(layerCanvas, color), blur);

  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.save();
  ctx.globalAlpha = clamp01(opacity);
  ctx.drawImage(shadow, offsetX, offsetY);
  ctx.restore();
  ctx.drawImage(layerCanvas, 0, 0);
  return out;
}

/**
 * Outer Glow: a blurred, recolored, NOT-offset silhouette drawn
 * OUTSIDE the shape (radiating from the edge), composited with
 * 'screen' by default so it reads as adding light rather than a flat
 * colored halo - the real reason a glow looks like light and a shadow
 * looks like a shadow is exactly this blend-mode choice, not the blur
 * itself (layerStack.js's BLEND_MODE_MAP is reused directly here, so
 * the same verified-correct compositing math from batch 3 backs this).
 */
function applyOuterGlow(layerCanvas, { color = '#FFD966', opacity = 0.9, blur = 16, blendMode = 'screen' } = {}) {
  const w = layerCanvas.width, h = layerCanvas.height;
  const glow = blurCanvas(silhouette(layerCanvas, color), blur);
  const { BLEND_MODE_MAP } = require('./layerStack');

  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.save();
  ctx.globalAlpha = clamp01(opacity);
  ctx.globalCompositeOperation = BLEND_MODE_MAP[blendMode] || 'screen';
  ctx.drawImage(glow, 0, 0);
  ctx.restore();
  ctx.drawImage(layerCanvas, 0, 0);
  return out;
}

/**
 * Inner Glow / Inner Shadow: both blur a recolored silhouette, then
 * clip it BACK INSIDE the original shape (applyMask against the
 * original layer's own alpha) so the effect only shows within the
 * layer's own boundary, brightest/darkest near the edge and fading
 * toward the center - the defining visual difference from outer glow.
 * Distinguished only by blend mode (screen=lightens=glow,
 * multiply=darkens=shadow) and typically a smaller blur.
 */
function applyInnerEffect(layerCanvas, { color, opacity = 0.85, blur = 12, blendMode } = {}) {
  const w = layerCanvas.width, h = layerCanvas.height;
  const sil = blurCanvas(silhouette(layerCanvas, color), blur);
  applyMask(sil, layerCanvas); // clip the blurred glow back to the ORIGINAL shape
  const { BLEND_MODE_MAP } = require('./layerStack');

  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(layerCanvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = clamp01(opacity);
  ctx.globalCompositeOperation = BLEND_MODE_MAP[blendMode] || 'source-over';
  ctx.drawImage(sil, 0, 0);
  ctx.restore();
  return out;
}
const applyInnerGlow = (layerCanvas, opts = {}) => applyInnerEffect(layerCanvas, { color: '#FFD966', blendMode: 'screen', ...opts });
const applyInnerShadow = (layerCanvas, opts = {}) => applyInnerEffect(layerCanvas, { color: '#000000', blendMode: 'multiply', ...opts });

/**
 * Stroke: an outline along the shape's boundary. Built from the SAME
 * blur+rethreshold dilate/erode approximation maskAlpha.js uses for
 * Mask Expansion (reused directly, not reimplemented) - a "centered"
 * stroke of width W is (dilate by W/2) MINUS (erode by W/2); "outside"
 * is (dilate by W) minus the original; "inside" is the original minus
 * (erode by W).
 */
function dilateErodeAlpha(sourceCanvas, amount, width, height) {
  const { rasterizeMask } = require('./maskAlpha');
  return rasterizeMask((ctx) => ctx.drawImage(sourceCanvas, 0, 0), width, height, { expansion: amount });
}

function subtractAlpha(aCanvas, bCanvas, width, height) {
  const out = createCanvas(width, height);
  const ctx = out.getContext('2d');
  ctx.drawImage(aCanvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(bCanvas, 0, 0);
  ctx.restore();
  return out;
}

function applyStroke(layerCanvas, { color = '#FFFFFF', width = 6, align = 'center' } = {}) {
  const w = layerCanvas.width, h = layerCanvas.height;
  let ring;
  if (align === 'outside') {
    ring = subtractAlpha(dilateErodeAlpha(layerCanvas, width, w, h), layerCanvas, w, h);
  } else if (align === 'inside') {
    ring = subtractAlpha(layerCanvas, dilateErodeAlpha(layerCanvas, -width, w, h), w, h);
  } else {
    ring = subtractAlpha(dilateErodeAlpha(layerCanvas, width / 2, w, h), dilateErodeAlpha(layerCanvas, -width / 2, w, h), w, h);
  }
  const strokeSil = silhouette(ring, color);

  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  if (align === 'outside') { ctx.drawImage(strokeSil, 0, 0); ctx.drawImage(layerCanvas, 0, 0); }
  else { ctx.drawImage(layerCanvas, 0, 0); ctx.drawImage(strokeSil, 0, 0); }
  return out;
}

module.exports = {
  silhouette, blurCanvas, applyDropShadow, applyOuterGlow, applyInnerGlow, applyInnerShadow, applyStroke,
  // Exposed for pathOperations.js/shapeLayer.js (batch 6/7): a
  // rasterized Path Operation result needs the SAME dilate/erode ring
  // construction Stroke already uses, but WITHOUT also compositing the
  // original silhouette underneath (a stroke-only raster path has no
  // "original layer content" of its own to preserve) - reusing these
  // two directly avoids a second copy of the same ring math.
  dilateErodeAlpha, subtractAlpha,
};
