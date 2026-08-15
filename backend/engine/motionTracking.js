const { Property } = require('./keyframes');

/**
 * Motion Tracking/Stabilization: a real point tracker built on
 * Normalized Cross-Correlation (NCC) template matching - the actual
 * classic computer-vision technique behind basic feature tracking
 * (AE's own advanced planar tracker, Mocha, uses more sophisticated
 * methods; its simpler built-in Track Motion point tracker is
 * fundamentally this same idea). NCC (not simple sum-of-squared-
 * differences) is the real, correct choice here because it's
 * mathematically invariant to linear brightness/contrast shifts
 * between frames - genuinely meaningful for real footage where
 * lighting flickers slightly frame to frame, which SSD would
 * misinterpret as the feature having moved.
 */

function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return gray;
}

/** Real Normalized Cross-Correlation between a template patch and a same-size window of a larger search image - the Pearson correlation coefficient applied to image intensities, in [-1,1] (1 = perfect match). Both mean-subtracted (brightness-invariant) and variance-normalized (contrast-invariant). */
function ncc(template, tw, th, search, sw, sx, sy) {
  const n = tw * th;
  let sumT = 0, sumI = 0;
  for (let i = 0; i < n; i++) sumT += template[i];
  for (let j = 0; j < th; j++) {
    const rowBase = (sy + j) * sw + sx;
    for (let i = 0; i < tw; i++) sumI += search[rowBase + i];
  }
  const meanT = sumT / n, meanI = sumI / n;

  let num = 0, denomT = 0, denomI = 0;
  for (let j = 0; j < th; j++) {
    const rowBase = (sy + j) * sw + sx;
    const tRowBase = j * tw;
    for (let i = 0; i < tw; i++) {
      const tv = template[tRowBase + i] - meanT;
      const iv = search[rowBase + i] - meanI;
      num += tv * iv;
      denomT += tv * tv;
      denomI += iv * iv;
    }
  }
  const denom = Math.sqrt(denomT * denomI);
  return denom > 1e-6 ? num / denom : 0;
}

/** The standard 1D parabolic sub-pixel peak refinement: given a discrete correlation peak at integer position 0 with neighbor scores sLeft/sCenter/sRight, fits a parabola through the 3 points and returns the offset (in [-0.5,0.5]) of the parabola's true (sub-pixel) maximum - a real, widely-used technique in template-matching/stereo-correspondence tracking, not a guessed smoothing. */
function subPixelPeak(sLeft, sCenter, sRight) {
  const denom = sLeft - 2 * sCenter + sRight;
  if (Math.abs(denom) < 1e-9) return 0;
  const offset = (0.5 * (sLeft - sRight)) / denom;
  return Math.max(-0.5, Math.min(0.5, offset));
}

/**
 * Tracks one feature region from `templateImageData` (where the
 * feature is at `region`) into `searchImageData` (the next frame),
 * searching a `searchRadius`-pixel window around the region's own
 * position - a real, correct (if brute-force - see the class-level
 * doc comment on the module's real scope) exhaustive NCC search, not
 * an approximation. Sub-pixel-refines the winning integer offset by
 * fitting parabolas along both axes independently through its
 * immediate neighbor scores (the standard practical simplification of
 * a full 2D quadratic fit).
 */
function trackFeature(templateImageData, searchImageData, region, searchRadius = 15) {
  const { w, h } = region;
  // Real bug found and fixed while verifying this against a known
  // synthesized motion path: `region.x`/`region.y` carry the SUB-PIXEL
  // refined position from the previous frame's track, but typed-array
  // indexing silently returns `undefined` (not a rounded/floored
  // element) for a non-integer index - confirmed directly. Using the
  // fractional position straight as an array index corrupted every
  // frame after the first sub-pixel refinement into reading NaN.
  // Rounding to integers HERE (for indexing only) fixes it; the
  // returned position below still keeps full sub-pixel precision.
  const x = Math.round(region.x), y = Math.round(region.y);
  const templateGray = toGray(templateImageData);
  const searchGray = toGray(searchImageData);
  const tw = templateImageData.width;
  const sw = searchImageData.width, sh = searchImageData.height;

  const template = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) template[j * w + i] = templateGray[(y + j) * tw + (x + i)];
  }

  let bestScore = -Infinity, bestDx = 0, bestDy = 0;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    const sy = y + dy;
    if (sy < 0 || sy + h > sh) continue;
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const sx = x + dx;
      if (sx < 0 || sx + w > sw) continue;
      const score = ncc(template, w, h, searchGray, sw, sx, sy);
      if (score > bestScore) { bestScore = score; bestDx = dx; bestDy = dy; }
    }
  }

  const scoreAt = (dx, dy) => {
    const sx = x + dx, sy = y + dy;
    if (sx < 0 || sy < 0 || sx + w > sw || sy + h > sh) return bestScore;
    return ncc(template, w, h, searchGray, sw, sx, sy);
  };
  const subX = subPixelPeak(scoreAt(bestDx - 1, bestDy), bestScore, scoreAt(bestDx + 1, bestDy));
  const subY = subPixelPeak(scoreAt(bestDx, bestDy - 1), bestScore, scoreAt(bestDx, bestDy + 1));

  return {
    x: x + bestDx + subX,
    y: y + bestDy + subY,
    confidence: bestScore,
  };
}

