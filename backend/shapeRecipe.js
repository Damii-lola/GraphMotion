const { clamp01 } = require('./easing');

/**
 * THE ANSWER to "there are trillions of objects, we can't hand-code
 * them all." Every hero icon so far (watch, car, rocket...) is one
 * hardcoded vector path written by hand - that genuinely doesn't
 * scale, and never will.
 *
 * This is the alternative: a tiny, SAFE vocabulary of geometric
 * primitives (circle, rect, triangle, polygon, arc, line) that
 * Mistral can compose into a "shape recipe" - structured DATA
 * describing an object, not code. A guitar becomes a rect (body) + a
 * long thin rect (neck) + a circle (sound hole). A pizza slice
 * becomes a triangle + small circles (toppings). We interpret this
 * recipe with our own fixed, bounds-checked rendering logic - Mistral
 * never writes a single line of canvas code, it only ever describes
 * shapes-and-positions as JSON, which is validated and clamped before
 * anything touches a canvas. This is what actually scales to any
 * object without ever executing untrusted code.
 */

const VALID_PRIMITIVE_TYPES = ['circle', 'rect', 'triangle', 'polygon', 'arc', 'line'];
const MAX_SHAPES_PER_RECIPE = 14;
const MAX_POLYGON_POINTS = 8;

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Validates and sanitizes a raw shape recipe (whatever Mistral sent)
 * into something guaranteed safe to render - every numeric value
 * clamped to a sane range, every shape type checked against the fixed
 * enum, malformed entries dropped rather than crashing the render.
 * This is the actual security boundary: nothing past this function
 * is trusted as "possibly attacker-shaped" anymore.
 */
function validateShapeRecipe(rawRecipe) {
  if (!Array.isArray(rawRecipe)) return [];

  const clean = [];
  for (const raw of rawRecipe.slice(0, MAX_SHAPES_PER_RECIPE)) {
    if (!raw || typeof raw !== 'object') continue;
    if (!VALID_PRIMITIVE_TYPES.includes(raw.type)) continue;

    const shape = {
      type: raw.type,
      x: clampNum(raw.x, -1.3, 1.3, 0),
      y: clampNum(raw.y, -1.3, 1.3, 0),
      rotation: clampNum(raw.rotation, 0, 360, 0),
      fill: raw.fill !== false,
    };

    if (shape.type === 'circle' || shape.type === 'arc') {
      shape.r = clampNum(raw.r, 0.03, 1.2, 0.2);
    }
    if (shape.type === 'rect') {
      shape.w = clampNum(raw.w, 0.03, 1.5, 0.3);
      shape.h = clampNum(raw.h, 0.03, 1.5, 0.3);
      shape.rx = clampNum(raw.rx, 0, Math.min(shape.w, shape.h) / 2, 0);
    }
    if (shape.type === 'arc') {
      shape.startAngle = clampNum(raw.startAngle, 0, 360, 0);
      shape.endAngle = clampNum(raw.endAngle, 0, 360, 180);
    }
    if (shape.type === 'line') {
      shape.x2 = clampNum(raw.x2, -1.3, 1.3, shape.x + 0.3);
      shape.y2 = clampNum(raw.y2, -1.3, 1.3, shape.y);
      shape.strokeWidth = clampNum(raw.strokeWidth, 0.02, 0.25, 0.06);
    }
    if (shape.type === 'triangle' || shape.type === 'polygon') {
      if (!Array.isArray(raw.points)) continue;
      const points = raw.points
        .slice(0, MAX_POLYGON_POINTS)
        .filter((p) => Array.isArray(p) && p.length === 2)
        .map(([px, py]) => [clampNum(px, -1.3, 1.3, 0), clampNum(py, -1.3, 1.3, 0)]);
      if (points.length < 3) continue;
      shape.points = points;
    }

    clean.push(shape);
  }
  return clean;
}

/**
 * Renders a validated recipe - every primitive drawn with our own
 * fixed, safe canvas calls. `size` maps the recipe's normalized -1..1
 * coordinate space to actual pixels, centered at the current origin
 * (caller is expected to have already translated/scaled into
 * position, matching how every other icon in this codebase works).
 */
function drawShapeRecipe(ctx, recipe, size, accentColor) {
  if (!recipe || recipe.length === 0) return false;

  for (const shape of recipe) {
    ctx.save();
    ctx.translate(shape.x * size, shape.y * size);
    ctx.rotate((shape.rotation * Math.PI) / 180);
    ctx.fillStyle = accentColor;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = size * 0.05;

    switch (shape.type) {
      case 'circle':
        ctx.beginPath();
        ctx.arc(0, 0, shape.r * size, 0, Math.PI * 2);
        shape.fill ? ctx.fill() : ctx.stroke();
        break;
      case 'rect':
        ctx.beginPath();
        roundRectPath(ctx, -shape.w * size / 2, -shape.h * size / 2, shape.w * size, shape.h * size, shape.rx * size);
        shape.fill ? ctx.fill() : ctx.stroke();
        break;
      case 'arc':
        ctx.beginPath();
        ctx.arc(0, 0, shape.r * size, (shape.startAngle * Math.PI) / 180, (shape.endAngle * Math.PI) / 180);
        ctx.lineWidth = size * 0.08;
        ctx.stroke();
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo((shape.x2 - shape.x) * size, (shape.y2 - shape.y) * size);
        ctx.lineWidth = shape.strokeWidth * size;
        ctx.lineCap = 'round';
        ctx.stroke();
        break;
      case 'triangle':
      case 'polygon':
        ctx.beginPath();
        shape.points.forEach(([px, py], i) => {
          const sx = px * size, sy = py * size;
          if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        });
        ctx.closePath();
        shape.fill ? ctx.fill() : ctx.stroke();
        break;
    }
    ctx.restore();
  }
  return true;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

module.exports = { validateShapeRecipe, drawShapeRecipe, VALID_PRIMITIVE_TYPES, MAX_SHAPES_PER_RECIPE, MAX_POLYGON_POINTS };
