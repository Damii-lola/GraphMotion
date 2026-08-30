const { createCanvas } = require('@napi-rs/canvas');
const { clamp01 } = require('./mathUtils');

/**
 * The compositor underneath three AE concepts at once, because in AE
 * they're all facets of the same thing: a COMPOSITION's layer stack,
 * rendered bottom-to-top, where each layer can (a) blend with
 * everything already composited below it via something other than
 * plain alpha-over, (b) have its own visibility carved out by another
 * layer's shape/brightness, or (c) - if it's an adjustment layer -
 * skip having content of its own entirely and instead post-process
 * everything below it in place. All three require the SAME underlying
 * mechanism: render each layer to its own isolated buffer, then
 * composite/matte/post-process against a shared accumulator canvas
 * that genuinely represents "everything so far," in stack order.
 *
 * DELIBERATELY SCOPED to Composition, not generic Node-with-children:
 * this is faithful to AE itself, not an arbitrary limitation - blend
 * modes/track mattes/adjustment layers are real Composition-level
 * concepts there too. A plain Node with children (a parenting rig,
 * batch 2) doesn't need this; if you want layer-stack behavior at some
 * point in a hierarchy, that's exactly what a nested Composition/
 * PrecompNode already models.
 *
 * IMPORTANT, confirmed by direct testing against this napi-rs/canvas
 * build before writing any of this: globalCompositeOperation blend
 * modes and destination-in matte compositing are only mathematically
 * correct here when the SOURCE being composited is a real image
 * (drawImage of an already-rendered canvas) - compositing a raw
 * shape fill (fillRect/etc) with its own alpha under a non-default
 * composite operation double-applies that alpha (verified directly:
 * a 50%-alpha destination-in fillRect produced 25% instead of 50%).
 * Every compositing step below therefore ALWAYS renders a layer to
 * its own full canvas first and composites that canvas via drawImage
 * - never a bare shape fill under a custom composite operation.
 */

// AE's blend-mode names mapped to the W3C/Canvas globalCompositeOperation
// strings that implement the identical, standardized blend formulas.
const BLEND_MODE_MAP = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  colorDodge: 'color-dodge',
  colorBurn: 'color-burn',
  hardLight: 'hard-light',
  softLight: 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  add: 'lighter',
};

/**
 * Converts a rendered canvas's LUMINANCE (Rec.709 coefficients, the
 * modern standard used across video/graphics tooling) into its ALPHA
 * channel, weighted by the source's own existing alpha so a
 * transparent-but-bright pixel doesn't accidentally read as "fully
 * visible" by coincidence. This is the real mechanism a luma track
 * matte needs - destination-in only ever looks at alpha, so a matte
 * driven by brightness has to have that brightness moved into alpha
 * first, on a fresh derived buffer (the matte's own RGB is discarded;
 * only its shape-via-luminance matters from here on).
 */
function luminanceToAlphaMask(sourceCanvas, { inverted = false } = {}) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const imgData = sourceCanvas.getContext('2d').getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    let luma = ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * (a / 255);
    if (inverted) luma = 1 - luma;
    data[i + 3] = Math.round(clamp01(luma) * 255);
  }
  const maskCanvas = createCanvas(w, h);
  maskCanvas.getContext('2d').putImageData(imgData, 0, 0);
  return maskCanvas;
}

/** Alpha-inverts a canvas's existing alpha channel, for an Alpha Inverted Matte. */
function invertAlpha(sourceCanvas) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const imgData = sourceCanvas.getContext('2d').getImageData(0, 0, w, h);
  for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255 - imgData.data[i];
  const out = createCanvas(w, h);
  out.getContext('2d').putImageData(imgData, 0, 0);
  return out;
}

/** Cuts targetCanvas down to maskCanvas's alpha shape, in place, via destination-in (always image-vs-image, per the correctness note above). */
function applyMask(targetCanvas, maskCanvas) {
  const ctx = targetCanvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.restore();
}

