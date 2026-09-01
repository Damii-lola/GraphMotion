const { cubicBezier, getEasing } = require('./easingCurves');
const { lerp, lerpVector, clamp01 } = require('./mathUtils');

/**
 * THE core animation primitive. Every animatable thing in the new
 * engine - a position, an opacity, a color channel, a font size, a
 * glow-intensity effect parameter, even the value used for time-
 * remapping (see timeRemap.js) - is "a Property with keyframes", read
 * with the same .valueAt(t) call, instead of the old system's approach
 * of every template hand-deriving its own ad-hoc formula per effect.
 *
 * A Keyframe looks like:
 *   {
 *     time: number,                 // seconds (or any consistent unit)
 *     value: number | number[],     // scalar, or a vector (position, color, ...)
 *     interpolation: 'hold' | 'linear' | 'easing' | 'bezier',  // default 'easing'
 *     easing: 'easeOutBack',        // required if interpolation === 'easing'
 *     easingParams: { overshoot },  // optional, passed to getEasing()
 *     outTangent: { x, y },         // required if interpolation === 'bezier' (this keyframe's outgoing handle)
 *     inTangent:  { x, y },         // required on the NEXT keyframe if interpolation === 'bezier'
 *     spatialOutTangent: number[],  // OPTIONAL, vector-valued keyframes only - see below
 *     spatialInTangent: number[],   // OPTIONAL, vector-valued keyframes only
 *   }
 *
 * Interpolation is read off the EARLIER (outgoing) keyframe of each
 * bracketing pair - this matches After Effects' own convention, where
 * a keyframe's interpolation setting describes how it transitions
 * to what's next, not how the previous segment arrived at it.
 *
 * TEMPORAL vs SPATIAL (the real AE distinction, both supported):
 * - Temporal interpolation (hold/linear/easing/bezier above) controls
 *   the RATE a value changes over time - "ease out of this keyframe."
 * - Spatial interpolation (spatialOutTangent/spatialInTangent) is a
 *   SEPARATE, optional thing that only applies to vector-valued
 *   properties (a 2D/3D position) - it curves the actual PATH SHAPE
 *   through space between two points, via a real cubic bezier (De
 *   Casteljau), independent of how the timing along that path eases.
 *   This is why AE motion along a curved path still looks hand-crafted
 *   even with linear timing - the path itself is a designed curve, not
 *   just a straight line eased unevenly. Omitting spatial tangents
 *   degrades exactly to a straight line between the two points (the
 *   control points collapse onto the line), so this is purely additive
 *   - nothing breaks if a caller never uses it.
 */
class Property {
  constructor(keyframes, opts = {}) {
    if (!Array.isArray(keyframes) || keyframes.length === 0) {
      throw new Error('Property requires at least one keyframe');
    }
    this.keyframes = [...keyframes].sort((a, b) => a.time - b.time);
    this.isVector = Array.isArray(this.keyframes[0].value);
    this.spatial = !!opts.spatial && this.isVector;
  }

  valueAt(t) {
    const kfs = this.keyframes;
    if (kfs.length === 1) return kfs[0].value;
    if (t <= kfs[0].time) return kfs[0].value;
    if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;

    let i = 0;
    while (i < kfs.length - 1 && kfs[i + 1].time <= t) i++;
    const a = kfs[i];
    const b = kfs[i + 1];

    const span = b.time - a.time;
    // Duplicate keyframe times (span === 0) would divide by zero - a
    // real hard-cut/instant-jump beat should use interpolation:'hold'
    // instead, but defensively snap to b's value rather than NaN out
    // if it happens anyway (this will be driven by AI-generated data
    // eventually, which won't always be perfectly well-formed).
    const segT = span > 0 ? clamp01((t - a.time) / span) : 1;

    const interpolation = a.interpolation || 'easing';

    if (interpolation === 'hold') {
      return a.value;
    }

    let easedT;
    if (interpolation === 'bezier') {
      if (!a.outTangent || !b.inTangent) {
        throw new Error(`Keyframe at t=${a.time} uses interpolation:'bezier' but is missing outTangent/inTangent`);
      }
      easedT = cubicBezier(a.outTangent.x, a.outTangent.y, b.inTangent.x, b.inTangent.y)(segT);
    } else if (interpolation === 'linear') {
      easedT = segT;
    } else {
      // 'easing' - the common case, a named preset
      easedT = getEasing(a.easing || 'linear', a.easingParams)(segT);
    }

    if (this.spatial) {
      return spatialBezierPoint(a, b, easedT);
    }

    return this.isVector ? lerpVector(a.value, b.value, easedT) : lerp(a.value, b.value, easedT);
  }
}

/**
 * Evaluates a point along the curved PATH between two vector
 * keyframes at parameter u (0-1) - a true cubic bezier in N-dimensional
 * space (De Casteljau, expanded per-component), using each keyframe's
 * own spatial tangent as an OFFSET from its actual value (matching how
 * AE's direction handles work - you drag a handle near the point, not
 * an absolute coordinate elsewhere in the frame).
 */
function spatialBezierPoint(a, b, u) {
  const dims = a.value.length;
  const p0 = a.value;
  const p1 = a.spatialOutTangent ? a.value.map((v, i) => v + a.spatialOutTangent[i]) : a.value;
  const p2 = b.spatialInTangent ? b.value.map((v, i) => v + b.spatialInTangent[i]) : b.value;
  const p3 = b.value;

  const mt = 1 - u;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * u;
  const w2 = 3 * mt * u * u;
  const w3 = u * u * u;

  const out = new Array(dims);
  for (let d = 0; d < dims; d++) {
    out[d] = w0 * p0[d] + w1 * p1[d] + w2 * p2[d] + w3 * p3[d];
  }
  return out;
}

module.exports = { Property, spatialBezierPoint };
