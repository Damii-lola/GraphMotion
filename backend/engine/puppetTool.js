const { warpTriangle } = require('./layer3d');
const { resolve } = require('./node');

/**
 * The Puppet tool: place pins on a layer, move individual pins over
 * time, and the WHOLE layer deforms organically between them - real
 * mesh deformation, built from two genuinely reused pieces rather than
 * invented from scratch: a real Delaunay triangulation of the pins
 * (below), and batch 7's EXACT per-triangle affine warp (warpTriangle,
 * layer3d.js) for the actual pixel deformation - each triangle's
 * change from its rest shape to its current (pin-driven) shape IS
 * precisely a 3-point affine transform, the same primitive that
 * already powers perspective plane-warping.
 *
 * SCOPE: Position pins only (the primary real puppet-tool experience -
 * grab a point, move it, the mesh follows). AE's Starch pins (locking
 * a region's rigidity) and Bend pins are real, deliberately NOT built
 * here - a genuine, stated boundary, not a hidden gap. The mesh only
 * covers the CONVEX HULL of the pins (an inherent property of
 * triangulating a point set) - content outside that hull is not
 * touched by warpPuppetMesh at all, so real usage places pins around
 * the full boundary of whatever region should deform, exactly like
 * placing pins in real AE.
 */

/**
 * The circumcenter/circumradius of a triangle - the standard, real
 * closed-form solution (from the perpendicular-bisector intersection
 * of two of the triangle's edges). Returns null for a degenerate
 * (collinear) triangle, where no finite circumcircle exists.
 */
function circumcircle(a, b, c) {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const aSq = ax * ax + ay * ay, bSq = bx * bx + by * by, cSq = cx * cx + cy * cy;
  const ux = (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / d;
  const uy = (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / d;
  return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
}

function pointInCircumcircle(p, a, b, c) {
  const circ = circumcircle(a, b, c);
  if (!circ) return false;
  return Math.hypot(p[0] - circ.x, p[1] - circ.y) < circ.r - 1e-9;
}

/**
 * A real Bowyer-Watson incremental Delaunay triangulation: starts from
 * one huge "super-triangle" guaranteed to contain every input point,
 * then inserts points one at a time - each insertion finds every
 * existing triangle whose circumcircle contains the new point (the
 * defining Delaunay violation), removes them (leaving a star-shaped
 * polygonal hole), and re-fills the hole by connecting the new point
 * to every boundary edge of that hole. Finally discards any triangle
 * still touching a super-triangle vertex. Returns triangles as index
 * TRIPLES into the original `points` array (not copies of the points
 * themselves), matching how a mesh's connectivity is normally stored.
 */
function delaunayTriangulate(points) {
  if (points.length < 3) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const deltaMax = Math.max(maxX - minX, maxY - minY, 1) * 10;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  const superA = [midX - 2 * deltaMax, midY - deltaMax];
  const superB = [midX, midY + 2 * deltaMax];
  const superC = [midX + 2 * deltaMax, midY - deltaMax];

  const allPoints = [...points, superA, superB, superC];
  const superIdx = [points.length, points.length + 1, points.length + 2];
  let triangles = [[superIdx[0], superIdx[1], superIdx[2]]];

  const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  for (let pi = 0; pi < points.length; pi++) {
    const p = allPoints[pi];
    const badTriangles = triangles.filter(
      ([i0, i1, i2]) => pointInCircumcircle(p, allPoints[i0], allPoints[i1], allPoints[i2]),
    );

    const edgeCount = new Map();
    for (const [i0, i1, i2] of badTriangles) {
      for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
        const key = edgeKey(a, b);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }
    const boundary = [];
    for (const [i0, i1, i2] of badTriangles) {
      for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
        if (edgeCount.get(edgeKey(a, b)) === 1) boundary.push([a, b]);
      }
    }

    triangles = triangles.filter((tri) => !badTriangles.includes(tri));
    for (const [a, b] of boundary) triangles.push([a, b, pi]);
  }

  return triangles.filter((tri) => !tri.some((idx) => superIdx.includes(idx)));
}

/**
 * A puppet pin: `restPosition` is fixed (the point on the layer this
 * pin was placed at, defining the triangulation), `position` is the
 * animatable CURRENT position - a plain [x,y] or a keyframes.js
 * Property (resolved via node.js's resolve(), the same "accept either"
 * convention every other animatable field in this engine uses).
 * Defaults to sitting exactly at restPosition (no deformation) if no
 * position is given.
 */
class PuppetPin {
  constructor(restPosition, position = null) {
    this.restPosition = restPosition;
    this.position = position || restPosition;
  }
}

/** A full puppet mesh: a set of pins, triangulated ONCE from their rest positions (the triangulation itself never changes as pins move - only where each triangle's vertices currently ARE changes, exactly like a real puppet mesh's topology staying fixed while its pose changes). */
class PuppetMesh {
  constructor(pins) {
    this.pins = pins;
    this.restPoints = pins.map((p) => p.restPosition);
    this.triangleIndices = delaunayTriangulate(this.restPoints);
  }

  getCurrentPositions(t) {
    return this.pins.map((p) => resolve(p.position, t));
  }
}

/**
 * Warps `sourceCanvas` onto `ctx` according to `mesh`'s current pose at
 * time t: for every triangle in the mesh's (fixed) triangulation, the
 * REST positions of its 3 vertices are the source triangle and the
 * CURRENT (pin-resolved) positions are the destination triangle -
 * batch 7's warpTriangle does the actual exact affine pixel warp for
 * that single triangle, called once per mesh triangle here.
 */
function warpPuppetMesh(ctx, sourceCanvas, mesh, t) {
  const current = mesh.getCurrentPositions(t);
  // Fresh per call, never shared across frames - required for
  // correctness if sourceCanvas's own content ever changes between
  // calls (an animated puppet source, not just a deformed static one) -
  // see layer3d.js's getSourceImageData doc comment for the real bug
  // this exact pattern was found to cause when it used to be a
  // persistent, module-level cache instead.
  const cache = {};
  for (const [i0, i1, i2] of mesh.triangleIndices) {
    const srcTri = [mesh.restPoints[i0], mesh.restPoints[i1], mesh.restPoints[i2]];
    const dstTri = [current[i0], current[i1], current[i2]];
    warpTriangle(ctx, sourceCanvas, srcTri, dstTri, 0.75, cache);
  }
}

module.exports = {
  PuppetPin, PuppetMesh, warpPuppetMesh, delaunayTriangulate, circumcircle,
};
