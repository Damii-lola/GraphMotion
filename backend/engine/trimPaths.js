const {
  buildPathSampler, pointAtDistance, segmentControlPoints, subCurve,
} = require('./path');

/**
 * AE's Trim Paths: reveals only the portion of a path's arc length
 * between Start% and End%, slid around the path by Offset% - which can
 * push the window past 100%/before 0%, WRAPPING it around a closed
 * path. That wrap is the actual mechanism behind a classic circular
 * "spinner"/progress-ring animation (Offset animating while Start/End
 * stay fixed at, say, 0/25), and is genuinely supported here - not
 * just the simple non-wrapping case - by splitting into two separate
 * runs when the shifted window crosses the seam.
 *
 * Reuses path.js's arc-length sampler (the exact same one Text on a
 * Path walks) and its exact De Casteljau sub-curve extraction for the
 * partial segments at each end of the trimmed window, rather than
 * approximating the cut with a polyline.
 */

function mod1(x) {
  const r = x % 1;
  return r < 0 ? r + 1 : r;
}

/**
 * Extracts one open anchors run covering arc-length fraction range
 * [fracStart, fracEnd] (0-1, already offset-applied, NOT wrapped) of a
 * single already-built sampler. Walks every original segment the
 * window touches, taking the FULL segment for ones entirely inside the
 * window and an exact subCurve() for the (at most two) partial
 * segments at each end.
 */
function extractRun(sampler, fracStart, fracEnd) {
  const total = sampler.totalLength;
  if (total <= 0 || fracEnd <= fracStart) return null;
  const distStart = fracStart * total;
  const distEnd = fracEnd * total;

  const startPoint = pointAtDistance(sampler, distStart);
  const endPoint = pointAtDistance(sampler, distEnd);
  const startSeg = startPoint.segIndex;
  const endSeg = endPoint.segIndex;

  const { anchors, closed } = sampler;
  const n = anchors.length;
  const runAnchors = [];

  for (let seg = startSeg; seg <= endSeg; seg++) {
    const a = anchors[seg % n];
    const b = anchors[(seg + 1) % n];
    const [p0, p1, p2, p3] = segmentControlPoints(a, b);
    const localU0 = seg === startSeg ? startPoint.u : 0;
    const localU1 = seg === endSeg ? endPoint.u : 1;
    const [q0, q1, q2, q3] = subCurve(p0, p1, p2, p3, localU0, localU1);

    if (runAnchors.length === 0) {
      runAnchors.push({ point: q0, outTangent: [q1[0] - q0[0], q1[1] - q0[1]] });
    } else {
      // This segment's start point is the SAME physical point as the
      // previous segment's end (they share the original anchor) - set
      // its outTangent on the anchor already pushed rather than
      // duplicating the point, so the run stays one continuous chain.
      runAnchors[runAnchors.length - 1].outTangent = [q1[0] - q0[0], q1[1] - q0[1]];
    }
    runAnchors.push({ point: q3, inTangent: [q2[0] - q3[0], q2[1] - q3[1]] });
  }

  return { anchors: runAnchors, closed: false };
}

/**
 * Trims a single path. `closed` paths whose shifted [start,end] window
 * crosses the 100%/0% seam produce TWO runs (the wrapped-around
 * portion is real content, not something to silently drop).
 */
function trimPath(anchors, closed, {
  start = 0, end = 100, offset = 0, samplesPerSegment = 80,
} = {}) {
  if (end <= start) return [];
  const sampler = buildPathSampler(anchors, { samplesPerSegment, closed });
  const width = (end - start) / 100;
  const winStart = mod1(start / 100 + offset / 100);
  const winEnd = winStart + width;

  if (!closed || winEnd <= 1) {
    return [extractRun(sampler, winStart, Math.min(winEnd, 1))].filter(Boolean);
  }
  const runA = extractRun(sampler, winStart, 1);
  const runB = extractRun(sampler, 0, winEnd - 1);
  return [runA, runB].filter(Boolean);
}

/**
 * Trims a LIST of paths (a shape group may stack several above one
 * Trim Paths operator) per AE's real "individually" vs "simultaneously"
 * toggle:
 * - individually (AE's default): the SAME start/end/offset window is
 *   applied to EACH path independently, so multiple shapes reveal in
 *   visual sync with each other.
 * - simultaneously: all paths are treated as ONE combined arc length
 *   (concatenated in list order) and the window sweeps across them
 *   together - earlier paths finish revealing before later ones begin,
 *   as if drawn by a single continuous pen stroke across all of them.
 */
function trimPathsMultiple(pathList, {
  start = 0, end = 100, offset = 0, multiple = 'individually', samplesPerSegment = 80,
} = {}) {
  if (multiple === 'individually' || pathList.length <= 1) {
    return pathList.flatMap((p) => trimPath(p.anchors, p.closed, {
      start, end, offset, samplesPerSegment,
    }));
  }

  const samplers = pathList.map((p) => buildPathSampler(p.anchors, { samplesPerSegment, closed: p.closed }));
  const lengths = samplers.map((s) => s.totalLength);
  const totalCombined = lengths.reduce((a, b) => a + b, 0);
  if (totalCombined <= 0) return [];

  const width = (end - start) / 100;
  const winStart = mod1(start / 100 + offset / 100);
  const winEnd = winStart + width;
  const windows = winEnd <= 1 ? [[winStart, winEnd]] : [[winStart, 1], [0, winEnd - 1]];

  const runs = [];
  let cursor = 0; // combined-fraction offset of the START of the current path
  for (let i = 0; i < pathList.length; i++) {
    const pathFracLen = lengths[i] / totalCombined;
    const pathStart = cursor;
    const pathEnd = cursor + pathFracLen;
    cursor = pathEnd;
    if (pathFracLen <= 0) continue;

    for (const [ws, we] of windows) {
      const overlapStart = Math.max(ws, pathStart);
      const overlapEnd = Math.min(we, pathEnd);
      if (overlapEnd <= overlapStart) continue;
      // Re-map the overlap from COMBINED-fraction space into THIS
      // path's own local 0-1 fraction space before extracting.
      const localStart = (overlapStart - pathStart) / pathFracLen;
      const localEnd = (overlapEnd - pathStart) / pathFracLen;
      const run = extractRun(samplers[i], localStart, localEnd);
      if (run) runs.push(run);
    }
  }
  return runs;
}

module.exports = { trimPath, trimPathsMultiple, extractRun };
