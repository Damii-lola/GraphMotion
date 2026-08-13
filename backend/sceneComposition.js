const { easeOutCubic, easeOutBack, easeInOutCubic, lerp, clamp01 } = require('./easing');

/**
 * v4 - v3 added a motif grid + one corner tag + one tiny accent shape,
 * which was still visually mostly empty frame with three small
 * decorations. That's not "multiple things happening" - it's still
 * one lonely composition with a few extra dots. This version fills
 * the frame with genuinely many simultaneous, independently-timed
 * elements: a stronger dual-layer grid, a continuous scan-line sweep,
 * THREE secondary accent shapes at different positions/depths/scales
 * (not one), floating mini "data chip" UI cards for screen-within-
 * screen density, and a second corner indicator - all always present,
 * all moving independently, all beneath the hero content in z-order
 * so the message still reads clearly on top of a genuinely busy frame.
 */

function drawMotifGrid(ctx, globalT, width, height, accentColor) {
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1;

  ctx.globalAlpha = 0.1;
  const spacing = 64;
  const drift = (globalT * 6) % spacing;
  for (let x = -spacing + drift; x < width + spacing; x += spacing) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = -spacing + (drift * 0.4); y < height + spacing; y += spacing) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  ctx.restore();
}

/**
 * Two scan-lines now, moving opposite directions at different speeds -
 * more constant motion across the frame, reads as more "alive."
 */
function drawScanline(ctx, globalT, width, height, accentColor) {
  const drawSweep = (period, offset, color, thickness) => {
    const cycleT = ((globalT + offset) % period) / period;
    const y = cycleT * height;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const grad = ctx.createLinearGradient(0, y - thickness, 0, y + thickness);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - thickness, width, thickness * 2);
    ctx.restore();
  };
  drawSweep(6, 0, accentColor + '40', 40);
  drawSweep(9, 4.5, '#FFFFFF22', 25);
}

/**
 * A running timestamp readout, bottom-left - "REC" style UI chrome,
 * ties the whole thing to global elapsed time so it reads as a live
 * feed rather than a static graphic.
 */
// Platform safe zone: TikTok/Reels/Shorts overlay their own caption
// text and interaction UI (like/comment/share, username) over the
// bottom ~15-20% and a strip down the right edge of every vertical
// video. Anything meant to actually be READ (not just decorative
// background texture) needs to stay clear of this, or it gets covered
// on the real platform - a real, previously-flagged, never-fixed gap.
const SAFE_ZONE_BOTTOM = 0.82; // nothing readable below this fraction of height

