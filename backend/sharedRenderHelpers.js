const { easeOutCubic, easeOutBack, lerp, clamp01 } = require('./easing');

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

/**
 * Every one of the 21 template functions anchored its content around
 * height*0.4-0.42 (with the hero visual separately fixed at 0.22 above
 * that) - meaning roughly the top 40% of every 720x1280 frame carried
 * all the content and the bottom ~60% was permanently empty, regardless
 * of template. These shared anchors push the vertical center of mass
 * down into real mid-frame territory and give multi-item layouts (grids,
 * lists) more room to spread, while staying above sceneComposition.js's
 * SAFE_ZONE_BOTTOM (0.82) so nothing meant to be read gets covered by a
 * real platform's caption/interaction UI.
 */
const LAYOUT = {
  heroPositionY: 0.24,
  heroSize: 190,
  contentCenterY: 0.54,
  captionY: 0.72,
};

/**
 * A real type scale, replacing ~15 distinct hardcoded font-size magic
 * numbers scattered across both template files (128, 84, 76, 52, 50/66,
 * 44, 40, 34, 32, 28...) with a small named set every template pulls
 * from - also the mechanism for actually making text bigger/bolder
 * across the board, not just repositioned.
 */
const TYPE_SCALE = {
  display: 168,
  hero: 108,
  title: 58,
  emphasis: 78,
  subhead: 40,
  body: 30,
  label: 24,
  micro: 18,
};

/**
 * Lays out a string as individually-positioned, word-wrapped characters
 * around a center point - the geometry half of kineticTextReveal's
 * per-character reveal, pulled out here so other "statement" templates
 * (a quote, a callout bubble, a comparison label) can get the same
 * kinetic treatment kineticTextReveal pioneered, instead of it being a
 * one-template-only trick. kineticTextReveal itself keeps its own
 * inline version (it has extra mixed-weight/emphasis-word behavior this
 * generic version deliberately doesn't try to replicate) - this is new
 * shared infrastructure for the templates that didn't have any
 * per-character reveal before.
 */
function layoutKineticChars(ctx, text, { fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY }) {
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const words = text.split(' ');
  const lines = [];
  let current = [];
  let currentWidth = 0;
  words.forEach((word) => {
    const wordWidth = ctx.measureText(`${word} `).width;
    if (currentWidth + wordWidth > maxWidth && current.length > 0) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(word);
    currentWidth += wordWidth;
  });
  if (current.length) lines.push(current);

  const totalHeight = lines.length * lineHeight;
  const startY = centerY - totalHeight / 2 + lineHeight / 2;

  const chars = [];
  lines.forEach((lineWords, li) => {
    const lineWidth = lineWords.reduce((sum, w) => sum + ctx.measureText(`${w} `).width, 0);
    let cx = centerX - lineWidth / 2;
    const cy = startY + li * lineHeight;
    lineWords.forEach((word) => {
      for (const ch of `${word} `) {
        const w = ctx.measureText(ch).width;
        chars.push({ ch, x: cx + w / 2, y: cy, index: chars.length });
        cx += w;
      }
    });
  });

  return { chars, totalHeight, startY };
}

/**
 * Animates a layoutKineticChars() result with the same per-character
 * stagger + overshoot-scale + jitter + optional glow used by
 * kineticTextReveal - the motion half, shared so every adopting
 * template gets identical-feeling kinetic type, not four subtly
 * different reimplementations.
 */
function drawKineticChars(ctx, chars, t, duration, { fontFamily, fontWeight, fontSize, fillStyle, glowColor = null, staggerWindow }) {
  // Capped absolute, not purely proportional to duration - a long beat
  // (e.g. one whose duration is stretched by narration) shouldn't make
  // its own text take proportionally longer to finish landing. A hook
  // has to punch in fast regardless of how long the beat holds after.
  const window = staggerWindow != null ? staggerWindow : Math.min(duration * 0.22, 0.4);
  const perCharDelay = chars.length > 1 ? window / chars.length : 0;
  const charLandWindow = Math.min(duration * 0.28, 0.32);
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    const charStart = c.index * perCharDelay;
    const charT = clamp01((t - charStart) / charLandWindow);
    if (charT <= 0) continue;

    const opacity = easeOutCubic(charT);
    const scale = lerp(1.4, 1, easeOutBack(charT));
    // Continuous, not a one-time-per-character fixed offset - see the
    // matching note in templateRenderers.js's own copy of this loop.
    const jitter = Math.sin(t * 1.8 + c.index * 12.9898) * 2.6;
    // Whole-phrase synchronized breathing pulse once landed - see the
    // matching note in templateRenderers.js's own copy of this loop for
    // why (a landed phrase held dead still for the rest of a long beat
    // otherwise).
    const settleTime = Math.max(0, t - charStart - charLandWindow - 0.15);
    const breathe = 1 + Math.sin(settleTime * (Math.PI * 2 / 2.2)) * 0.035;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(c.x, c.y + jitter);
    ctx.scale(scale * breathe, scale * breathe);
    if (glowColor) {
      ctx.shadowColor = glowColor;
      const glowRamp = clamp01((t - charStart - duration * 0.15) / (duration * 0.2));
      const glowPulse = 1 + Math.sin(t * 2.2 + c.index * 0.5) * 0.35 * glowRamp;
      ctx.shadowBlur = lerp(0, 16, glowRamp) * glowPulse;
    }
    ctx.fillStyle = fillStyle;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

module.exports = { drawFramingCard, LAYOUT, TYPE_SCALE, layoutKineticChars, drawKineticChars };
