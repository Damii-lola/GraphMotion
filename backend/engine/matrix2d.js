/**
 * 2D affine transform matrices - the load-bearing math underneath
 * parenting/null-objects and precomposition both. A Node's world
 * position is "compose this matrix with every ancestor's matrix," and
 * that composition IS matrix multiplication - there's no way to build
 * a real transform hierarchy without this being correct.
 *
 * Represented as {a,b,c,d,e,f} matching HTML Canvas 2D's own
 * setTransform(a,b,c,d,e,f) convention exactly:
 *   | a  c  e |   x' = a*x + c*y + e
 *   | b  d  f |   y' = b*x + d*y + f
 *   | 0  0  1 |
 * so a computed matrix can be hand to ctx.setTransform(...spread)
 * directly - no translation layer between "the math" and "the draw
 * call," which is exactly what makes it possible to query a node's
 * world position WITHOUT touching canvas state at all (needed by
 * motion blur's sub-sampling and by anything that needs to know where
 * something ends up before deciding whether/how to draw it).
 */

function identity() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function translate(tx, ty) {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function scale(sx, sy) {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/**
 * Rotation by `radians`. Canvas 2D's y-axis points DOWN, so a positive
 * angle rotates clockwise on screen (not the counter-clockwise
 * convention of standard math-textbook axes) - this matches
 * ctx.rotate() exactly, which is the whole point.
 */
function rotate(radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/**
 * m1 ∘ m2 - applies m2 to a point FIRST, then m1 ("m1 after m2"),
 * matching standard matrix multiplication of the two augmented 3x3
 * forms these {a,b,c,d,e,f} objects represent. This is the operation
 * that makes a transform hierarchy possible: parent.getWorldMatrix(t)
 * composed with child.localMatrix(t) via multiply(parentWorld, childLocal).
 */
function multiply(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    b: m1.b * m2.a + m1.d * m2.b,
    d: m1.b * m2.c + m1.d * m2.d,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/**
 * Builds the per-layer transform matrix in After Effects' own order -
 * this specific order is not arbitrary, it's what makes "rotate/scale
 * around the anchor point, independent of where that anchor sits in
 * the frame" work correctly: subtract the anchor (recentering local
 * space on it), scale, rotate, THEN translate to the final position.
 * Composed via the primitives above (not hand-derived as one closed-
 * form expression) so each piece stays independently testable/correct.
 *
 * `rotation` is DEGREES (matching the schema's own documented units -
 * every "rotation" field the AI generates, here and in the prompt, is
 * "AnimatableValue<number> (degrees)"), converted to radians right here
 * before reaching `rotate()`. A real, severe bug found via live frame
 * inspection: this conversion never existed anywhere in the engine, so
 * `rotate(rotation)` fed a raw DEGREE value straight into a function
 * expecting RADIANS - confirmed directly, a text layer with
 * "rotation":-3 (meant as a subtle -3deg stylistic tilt) rendered
 * rotated -3 RADIANS (~-171.9deg), i.e. almost perfectly upside-down.
 * This is the single shared choke point for every caller (Node's own
 * layer transform, repeater.js's per-copy transform, shapeLayer.js's
 * nested group transform), so fixing it here fixes all of them at once
 * instead of patching each call site separately.
 */
function fromTRS({ position = [0, 0], rotation = 0, scale: s = [1, 1], anchor = [0, 0] }) {
  let m = translate(-anchor[0], -anchor[1]);
  m = multiply(scale(s[0], s[1]), m);
  m = multiply(rotate((rotation * Math.PI) / 180), m);
  m = multiply(translate(position[0], position[1]), m);
  return m;
}

function transformPoint(m, point) {
  return [m.a * point[0] + m.c * point[1] + m.e, m.b * point[0] + m.d * point[1] + m.f];
}

/** [a,b,c,d,e,f] in the exact order ctx.setTransform(...) expects. */
function toCanvasArgs(m) {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

module.exports = { identity, translate, scale, rotate, multiply, fromTRS, transformPoint, toCanvasArgs };
