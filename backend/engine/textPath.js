const { clamp01, lerp } = require('./mathUtils');
const { buildPathSampler, pointAtDistance, bezierTangent } = require('./path');

/**
 * Text on a Path: characters laid out along an arbitrary curve instead
 * of a straight baseline, each rotated to follow the curve's own
 * tangent direction. AE's own control set (First/Last Margin, Reverse
 * Path, Perpendicular To Path, Force Alignment) is implemented exactly
 * as AE defines it, not just a loose approximation of the idea.
 *
 * The arc-length sampling machinery this file originated in batch 5
 * now lives in path.js (batch 6 promoted it out, the same way
 * selectors.js was promoted out of textAnimator.js) so Trim Paths and
 * shape rendering can share the identical, already-verified sampler
 * and exact De Casteljau sub-curve extraction rather than a second
 * copy of the same bezier math.
 *
 * Anchors: [{ point: [x,y], outTangent?: [dx,dy], inTangent?: [dx,dy] }, ...]
 * Omitting tangents on every anchor degrades the path to a straight-
 * line polyline through the anchors (the tangent-less case in
 * spatialBezierPoint already collapses to exactly this).
 */

/**
 * Lays out characters along the path by ARC LENGTH (not by index or
 * fixed spacing), so every character sits its own true rendered
 * pixel-width apart along the curve - matching AE's Text-on-a-Path
 * "natural spacing" behavior. Returns the same {ch,x,y,index,wordIndex}
 * contract as textAnimator.js's layoutText (plus a new `angle` field)
 * so animators plug in identically regardless of layout source.
 *
 * - firstMargin/lastMargin: AE's own controls, offsetting the usable
 *   span inward from the path's true start/end (same length units as
 *   the path's own coordinate space).
 * - reversePath: walk the path from its end toward its start.
 * - perpendicularToPath: whether each character rotates to match the
 *   path's tangent (true, the common case) or stays upright (false,
 *   AE's own toggle - useful for e.g. text sitting ON TOP of a curve
 *   rather than flowing along it).
 * - forceAlignment: stretch/compress inter-character spacing so the
 *   text exactly fills firstMargin..lastMargin (AE's own toggle),
 *   computed as a genuine two-pass operation - natural widths are
 *   measured first, THEN uniformly rescaled - rather than guessed.
 */
function layoutTextOnPath(ctx, text, anchors, opts = {}) {
  const {
    fontFamily, fontWeight, fontSize,
    firstMargin = 0, lastMargin = 0,
    reversePath = false, perpendicularToPath = true, forceAlignment = false,
    samplesPerSegment = 60,
  } = opts;
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const sampler = buildPathSampler(anchors, { samplesPerSegment, closed: false });
  const usableLength = Math.max(sampler.totalLength - firstMargin - lastMargin, 0);

  const entries = [];
  let naturalWidth = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch === ' ' ? ' ' : ch).width;
    entries.push({ ch, width: w });
    naturalWidth += w;
  }
  const scale = forceAlignment && naturalWidth > 0 ? usableLength / naturalWidth : 1;

  const chars = [];
  let wordIndex = 0;
  let cursor = 0;
  let sawCharInWord = false;
  for (const entry of entries) {
    if (entry.ch === ' ') {
      cursor += entry.width;
      if (sawCharInWord) { wordIndex++; sawCharInWord = false; }
      continue;
    }
    sawCharInWord = true;
    const centerNatural = cursor + entry.width / 2;
    cursor += entry.width;

    const distAlongUsable = centerNatural * scale;
    const rawDistance = reversePath
      ? sampler.totalLength - lastMargin - distAlongUsable
      : firstMargin + distAlongUsable;

    const { x, y, angle } = pointAtDistance(sampler, rawDistance);
    chars.push({
      ch: entry.ch, x, y,
      angle: perpendicularToPath ? (reversePath ? angle + Math.PI : angle) : 0,
      index: chars.length,
      wordIndex,
    });
  }
  const totalWords = wordIndex + (sawCharInWord ? 1 : 0);

  return { chars, totalWords, sampler, usableLength };
}

/**
 * Same animator-driven rendering as textAnimator.js's renderAnimatedText,
 * but the character's BASE position/rotation comes from the path
 * (layoutTextOnPath) instead of a straight word-wrapped baseline.
 * Animator position deltas are applied in the character's own rotated
 * local space (translate-then-rotate order below) so a "kick along the
 * path" reads correctly for curved text, matching how AE's own
 * per-character transforms are relative to that character's baseline.
 */
function renderAnimatedTextOnPath(ctx, text, anchors, t, opts) {
  const {
    fontFamily, fontWeight, fontSize,
    fillStyle = '#FFFFFF', animators = [],
    firstMargin, lastMargin, reversePath, perpendicularToPath, forceAlignment, samplesPerSegment,
  } = opts;

  const { chars, totalWords } = layoutTextOnPath(ctx, text, anchors, {
    fontFamily, fontWeight, fontSize, firstMargin, lastMargin, reversePath, perpendicularToPath, forceAlignment, samplesPerSegment,
  });
  const totalChars = chars.length;

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    let dx = 0, dy = 0, scaleMul = 1, dRotation = 0, opacityDelta = 0;
    const unit = { charIndex: c.index, totalChars, wordIndex: c.wordIndex, totalWords, t };

    for (const anim of animators) {
      const strength = anim.selector(unit);
      if (strength === 0) continue;
      const p = anim.properties || {};
      if (p.position) { dx += p.position[0] * strength; dy += p.position[1] * strength; }
      if (p.scale !== undefined) scaleMul *= lerp(1, p.scale, strength);
      if (p.rotation) dRotation += p.rotation * strength;
      if (p.opacity !== undefined) opacityDelta += p.opacity * strength;
    }

    const finalOpacity = clamp01(1 + opacityDelta);
    if (finalOpacity <= 0.001) continue;

    ctx.save();
    ctx.globalAlpha = finalOpacity;
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.translate(dx, dy);
    // Same degrees->radians fix as textAnimator.js's identical
    // dRotation accumulator - see matrix2d.js's fromTRS doc comment.
    ctx.rotate((dRotation * Math.PI) / 180);
    ctx.scale(scaleMul, scaleMul);
    ctx.fillStyle = fillStyle;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

module.exports = {
  buildPathSampler, pointAtDistance, layoutTextOnPath, renderAnimatedTextOnPath, bezierTangent,
};
