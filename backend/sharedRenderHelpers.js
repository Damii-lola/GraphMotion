const { easeOutCubic, lerp, clamp01 } = require('./easing');

/**
 * Extracted to its own file specifically to avoid a circular require:
 * templateRenderers.js already requires templateRenderersExtended.js
 * (for splitCompare, listReveal, etc.), so if templateRenderersExtended.js
 * also required templateRenderers.js back (to get this helper), Node
 * would return an incomplete, still-loading module - confirmed
 * directly: a real "accessing non-existent property inside circular
 * dependency" warning fired, and the destructured value would have
 * been permanently undefined. This file has no dependency on either
 * template file, so both can safely import from it.
 */
function drawFramingCard(ctx, centerX, centerY, contentWidth, contentHeight, t, duration, accentColor) {
  const cardT = easeOutCubic(clamp01(t / (duration * 0.3)));
  const cardWidth = lerp(0, contentWidth, cardT);
  const outerAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = outerAlpha * cardT * 0.14;
  ctx.fillStyle = accentColor;
  const r = 14;
  const cw = cardWidth, ch = contentHeight;
  ctx.beginPath();
  ctx.moveTo(centerX - cw / 2 + r, centerY - ch / 2);
  ctx.arcTo(centerX + cw / 2, centerY - ch / 2, centerX + cw / 2, centerY - ch / 2 + r, r);
  ctx.arcTo(centerX + cw / 2, centerY + ch / 2, centerX + cw / 2 - r, centerY + ch / 2, r);
  ctx.arcTo(centerX - cw / 2, centerY + ch / 2, centerX - cw / 2, centerY + ch / 2 - r, r);
  ctx.arcTo(centerX - cw / 2, centerY - ch / 2, centerX - cw / 2 + r, centerY - ch / 2, r);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = accentColor;
  ctx.globalAlpha = outerAlpha * cardT * 0.5;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

module.exports = { drawFramingCard };
