const { easeOutBack, easeOutCubic, easeOutExpo, lerp, clamp01 } = require('./easing');
const { drawIconPath } = require('./templateRenderers');
const { validateShapeRecipe, drawShapeRecipe } = require('./shapeRecipe');

/**
 * Direct response to real reference footage: every beat with text
 * also had a large, bold visual (an icon, a mark, a sweeping shape)
 * that was the FIRST thing the eye landed on, text second. Our
 * existing icon system already proves clean vector shapes read fine
 * at icon scale (~70px) - this reuses the exact same path data at
 * 3-4x that size, positioned as a real co-primary element instead of
 * a small background decoration.
 *
 * Two families: reused icons (drawIconPath, scaled way up) for
 * concrete-object prompts, and new abstract marks (ribbon/halo/burst)
 * for everything else - covering the "bold geometric shape" pattern
 * seen across multiple references that weren't depicting a literal
 * object at all.
 */

const ICON_HERO_NAMES = ['alert', 'check', 'spark', 'clock', 'money', 'chart', 'lock', 'heart',
  'watch', 'phone', 'house', 'car', 'gift', 'trophy', 'rocket', 'camera', 'briefcase', 'coffee'];
const ABSTRACT_HERO_NAMES = ['ribbon', 'halo', 'mark', 'burst'];
const ALL_HERO_SHAPES = [...ICON_HERO_NAMES, ...ABSTRACT_HERO_NAMES];

function drawRibbon(ctx, size) {
  // A sweeping curved band, like a road/ribbon crossing the frame -
  // built from two parallel bezier curves closing into a filled band.
  const s = size;
  ctx.beginPath();
  ctx.moveTo(-s * 0.9, s * 0.15);
  ctx.bezierCurveTo(-s * 0.3, -s * 0.35, s * 0.3, s * 0.35, s * 0.9, -s * 0.15);
  ctx.lineTo(s * 0.9, s * 0.05);
  ctx.bezierCurveTo(s * 0.3, s * 0.55, -s * 0.3, -s * 0.15, -s * 0.9, s * 0.35);
  ctx.closePath();
}

function drawHalo(ctx, size, t) {
  // Concentric rings, like a light burst / radar pulse - 3 rings at
  // different radii and opacities.
  const s = size;
  for (let i = 0; i < 3; i++) {
    const r = s * (0.35 + i * 0.22);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.lineWidth = lerp(6, 2, i / 2);
    ctx.globalAlpha *= (1 - i * 0.1);
    ctx.stroke();
  }
}

function drawMark(ctx, size) {
  // Interlocking geometric mark - two overlapping rounded triangles,
  // reads as an abstract "logo" the way several references used a
  // bold geometric symbol rather than a literal object.
  const s = size;
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.5);
  ctx.lineTo(s * 0.45, s * 0.3);
  ctx.lineTo(-s * 0.45, s * 0.3);
  ctx.closePath();
  ctx.moveTo(0, -s * 0.15);
  ctx.lineTo(s * 0.3, s * 0.35);
  ctx.lineTo(-s * 0.3, s * 0.35);
  ctx.closePath();
}

function drawBurst(ctx, size) {
  const s = size;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i;
    const tipX = Math.cos(angle) * s * 0.5, tipY = Math.sin(angle) * s * 0.5;
    const midAngle = angle + Math.PI / 8;
    const midX = Math.cos(midAngle) * s * 0.16, midY = Math.sin(midAngle) * s * 0.16;
    if (i === 0) ctx.moveTo(tipX, tipY); else ctx.lineTo(tipX, tipY);
    ctx.lineTo(midX, midY);
  }
  ctx.closePath();
}

/**
 * Draws the hero visual for a beat - big (roughly 3.5x icon scale),
 * positioned above where the beat's own text/content naturally sits,
 * with its own overshoot entrance so it lands with real weight before
 * text follows. Every beat gets one of these, per the direct
 * reference-video feedback that our output was "just text."
 */
function drawHeroVisual(ctx, shapeName, accentColor, t, duration, width, height, system, carOptions = {}, customShapeRecipe = null) {
  // Custom recipe takes priority when present and valid - this is
  // what actually scales past the fixed icon list to any object at
  // all, safely, since the recipe is pre-validated data, never code.
  const validatedRecipe = customShapeRecipe ? validateShapeRecipe(customShapeRecipe) : [];
  const useCustom = validatedRecipe.length > 0;
  const name = useCustom ? 'custom' : (ALL_HERO_SHAPES.includes(shapeName) ? shapeName : 'mark');
  const entranceT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(clamp01(t / (duration * 0.25)));
  const scale = lerp(0.4, 1, easeOutBack(entranceT));
  const size = 130;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.22);
  ctx.scale(scale, scale);

  if (system.heroUsesGlow) {
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = lerp(0, 40, clamp01((t - duration * 0.1) / (duration * 0.3)));
  }
  ctx.strokeStyle = accentColor;
  ctx.fillStyle = accentColor;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (useCustom) {
    drawShapeRecipe(ctx, validatedRecipe, size, accentColor);
  } else if (ICON_HERO_NAMES.includes(name)) {
    const shape = drawIconPath(ctx, name, size, carOptions);
    if (shape && shape.strokeOnly) ctx.stroke();
    else { ctx.stroke(); ctx.fill(); }
    if (shape && shape.hasCarWheels) {
      [-size * 0.22, size * 0.22].forEach((wx) => {
        ctx.fillStyle = system.bgColorInner;
        ctx.beginPath();
        ctx.arc(wx, size * 0.22, size * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    // Same real badge treatment as the small icon version - the large
    // hero visual shouldn't be a lesser, detail-stripped copy of the
    // same template.
    if (shape && shape.hasCarBadge) {
      const badgeY = -size * 0.01, badgeR = size * 0.12;
      ctx.fillStyle = system.bgColorInner;
      if (shape.carBadgeShape === 'shield') {
        ctx.beginPath();
        ctx.moveTo(0, badgeY - badgeR);
        ctx.lineTo(badgeR * 0.85, badgeY - badgeR * 0.3);
        ctx.lineTo(badgeR * 0.6, badgeY + badgeR);
        ctx.lineTo(-badgeR * 0.6, badgeY + badgeR);
        ctx.lineTo(-badgeR * 0.85, badgeY - badgeR * 0.3);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, badgeY, badgeR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = accentColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(badgeR * 1.1)}px ${system.fontFamily}`;
      ctx.fillText(String(shape.carBadgeText).slice(0, 2).toUpperCase(), 0, badgeY + 1);
    }
  } else if (name === 'ribbon') {
    drawRibbon(ctx, size);
    ctx.fill();
  } else if (name === 'halo') {
    drawHalo(ctx, size, t);
  } else if (name === 'burst') {
    drawBurst(ctx, size);
    ctx.fill();
  } else {
    drawMark(ctx, size);
    ctx.fill();
  }
  ctx.restore();
}

module.exports = { drawHeroVisual, ALL_HERO_SHAPES };
