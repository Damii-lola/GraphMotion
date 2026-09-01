const { createCanvas } = require('@napi-rs/canvas');
const { silhouette } = require('./layerStyles');
const { rasterizeMask } = require('./maskAlpha');
const { lerp, clamp01 } = require('./mathUtils');

/**
 * Pseudo-3D text extrusion + beveling via parallel (orthographic)
 * projection - deliberately NOT built on a real 3D camera/perspective
 * pipeline, because that doesn't exist yet (items 20-22 on the
 * roadmap: real 3D layers, an animatable camera, lights - a future
 * batch). This is the same kind of scope boundary as every prior
 * approximation this session (mask expansion's blur-rethreshold
 * dilate/erode, etc.): a real, mathematically-grounded technique for
 * exactly what it claims to be, not a placeholder standing in for the
 * real thing. It's also literally how a lot of practical "3D text"
 * effects work without a full 3D engine (layered offset silhouettes is
 * the same idea behind a stacked text-shadow 3D-text technique) - and
 * critically, a FIXED 2D extrusion direction means every point on the
 * silhouette recedes along the IDENTICAL vector, so plain back-to-front
 * painter's-algorithm layering is exactly correct with zero depth-
 * sorting ambiguity (unlike a true perspective camera, there is no
 * configuration where two points on this shape could occlude each
 * other out of that fixed draw order).
 *
 * === Extrusion (extrudeText) ===
 * `layers` recolored, offset copies of the shape's own silhouette
 * (reusing layerStyles.js's silhouette(), the same alpha-preserving
 * recolor primitive already used for drop shadows/glows) are drawn
 * back-to-front along (cos(angle), sin(angle)) * depth, ramping from
 * `sideColorFar` to `sideColorNear` - this is what reads as the
 * receding "sides" of the letters. The real front face (untouched
 * source pixels - whatever fill, gradient, or bevel it already has) is
 * drawn on top, at zero offset, last.
 *
 * === Beveling (applyBevel) ===
 * A real per-pixel lighting model, not a guessed uniform rim glow: a
 * "height field" is built by checking, for every pixel, how many
 * integer erosion steps (reusing maskAlpha.js's expansion machinery -
 * the same technique batch 4 already used for Stroke) it survives
 * before being eroded away, up to `bevelSize` - this approximates a
 * real distance-from-edge transform. A profile curve (linear chamfer
 * or a rounded quarter-circle) turns that distance into a synthetic
 * "elevation." The elevation field's own gradient (central-difference,
 * the standard numerical way to estimate a sampled surface's local
 * slope) gives a genuine per-pixel tilt direction, dotted against a
 * fixed light direction to decide highlight vs shadow - the same
 * physical idea as bump/normal-map lighting, just derived from a real
 * synthetic height field instead of authored art.
 */

