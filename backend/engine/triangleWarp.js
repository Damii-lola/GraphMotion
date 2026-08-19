const { createCanvas } = require('@napi-rs/canvas');

/**
 * Extracted out of the now-deleted layer3d.js when 3D rendering was
 * removed from the engine entirely (a deliberate scope cut - 3D
 * rendering was measured to be the dominant driver of both a severe
 * memory problem, ~580MB peak RSS on a single 3D beat against a 100MB
 * target, and a severe speed problem, per-frame render time roughly
 * 10x'ing during 3D beats). This file is NOT 3D code - it's a generic,
 * pure-2D "warp a source canvas onto an arbitrary destination triangle"
 * primitive with no camera/lighting/3D-matrix involvement anywhere in
 * it, genuinely shared by puppetTool.js's 2D mesh deformation (the only
 * remaining real consumer). Kept exactly as it was verified/tested
 * before the 3D removal - only its home file changed, not its logic.
 */

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

/**
 * Fetches a source canvas's full pixel data once and reuses it for
 * every triangle crop within ONE logical warp operation (one
 * warpPuppetMesh call) via `cache` - a plain object the caller owns and
 * scopes to exactly that operation. Real fix for a real cost, confirmed
 * by direct testing: @napi-rs/canvas's drawImage() pays a cost
 * proportional to the SOURCE canvas's own full size on every call
 * regardless of destination size, so re-fetching per-triangle would be
 * expensive; getImageData does NOT have that repeat-per-call cost,
 * making a single fetch-and-reuse the right fix.
 *
 * MUST be scoped per-call, not persisted across frames - a real,
 * previously-shipped correctness bug found via direct pixel testing,
 * not assumed: this used to be a MODULE-LEVEL WeakMap keyed by canvas
 * object identity, which is unsafe whenever a caller reuses and redraws
 * the SAME canvas object every frame (stale first-frame pixel data
 * would be served forever after). Scoping `cache` to one caller-owned
 * object per operation keeps the exact same performance win (still one
 * real fetch per operation, not per triangle) while making staleness
 * structurally impossible - a fresh object every call can never see a
 * stale previous frame's data.
 */
function getSourceImageData(sourceCanvas, cache = null) {
  if (cache && cache.sourceCanvasRef === sourceCanvas) return cache.sourceData;
  const data = sourceCanvas.getContext('2d').getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  if (cache) { cache.sourceCanvasRef = sourceCanvas; cache.sourceData = data; }
  return data;
}

/**
 * Warps `sourceCanvas` through the exact affine transform mapping
 * srcTri->dstTri, clipped to a very slightly dilated dstTri (see
 * expandTriangleForClip).
 *
 * `cache` (optional, default null = old per-call behavior unchanged for
 * existing callers that don't pass one): a plain object a caller
 * creates FRESH per logical warp operation (one warpPuppetMesh call)
 * and reuses across every warpTriangle call within that operation -
 * both for the source pixel data (see getSourceImageData's own doc
 * comment for why this MUST be scoped per operation, never persisted
 * across frames) and for a reusable crop canvas (`cache.cropCanvas`),
 * grown but never shrunk across calls - real, measured fix for a real
 * cost: extracting just this triangle's own small bounding box out of
 * the CACHED full-source pixel data (see getSourceImageData above) via
 * manual typed-array copying avoids any drawImage call on the large
 * source at any point, at a real, measured, ~40x lower memory cost than
 * drawImage-ing the whole source per triangle. Draws via the explicit
 * source-rect drawImage form below specifically because a reused crop
 * canvas can be LARGER than this triangle's own cropW x cropH - only
 * that top-left sub-region (the part putImageData just wrote) is ever
 * valid; the rest may hold stale pixels from an earlier, bigger
 * triangle and must never be sampled.
 */
function warpTriangle(ctx, sourceCanvas, srcTri, dstTri, clipExpand = 0.75, cache = null) {
  const minX = Math.max(0, Math.floor(Math.min(srcTri[0][0], srcTri[1][0], srcTri[2][0])) - 1);
  const minY = Math.max(0, Math.floor(Math.min(srcTri[0][1], srcTri[1][1], srcTri[2][1])) - 1);
  const maxX = Math.min(sourceCanvas.width, Math.ceil(Math.max(srcTri[0][0], srcTri[1][0], srcTri[2][0])) + 1);
  const maxY = Math.min(sourceCanvas.height, Math.ceil(Math.max(srcTri[0][1], srcTri[1][1], srcTri[2][1])) + 1);
  const cropW = maxX - minX, cropH = maxY - minY;
  if (cropW <= 0 || cropH <= 0) return;

  const localSrcTri = srcTri.map(([x, y]) => [x - minX, y - minY]);
  const m = solveAffineFromTriangle(localSrcTri, dstTri);
  if (!m) return;

  const fullData = getSourceImageData(sourceCanvas, cache);
  const srcW = sourceCanvas.width;

  let cropped;
  if (cache) {
    const curW = cache.cropCanvas ? cache.cropCanvas.width : 0;
    const curH = cache.cropCanvas ? cache.cropCanvas.height : 0;
    if (curW < cropW || curH < cropH) {
      cache.cropCanvas = createCanvas(Math.max(curW, cropW), Math.max(curH, cropH));
    }
    cropped = cache.cropCanvas;
  } else {
    cropped = createCanvas(cropW, cropH);
  }
  const cropCtx = cropped.getContext('2d');
  const cropImgData = cropCtx.createImageData(cropW, cropH);
  for (let row = 0; row < cropH; row++) {
    const srcRowStart = ((minY + row) * srcW + minX) * 4;
    cropImgData.data.set(fullData.data.subarray(srcRowStart, srcRowStart + cropW * 4), row * cropW * 4);
  }
  cropCtx.putImageData(cropImgData, 0, 0);

  const clipTri = clipExpand > 0 ? expandTriangleForClip(dstTri, clipExpand) : dstTri;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(clipTri[0][0], clipTri[0][1]);
  ctx.lineTo(clipTri[1][0], clipTri[1][1]);
  ctx.lineTo(clipTri[2][0], clipTri[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(cropped, 0, 0, cropW, cropH, 0, 0, cropW, cropH);
  ctx.restore();
}

module.exports = {
  warpTriangle, solveAffineFromTriangle, invert3x3, expandTriangleForClip, getSourceImageData,
};
