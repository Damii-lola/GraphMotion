const { createCanvas } = require('@napi-rs/canvas');
const { renderPathToContext } = require('./path');
const { toCanvasArgs } = require('./matrix2d');
const { MASK_MODE_HANDLERS } = require('./maskAlpha');

/**
 * AE's Merge Paths (Path Operations): combines every path above it in
 * a shape group into ONE shape via a boolean operation - Add (union),
 * Subtract, Intersect, Exclude Intersections (XOR). ("Merge" is AE's
 * fifth mode name, visually identical to Add for a filled result - the
 * distinction AE draws between them is about stroke continuity along
 * the merged outline, which doesn't apply once this has rasterized;
 * documented as an alias for 'add' here rather than silently ignored.)
 *
 * This is architecturally the EXACT SAME operation as batch 4's Mask
 * combination modes (maskAlpha.js) - both are "combine two alpha
 * silhouettes via a named boolean rule" - so this reuses
 * MASK_MODE_HANDLERS directly rather than re-deriving Porter-Duff
 * compositing a third time (layerStack.js's blend modes were the
 * first). Add/Subtract/Intersect map to exact native composite
 * operations; Exclude reuses the same 'difference' (XOR) handler mask
 * modes call Difference.
 *
 * Unlike Trim Paths/Repeater (which output real vector anchors that
 * can still be trimmed/repeated/filled/stroked with full precision),
 * combining paths via true bezier-vs-bezier boolean geometry is a
 * substantially harder problem (real vector boolean-clip libraries are
 * a project unto themselves). This engine takes the same honest,
 * scoped approach as mask expansion's blur-rethreshold technique:
 * RASTERIZE each path to its own alpha buffer, combine those via the
 * verified-correct compositing above, and hand back a raster result.
 * This is a REAL, documented scope boundary, not a hidden shortcut - a
 * Path Operation's output can still be filled or stroked (stroke via
 * the same dilate/erode technique layerStyles.js already uses), but it
 * can no longer be fed into a downstream Trim Paths or Repeater, which
 * need true vector anchor data. shapeLayer.js enforces this with a
 * clear error rather than silently producing wrong output.
 */

const PATH_OP_ALIASES = { merge: 'add' };

/**
 * Rasterizes a LIST of {anchors, closed, matrix?} vector paths (the
 * same shape shapeLayer.js's currentPaths carries) into one combined
 * alpha canvas, applying each path's own matrix (from a preceding
 * Repeater, if any) via ctx.transform before tracing it - exactly how
 * shapeLayer.js's drawFill/drawStroke already apply per-copy matrices.
 */
function rasterizePathList(pathList, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  for (const p of pathList) {
    ctx.save();
    if (p.matrix) ctx.transform(...toCanvasArgs(p.matrix));
    ctx.beginPath();
    renderPathToContext(ctx, p.anchors, p.closed);
    ctx.fill();
    ctx.restore();
  }
  return canvas;
}

/**
 * Combines `pathList` via `mode`, folding paths together in list order
 * (matching AE's own top-to-bottom Merge Paths evaluation - each
 * additional shape combines with everything already merged above it).
 * Returns { isRaster: true, canvas } - shapeLayer.js's new raster
 * currentPaths state.
 */
function applyPathOperation(pathList, { mode = 'add', width, height } = {}) {
  const resolvedMode = PATH_OP_ALIASES[mode] || mode;
  const handler = MASK_MODE_HANDLERS[resolvedMode === 'exclude' ? 'difference' : resolvedMode] || MASK_MODE_HANDLERS.add;

  if (pathList.length === 0) return { isRaster: true, canvas: createCanvas(width, height) };

  let acc = null;
  for (const p of pathList) {
    const layer = rasterizePathList([p], width, height);
    if (acc === null) { acc = layer; continue; }
    handler(acc, layer, width, height);
  }
  return { isRaster: true, canvas: acc };
}

module.exports = { applyPathOperation, rasterizePathList };
