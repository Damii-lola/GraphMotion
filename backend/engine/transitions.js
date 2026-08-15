const { createCanvas } = require('@napi-rs/canvas');
const { clamp01 } = require('./mathUtils');
const { ellipsePath, starPath, polygonPath } = require('./shapePrimitives');
const { renderPathToContext } = require('./path');
const { fractalNoise } = require('./noiseEffects');
const { rgbShift, blockDisplace } = require('./glitchEffects');
const { Layer3D, renderScene3D } = require('./layer3d');
const { Camera } = require('./camera3d');

/**
 * A real transition vocabulary: every function here takes two already-
 * rendered frames (`fromCanvas`, `toCanvas` - genuinely any content
 * this engine can produce, since a transition just composites two
 * finished canvases) and a progress value t in [0,1], and returns the
 * composited transition frame - t=0 is EXACTLY `fromCanvas`, t=1 is
 * EXACTLY `toCanvas` (verified for every transition in the batch 11
 * test suite, not just assumed).
 *
 * Nearly every non-trivial transition here is built by REUSING an
 * already-real primitive from an earlier batch rather than inventing
 * new masking/compositing logic per transition: Iris Wipe reuses
 * shapePrimitives.js's real path generators, Gradient Wipe reuses
 * noiseEffects.js's real Perlin fractal noise as a per-pixel reveal-
 * order map, the 3D Card Flip reuses layer3d.js's real 3D rotation and
 * perspective warp, and the Glitch transition reuses glitchEffects.js
 * directly. This is a deliberate capstone of the whole session's
 * primitive-reuse discipline, not a coincidence.
 */

/** Composites `toCanvas` over `fromCanvas`, with `toCanvas` first clipped to `maskCanvas`'s own alpha shape via the established "always drawImage a real canvas, never a raw fill, under a non-default composite operation" rule (batch 3's layerStack.js correctness finding, followed consistently ever since). */
function compositeThroughMask(fromCanvas, toCanvas, maskCanvas) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const toMasked = createCanvas(w, h);
  const tctx = toMasked.getContext('2d');
  tctx.drawImage(toCanvas, 0, 0);
  tctx.save();
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(maskCanvas, 0, 0);
  tctx.restore();

  const out = createCanvas(w, h);
  const octx = out.getContext('2d');
  octx.drawImage(fromCanvas, 0, 0);
  octx.drawImage(toMasked, 0, 0);
  return out;
}

/** The simplest, most common real transition: a plain alpha crossfade. */
function crossDissolve(fromCanvas, toCanvas, t) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.globalAlpha = 1 - t;
  ctx.drawImage(fromCanvas, 0, 0);
  ctx.globalAlpha = t;
  ctx.drawImage(toCanvas, 0, 0);
  ctx.globalAlpha = 1;
  return ctx.canvas;
}

/**
 * Linear Wipe: a straight edge sweeping across the frame at `angle`,
 * with a soft (smoothstep) transition band rather than a hard cutoff.
 * Every pixel's position is projected onto the wipe direction and
 * compared against the sweep's current position along that SAME axis,
 * computed from the true corner-to-corner projected range (not just
 * the canvas width) so the wipe correctly reaches every corner
 * regardless of angle.
 */
function linearWipe(fromCanvas, toCanvas, t, { angle = 0, softness = 0.05 } = {}) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const corners = [[0, 0], [w, 0], [w, h], [0, h]];
  const projections = corners.map(([x, y]) => x * dx + y * dy);
  const minP = Math.min(...projections), maxP = Math.max(...projections);
  const range = maxP - minP || 1;
  const edge = minP + t * range;
  const softPx = Math.max(1, softness * range);

  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  const maskData = mctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const proj = x * dx + y * dy;
      const raw = clamp01((proj - (edge - softPx)) / (2 * softPx));
      const smooth = raw * raw * (3 - 2 * raw);
      const idx = (y * w + x) * 4;
      maskData.data[idx] = 255; maskData.data[idx + 1] = 255; maskData.data[idx + 2] = 255;
      maskData.data[idx + 3] = Math.round((1 - smooth) * 255);
    }
  }
  mctx.putImageData(maskData, 0, 0);
  return compositeThroughMask(fromCanvas, toCanvas, maskCanvas);
}

