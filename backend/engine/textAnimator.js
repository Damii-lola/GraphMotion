const { clamp01, lerp } = require('./mathUtils');
const {
  rangeSelector, wigglySelector, expressionSelector, combineSelectors,
} = require('./selectors');

/**
 * THE mechanism behind "letters cascade in one at a time" and every
 * other per-character text effect: a Selector (selectors.js, its own
 * first-class module as of batch 5) answers "how strongly is THIS
 * character selected, right now" for every character in a string, and
 * an Animator (this file) applies property changes SCALED by that
 * strength. Animating a range selector's start/end across time is what
 * makes a sweeping reveal work - the selector doesn't need to know
 * it's being swept, it just answers the question at whatever t it's
 * asked. Re-exported here (not just left in selectors.js) so existing
 * call sites that import selectors from textAnimator keep working
 * unchanged.
 */

// ---------------------------------------------------------------------
// Character layout - real word-wrap + per-character base position,
// tracking both a character index AND a word index per character so
// basedOn:'words' selectors work.
// ---------------------------------------------------------------------

function layoutText(ctx, text, { fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY }) {
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const words = text.split(' ').filter((w) => w.length > 0);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  words.forEach((word) => {
    const wordWidth = ctx.measureText(`${word} `).width;
    if (currentWidth + wordWidth > maxWidth && current.length > 0) {
      lines.push(current); current = []; currentWidth = 0;
    }
    current.push(word);
    currentWidth += wordWidth;
  });
  if (current.length) lines.push(current);

  const totalHeight = lines.length * lineHeight;
  const startY = centerY - totalHeight / 2 + lineHeight / 2;

  const chars = [];
  let wordIndex = 0;
  lines.forEach((lineWords, li) => {
    const lineWidth = lineWords.reduce((sum, w) => sum + ctx.measureText(`${w} `).width, 0);
    let cx = centerX - lineWidth / 2;
    const cy = startY + li * lineHeight;
    lineWords.forEach((word) => {
      for (const ch of word) {
        const w = ctx.measureText(ch).width;
        chars.push({ ch, x: cx + w / 2, y: cy, index: chars.length, wordIndex });
        cx += w;
      }
      cx += ctx.measureText(' ').width;
      wordIndex++;
    });
  });

  return { chars, totalHeight, totalWords: wordIndex };
}

// ---------------------------------------------------------------------
// Rendering: layout once, then for every animator/character pair,
// blend "base" (strength 0) toward "base + property delta" (strength
// 1) by that character's combined selection strength.
// ---------------------------------------------------------------------

function renderAnimatedText(ctx, text, t, opts) {
  const {
    fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY,
    fillStyle = '#FFFFFF', animators = [],
  } = opts;

  const { chars, totalWords } = layoutText(ctx, text, { fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY });
  const totalChars = chars.length;

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    let dx = 0, dy = 0, scaleMul = 1, dRotation = 0, opacityDelta = 0;
    const unit = { charIndex: c.index, totalChars, wordIndex: c.wordIndex, totalWords, t };

    for (const anim of animators) {
      const strength = anim.selector(unit);
      // Only exact zero is skippable. A NEGATIVE strength is now a real,
      // meaningful case as of batch 5's selector `amount` (which can be
      // negative to invert a selection) - it means "apply this delta in
      // reverse," not "no contribution." Skipping on strength<=0 would
      // silently discard that inversion.
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
    ctx.translate(c.x + dx, c.y + dy);
    // dRotation accumulates animator "rotation" DELTAS, degrees like
    // every other rotation field in the schema - ctx.rotate() itself
    // wants radians, the same unit mismatch fixed in matrix2d.js's
    // fromTRS (see its doc comment for the full story).
    ctx.rotate((dRotation * Math.PI) / 180);
    ctx.scale(scaleMul, scaleMul);
    ctx.fillStyle = fillStyle;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

module.exports = {
  rangeSelector, wigglySelector, expressionSelector, combineSelectors,
  layoutText, renderAnimatedText,
};