/**
 * Renders an ordered list of layer nodes (bottom of the array = bottom
 * of the stack) onto `ctx`, handling blendMode / trackMatte /
 * isAdjustmentLayer on each. `nodeRenderFn(node, ctx, t)` is the
 * caller-supplied function that actually draws one node (normally just
 * `(node, ctx, t) => node.render(ctx, t)`, kept as a parameter rather
 * than hardcoded so callers can wrap it - e.g. with motion blur - per
 * layer without this module needing to know about that).
 */
// Real, confirmed-live memory finding (not a classic leak - correctly
// freed, just far too much of it alive at once): this loop used to
// `createCanvas(width, height)` fresh for EVERY node, every single
// call - and this function is itself called up to `samples` times
// (motionBlur.js, currently 4) for ONE output frame. A beat with L
// decorative layers (content card, kicker pill/text, icon, accent bar,
// grain, headline - 6+ is now common since the dense-composition and
// content-matched-icon work) was allocating roughly samples*(L+1) full
// 540x960 native Skia buffers (~2MB each) for a SINGLE frame - the
// direct, measured reason peak RSS sat far above a <75MB target despite
// no single buffer ever being orphaned. Fixed by pooling: ONE
// `layerCanvas` and ONE `matteCanvas`, allocated once per
// renderLayerStack call (not per node) and cleared+reused for every
// node that needs one - correctness is unaffected (each node still
// gets a properly cleared, isolated buffer before it draws), only the
// allocation COUNT drops from O(layers) to O(1) per call.
function renderLayerStack(ctx, width, height, nodes, t, nodeRenderFn = (node, c, tt) => node.render(c, tt)) {
  const accumulator = createCanvas(width, height);
  const accCtx = accumulator.getContext('2d');

  // A node used as someone else's track-matte source is consumed
  // purely as a mask - it does not ALSO render independently into the
  // stack, matching AE auto-hiding a layer's own visibility the moment
  // it's picked as another layer's track matte.
  const matteSourceNodes = new Set(nodes.filter((n) => n.trackMatte).map((n) => n.trackMatte.source));

  let layerCanvas = null;
  let matteCanvas = null;

  for (const node of nodes) {
    if (matteSourceNodes.has(node)) continue;

    if (node.isAdjustmentLayer) {
      // No content of its own - it post-processes everything
      // composited so far, in place, then compositing continues from
      // the modified accumulator for every layer still above it.
      let imgData = accCtx.getImageData(0, 0, width, height);
      for (const effect of node.effects || []) {
        const result = effect(imgData, t);
        if (result) imgData = result;
      }
      accCtx.putImageData(imgData, 0, 0);
      continue;
    }

    if (!layerCanvas) layerCanvas = createCanvas(width, height);
    const layerCtx = layerCanvas.getContext('2d');
    layerCtx.clearRect(0, 0, width, height);
    nodeRenderFn(node, layerCtx, t);
    // A track matte replaces layerCanvas's own alpha (applyMask below),
    // so a lingering mask from a PREVIOUS node sharing this pooled
    // canvas can never bleed through - every node either gets its own
    // fresh matte applied or none at all, same as the un-pooled version.

    if (node.trackMatte) {
      if (!matteCanvas) matteCanvas = createCanvas(width, height);
      const matteCtx = matteCanvas.getContext('2d');
      matteCtx.clearRect(0, 0, width, height);
      nodeRenderFn(node.trackMatte.source, matteCtx, t);
      const type = node.trackMatte.type;
      let mask;
      if (type === 'luma' || type === 'lumaInverted') {
        mask = luminanceToAlphaMask(matteCanvas, { inverted: type === 'lumaInverted' });
      } else if (type === 'alphaInverted') {
        mask = invertAlpha(matteCanvas);
      } else {
        mask = matteCanvas; // 'alpha' - use the matte's own alpha channel directly
      }
      applyMask(layerCanvas, mask);
    }

    accCtx.save();
    accCtx.globalCompositeOperation = BLEND_MODE_MAP[node.blendMode || 'normal'] || 'source-over';
    accCtx.drawImage(layerCanvas, 0, 0);
    accCtx.restore();
  }

  ctx.drawImage(accumulator, 0, 0);
}

module.exports = { renderLayerStack, luminanceToAlphaMask, invertAlpha, applyMask, BLEND_MODE_MAP };
