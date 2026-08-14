const { spatialBezierPoint } = require('./keyframes');
const { clamp01, lerp, lerpAngle } = require('./mathUtils');

/**
 * Text on a Path: characters laid out along an arbitrary curve instead
 * of a straight baseline, each rotated to follow the curve's own
 * tangent direction. AE's own control set (First/Last Margin, Reverse
 * Path, Perpendicular To Path, Force Alignment) is implemented exactly
 * as AE defines it, not just a loose approximation of the idea.
 *
 * The path itself is deliberately the SAME primitive batch 1 built for
 * spatial motion paths - a sequence of anchor points, each optionally
 * carrying its own out/in tangent handles as OFFSETS from its own
 * position - reusing keyframes.js's spatialBezierPoint directly rather
 * than reimplementing cubic bezier math a second time. The only
 * genuinely new piece here is walking ARC LENGTH along that curve (for
 * placing characters at even, true pixel-width spacing) instead of
 * walking the time axis keyframes.js walks.
 *
 * Anchors: [{ point: [x,y], outTangent?: [dx,dy], inTangent?: [dx,dy] }, ...]
 * Omitting tangents on every anchor degrades the path to a straight-
 * line polyline through the anchors (the tangent-less case in
 * spatialBezierPoint already collapses to exactly this).
 */

function anchorToKeyframeShape(anchor) {
  return { value: anchor.point, spatialOutTangent: anchor.outTangent, spatialInTangent: anchor.inTangent };
}

/**
 * Analytic derivative of the identical cubic bezier spatialBezierPoint
 * evaluates (same control-point construction, same weights differentiated
 * w.r.t. u) - an EXACT tangent direction at any u, rather than a finite-
 * difference estimate from neighboring samples.
 */
function bezierTangent(a, b, u) {
  const dims = a.value.length;
  const p0 = a.value;
  const p1 = a.spatialOutTangent ? a.value.map((v, i) => v + a.spatialOutTangent[i]) : a.value;
  const p2 = b.spatialInTangent ? b.value.map((v, i) => v + b.spatialInTangent[i]) : b.value;
  const p3 = b.value;
  const mt = 1 - u;
  const out = new Array(dims);
  for (let d = 0; d < dims; d++) {
    out[d] = 3 * mt * mt * (p1[d] - p0[d]) + 6 * mt * u * (p2[d] - p1[d]) + 3 * u * u * (p3[d] - p2[d]);
  }
  return out;
}

/**
 * Samples every bezier segment of the path at fine resolution and
 * builds a cumulative arc-length lookup table - the standard technique
 * for arc-length parameterization of a bezier curve (there is no
 * closed-form arc-length formula for a general cubic bezier).
 * `samplesPerSegment` trades accuracy for build cost; the error from
 * approximating true curve length as summed straight-line distance
 * between adjacent samples is bounded by the curve's curvature over an
 * interval of only 1/samplesPerSegment of a segment's u-range -
 * negligible at 60 samples for on-screen text sizes.
 */
function buildPathSampler(anchors, samplesPerSegment = 60) {
  if (!Array.isArray(anchors) || anchors.length < 2) {
    throw new Error('buildPathSampler requires at least 2 anchors');
  }
  const samples = []; // { distance, x, y, angle }
  let cumulative = 0;

  for (let seg = 0; seg < anchors.length - 1; seg++) {
    const a = anchorToKeyframeShape(anchors[seg]);
    const b = anchorToKeyframeShape(anchors[seg + 1]);
    const startI = seg === 0 ? 0 : 1; // u=0 of segment N === u=1 of segment N-1, don't duplicate that sample
    for (let i = startI; i <= samplesPerSegment; i++) {
      const u = i / samplesPerSegment;
      const [x, y] = spatialBezierPoint(a, b, u);
      const [dx, dy] = bezierTangent(a, b, u);
      const angle = Math.atan2(dy, dx);
      if (samples.length > 0) {
        const prev = samples[samples.length - 1];
        cumulative += Math.hypot(x - prev.x, y - prev.y);
      }
      samples.push({ distance: cumulative, x, y, angle });
    }
  }
  return { samples, totalLength: cumulative };
}

/**
 * Binary search + linear interpolation between the two bracketing
 * samples: the point/tangent-angle at a given arc-length distance along
 * the path. Clamps to the path's own ends outside [0, totalLength].
 * Angle interpolation uses lerpAngle (shortest-path) rather than a
 * plain lerp, since angle wraps at +-PI - a plain lerp would occasionally
 * spin the long way around at a sample straddling that wrap.
 */
function pointAtDistance(sampler, distance) {
  const { samples } = sampler;
  if (distance <= samples[0].distance) return samples[0];
  const last = samples[samples.length - 1];
  if (distance >= last.distance) return last;

  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].distance <= distance) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const span = b.distance - a.distance;
  const localT = span > 0 ? (distance - a.distance) / span : 0;
  return {
    x: lerp(a.x, b.x, localT),
    y: lerp(a.y, b.y, localT),
    angle: lerpAngle(a.angle, b.angle, localT),
  };
}

