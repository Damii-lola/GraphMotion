/**
 * Procedural vector shapes: AE's Rectangle, Ellipse, Polygon, and Star
 * shape tools all generate a closed bezier path from a handful of
 * numeric parameters, rather than the user hand-drawing one - the
 * "procedural" part of "procedural vector shapes." Each generator
 * below returns { anchors, closed: true } in path.js's shared anchor
 * format, so the output plugs directly into trimPaths.js, repeater.js,
 * and shapeLayer.js's fill/stroke rendering with no adapter needed.
 */

const KAPPA = 0.5522847498307936; // 4/3 * (sqrt(2)-1) - the standard constant for approximating a quarter-circle arc with a single cubic bezier (already used and arc-length-verified in batch 5's quarter-circle test)

function vecSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function vecScale(v, s) { return [v[0] * s, v[1] * s]; }
function vecNorm(v) { const m = Math.hypot(v[0], v[1]) || 1; return [v[0] / m, v[1] / m]; }

/**
 * Builds a closed rounded-corner path from a list of straight-edge
 * vertices - the SAME general technique whether the polygon is a
 * rectangle (4 vertices), an N-gon, or a star (2N alternating-radius
 * vertices), so all three shape generators below share this one
 * routine instead of each separately re-deriving corner rounding.
 *
 * For vertex i, the incoming edge direction (from vertex i-1) and
 * outgoing edge direction (to vertex i+1) are computed, and the sharp
 * corner is replaced by two anchors offset `roundness` back along the
 * incoming edge and forward along the outgoing edge, joined by a
 * bezier arc whose tangent lengths are KAPPA*roundness in each edge's
 * own direction - the exact same geometric construction as a rounded
 * rectangle corner, just generalized to an arbitrary edge angle.
 *
 * roundness may be a single number (applied to every vertex) or an
 * array (one entry per vertex - Star uses this for separate inner-
 * point / outer-point roundness). At roundness=0 for a vertex, both
 * its corner anchors collapse onto the vertex itself with zero-length
 * tangents - a genuinely sharp corner falls out with no special-casing.
 */
function roundedPolygonFromVertices(vertices, roundness) {
  const n = vertices.length;
  const rArr = Array.isArray(roundness) ? roundness : new Array(n).fill(roundness);
  const anchors = [];
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const cur = vertices[i];
    const next = vertices[(i + 1) % n];
    const r = Math.max(0, rArr[i]);

    const edgeIn = vecNorm(vecSub(cur, prev));
    const edgeOut = vecNorm(vecSub(next, cur));

    const anchorIn = vecSub(cur, vecScale(edgeIn, r));
    const anchorOut = vecAdd(cur, vecScale(edgeOut, r));

    anchors.push({ point: anchorIn, outTangent: vecScale(edgeIn, KAPPA * r) });
    anchors.push({ point: anchorOut, inTangent: vecScale(edgeOut, -KAPPA * r) });
  }
  return { anchors, closed: true };
}

/** AE's Rectangle tool: width/height around `position` (center), with `roundness` (px) matching AE's own uniform corner-radius control, clamped so opposite corners can never overlap. */
function rectanglePath({
  width = 100, height = 100, position = [0, 0], roundness = 0,
} = {}) {
  const [cx, cy] = position;
  const hw = width / 2, hh = height / 2;
  const r = Math.min(Math.max(0, roundness), hw, hh);
  const vertices = [
    [cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh],
  ];
  return roundedPolygonFromVertices(vertices, r);
}

/** AE's Ellipse tool: the standard 4-anchor KAPPA bezier approximation of an ellipse (the same technique AE itself uses internally) - width/height around `position` (center). */
function ellipsePath({ width = 100, height = 100, position = [0, 0] } = {}) {
  const [cx, cy] = position;
  const rx = width / 2, ry = height / 2;
  const anchors = [
    { point: [cx, cy - ry], outTangent: [KAPPA * rx, 0], inTangent: [-KAPPA * rx, 0] },
    { point: [cx + rx, cy], outTangent: [0, KAPPA * ry], inTangent: [0, -KAPPA * ry] },
    { point: [cx, cy + ry], outTangent: [-KAPPA * rx, 0], inTangent: [KAPPA * rx, 0] },
    { point: [cx - rx, cy], outTangent: [0, -KAPPA * ry], inTangent: [0, KAPPA * ry] },
  ];
  return { anchors, closed: true };
}

/** AE's Polygon (Polystar in "Polygon" mode): `points`-sided regular polygon, point 0 at the top (rotation=0), matching AE's own Polystar convention. `roundness` softens every corner uniformly. */
function polygonPath({
  points = 5, radius = 60, position = [0, 0], rotation = 0, roundness = 0,
} = {}) {
  const [cx, cy] = position;
  const vertices = [];
  const rotRad = ((rotation - 90) * Math.PI) / 180;
  for (let i = 0; i < points; i++) {
    const a = rotRad + (i / points) * Math.PI * 2;
    vertices.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  return roundedPolygonFromVertices(vertices, roundness);
}

/** AE's Polystar in "Star" mode: `points`-pointed star alternating between outerRadius and innerRadius vertices, with SEPARATE inner/outer roundness controls (AE's own real distinction - a rounded-tip star can still have sharp inner notches, or vice versa). */
function starPath({
  points = 5, innerRadius = 30, outerRadius = 60, position = [0, 0], rotation = 0,
  innerRoundness = 0, outerRoundness = 0,
} = {}) {
  const [cx, cy] = position;
  const vertices = [];
  const roundnessArr = [];
  const rotRad = ((rotation - 90) * Math.PI) / 180;
  const n = points * 2;
  for (let i = 0; i < n; i++) {
    const isOuter = i % 2 === 0;
    const r = isOuter ? outerRadius : innerRadius;
    const a = rotRad + (i / n) * Math.PI * 2;
    vertices.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    roundnessArr.push(isOuter ? outerRoundness : innerRoundness);
  }
  return roundedPolygonFromVertices(vertices, roundnessArr);
}

/**
 * AE's Pen tool: an author-specified bezier path from explicit anchor
 * points, rather than a procedurally-generated primitive. Genuinely
 * trivial to add - path.js's renderPathToContext (and every other
 * consumer of a shape's {anchors, closed} output: trimPaths.js,
 * repeater.js, shapeLayer.js's fill/stroke) already works on this
 * exact generic anchor format, and the schema's own text-on-path
 * feature (onPath.anchors) already authors the identical shape from
 * the outside - this just exposes that same already-tested format as
 * a real shape kind too.
 *
 * Added directly in response to a real, repeated live-generation
 * failure: with only 4 closed-form primitives (rectangle/ellipse/
 * polygon/star) available, the model repeatedly tried to author
 * custom icon-like marks (checkmarks, arrows, freeform glyphs) it had
 * no correct way to express, and kept guessing "path" as the
 * shape.kind (a natural but wrong guess - "path" IS the correct
 * CONTENT ITEM type one level up, just not a shape KIND). Rather than
 * keep telling the model "no, compose it from primitives instead" for
 * something primitives genuinely can't build, this gives it the real
 * capability AE's own Pen tool provides.
 */
function customPath({ anchors = [], closed = true } = {}) {
  return { anchors, closed };
}

module.exports = {
  rectanglePath, ellipsePath, polygonPath, starPath, customPath, roundedPolygonFromVertices, KAPPA,
};