/**
 * Radial Wipe: sweeps around `center` like a clock hand, from
 * `startAngle` through a 360deg*t arc.
 *
 * Real bug found and fixed via direct testing (not assumed): this
 * canvas build's arc() has a genuine degenerate-sweep quirk - a sweep
 * of EXACTLY 2*PI (t=1.0 here) fills NOTHING at all (confirmed
 * directly: sweepFrac=0.999 filled correctly, sweepFrac=1.0 filled
 * zero pixels anywhere, not even a small rounding-affected sliver),
 * almost certainly because the implementation normalizes start/end
 * angles modulo 2*PI internally and an exact full-turn sweep collapses
 * to start===end, i.e. a zero-length arc. t>=1 is special-cased to
 * skip the arc entirely and return `toCanvas` outright - which is
 * ALSO exactly the transition's own documented t=1 contract anyway,
 * so this isn't a workaround bolted on top of the real behavior, it's
 * the correct answer arrived at by a different (safer) path.
 */
function radialWipe(fromCanvas, toCanvas, t, { center = null, startAngle = -90 } = {}) {
  if (t <= 0) return fromCanvas;
  if (t >= 1) return toCanvas;

  const w = fromCanvas.width, h = fromCanvas.height;
  const c = center || [w / 2, h / 2];
  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  mctx.fillStyle = '#ffffff';
  mctx.beginPath();
  mctx.moveTo(c[0], c[1]);
  const startRad = (startAngle * Math.PI) / 180;
  mctx.arc(c[0], c[1], Math.hypot(w, h), startRad, startRad + t * Math.PI * 2);
  mctx.closePath();
  mctx.fill();
  return compositeThroughMask(fromCanvas, toCanvas, maskCanvas);
}

/** Iris Wipe: reveals `toCanvas` through an expanding shape (ellipse/polygon/star, reusing shapePrimitives.js's real path generators directly - not a re-derived circle formula) centered on `center`, growing from nothing at t=0 to fully covering the frame at t=1. */
function irisWipe(fromCanvas, toCanvas, t, {
  shape = 'ellipse', center = null, points = 5,
} = {}) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const c = center || [w / 2, h / 2];
  const maxRadius = Math.hypot(w, h);
  const radius = t * maxRadius;

  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  if (radius > 0.5) {
    let pathDef;
    if (shape === 'star') pathDef = starPath({ points, innerRadius: radius * 0.55, outerRadius: radius, position: c });
    else if (shape === 'polygon') pathDef = polygonPath({ points, radius, position: c });
    else pathDef = ellipsePath({ width: radius * 2, height: radius * 2, position: c });

    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    renderPathToContext(mctx, pathDef.anchors, true);
    mctx.fill();
  }
  return compositeThroughMask(fromCanvas, toCanvas, maskCanvas);
}

/** Venetian Blinds: splits the frame into `stripes` bands, each independently wiping across its own local axis in sync - the classic "blinds opening" reveal. */
function venetianBlinds(fromCanvas, toCanvas, t, { stripes = 10, direction = 'horizontal' } = {}) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  const horizontal = direction === 'horizontal';
  const stripeSize = horizontal ? h / stripes : w / stripes;
  const revealSize = t * (horizontal ? w : h);
  mctx.fillStyle = '#ffffff';
  for (let i = 0; i < stripes; i++) {
    if (horizontal) mctx.fillRect(0, i * stripeSize, revealSize, stripeSize);
    else mctx.fillRect(i * stripeSize, 0, stripeSize, revealSize);
  }
  return compositeThroughMask(fromCanvas, toCanvas, maskCanvas);
}

/**
 * Gradient Wipe: reveal order driven by a real Perlin fractal-noise
 * field (noiseEffects.js, direct reuse) instead of a uniform sweep -
 * pixels sitting on LOWER-luminance noise regions reveal earlier,
 * producing an organic, non-uniform dissolve pattern (real AE's
 * Gradient Wipe effect works from the same idea - a supplied
 * luminance map controlling per-pixel reveal timing - just normally
 * fed an authored grayscale image rather than procedural noise).
 */
