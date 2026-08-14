const { createCanvas } = require('@napi-rs/canvas');
const { hash01 } = require('./selectors');

/**
 * AE's Generate category: effects that create new content rather than
 * modifying existing pixels. Each function here returns a fresh
 * canvas, matching how shapePrimitives.js/textExtrude.js/etc already
 * hand back new canvases rather than mutating in place.
 */

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function clampByte(v) { return Math.min(255, Math.max(0, v)); }

/**
 * Gradient Ramp: computed per-pixel (not via ctx.createLinearGradient)
 * specifically so a real DITHER can be injected before quantizing to
 * 8-bit - a smooth gradient with no dither visibly bands (many
 * adjacent pixels landing on the identical rounded byte value before
 * the true continuous color has moved enough to reach the next one),
 * and adding a small amount of deterministic per-pixel noise (reusing
 * selectors.js's already-verified hash01, the same deterministic
 * pseudo-random source used everywhere else in this engine) before
 * rounding breaks that up - a real, standard technique (ordered/random
 * dithering), not a cosmetic afterthought.
 */
function gradientRamp(width, height, {
  startPoint = [0, 0], endPoint = [width, 0], startColor = '#000000', endColor = '#ffffff',
  shape = 'linear', dither = true,
} = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  const [sr, sg, sb] = hexToRgb(startColor);
  const [er, eg, eb] = hexToRgb(endColor);
  const dx = endPoint[0] - startPoint[0], dy = endPoint[1] - startPoint[1];
  const lenSq = dx * dx + dy * dy || 1;
  const radius = Math.hypot(dx, dy) || 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let t;
      if (shape === 'radial') {
        t = Math.hypot(x - startPoint[0], y - startPoint[1]) / radius;
      } else {
        const px = x - startPoint[0], py = y - startPoint[1];
        t = (px * dx + py * dy) / lenSq;
      }
      t = Math.min(1, Math.max(0, t));

      const noise = dither ? hash01(x * 12.9898 + y * 78.233 * 3.7) - 0.5 : 0;
      const i = (y * width + x) * 4;
      data[i] = clampByte(Math.round(sr + (er - sr) * t + noise));
      data[i + 1] = clampByte(Math.round(sg + (eg - sg) * t + noise));
      data[i + 2] = clampByte(Math.round(sb + (eb - sb) * t + noise));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/** AE's Checkerboard: a two-color tile pattern, tile parity by (col+row)%2. */
function checkerboard(width, height, { tileSize = 20, colorA = '#ffffff', colorB = '#000000' } = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const col = Math.floor(x / tileSize), row = Math.floor(y / tileSize);
      ctx.fillStyle = (col + row) % 2 === 0 ? colorA : colorB;
      ctx.fillRect(x, y, tileSize, tileSize);
    }
  }
  return canvas;
}

/** AE's Grid: evenly spaced horizontal/vertical lines over an optional background. */
function grid(width, height, {
  cellWidth = 40, cellHeight = 40, lineColor = '#ffffff', lineWidth = 2, backgroundColor = null,
} = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (backgroundColor) { ctx.fillStyle = backgroundColor; ctx.fillRect(0, 0, width, height); }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (let x = 0; x <= width; x += cellWidth) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 0; y <= height; y += cellHeight) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();
  return canvas;
}

/**
 * A single radial glow blob - the one primitive every Lens Flare
 * element below is built from. `ring:true` makes the gradient peak
 * partway out and fade at BOTH ends (a soft ring rather than a solid
 * hotspot) - real AE lens flare "ghosts" are mostly rings/donuts of
 * light, not solid discs, which is what distinguishes them visually
 * from the flare's own bright source core.
 *
 * Composited with 'lighter' (additive) - light sources genuinely ADD
 * to what's behind them rather than alpha-blending over it, and this
 * specific case (a gradient fill, not a raw solid fill, under a non-
 * default composite operation) was empirically verified before use:
 * a 50%-alpha radial gradient over a mid-gray background produced
 * (approximately) the correct additive result, not the 2x-error
 * double-alpha-application bug batch 3 found for raw fillRect fills
 * under destination-in/out - that finding does NOT generalize to every
 * non-default composite operation, confirmed directly rather than
 * assumed either way.
 */
function drawGlow(ctx, pos, radius, color, opacity, ring = false) {
  const [r, g, b] = hexToRgb(color);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const grad = ctx.createRadialGradient(pos[0], pos[1], 0, pos[0], pos[1], radius);
  if (ring) {
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(0.65, `rgba(${r},${g},${b},${opacity})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  } else {
    grad.addColorStop(0, `rgba(${r},${g},${b},${opacity})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(pos[0], pos[1], radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * AE's Lens Flare: a bright core + halo at the light source, plus a
 * chain of "ghost" reflections strung along the axis from the source
 * THROUGH the frame center and continuing past it - the real optical
 * basis for this (internal reflections between camera lens elements
 * produce secondary images of the source, positioned along that exact
 * line, both before and after the center) is why AE's own effect
 * works this way, not an arbitrary layout choice. Ghost position at
 * parameter t: sourcePoint + (center-sourcePoint)*t - t=0 is the
 * source itself, t=1 is the frame center, t>1 continues past it on the
 * opposite side.
 */
function lensFlare(width, height, {
  sourcePoint = [width * 0.75, height * 0.2], intensity = 1, color = '#fff2d0', ghosts = null,
} = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const center = [width / 2, height / 2];
  const axis = [center[0] - sourcePoint[0], center[1] - sourcePoint[1]];

  drawGlow(ctx, sourcePoint, 90 * intensity, color, Math.min(1, intensity));
  drawGlow(ctx, sourcePoint, 220 * intensity, color, 0.22 * intensity);

  const defaultGhosts = [
    { t: 0.3, radius: 16, opacity: 0.32, color: '#ffee88' },
    { t: 0.55, radius: 28, opacity: 0.22, color: '#88ccff' },
    { t: 0.8, radius: 12, opacity: 0.28, color: '#ff88cc' },
    { t: 1.15, radius: 44, opacity: 0.18, color: '#ffffff' },
    { t: 1.45, radius: 18, opacity: 0.22, color: '#88ffcc' },
    { t: 1.8, radius: 58, opacity: 0.1, color: '#ffaa66' },
  ];
  for (const gh of (ghosts || defaultGhosts)) {
    const pos = [sourcePoint[0] + axis[0] * gh.t, sourcePoint[1] + axis[1] * gh.t];
    drawGlow(ctx, pos, gh.radius, gh.color, gh.opacity * intensity, true);
  }
  return canvas;
}

module.exports = {
  gradientRamp, checkerboard, grid, lensFlare, drawGlow,
};
