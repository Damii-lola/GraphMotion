/**
 * 4x4 homogeneous transform matrices - the 3D counterpart to
 * matrix2d.js, needed once a layer has a real Z position/orientation
 * instead of living flat in the XY plane. Represented as a flat
 * 16-element array in ROW-MAJOR order:
 *   | m0  m1  m2  m3  |
 *   | m4  m5  m6  m7  |
 *   | m8  m9  m10 m11 |
 *   | m12 m13 m14 m15 |
 * transforming a point as a column vector [x,y,z,1]^T (M * v), the
 * same convention matrix2d.js uses for 2D (2x3-in-3x3 there, full 4x4
 * here since 3D rotation genuinely needs the third row/column).
 *
 * WORLD AXIS CONVENTION (chosen explicitly, not a textbook default -
 * documented here because getting this wrong silently is exactly the
 * kind of thing that only shows up as "everything looks subtly
 * mirrored," so it's stated up front and empirically verified in
 * camera3d.js before anything real is built on it):
 *   +X: right (matches the 2D engine and screen space)
 *   +Y: DOWN (matches canvas/2D engine - camera3d.js's "up" vector is
 *       therefore [0,-1,0], not [0,1,0])
 *   +Z: INTO the screen, away from the viewer (matches AE's own
 *       convention - a layer with a larger Z sits further back)
 */

function identity4() {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

function translate4(tx, ty, tz) {
  return [
    1, 0, 0, tx,
    0, 1, 0, ty,
    0, 0, 1, tz,
    0, 0, 0, 1,
  ];
}

function scale4(sx, sy, sz) {
  return [
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ];
}

function rotateX4(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [
    1, 0, 0, 0,
    0, c, -s, 0,
    0, s, c, 0,
    0, 0, 0, 1,
  ];
}

function rotateY4(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [
    c, 0, s, 0,
    0, 1, 0, 0,
    -s, 0, c, 0,
    0, 0, 0, 1,
  ];
}

function rotateZ4(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [
    c, -s, 0, 0,
    s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/** a ∘ b ("a after b" - apply b to a point first, then a), matching matrix2d.js's multiply() convention exactly, generalized to 4x4. */
function multiply4(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

/** Transforms a 3D point, returning full homogeneous [x,y,z,w] (w is 1 for a pure affine transform, but a projection matrix produces w!==1, so callers must handle that themselves rather than this function silently dividing). */
function transformPoint4(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
    m[12] * x + m[13] * y + m[14] * z + m[15],
  ];
}

/**
 * Transforms a DIRECTION (not a point) - the translation column (m3,
 * m7, m11) is deliberately excluded, since a direction has no
 * position, only orientation/magnitude (batch 8's lights.js needs this
 * for transforming a flat layer's local surface normal into world
 * space by its rotation, without the layer's own position corrupting
 * the result). Exact for rotation-only or uniform-scale transforms; a
 * non-uniform scale technically needs the inverse-transpose to keep a
 * normal perpendicular to its surface, which this does not compute - a
 * real, honest, stated simplification (lights.js documents the same
 * boundary where it's actually used), not a silent inaccuracy.
 */
function transformDirection4(m, d) {
  const [x, y, z] = d;
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[4] * x + m[5] * y + m[6] * z,
    m[8] * x + m[9] * y + m[10] * z,
  ];
}

/**
 * Builds a layer's full local transform in AE's own order, the exact
 * 3D generalization of matrix2d.js's fromTRS: subtract the anchor
 * (recenter local space on it), scale, rotate (X then Y then Z - a
 * deliberately chosen, internally-consistent compound order, not
 * claimed to bit-match AE's own internal Orientation math, the same
 * honest stance matrix2d.js's 2D fromTRS takes), then translate to the
 * final 3D position.
 */
function fromTRS3D({
  position = [0, 0, 0], rotationX = 0, rotationY = 0, rotationZ = 0, scale = [1, 1, 1], anchor = [0, 0, 0],
} = {}) {
  let m = translate4(-anchor[0], -anchor[1], -anchor[2]);
  m = multiply4(scale4(scale[0], scale[1], scale[2]), m);
  m = multiply4(rotateX4(rotationX), m);
  m = multiply4(rotateY4(rotationY), m);
  m = multiply4(rotateZ4(rotationZ), m);
  m = multiply4(translate4(position[0], position[1], position[2]), m);
  return m;
}

/**
 * Standard "camera-space change of basis" lookAt matrix: given the
 * camera's world position (`eye`), what it's looking at (`target`),
 * and a reference `up` vector, builds an orthonormal basis
 * {xaxis(right), yaxis(true up), zaxis(backward, i.e. eye-target)} and
 * returns the matrix that transforms WORLD points into this camera's
 * local space. This is the well-known OpenGL-style construction (valid
 * for ANY consistent world-axis convention, since it's just "build an
 * orthonormal frame from these three vectors and express world points
 * relative to it" - it doesn't itself assume Y-up or Z-forward,
 * camera3d.js is what supplies THIS engine's specific [0,-1,0] up
 * vector and interprets the resulting camera-space Z sign correctly
 * for its own projection formula, verified empirically there).
 */
function lookAt4(eye, target, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v) => {
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const zaxis = norm(sub(eye, target));
  const xaxis = norm(cross(up, zaxis));
  const yaxis = cross(zaxis, xaxis);

  return [
    xaxis[0], xaxis[1], xaxis[2], -dot(xaxis, eye),
    yaxis[0], yaxis[1], yaxis[2], -dot(yaxis, eye),
    zaxis[0], zaxis[1], zaxis[2], -dot(zaxis, eye),
    0, 0, 0, 1,
  ];
}

module.exports = {
  identity4, translate4, scale4, rotateX4, rotateY4, rotateZ4, multiply4, transformPoint4, transformDirection4, fromTRS3D, lookAt4,
};
