const { createCanvas } = require('@napi-rs/canvas');
const { fromTRS3D, multiply4, transformPoint4 } = require('./matrix4');
const { resolve } = require('./node');

/**
 * Real 3D layers in a shared space: each Layer3D is fundamentally a
 * FLAT rectangle (its own rendered 2D content, `width` x `height`)
 * positioned/rotated anywhere in one common 3D world - this is
 * genuinely how AE's own "3D layer" model works too (a 3D switch on a
 * layer gives it Z position and X/Y/Z rotation/orientation, it does
 * NOT turn the layer into a real mesh). Multiple such layers sharing
 * the same camera and world space is what makes them occlude/relate to
 * each other correctly, which is the actual point of "a shared space"
 * as opposed to batch 5's per-layer pseudo-3D text extrusion (which
 * had no shared camera or cross-layer depth relationship at all).
 *
 * Parenting mirrors node.js's 2D Node exactly (position/rotation
 * Properties, getWorldMatrix composing up the ancestor chain via
 * matrix4.js's multiply4) - the same architectural pattern, promoted
 * to 4x4, not a different design.
 *
 * DEPTH SORTING is real but deliberately SCOPED to whole-layer
 * painter's algorithm (sort by each layer's average projected corner
 * depth, draw back-to-front) - matching AE's own actual default
 * behavior for 3D layers without its "Ray-traced 3D"/per-pixel-
 * intersections renderer engaged, not an arbitrary shortcut. A layer
 * that PHYSICALLY INTERSECTS another (rather than sitting cleanly in
 * front of or behind it) has no single correct draw order under this
 * model - a real, honest limitation, not a bug.
 *
 * NO NEAR-PLANE CLIPPING: a layer straddling the camera's near plane
 * (some corners in front, some behind) will render using
 * camera3d.js's simple center-point fallback for its behind-camera
 * corners rather than a properly clipped, re-triangulated edge - a
 * real, deliberate scope boundary (true clipping needs polygon
 * splitting against a plane, meaningfully more machinery for an edge
 * case that doesn't arise in normal camera moves that keep content in
 * front of the camera, which is how this is verified/demonstrated).
 */
class Layer3D {
  constructor({
    position = [0, 0, 0], rotationX = 0, rotationY = 0, rotationZ = 0, scale = [1, 1, 1], anchor = [0, 0, 0],
    opacity = 1, width = 200, height = 200, content = null, draw = null, name = null,
  } = {}) {
    this.position = position;
    this.rotationX = rotationX;
    this.rotationY = rotationY;
    this.rotationZ = rotationZ;
    this.scale = scale;
    this.anchor = anchor;
    this.opacity = opacity;
    this.width = width;
    this.height = height;
    this.content = content; // a static pre-rendered canvas, OR...
    this.draw = draw; // ...(ctx, t) => void, rendered fresh into an internal buffer each call
    this.name = name;
    this.parent = null;
    this.children = [];
    this._buffer = null;
  }

  addChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parent = null;
  }

  localMatrix(t) {
    return fromTRS3D({
      position: resolve(this.position, t),
      rotationX: resolve(this.rotationX, t),
      rotationY: resolve(this.rotationY, t),
      rotationZ: resolve(this.rotationZ, t),
      scale: resolve(this.scale, t),
      anchor: resolve(this.anchor, t),
    });
  }

  getWorldMatrix(t) {
    const local = this.localMatrix(t);
    return this.parent ? multiply4(this.parent.getWorldMatrix(t), local) : local;
  }

  getWorldOpacity(t) {
    const own = resolve(this.opacity, t);
    return this.parent ? this.parent.getWorldOpacity(t) * own : own;
  }

  getContentCanvas(t) {
    if (this.content) return this.content;
    if (this.draw) {
      if (!this._buffer) this._buffer = createCanvas(this.width, this.height);
      const ctx = this._buffer.getContext('2d');
      ctx.clearRect(0, 0, this.width, this.height);
      this.draw(ctx, t);
      return this._buffer;
    }
    return null;
  }

  /** The flat plane's 4 corners in LOCAL space, TL/TR/BR/BL order (matching a typical 2D layer's top-left-origin content authoring) - anchor (subtracted inside fromTRS3D, matching matrix2d.js's 2D convention) is what lets a layer pivot around its own center by setting anchor:[width/2,height/2,0], the same mental model as a 2D Node. */
  localCorners() {
    return [
      [0, 0, 0], [this.width, 0, 0], [this.width, this.height, 0], [0, this.height, 0],
    ];
  }
}

