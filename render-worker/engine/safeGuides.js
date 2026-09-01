/**
 * Title-safe / Action-safe guides: the real broadcast-television
 * framing convention (still directly relevant for short-form video -
 * different platforms crop/letterbox/overlay UI differently, so
 * keeping important content away from the true edges is exactly the
 * same underlying problem broadcast TV safe areas were invented for).
 * The real, standard percentages: Title Safe = the inner 80% of the
 * frame (10% margin on every side - anything meant to be READ, like
 * on-screen text, should stay inside this), Action Safe = the inner
 * 90% (5% margin - anything that needs to be SEEN but not necessarily
 * centered, like a full-bleed background element's important detail,
 * should stay inside this, looser than title safe).
 */

function computeSafeAreas(width, height) {
  const titleMarginX = width * 0.1, titleMarginY = height * 0.1;
  const actionMarginX = width * 0.05, actionMarginY = height * 0.05;
  return {
    titleSafe: {
      x: titleMarginX, y: titleMarginY, width: width - 2 * titleMarginX, height: height - 2 * titleMarginY,
    },
    actionSafe: {
      x: actionMarginX, y: actionMarginY, width: width - 2 * actionMarginX, height: height - 2 * actionMarginY,
    },
  };
}

/** Draws the real reference overlay (dashed rectangles for each safe area, plus a center crosshair - the standard broadcast-monitor guide look) - a PREVIEW/reference aid, never meant to be baked into a final render. */
function drawSafeGuides(ctx, width, height, opts = {}) {
  const {
    titleColor = '#ffff00', actionColor = '#00ffff', crosshairColor = '#ffffff', lineWidth = 1, dash = [6, 4],
  } = opts;
  const { titleSafe, actionSafe } = computeSafeAreas(width, height);

  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineWidth = lineWidth;

  ctx.strokeStyle = actionColor;
  ctx.strokeRect(actionSafe.x, actionSafe.y, actionSafe.width, actionSafe.height);

  ctx.strokeStyle = titleColor;
  ctx.strokeRect(titleSafe.x, titleSafe.y, titleSafe.width, titleSafe.height);

  ctx.setLineDash([]);
  ctx.strokeStyle = crosshairColor;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 15, height / 2); ctx.lineTo(width / 2 + 15, height / 2);
  ctx.moveTo(width / 2, height / 2 - 15); ctx.lineTo(width / 2, height / 2 + 15);
  ctx.stroke();
  ctx.restore();
}

/** Exact containment test - `box` (a plain {x,y,width,height} rect) is considered within `safeArea` only if EVERY edge stays inside it (partial overlap doesn't count as safe - the whole point is nothing important gets clipped). */
function isBoxWithinSafeArea(box, safeArea) {
  return (
    box.x >= safeArea.x
    && box.y >= safeArea.y
    && box.x + box.width <= safeArea.x + safeArea.width
    && box.y + box.height <= safeArea.y + safeArea.height
  );
}

/**
 * Validates a list of layout elements (each `{box: {x,y,width,height}, ...}`
 * or a bare box) against both safe areas for a given comp size -
 * genuinely useful for an AI-driven pipeline: Mistral-generated scene
 * JSON can be checked automatically before rendering, flagging text or
 * key visual elements whose computed position/size would place them
 * outside the safe margins on the actual target frame, rather than
 * only discovering a cropped headline by eye after a render completes.
 */
function validateLayout(elements, width, height, { requireTitleSafe = true } = {}) {
  const { titleSafe, actionSafe } = computeSafeAreas(width, height);
  const results = elements.map((el) => {
    const box = el.box || el;
    const withinActionSafe = isBoxWithinSafeArea(box, actionSafe);
    const withinTitleSafe = isBoxWithinSafeArea(box, titleSafe);
    const violations = [];
    if (!withinActionSafe) violations.push('outside action-safe area');
    if (requireTitleSafe && !withinTitleSafe) violations.push('outside title-safe area');
    return {
      element: el, withinActionSafe, withinTitleSafe, violations, ok: violations.length === 0,
    };
  });
  return { results, allOk: results.every((r) => r.ok) };
}

module.exports = {
  computeSafeAreas, drawSafeGuides, isBoxWithinSafeArea, validateLayout,
};