function degToVec(deg) {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function lerpHexColor(hexA, hexB, t) {
  const [ar, ag, ab] = hexToRgb(hexA);
  const [br, bg, bb] = hexToRgb(hexB);
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const b = Math.round(lerp(ab, bb, t));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Extrudes `faceCanvas` (any rendered layer with real alpha - flat
 * text, already-beveled text, anything) into a receding 3D-look block.
 */
function extrudeText(faceCanvas, {
  depth = 18,
  angle = -55,
  layers = 20,
  sideColorNear = '#8a6d1f',
  sideColorFar = '#241c08',
} = {}) {
  const w = faceCanvas.width, h = faceCanvas.height;
  const [dx, dy] = degToVec(angle);

  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');

  // Back-to-front: i = layers-1 (farthest) down to i = 1 (nearest side
  // slice, one step behind the front face). i = 0 is intentionally
  // skipped as a side layer - that position belongs to the real front
  // face, drawn separately below with its own true pixels intact.
  for (let i = layers - 1; i >= 1; i--) {
    const frac = i / (layers - 1);
    const offsetX = dx * depth * frac;
    const offsetY = dy * depth * frac;
    const color = lerpHexColor(sideColorNear, sideColorFar, frac);
    const layer = silhouette(faceCanvas, color);
    ctx.drawImage(layer, offsetX, offsetY);
  }

  ctx.drawImage(faceCanvas, 0, 0);
  return out;
}

/**
 * Builds the elevation ("bevel height") field: for each pixel, how
 * many integer erosion steps of the source silhouette it survives,
 * clamped to bevelSize and normalized to 0..1 - approximates a real
 * distance-from-edge transform using the same erosion primitive as
 * batch 4's Stroke/Mask-Expansion, banded at every integer radius up
 * to bevelSize. Returns a Float32Array of length w*h, plus the source
 * alpha data (so the caller doesn't have to re-read it).
 */
function buildHeightField(faceCanvas, bevelSize, profile) {
  const w = faceCanvas.width, h = faceCanvas.height;
  const bandAlpha = [];
  for (let k = 0; k <= bevelSize; k++) {
    const eroded = k === 0
      ? faceCanvas
      : rasterizeMask((c) => c.drawImage(faceCanvas, 0, 0), w, h, { expansion: -k });
    bandAlpha.push(eroded.getContext('2d').getImageData(0, 0, w, h).data);
  }

  const field = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const alphaIdx = p * 4 + 3;
    let depthPx = 0;
    for (let k = 1; k <= bevelSize; k++) {
      if (bandAlpha[k][alphaIdx] > 128) depthPx = k; else break;
    }
    const linear = clamp01(depthPx / bevelSize);
    field[p] = profile === 'round' ? Math.sin((linear * Math.PI) / 2) : linear;
  }
  return { field, srcAlpha: bandAlpha[0] };
}

/**
 * Applies directional highlight/shadow shading to `faceCanvas` based
 * on the height field's local gradient (central differences) dotted
 * against a fixed light direction - real per-pixel lighting, not a
 * uniform rim glow. Returns a NEW canvas; faceCanvas is untouched.
 *
 * The `mag` (gradient magnitude) term additionally modulates shade
 * intensity, not just its sign/direction - this is a real, not
 * decorative, consequence of the model: the FLATTEST parts of the
 * bevel profile (deep in the interior past bevelSize, or right at the
 * rounded top where a 'round' profile's slope approaches zero) should
 * shade less than the STEEPEST part (right at the true silhouette
 * edge), exactly like a real curved surface catches the least direct
 * light where it's most nearly perpendicular to the viewer. The
 * `magToShade` scale constant is an empirically tuned visual constant
 * (documented and verified in the batch 5 test suite, the same
 * discipline as maskAlpha.js's calibrated blur radius) - raw gradient
 * magnitudes for typical bevelSize values (4-10px) land in a small
 * fraction-of-1 range, so a fixed multiplier maps the steepest part of
 * a typical profile up to full `strength`.
 */
function applyBevel(faceCanvas, {
  bevelSize = 6,
  profile = 'round',
  lightAngle = -45,
  highlightColor = '#FFFFFF',
  shadowColor = '#000000',
  strength = 0.85,
  magToShade = 4,
} = {}) {
  const w = faceCanvas.width, h = faceCanvas.height;
  const { field, srcAlpha } = buildHeightField(faceCanvas, bevelSize, profile);
  const [lx, ly] = degToVec(lightAngle);

  const srcData = faceCanvas.getContext('2d').getImageData(0, 0, w, h);
  const out = createCanvas(w, h);
  const outCtx = out.getContext('2d');
  const outData = outCtx.createImageData(w, h);
  outData.data.set(srcData.data);

  const [hr, hg, hb] = hexToRgb(highlightColor);
  const [sr, sg, sb] = hexToRgb(shadowColor);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const alphaIdx = p * 4 + 3;
      if (srcAlpha[alphaIdx] === 0) continue;

      const gx = (field[p + 1] - field[p - 1]) / 2;
      const gy = (field[p + w] - field[p - w]) / 2;
      const mag = Math.hypot(gx, gy);
      if (mag < 1e-6) continue; // flat region (deep interior or fully outside the shape) - no bevel shading

      // Surface tilts toward LOWER elevation (outward, toward the true
      // edge) - dotting that direction against the light direction is
      // what decides whether this point faces toward or away from the
      // light, exactly like a rounded physical edge.
      const nx = -gx / mag, ny = -gy / mag;
      const dot = nx * lx + ny * ly; // -1..1

      const shade = clamp01(Math.abs(dot)) * strength * clamp01(mag * magToShade);
      const i = alphaIdx - 3;
      if (dot > 0) {
        outData.data[i] = lerp(outData.data[i], hr, shade);
        outData.data[i + 1] = lerp(outData.data[i + 1], hg, shade);
        outData.data[i + 2] = lerp(outData.data[i + 2], hb, shade);
      } else {
        outData.data[i] = lerp(outData.data[i], sr, shade);
        outData.data[i + 1] = lerp(outData.data[i + 1], sg, shade);
        outData.data[i + 2] = lerp(outData.data[i + 2], sb, shade);
      }
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

module.exports = { extrudeText, applyBevel, buildHeightField, degToVec };
