const { easeOutCubic, easeOutBack, lerp, clamp01 } = require('./easing');

/**
 * Composites a real (Pollinations-generated) photo into a beat as a
 * large rounded "photo card" - sized and positioned to sit ABOVE
 * LAYOUT.contentCenterY (sharedRenderHelpers.js) where a template's own
 * text already renders, so there's no overlap to manage by construction,
 * and no scrim/legibility hack needed. Deliberately NOT full-bleed:
 * a raw full-frame photo would clash with the atmosphere/grid/scanline
 * chrome the rest of this system draws in the margins, and would read
 * as a jarring format-switch beat-to-beat in a video that mixes photo
 * and procedural beats. A framed card keeps one consistent visual
 * language across both beat types.
 */

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * CSS background-size:cover equivalent - crops the source image (never
 * stretches it) so it fills the target box exactly, centered.
 */
function coverFitSourceRect(imgW, imgH, boxW, boxH) {
  const imgRatio = imgW / imgH;
  const boxRatio = boxW / boxH;
  if (imgRatio > boxRatio) {
    const sw = imgH * boxRatio;
    return { sx: (imgW - sw) / 2, sy: 0, sw, sh: imgH };
  }
  const sh = imgW / boxRatio;
  return { sx: 0, sy: (imgH - sh) / 2, sw: imgW, sh };
}

function drawHeroImage(ctx, image, width, height, accentColor, t, duration, system, seed = 0) {
  const boxW = width * 0.84;
  const boxH = height * 0.44;
  const boxX = width / 2 - boxW / 2;
  const boxY = height * 0.07;
  const radius = 22;

  const entranceT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(clamp01(t / (duration * 0.25)));
  const scale = lerp(0.92, 1, easeOutBack(entranceT));

  // Ken Burns: a slow, continuous zoom+pan across the SOURCE crop for
  // the entire beat duration (not just the entrance) - a photo that's
  // done entering but still sitting there for another 2-3s otherwise
  // reads as a frozen slide, which was the actual "nothing is
  // happening" complaint. `seed` (the beat index, passed by the
  // caller) spreads pan direction across the golden angle so multiple
  // photo beats in one video don't all drift the same way.
  const kbT = clamp01(t / duration);
  const zoomAmount = lerp(1, 1.14, kbT);
  const panAngle = (seed * 2.399963) % (Math.PI * 2);
  const panDistance = lerp(0, 0.055, kbT);
  const panX = Math.cos(panAngle) * panDistance;
  const panY = Math.sin(panAngle) * panDistance * 0.6;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(boxX + boxW / 2, boxY + boxH / 2);
  ctx.scale(scale, scale);
  ctx.translate(-(boxX + boxW / 2), -(boxY + boxH / 2));

  if (system.heroUsesGlow) {
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 28;
  }

  roundRectPath(ctx, boxX, boxY, boxW, boxH, radius);
  ctx.save();
  ctx.clip();
  ctx.shadowBlur = 0;

  const { sx, sy, sw, sh } = coverFitSourceRect(image.width, image.height, boxW, boxH);
  const zsw = sw / zoomAmount;
  const zsh = sh / zoomAmount;
  const rawZsx = sx + (sw - zsw) / 2 + panX * sw;
  const rawZsy = sy + (sh - zsh) / 2 + panY * sh;
  const zsx = Math.max(sx, Math.min(sx + sw - zsw, rawZsx));
  const zsy = Math.max(sy, Math.min(sy + sh - zsh, rawZsy));
  ctx.drawImage(image, zsx, zsy, zsw, zsh, boxX, boxY, boxW, boxH);

  // Cheap "graded to match" tint instead of true pixel-level duotone
  // (getImageData/putImageData would cost meaningfully more per beat) -
  // a translucent accent-color wash over the photo via a multiply-style
  // blend, so it reads as color-graded footage rather than a raw stock
  // photo pasted into a differently-colored video.
  ctx.globalCompositeOperation = 'hue';
  ctx.fillStyle = accentColor;
  ctx.globalAlpha = opacity * 0.55;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = opacity * 0.18;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.restore();

  ctx.globalAlpha = opacity * 0.8;
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  roundRectPath(ctx, boxX, boxY, boxW, boxH, radius);
  ctx.stroke();

  ctx.restore();
}

module.exports = { drawHeroImage };