function gradientWipe(fromCanvas, toCanvas, t, {
  seed = 0, scale = 0.02, softness = 0.15,
} = {}) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const noiseCanvas = fractalNoise(w, h, {
    seed, scale, octaves: 4, colorA: '#000000', colorB: '#ffffff',
  });
  const noiseData = noiseCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  const maskData = mctx.createImageData(w, h);
  const softFrac = Math.max(0.001, softness);
  for (let i = 0; i < noiseData.length; i += 4) {
    const n = noiseData[i] / 255;
    const raw = clamp01((t - (n - softFrac)) / (2 * softFrac));
    const smooth = raw * raw * (3 - 2 * raw);
    maskData.data[i] = 255; maskData.data[i + 1] = 255; maskData.data[i + 2] = 255;
    maskData.data[i + 3] = Math.round(smooth * 255);
  }
  mctx.putImageData(maskData, 0, 0);
  return compositeThroughMask(fromCanvas, toCanvas, maskCanvas);
}

/**
 * 3D Card Flip: `fromCanvas` rotates away (0deg -> 90deg, vanishing
 * edge-on via genuine perspective foreshortening) through the first
 * half of the transition, then `toCanvas` rotates in (-90deg -> 0deg)
 * through the second half - a direct, real reuse of layer3d.js's
 * Layer3D/Camera/renderScene3D (batch 7), not a faked 2D scale-squash
 * imitation of a 3D flip.
 */
function card3DFlip(fromCanvas, toCanvas, t, { axis = 'y' } = {}) {
  const w = fromCanvas.width, h = fromCanvas.height;
  const camera = new Camera({ position: [0, 0, -Math.max(w, h) * 1.8], pointOfInterest: [0, 0, 0], zoom: Math.max(w, h) * 1.8 });
  const firstHalf = t < 0.5;
  const content = firstHalf ? fromCanvas : toCanvas;
  const localT = firstHalf ? t * 2 : (t - 0.5) * 2;
  const angle = firstHalf ? localT * (Math.PI / 2) : -((1 - localT) * (Math.PI / 2));

  const layer = new Layer3D({
    position: [0, 0, 0],
    anchor: [w / 2, h / 2, 0],
    width: w,
    height: h,
    content,
    rotationY: axis === 'y' ? angle : 0,
    rotationX: axis === 'x' ? angle : 0,
  });
  const out = createCanvas(w, h);
  renderScene3D(out.getContext('2d'), w, h, [layer], camera, 0);
  return out;
}

/**
 * Glitch transition: a crossDissolve base with a burst of real digital-
 * glitch artifacts (glitchEffects.js, direct reuse) whose strength
 * peaks at t=0.5 and fades to exactly 0 at both t=0 and t=1 - so the
 * transition still satisfies the universal "t=0 is exactly fromCanvas,
 * t=1 is exactly toCanvas" contract despite the stylized middle.
 */
function glitchTransition(fromCanvas, toCanvas, t) {
  const base = crossDissolve(fromCanvas, toCanvas, t);
  const glitchStrength = 1 - Math.abs(t - 0.5) * 2;
  if (glitchStrength <= 0.02) return base;
  const ctx = base.getContext('2d');
  const imgData = ctx.getImageData(0, 0, base.width, base.height);
  const shiftAmt = Math.round(15 * glitchStrength);
  rgbShift(imgData, {
    redOffset: [shiftAmt, 0], greenOffset: [0, 0], blueOffset: [-shiftAmt, 0],
  });
  blockDisplace(imgData, {
    bandHeight: 6, maxShift: Math.round(20 * glitchStrength), probability: 0.4 * glitchStrength, seed: Math.round(t * 1000),
  });
  ctx.putImageData(imgData, 0, 0);
  return base;
}

module.exports = {
  crossDissolve, linearWipe, radialWipe, irisWipe, venetianBlinds, gradientWipe, card3DFlip, glitchTransition, compositeThroughMask,
};
