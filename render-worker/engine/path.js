const { spatialBezierPoint } = require('./keyframes');
const { lerp } = require('./mathUtils');

/**
 * The single shared "Path" primitive used everywhere a curve needs
 * real arc-length walking or exact sub-curve extraction: Text on a
 * Path (textPath.js), Trim Paths (trimPaths.js), and shape rendering
 * (shapeLayer.js) all build on this ONE module rather than each
 * re-deriving bezier math separately - promoted out of textPath.js
 * (which originated it in batch 5) the same way selectors.js was
 * promoted out of textAnimator.js.
 *
 * A path is a sequence of anchors [{point:[x,y], outTangent?, inTangent?}, ...],
 * the SAME shape keyframes.js's spatialBezierPoint already consumes -
 * tangent-less anchors degenerate to straight lines for free, which is
 * exactly what lets shapePrimitives.js's sharp-corner (roundness=0)
 * case fall out with zero special-casing.
 */

function anchorToKeyframeShape(anchor) {
  return { value: anchor.point, spatialOutTangent: anchor.outTangent, spatialInTangent: anchor.inTangent };
}

/** Analytic derivative of the identical cubic bezier spatialBezierPoint evaluates - an EXACT tangent direction at any u, not finite-differenced. */
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

/** Absolute cubic bezier control points [P0,P1,P2,P3] for the segment between anchors a and b - the same construction spatialBezierPoint/bezierTangent use internally, exposed so splitCubicBezier/subCurve can operate on a segment directly. */
function segmentControlPoints(a, b) {
  const p0 = a.point;
  const p1 = a.outTangent ? [a.point[0] + a.outTangent[0], a.point[1] + a.outTangent[1]] : a.point;
  const p2 = b.inTangent ? [b.point[0] + b.inTangent[0], b.point[1] + b.inTangent[1]] : b.point;
  const p3 = b.point;
  return [p0, p1, p2, p3];
}

/**
 * De Casteljau split of a single cubic bezier [p0,p1,p2,p3] at
 * parameter t into two sub-curves that together exactly retrace the
 * original curve - not an approximation: repeated linear interpolation
 * of the control polygon at t produces both sub-curves' true control
 * points directly, the standard algorithm.
 */
function splitCubicBezier(p0, p1, p2, p3, t) {
  const lerp2 = (a, b) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  const q0 = lerp2(p0, p1), q1 = lerp2(p1, p2), q2 = lerp2(p2, p3);
  const r0 = lerp2(q0, q1), r1 = lerp2(q1, q2);
  const s0 = lerp2(r0, r1);
  return { left: [p0, q0, r0, s0], right: [s0, r1, q2, p3] };
}

/**
 * Extracts the EXACT sub-curve of a cubic bezier covering parameter
 * range [u0,u1] (0<=u0<=u1<=1): split at u1 first (keep the earlier
 * portion), then re-parameterize u0 into that already-shortened
 * curve's own 0-1 range and split again (keep the later portion of
 * THAT split) - the standard two-step bezier sub-curve extraction.
 */
function subCurve(p0, p1, p2, p3, u0, u1) {
  if (u0 <= 0 && u1 >= 1) return [p0, p1, p2, p3];
  const { left: toU1 } = splitCubicBezier(p0, p1, p2, p3, Math.min(Math.max(u1, 0), 1));
  if (u0 <= 0) return toU1;
  const u0Remapped = u1 > 0 ? u0 / u1 : 0;
  const { right: fromU0 } = splitCubicBezier(toU1[0], toU1[1], toU1[2], toU1[3], Math.min(Math.max(u0Remapped, 0), 1));
  return fromU0;
}

/**
 * Samples every bezier segment of the path (including the closing
 * segment back to anchors[0] if `closed`) at fine resolution and
 * builds a cumulative arc-length lookup table - the standard technique
 * for arc-length parameterization (no closed-form arc-length formula
 * exists for a general cubic bezier). Each sample also records which
 * ORIGINAL segment index and local-u it came from, so callers (Trim
 * Paths) can map an arc-length distance back to an exact sub-curve via
 * subCurve/segmentControlPoints instead of only an approximate point.
 */
function buildPathSampler(anchors, { samplesPerSegment = 60, closed = false } = {}) {
  if (!Array.isArray(anchors) || anchors.length < 2) {
    throw new Error('buildPathSampler requires at least 2 anchors');
  }
  const n = anchors.length;
  const segCount = closed ? n : n - 1;
  const samples = []; // { distance, x, y, angle, segIndex, u }
  let cumulative = 0;

  for (let seg = 0; seg < segCount; seg++) {
    const a = anchorToKeyframeShape(anchors[seg]);
    const b = anchorToKeyframeShape(anchors[(seg + 1) % n]);
    const startI = seg === 0 ? 0 : 1; // segment N's u=0 === segment N-1's u=1, don't duplicate that sample
    for (let i = startI; i <= samplesPerSegment; i++) {
      const u = i / samplesPerSegment;
      const [x, y] = spatialBezierPoint(a, b, u);
      const [dx, dy] = bezierTangent(a, b, u);
      const angle = Math.atan2(dy, dx);
      if (samples.length > 0) {
        const prev = samples[samples.length - 1];
        cumulative += Math.hypot(x - prev.x, y - prev.y);
      }
      samples.push({ distance: cumulative, x, y, angle, segIndex: seg, u });
    }
  }
  return {
    samples, totalLength: cumulative, segCount, closed, anchors,
  };
}

function lerpAngleLocal(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Binary search + interpolation: point/tangent-angle/original-segment
 * position at a given arc-length distance along the path. Clamps to
 * the path's own ends outside [0, totalLength] (meaningless for a
 * `closed` sampler in practice, since callers wrap distance themselves,
 * but kept safe regardless).
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
    angle: lerpAngleLocal(a.angle, b.angle, localT),
    segIndex: localT < 0.5 ? a.segIndex : b.segIndex,
    // Only exactly meaningful when a.segIndex === b.segIndex (the
    // overwhelmingly common case at this sample density) - the two
    // samples straddling a genuine segment BOUNDARY are, by
    // construction above, the exact same physical point (zero
    // distance apart), so span===0 there and localT snaps to 0,
    // returning a's own (segIndex,u) rather than an interpolated one.
    u: lerp(a.u, b.u, localT),
  };
}

/** Traces `anchors` (open or closed) onto a 2D context via moveTo/bezierCurveTo - does NOT call beginPath/fill/stroke itself, so callers can trace multiple subpaths into one path before filling/stroking (needed for evenodd fill rules across multiple simultaneous shapes). */
function renderPathToContext(ctx, anchors, closed) {
  if (!anchors || anchors.length === 0) return;
  ctx.moveTo(anchors[0].point[0], anchors[0].point[1]);
  const n = anchors.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    const p1 = a.outTangent ? [a.point[0] + a.outTangent[0], a.point[1] + a.outTangent[1]] : a.point;
    const p2 = b.inTangent ? [b.point[0] + b.inTangent[0], b.point[1] + b.inTangent[1]] : b.point;
    ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], b.point[0], b.point[1]);
  }
  if (closed) ctx.closePath();
}

module.exports = {
  buildPathSampler, pointAtDistance, bezierTangent, segmentControlPoints,
  splitCubicBezier, subCurve, renderPathToContext,
};