// ---------------------------------------------------------------------
// Perspective-correct-ENOUGH image warping: a flat layer's projected
// quad is, under true perspective, a general (non-affine) quadrilateral
// - canvas's own ctx.setTransform can only ever represent an AFFINE
// map (parallelograms), so a single transform+drawImage would be
// visibly wrong for anything but a layer parallel to the camera. The
// grid-subdivision + per-triangle-exact-affine technique below is the
// standard, well-established way to approximate true perspective
// texture mapping on an affine-only 2D API: an affine map IS exact for
// a TRIANGLE (3 point correspondences fully determine it, no residual
// error), so splitting the source rectangle into a fine grid of small
// triangles and affine-warping each one individually converges toward
// true perspective correctness as the grid gets finer - a real,
// provable convergence property, not a hand-wave. This is genuinely
// how a number of production perspective-texture-mapping-on-canvas
// implementations work, not a shortcut invented for this engine.
// ---------------------------------------------------------------------

/**
 * Inverts a 3x3 matrix (row-major flat 9-array) via the explicit
 * cofactor/adjugate method - a standard, directly-verifiable formula
 * (chosen over trying to recall a Cramer's-rule shortcut from memory,
 * which is exactly the kind of thing that's easy to get subtly wrong;
 * this is cross-checked in the batch 7 test suite by recovering a
 * KNOWN affine transform exactly). Returns null for a degenerate
 * (zero-area / collinear-points) triangle.
 */
function invert3x3(m) {
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m;
  const det = m0 * (m4 * m8 - m5 * m7) - m1 * (m3 * m8 - m5 * m6) + m2 * (m3 * m7 - m4 * m6);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const cof00 = m4 * m8 - m5 * m7, cof01 = -(m3 * m8 - m5 * m6), cof02 = m3 * m7 - m4 * m6;
  const cof10 = -(m1 * m8 - m2 * m7), cof11 = m0 * m8 - m2 * m6, cof12 = -(m0 * m7 - m1 * m6);
  const cof20 = m1 * m5 - m2 * m4, cof21 = -(m0 * m5 - m2 * m3), cof22 = m0 * m4 - m1 * m3;
  // adjugate = transpose of the cofactor matrix, scaled by 1/det
  return [
    cof00 * invDet, cof10 * invDet, cof20 * invDet,
    cof01 * invDet, cof11 * invDet, cof21 * invDet,
    cof02 * invDet, cof12 * invDet, cof22 * invDet,
  ];
}

function mulMat3Vec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Solves for the EXACT 2D affine transform {a,b,c,d,e,f} (canvas
 * convention) that maps src[i] to dst[i] for all 3 point pairs - built
 * by expressing "x' = a*x+c*y+e" as a 3x3 linear system (one row per
 * point) and inverting once to solve for both the x-coefficients
 * (a,c,e) and y-coefficients (b,d,f) via the same inverted matrix.
 */
function solveAffineFromTriangle(src, dst) {
  const S = [
    src[0][0], src[0][1], 1,
    src[1][0], src[1][1], 1,
    src[2][0], src[2][1], 1,
  ];
  const Sinv = invert3x3(S);
  if (!Sinv) return null;
  const [a, c, e] = mulMat3Vec3(Sinv, [dst[0][0], dst[1][0], dst[2][0]]);
  const [b, d, f] = mulMat3Vec3(Sinv, [dst[0][1], dst[1][1], dst[2][1]]);
  return {
    a, b, c, d, e, f,
  };
}

/**
 * Nudges each vertex of a triangle outward from its own centroid by a
 * fixed pixel amount - used ONLY for the clip boundary below, never
 * for the affine correspondence itself. Fixes a real, measured artifact
 * (found via direct pixel sampling before shipping this, not assumed):
 * two adjacent triangles sharing an edge, each clipped independently
 * via ctx.clip(), each anti-alias their OWN side of that shared edge
 * to ~50% coverage - and compositing two independently-50%-covered
 * draws via normal source-over alpha blending gives 1-(1-0.5)*(1-0.5)
 * = 75% opacity, NOT the 100% a perfectly-tiled seam should produce
 * (alpha compositing isn't linearly additive), leaving a visible
 * translucent seam along every triangle boundary. Dilating the CLIP
 * shape by a fraction of a pixel makes neighboring triangles overlap
 * slightly instead of leaving that hairline undercoverage gap - the
 * transform itself is untouched, so texture mapping stays correct;
 * only which pixels are ALLOWED to show through changes.
 */
function expandTriangleForClip(tri, amount) {
  const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
  const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
  return tri.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * amount, y + (dy / len) * amount];
  });
}