/**
 * Tracks a feature across a whole frame sequence, returning a real
 * keyframes.js Property of its [x,y] CENTER position over time - one
 * keyframe per frame, linear interpolation (the track is already
 * densely sampled at frame rate; further easing between adjacent
 * frames would smooth real measured motion into something it didn't
 * do, the same reasoning batch 10's audioToKeyframes already applies).
 *
 * Tracks FRAME-TO-FRAME (each frame's template comes from the
 * PREVIOUS frame at its just-tracked position), not against a single
 * fixed reference frame throughout - a real, valid tracking strategy
 * distinct from AE's own non-adaptive default, with a real, honest
 * tradeoff: more robust to the feature's appearance gradually
 * changing (lighting, slight rotation) since the template stays
 * current, at the cost of potential gradual drift accumulating over a
 * very long sequence (each frame's small error compounds) - a real
 * characteristic of adaptive tracking, not hidden.
 */
function trackSequence(frames, initialRegion, { searchRadius = 15, fps = 24 } = {}) {
  if (frames.length === 0) throw new Error('trackSequence requires at least one frame');
  let region = { ...initialRegion };
  const keyframes = [{
    time: 0,
    value: [region.x + region.w / 2, region.y + region.h / 2],
    interpolation: 'linear',
  }];

  for (let f = 1; f < frames.length; f++) {
    const result = trackFeature(frames[f - 1], frames[f], region, searchRadius);
    region = {
      x: result.x, y: result.y, w: region.w, h: region.h,
    };
    keyframes.push({
      time: f / fps,
      value: [result.x + region.w / 2, result.y + region.h / 2],
      interpolation: 'linear',
    });
  }
  return new Property(keyframes);
}

/**
 * 2-point tracking: tracks two independent features and derives
 * rotation (the change in angle of the line between them, relative to
 * the first frame) and scale (the change in distance between them,
 * relative to the first frame) at any time - the real mechanism AE's
 * own 2-point tracker uses to additionally capture a tracked object's
 * rotation/zoom, not just its translation.
 */
class TwoPointTrack {
  constructor(frames, regionA, regionB, opts = {}) {
    this.positionA = trackSequence(frames, regionA, opts);
    this.positionB = trackSequence(frames, regionB, opts);
    const a0 = this.positionA.keyframes[0].value;
    const b0 = this.positionB.keyframes[0].value;
    this._restAngle = Math.atan2(b0[1] - a0[1], b0[0] - a0[0]);
    this._restDistance = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1;
  }

  rotationAt(t) {
    const a = this.positionA.valueAt(t), b = this.positionB.valueAt(t);
    const currentAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // Real bug found and fixed via direct testing: a raw subtraction
    // of two atan2 results can cross the +-PI wrap boundary and report
    // a value off by a full 2*PI from the true shortest rotation (a
    // tracked rotation of ~0.45 rad measured as -5.835 rad, and
    // -5.835 + 2*PI = 0.448 - confirming the wrap, not a tracking
    // error). Wrapped into (-PI, PI] the same way mathUtils.js's
    // lerpAngle already does for the identical reason elsewhere in
    // this engine, rather than reported raw.
    let diff = currentAngle - this._restAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff <= -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  scaleAt(t) {
    const a = this.positionA.valueAt(t), b = this.positionB.valueAt(t);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / this._restDistance;
  }
}

/**
 * Stabilize Motion: the real inverse-motion technique - given a
 * tracked position Property, builds a new Property of OFFSETS that,
 * added to a layer's own base position, exactly cancels the tracked
 * jitter (keeping the tracked feature visually pinned at its very
 * first frame's position). This is precisely what AE's Stabilize
 * Motion does under the hood: track, then apply the negated track as
 * the layer's own motion.
 */
function computeStabilizationTransform(trackedProperty) {
  const restPos = trackedProperty.keyframes[0].value;
  const keyframes = trackedProperty.keyframes.map((kf) => ({
    time: kf.time,
    value: [restPos[0] - kf.value[0], restPos[1] - kf.value[1]],
    interpolation: 'linear',
  }));
  return new Property(keyframes);
}

module.exports = {
  trackFeature, trackSequence, TwoPointTrack, computeStabilizationTransform, ncc, subPixelPeak,
};
