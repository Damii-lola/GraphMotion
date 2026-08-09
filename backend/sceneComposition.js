const { easeOutCubic, easeOutBack, easeInOutCubic, lerp, clamp01 } = require('./easing');

/**
 * THE ACTUAL FIX for "only one thing happens on screen": every scene
 * used to be (atmosphere) + (one hero element), full stop. Adding
 * glow/grain/shadow to that is polish on emptiness - it was never
 * going to look "busy" or "god-tier" because there was structurally
 * only ever one object in the frame.
 *
 * This module draws THREE additional, ALWAYS-PRESENT layers around
 * whatever the hero content is, each with its own independent timing
 * so nothing moves in lockstep:
 *   1. A background motif (moving grid lines) - gives the eye
 *      something to travel across even during "empty" beats.
 *   2. A corner tag/badge - a small independently-animated label,
 *      the "screen-within-screen" density trick from the notes.
 *   3. A secondary accent shape - positioned OFF from the hero
 *      (rule-of-thirds, not dead center), at a different depth
 *      (dimmer/blurred) so there's real foreground/background
 *      separation, not everything on one flat plane.
 * The hero content (text/icon/number) still renders on top via each
 * template's own function - this just guarantees it's never alone.
 */

function drawMotifGrid(ctx, globalT, width, height, accentColor) {
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.globalAlpha = 0.06;
  ctx.lineWidth = 1;

  const spacing = 64;
  const drift = (globalT * 6) % spacing;

  for (let x = -spacing + drift; x < width + spacing; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = -spacing + (drift * 0.4); y < height + spacing; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Small pill-shaped tag in a top corner - its own entrance timing
 * (staggered against the hero content, never simultaneous), its own
 * subtle idle motion (drifts very slightly) so it reads as alive.
 */
function drawCornerTag(ctx, label, sceneLocalT, sceneDuration, width, height, accentColor) {
  const entranceT = clamp01((sceneLocalT - 0.1) / 0.4);
  if (entranceT <= 0) return;

  const opacity = easeOutCubic(entranceT);
  const slideX = lerp(-20, 0, easeOutBack(entranceT));
  const idleFloat = Math.sin(sceneLocalT * 1.3) * 2;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(60 + slideX, 90 + idleFloat);

  ctx.font = '600 18px sans-serif';
  const textWidth = ctx.measureText(label).width;
  const padX = 14, padY = 8;
  const boxW = textWidth + padX * 2;
  const boxH = 30;

  ctx.strokeStyle = accentColor;
  ctx.globalAlpha = opacity * 0.7;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0, -boxH / 2, boxW, boxH, boxH / 2);
  ctx.stroke();

  ctx.globalAlpha = opacity;
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(padX - 6, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#F5F5F5';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, padX + 4, 1);
  ctx.restore();
}

/**
 * A dim, blurred-feeling secondary shape sitting off-center (rule of
 * thirds, not dead center) at a different visual "depth" than the
 * hero content - it's what actually creates foreground/background
 * separation instead of one flat plane.
 */
function drawSecondaryAccent(ctx, sceneLocalT, sceneDuration, width, height, accentColor) {
  const entranceT = clamp01((sceneLocalT - 0.15) / 0.5);
  if (entranceT <= 0) return;

  const opacity = easeOutCubic(entranceT) * 0.35;
  const x = width * 0.82;
  const y = height * 0.78;
  const rotation = sceneLocalT * 0.15;
  const scale = lerp(0.7, 1, easeOutCubic(entranceT));

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-30, -30);
  ctx.lineTo(30, -30);
  ctx.lineTo(30, 30);
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Call this AFTER atmosphere and BEFORE the hero content in every
 * template - draws the motif + tag + secondary accent as one
 * guaranteed layer, so it's structurally impossible for a scene to
 * render as "one lonely element again."
 */
function drawComposition(ctx, tagLabel, sceneLocalT, sceneDuration, globalT, width, height, accentColor) {
  drawMotifGrid(ctx, globalT, width, height, accentColor);
  drawSecondaryAccent(ctx, sceneLocalT, sceneDuration, width, height, accentColor);
  if (tagLabel) {
    drawCornerTag(ctx, tagLabel, sceneLocalT, sceneDuration, width, height, accentColor);
  }
}

module.exports = { drawComposition };
