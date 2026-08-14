const { Node, resolve } = require('./node');
const { fromTRS, toCanvasArgs } = require('./matrix2d');
const { renderPathToContext } = require('./path');
const { trimPathsMultiple } = require('./trimPaths');
const { applyRepeater } = require('./repeater');

/**
 * A Shape Layer, matching AE's real content model: a `contents` list
 * processed TOP TO BOTTOM, maintaining a running list of "current
 * paths" that path-shape items APPEND to and path OPERATORS (Trim
 * Paths, Repeater) REPLACE with their transformed result - exactly how
 * a real AE shape group's stacking order works ("everything ABOVE an
 * operator or a Fill/Stroke is what that item actually acts on").
 *
 * Extends Node (batch 2) so a ShapeLayer is a first-class citizen of
 * the whole engine for free - parenting, motion blur, and (as a
 * Composition child) blend modes/track mattes/adjustment layers
 * (batch 3) all apply to it without anything special written here.
 * Node's constructor unconditionally sets `this.draw = opts.draw`
 * (null by default), which would SHADOW a `draw()` prototype method
 * defined via subclassing - so `this.draw` is assigned as an instance
 * property AFTER calling super(), not defined as a class method.
 *
 * Nested groups (`{type:'group', contents, transform}`) are rendered
 * INDEPENDENTLY - their own contents processed in their own scope,
 * with their own transform applied via ctx.transform - and composited
 * as pixels onto the parent, deliberately NOT sharing raw path
 * geometry back up into the parent's currentPaths list. This is a
 * real, intentional scope boundary (the same spirit as batch 2/3's
 * collapsed-precomp boundary): it covers the overwhelmingly common
 * real use of grouping a bundle of shapes+fill+stroke+their own
 * transform together, without needing full cross-group geometry flow -
 * which AE itself only supports through more advanced "collapse
 * transforms" wiring anyway.
 */
class ShapeLayer extends Node {
  constructor(opts = {}) {
    super(opts);
    this.contents = opts.contents || [];
    this.draw = (ctx, t) => renderContents(ctx, this.contents, t);
  }
}

/** Groups a list of {anchors,closed,matrix,opacity} path entries by their (possibly null/identity) matrix reference, so Fill/Stroke can combine multiple UNTRANSFORMED simultaneous shapes into one fill pass (correct evenodd/nonzero interaction between them) while still giving each differently-transformed Repeater copy its own separate pass (they are genuinely separate instances, not one combined path). */
function groupByMatrix(paths) {
  const map = new Map();
  const order = [];
  for (const p of paths) {
    const key = p.matrix || 'identity';
    if (!map.has(key)) {
      map.set(key, { matrix: p.matrix || null, opacity: p.opacity != null ? p.opacity : 1, paths: [] });
      order.push(key);
    }
    map.get(key).paths.push(p);
  }
  return order.map((k) => map.get(k));
}

function drawFill(ctx, currentPaths, item, t) {
  if (currentPaths.length === 0) return;
  const color = resolve(item.color, t) || '#ffffff';
  const opacity = resolve(item.opacity != null ? item.opacity : 1, t);
  const fillRule = item.fillRule || 'nonzero';

  for (const group of groupByMatrix(currentPaths)) {
    ctx.save();
    if (group.matrix) ctx.transform(...toCanvasArgs(group.matrix));
    ctx.beginPath();
    for (const p of group.paths) renderPathToContext(ctx, p.anchors, p.closed);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity * group.opacity;
    ctx.fill(fillRule);
    ctx.restore();
  }
}

function drawStroke(ctx, currentPaths, item, t) {
  if (currentPaths.length === 0) return;
  const color = resolve(item.color, t) || '#ffffff';
  const opacity = resolve(item.opacity != null ? item.opacity : 1, t);
  const width = resolve(item.width != null ? item.width : 4, t);

  for (const group of groupByMatrix(currentPaths)) {
    ctx.save();
    if (group.matrix) ctx.transform(...toCanvasArgs(group.matrix));
    ctx.beginPath();
    for (const p of group.paths) renderPathToContext(ctx, p.anchors, p.closed);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = item.cap || 'butt';
    ctx.lineJoin = item.join || 'miter';
    if (item.dash) ctx.setLineDash(item.dash);
    ctx.globalAlpha = opacity * group.opacity;
    ctx.stroke();
    ctx.restore();
  }
}

function drawNestedGroup(ctx, item, t) {
  ctx.save();
  const tr = item.transform || {};
  const m = fromTRS({
    position: resolve(tr.position, t) || [0, 0],
    rotation: resolve(tr.rotation != null ? tr.rotation : 0, t),
    scale: resolve(tr.scale, t) || [1, 1],
    anchor: resolve(tr.anchor, t) || [0, 0],
  });
  ctx.transform(...toCanvasArgs(m));
  const opacity = resolve(tr.opacity != null ? tr.opacity : 1, t);
  ctx.globalAlpha *= opacity;
  renderContents(ctx, item.contents || [], t);
  ctx.restore();
}

function resolveTrimOpts(item, t) {
  return {
    start: resolve(item.start != null ? item.start : 0, t),
    end: resolve(item.end != null ? item.end : 100, t),
    offset: resolve(item.offset != null ? item.offset : 0, t),
    multiple: item.multiple || 'individually',
  };
}

function resolveRepeaterOpts(item, t) {
  const tr = item.transform || {};
  return {
    copies: resolve(item.copies != null ? item.copies : 3, t),
    transform: {
      position: resolve(tr.position, t) || [0, 0],
      rotation: resolve(tr.rotation != null ? tr.rotation : 0, t),
      scale: resolve(tr.scale, t) || [1, 1],
      anchor: resolve(tr.anchor, t) || [0, 0],
    },
    startOpacity: resolve(item.startOpacity != null ? item.startOpacity : 1, t),
    endOpacity: resolve(item.endOpacity != null ? item.endOpacity : 1, t),
    order: item.order || 'below',
  };
}

/**
 * Processes one group's `contents` list top-to-bottom, exactly per
 * AE's real stacking rule: path items APPEND to the running
 * currentPaths list, Trim Paths / Repeater REPLACE it with their
 * transformed result, and Fill/Stroke consume whatever is currently in
 * it WITHOUT modifying it (so a second Fill further down the same
 * stack, or a Fill after a Repeater has already run, sees exactly what
 * a real AE shape group would show at that point in its own stack).
 */
function renderContents(ctx, contents, t) {
  let currentPaths = []; // [{anchors, closed, matrix?, opacity?}]

  for (const item of contents) {
    switch (item.type) {
      case 'path':
        currentPaths.push({ anchors: item.anchors, closed: item.closed !== false, matrix: null, opacity: 1 });
        break;
      case 'trim':
        currentPaths = trimPathsMultiple(currentPaths, resolveTrimOpts(item, t))
          .map((r) => ({ anchors: r.anchors, closed: false, matrix: null, opacity: 1 }));
        break;
      case 'repeater':
        currentPaths = applyRepeater(currentPaths, resolveRepeaterOpts(item, t));
        break;
      case 'fill':
        drawFill(ctx, currentPaths, item, t);
        break;
      case 'stroke':
        drawStroke(ctx, currentPaths, item, t);
        break;
      case 'group':
        drawNestedGroup(ctx, item, t);
        break;
      default:
        throw new Error(`Unknown shape content type: ${item.type}`);
    }
  }
}

module.exports = { ShapeLayer, renderContents };