function drawTimestamp(ctx, globalT, width, height, accentColor, system) {
  const mins = Math.floor(globalT / 60);
  const secs = Math.floor(globalT % 60);
  const label = `REC  ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const y = height * SAFE_ZONE_BOTTOM;

  ctx.save();
  ctx.globalAlpha = 0.5 + Math.sin(globalT * 4) * 0.15;
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(50, y, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.55;
  ctx.font = '600 14px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Was hardcoded '#F5F5F5' - invisible on softEditorial's light
  // background, the same class of bug already fixed in drawCornerTag
  // but missed here since this function never received `system`.
  ctx.fillStyle = system.heroTextColor;
  ctx.fillText(label, 62, y);
  ctx.restore();

  const barCount = 24;
  const barAreaW = width * 0.5;
  const startX = width - barAreaW - 50;
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = accentColor;
  for (let i = 0; i < barCount; i++) {
    const seed = i * 12.9898 + Math.floor(globalT * 6) * 78.233;
    const pseudoRand = Math.abs(Math.sin(seed)) % 1;
    const h = 4 + pseudoRand * 22;
    const x = startX + i * (barAreaW / barCount);
    ctx.fillRect(x, y - h / 2, 2.5, h);
  }
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
 * Small pill-shaped tag in a top corner - unchanged mechanic from v3,
 * still the primary content-aware label.
 */
function drawCornerTag(ctx, label, sceneLocalT, width, height, accentColor, system) {
  const entranceT = clamp01((sceneLocalT - 0.1) / 0.4);
  if (entranceT <= 0) return;

  const opacity = easeOutCubic(entranceT);
  const slideX = lerp(-20, 0, easeOutBack(entranceT));
  const idleFloat = Math.sin(sceneLocalT * 1.3) * 2;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(60 + slideX, 90 + idleFloat);

  ctx.font = `600 18px ${system.fontFamily}`;
  const textWidth = ctx.measureText(label).width;
  const padX = 14;
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

  ctx.fillStyle = system.heroTextColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, padX + 4, 1);
  ctx.restore();
}

/**
 * A second, smaller indicator in the OPPOSITE corner - a scene
 * counter styled like a camera/recording UI readout ("01 / 03"),
 * reinforcing the "screen-within-screen" nested-UI density from the
 * reference videos, and giving the top-right corner something to look
 * at instead of leaving it empty while the tag occupies top-left.
 */
function drawCornerCounter(ctx, sceneIndex, sceneCount, sceneLocalT, width, height, accentColor) {
  const entranceT = clamp01((sceneLocalT - 0.2) / 0.4);
  if (entranceT <= 0) return;

  const opacity = easeOutCubic(entranceT) * 0.85;
  const label = `${String(sceneIndex + 1).padStart(2, '0')} / ${String(sceneCount).padStart(2, '0')}`;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width - 60, 90);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '600 15px monospace';
  ctx.fillStyle = accentColor;
  ctx.fillText(label, 0, 0);

  ctx.beginPath();
  ctx.arc(10, 0, 3, 0, Math.PI * 2);
  ctx.globalAlpha = opacity * (0.5 + Math.sin(sceneLocalT * 4) * 0.5);
  ctx.fill();
  ctx.restore();
}

/**
 * Small floating "data chip" mini-cards - miniature UI-card shapes
 * (rounded rect outline + a tiny label + a tiny bar) scattered at
 * fixed positions, each drifting independently and at a different
 * "depth" (dimmer/smaller = further back). This is the direct
 * implementation of the "screen-within-screen" / nested-frame density
 * trick named in the reference breakdown - multiple small UI-like
 * elements the eye can travel across, not just the hero content.
 */
const CHIP_LAYOUT = [
  { x: 0.14, y: 0.72, depth: 0.4, style: 'line' },
  { x: 0.85, y: 0.28, depth: 0.6, style: 'bar' },
  { x: 0.18, y: 0.2, depth: 0.3, style: 'line' },
  { x: 0.8, y: 0.6, depth: 0.5, style: 'percent' },
  { x: 0.1, y: 0.5, depth: 0.35, style: 'bar' },
  { x: 0.9, y: 0.88, depth: 0.45, style: 'line' },
];

function drawDataChips(ctx, sceneLocalT, width, height, accentColor, secondaryColor) {
  CHIP_LAYOUT.forEach((chip, i) => {
    const entranceT = clamp01((sceneLocalT - 0.25 - i * 0.08) / 0.4);
    if (entranceT <= 0) return;

    // Every 3rd chip uses the secondary (hue-shifted) color instead of
    // the primary accent - a sparing, deliberate use of a second color
    // per the "one dominant, quiet secondary" color-grading principle,
    // not every chip recolored (that would just look inconsistent).
    const chipColor = (secondaryColor && i % 3 === 2) ? secondaryColor : accentColor;

    const opacity = easeOutCubic(entranceT) * lerp(0.15, 0.4, chip.depth);
    const drift = Math.sin(sceneLocalT * 0.6 + i * 2) * 6 * chip.depth;
    const w = lerp(50, 70, chip.depth);
    const h = 24;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(chip.x * width, chip.y * height + drift);
    ctx.strokeStyle = chipColor;
    ctx.lineWidth = 1;
    roundRect(ctx, -w / 2, -h / 2, w, h, 6);
    ctx.stroke();

    ctx.fillStyle = chipColor;
    ctx.beginPath();
    ctx.arc(-w / 2 + 10, 0, 2.5, 0, Math.PI * 2);
    ctx.fill();

    if (chip.style === 'bar') {
      // Three tiny animated bars instead of a plain line - mini chart.
      for (let b = 0; b < 3; b++) {
        const bh = 4 + Math.abs(Math.sin(sceneLocalT * 2 + b + i)) * 8;
        ctx.fillStyle = chipColor;
        ctx.globalAlpha = opacity * 0.7;
        ctx.fillRect(-w / 2 + 20 + b * 8, 6 - bh, 5, bh);
      }
    } else if (chip.style === 'percent') {
      const pct = Math.round(30 + Math.abs(Math.sin(sceneLocalT * 0.7 + i)) * 60);
      ctx.globalAlpha = opacity * 0.9;
      ctx.font = '600 11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#F5F5F5';
      ctx.fillText(`${pct}%`, -w / 2 + 20, 0);
    } else {
      ctx.strokeStyle = '#FFFFFF';
      ctx.globalAlpha = opacity * 0.6;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + 18, 0);
      ctx.lineTo(w / 2 - 8, 0);
      ctx.stroke();
    }
    ctx.restore();
  });
}

function drawAccentShape(ctx, shape) {
  ctx.beginPath();
  switch (shape) {
    case 'crosshair':
      ctx.moveTo(-30, 0); ctx.lineTo(-12, 0);
      ctx.moveTo(12, 0); ctx.lineTo(30, 0);
      ctx.moveTo(0, -30); ctx.lineTo(0, -12);
      ctx.moveTo(0, 12); ctx.lineTo(0, 30);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case 'dots': {
      const positions = [[-20, -10], [0, 15], [20, -15], [8, 5]];
      for (const [dx, dy] of positions) {
        ctx.beginPath(); ctx.arc(dx, dy, 3.5, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    case 'arrow':
      ctx.moveTo(-25, 15); ctx.lineTo(20, -15);
      ctx.moveTo(4, -15); ctx.lineTo(20, -15); ctx.lineTo(20, 1);
      ctx.stroke();
      return;
    case 'plus':
      ctx.moveTo(-22, 0); ctx.lineTo(22, 0);
      ctx.moveTo(0, -22); ctx.lineTo(0, 22);
      ctx.stroke();
      return;
    case 'triangle':
      ctx.moveTo(0, -28); ctx.lineTo(26, 20); ctx.lineTo(-26, 20);
      ctx.closePath(); ctx.stroke();
      return;
    case 'bracket':
    default:
      ctx.moveTo(-30, -30); ctx.lineTo(30, -30); ctx.lineTo(30, 30);
      ctx.stroke();
      return;
  }
}

// Fixed layout of 4 accent positions across the frame - the scene's
// chosen shape renders at full size/opacity in the primary slot, and
// three OTHER shapes from the enum fill the remaining slots at
// smaller scale/lower opacity, so the frame always has multiple
// distinct accent shapes at once, not a single repeated one.
const ACCENT_SHAPES_ALL = ['bracket', 'crosshair', 'dots', 'arrow', 'plus', 'triangle'];
// Opacity/rotation speed roughly doubled from the original values -
// at the old 0.3-1.0 opacityMul range (scaled again by a 0.35 base
// alpha below), the smaller slots landed under ~0.1 final opacity,
// functionally invisible. These are meant to be part of "something is
// always moving," not a subliminal detail nobody actually perceives.
const ACCENT_SLOTS = [
  { x: 0.82, y: 0.78, scaleMul: 1.1, opacityMul: 1, rotSpeed: 0.45 },
  { x: 0.16, y: 0.85, scaleMul: 0.7, opacityMul: 0.75, rotSpeed: -0.34 },
  { x: 0.88, y: 0.14, scaleMul: 0.6, opacityMul: 0.65, rotSpeed: 0.55 },
  { x: 0.55, y: 0.92, scaleMul: 0.55, opacityMul: 0.6, rotSpeed: -0.5 },
  { x: 0.08, y: 0.35, scaleMul: 0.5, opacityMul: 0.55, rotSpeed: 0.4 },
  { x: 0.65, y: 0.08, scaleMul: 0.5, opacityMul: 0.55, rotSpeed: -0.52 },
];

function pickSecondaryShape(primaryShape, slotIndex) {
  const others = ACCENT_SHAPES_ALL.filter((s) => s !== primaryShape);
  return others[slotIndex % others.length];
}

function drawSecondaryAccents(ctx, primaryShape, sceneLocalT, width, height, accentColor) {
  ACCENT_SLOTS.forEach((slot, i) => {
    const entranceT = clamp01((sceneLocalT - 0.15 - i * 0.08) / 0.5);
    if (entranceT <= 0) return;

    const shape = i === 0 ? primaryShape : pickSecondaryShape(primaryShape, i - 1);
    const opacity = easeOutCubic(entranceT) * 0.55 * slot.opacityMul;
    const rotation = sceneLocalT * slot.rotSpeed;
    const scale = lerp(0.7, 1, easeOutCubic(entranceT)) * slot.scaleMul;
    // A real orbit, not just spin-in-place - each slot drifts along a
    // small loop, phase-offset per slot so they don't move in unison.
    const bobX = Math.sin(sceneLocalT * 0.7 + i * 1.7) * 14;
    const bobY = Math.cos(sceneLocalT * 0.55 + i * 1.7) * 14;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(slot.x * width + bobX, slot.y * height + bobY);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);
    ctx.strokeStyle = accentColor;
    ctx.fillStyle = accentColor;
    ctx.lineWidth = 2;
    drawAccentShape(ctx, shape);
    ctx.restore();
  });
}

/**
 * Call this AFTER atmosphere and BEFORE the hero content in every
 * template. Draws, all simultaneously and independently timed: dual
 * grid layers, a continuous scan-line sweep, FOUR accent shapes
 * (varied), three floating data chips, a corner tag, and a corner
 * counter - a genuinely dense, always-multi-element frame instead of
 * a hero element plus a couple of small decorations.
 */
/**
 * Call this AFTER atmosphere and BEFORE the hero content in every
 * template. The HUD-specific chrome (grid, scanlines, timestamp/
 * waveform, data chips) only draws for systems that opt into it
 * (system.showGrid etc.) - softEditorial and boldGraphic are
 * deliberately NOT "hudTerminal with different colors," they omit
 * this chrome entirely. The corner tag, corner counter, and secondary
 * accent shapes are universal across all three systems.
 */
function drawComposition(ctx, tagLabel, accentShape, sceneLocalT, sceneDuration, globalT, width, height, accentColor, sceneIndex, sceneCount, system, secondaryColor) {
  if (system.showGrid) drawMotifGrid(ctx, globalT, width, height, accentColor);
  if (system.showScanlines) drawScanline(ctx, globalT, width, height, accentColor);
  if (system.showDataChips) drawDataChips(ctx, sceneLocalT, width, height, accentColor, secondaryColor);
  drawSecondaryAccents(ctx, accentShape, sceneLocalT, width, height, accentColor);
  if (system.showTimestamp) drawTimestamp(ctx, globalT, width, height, accentColor, system);
  if (tagLabel) {
    drawCornerTag(ctx, tagLabel, sceneLocalT, width, height, accentColor, system);
  }
  if (typeof sceneIndex === 'number' && typeof sceneCount === 'number') {
    drawCornerCounter(ctx, sceneIndex, sceneCount, sceneLocalT, width, height, accentColor);
  }
}

module.exports = { drawComposition };