/**
 * Lays out characters along the path by ARC LENGTH (not by index or
 * fixed spacing), so every character sits its own true rendered
 * pixel-width apart along the curve - matching AE's Text-on-a-Path
 * "natural spacing" behavior. Returns the same {ch,x,y,index,wordIndex}
 * contract as textAnimator.js's layoutText (plus a new `angle` field)
 * so animators plug in identically regardless of layout source.
 *
 * - firstMargin/lastMargin: AE's own controls, offsetting the usable
 *   span inward from the path's true start/end (same length units as
 *   the path's own coordinate space).
 * - reversePath: walk the path from its end toward its start.
 * - perpendicularToPath: whether each character rotates to match the
 *   path's tangent (true, the common case) or stays upright (false,
 *   AE's own toggle - useful for e.g. text sitting ON TOP of a curve
 *   rather than flowing along it).
 * - forceAlignment: stretch/compress inter-character spacing so the
 *   text exactly fills firstMargin..lastMargin (AE's own toggle),
 *   computed as a genuine two-pass operation - natural widths are
 *   measured first, THEN uniformly rescaled - rather than guessed.
 */
function layoutTextOnPath(ctx, text, anchors, opts = {}) {
  const {
    fontFamily, fontWeight, fontSize,
    firstMargin = 0, lastMargin = 0,
    reversePath = false, perpendicularToPath = true, forceAlignment = false,
    samplesPerSegment = 60,
  } = opts;
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const sampler = buildPathSampler(anchors, samplesPerSegment);
  const usableLength = Math.max(sampler.totalLength - firstMargin - lastMargin, 0);

  const entries = [];
  let naturalWidth = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch === ' ' ? ' ' : ch).width;
    entries.push({ ch, width: w });
    naturalWidth += w;
  }
  const scale = forceAlignment && naturalWidth > 0 ? usableLength / naturalWidth : 1;

  const chars = [];
  let wordIndex = 0;
  let cursor = 0;
  let sawCharInWord = false;
  for (const entry of entries) {
    if (entry.ch === ' ') {
      cursor += entry.width;
      if (sawCharInWord) { wordIndex++; sawCharInWord = false; }
      continue;
    }
    sawCharInWord = true;
    const centerNatural = cursor + entry.width / 2;
    cursor += entry.width;

    const distAlongUsable = centerNatural * scale;
    const rawDistance = reversePath
      ? sampler.totalLength - lastMargin - distAlongUsable
      : firstMargin + distAlongUsable;

    const { x, y, angle } = pointAtDistance(sampler, rawDistance);
    chars.push({
      ch: entry.ch, x, y,
      angle: perpendicularToPath ? (reversePath ? angle + Math.PI : angle) : 0,
      index: chars.length,
      wordIndex,
    });
  }
  const totalWords = wordIndex + (sawCharInWord ? 1 : 0);

  return { chars, totalWords, sampler, usableLength };
}

/**
 * Same animator-driven rendering as textAnimator.js's renderAnimatedText,
 * but the character's BASE position/rotation comes from the path
 * (layoutTextOnPath) instead of a straight word-wrapped baseline.
 * Animator position deltas are applied in the character's own rotated
 * local space (translate-then-rotate order below) so a "kick along the
 * path" reads correctly for curved text, matching how AE's own
 * per-character transforms are relative to that character's baseline.
 */
function renderAnimatedTextOnPath(ctx, text, anchors, t, opts) {
  const {
    fontFamily, fontWeight, fontSize,
    fillStyle = '#FFFFFF', animators = [],
    firstMargin, lastMargin, reversePath, perpendicularToPath, forceAlignment, samplesPerSegment,
  } = opts;

  const { chars, totalWords } = layoutTextOnPath(ctx, text, anchors, {
    fontFamily, fontWeight, fontSize, firstMargin, lastMargin, reversePath, perpendicularToPath, forceAlignment, samplesPerSegment,
  });
  const totalChars = chars.length;

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    let dx = 0, dy = 0, scaleMul = 1, dRotation = 0, opacityDelta = 0;
    const unit = { charIndex: c.index, totalChars, wordIndex: c.wordIndex, totalWords, t };

    for (const anim of animators) {
      const strength = anim.selector(unit);
      if (strength === 0) continue;
      const p = anim.properties || {};
      if (p.position) { dx += p.position[0] * strength; dy += p.position[1] * strength; }
      if (p.scale !== undefined) scaleMul *= lerp(1, p.scale, strength);
      if (p.rotation) dRotation += p.rotation * strength;
      if (p.opacity !== undefined) opacityDelta += p.opacity * strength;
    }

    const finalOpacity = clamp01(1 + opacityDelta);
    if (finalOpacity <= 0.001) continue;

    ctx.save();
    ctx.globalAlpha = finalOpacity;
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.translate(dx, dy);
    ctx.rotate(dRotation);
    ctx.scale(scaleMul, scaleMul);
    ctx.fillStyle = fillStyle;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

module.exports = {
  buildPathSampler, pointAtDistance, layoutTextOnPath, renderAnimatedTextOnPath, bezierTangent,
};