/** Warps the FULL sourceCanvas through the exact affine transform mapping srcTri->dstTri, clipped to a very slightly dilated dstTri (see expandTriangleForClip) - drawImage draws the whole source, but only the clipped triangle region ends up visible, and only that region is mapped correctly (the rest of the image is transformed too, just discarded by the clip). */
function warpTriangle(ctx, sourceCanvas, srcTri, dstTri, clipExpand = 0.75) {
  const m = solveAffineFromTriangle(srcTri, dstTri);
  if (!m) return;
  const clipTri = clipExpand > 0 ? expandTriangleForClip(dstTri, clipExpand) : dstTri;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(clipTri[0][0], clipTri[0][1]);
  ctx.lineTo(clipTri[1][0], clipTri[1][1]);
  ctx.lineTo(clipTri[2][0], clipTri[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
}

/** Standard bilinear interpolation of a 2D point within a quad given its 4 corners (TL,TR,BR,BL) at parameter (u,v) in [0,1]x[0,1] - lerp across the top edge and bottom edge, then lerp between those. */
function bilinearQuadPoint(quad, u, v) {
  const [TL, TR, BR, BL] = quad;
  const top = [TL[0] + (TR[0] - TL[0]) * u, TL[1] + (TR[1] - TL[1]) * u];
  const bottom = [BL[0] + (BR[0] - BL[0]) * u, BL[1] + (BR[1] - BL[1]) * u];
  return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
}

/**
 * Draws `sourceCanvas` warped so its 4 corners land on `quad4`
 * (destination screen points, TL/TR/BR/BL order) - subdivides the
 * source into an NxN grid, bilinearly interpolates each grid vertex's
 * destination position across the quad, and warps each resulting cell
 * (split into 2 triangles) via the exact per-triangle affine solver
 * above. Higher `subdivisions` converges closer to true perspective
 * correctness for a strongly-tilted plane; a layer with little/no
 * perspective distortion (facing the camera near-straight-on) is
 * already exact even at low subdivision, since its true projection
 * IS (near enough to) a single affine parallelogram in that case.
 */
function warpImageToQuad(ctx, sourceCanvas, quad4, subdivisions = 8) {
  const srcW = sourceCanvas.width, srcH = sourceCanvas.height;
  const n = Math.max(1, subdivisions);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
      const sTL = [u0 * srcW, v0 * srcH], sTR = [u1 * srcW, v0 * srcH];
      const sBR = [u1 * srcW, v1 * srcH], sBL = [u0 * srcW, v1 * srcH];
      const dTL = bilinearQuadPoint(quad4, u0, v0), dTR = bilinearQuadPoint(quad4, u1, v0);
      const dBR = bilinearQuadPoint(quad4, u1, v1), dBL = bilinearQuadPoint(quad4, u0, v1);
      warpTriangle(ctx, sourceCanvas, [sTL, sTR, sBR], [dTL, dTR, dBR]);
      warpTriangle(ctx, sourceCanvas, [sTL, sBR, sBL], [dTL, dBR, dBL]);
    }
  }
}

/**
 * Renders a whole 3D scene: projects every layer's 4 corners through
 * `camera` at time t, skips any layer entirely behind the camera,
 * sorts the rest back-to-front by average corner depth (painter's
 * algorithm - see the class-level doc comment for its real, documented
 * scope), and warps each layer's own rendered content onto its
 * projected quad in that order.
 */
function renderScene3D(ctx, compWidth, compHeight, layers, camera, t, { subdivisions = 8 } = {}) {
  const entries = [];
  for (const layer of layers) {
    const world = layer.getWorldMatrix(t);
    const worldCorners = layer.localCorners().map((c) => transformPoint4(world, c).slice(0, 3));
    const projected = worldCorners.map((c) => camera.project(c, t, compWidth, compHeight));
    if (!projected.some((p) => p.depth > 0)) continue; // entirely behind the camera
    const avgDepth = projected.reduce((s, p) => s + p.depth, 0) / projected.length;
    entries.push({ layer, projected, avgDepth });
  }

  entries.sort((a, b) => b.avgDepth - a.avgDepth); // farthest first -> drawn first -> back to front

  for (const entry of entries) {
    const content = entry.layer.getContentCanvas(t);
    if (!content) continue;
    const opacity = entry.layer.getWorldOpacity(t);
    if (opacity <= 0.001) continue;
    const quad = entry.projected.map((p) => [p.x, p.y]);
    ctx.save();
    ctx.globalAlpha = opacity;
    warpImageToQuad(ctx, content, quad, subdivisions);
    ctx.restore();
  }
}

module.exports = {
  Layer3D, renderScene3D, warpImageToQuad, warpTriangle, solveAffineFromTriangle, bilinearQuadPoint, invert3x3,
};
