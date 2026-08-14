const { identity, multiply, fromTRS } = require('./matrix2d');
const { lerp } = require('./mathUtils');

/**
 * AE's Repeater: duplicates the path(s) above it in a shape group N
 * times. The defining, easy-to-get-wrong detail is that the per-copy
 * transform COMPOUNDS - copy i carries the per-copy transform applied
 * i times (matrix POWER, not i * value), which is exactly what
 * produces AE's characteristic spiral/fan Repeater patterns when
 * rotation and position are both set: each further copy is rotated
 * about the ORIGIN and THEN offset, so the offset itself sweeps around
 * as rotation accumulates. This reuses matrix2d.js's fromTRS/multiply
 * exactly as-is (batch 2) rather than re-deriving 2D affine
 * composition a second time - `multiply(perCopy, cumMatrix)` repeated
 * is literally perCopy^i by construction.
 *
 * Start/End Opacity ramps LINEARLY across copies 0..N-1 (AE's own
 * definition - copy 0 gets startOpacity, the last copy gets
 * endOpacity). Order lets copies stack either 'below' (copy 0 drawn
 * first/furthest back - AE's default) or 'above' (draw order reversed,
 * so copy 0 ends up on top instead).
 *
 * Output entries carry a MATRIX + opacity rather than pre-transformed
 * point coordinates - shapeLayer.js applies the matrix via
 * ctx.transform() at draw time, which is exactly correct regardless of
 * how a path's own tangent-relative anchors are represented, and lets
 * multiple paths from the SAME copy share one matrix object (by
 * reference) so shapeLayer.js can group them into a single fill pass.
 */
function applyRepeater(pathList, {
  copies = 3, transform = {}, startOpacity = 1, endOpacity = 1, order = 'below',
} = {}) {
  const perCopy = fromTRS({
    position: transform.position || [0, 0],
    rotation: transform.rotation || 0,
    scale: transform.scale || [1, 1],
    anchor: transform.anchor || [0, 0],
  });

  const n = Math.max(0, Math.round(copies));
  const out = [];
  let cumMatrix = identity();
  for (let i = 0; i < n; i++) {
    const opacity = n > 1 ? lerp(startOpacity, endOpacity, i / (n - 1)) : startOpacity;
    const copyMatrix = cumMatrix; // shared by reference across every path in this copy
    for (const p of pathList) {
      out.push({
        anchors: p.anchors, closed: p.closed, matrix: copyMatrix, opacity,
      });
    }
    cumMatrix = multiply(perCopy, cumMatrix); // compound: next copy = perCopy applied ON TOP of everything accumulated so far
  }
  if (order === 'above') out.reverse();
  return out;
}

module.exports = { applyRepeater };
