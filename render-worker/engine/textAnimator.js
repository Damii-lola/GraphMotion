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

function layoutText(ctx, text, {
  fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY, textAlign = 'center',
}) {
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
    // Each character is still drawn individually CENTERED on its own
    // computed x (ctx.textAlign stays 'center' in renderAnimatedText
    // below) - only where each LINE's own run of characters starts
    // changes here. 'left'/'right' anchor every line to the same fixed
    // edge of the "maxWidth" box (a real, stacked-left-aligned kinetic-
    // typography paragraph, matching how short-form kinetic type is
    // conventionally set) instead of each line individually centering
    // on its own width, which is what made every previous line-break
    // "wobble" left/right relative to its neighbors regardless of
    // "textAlign" - the default here stays 'center' so existing
    // content with no opinion renders unchanged.
    let cx;
    if (textAlign === 'left') cx = centerX - maxWidth / 2;
    else if (textAlign === 'right') cx = centerX + maxWidth / 2 - lineWidth;
    else cx = centerX - lineWidth / 2;
    const cy = startY + li * lineHeight;
    lineWords.forEach((word) => {
      for (const ch of word) {
        const w = ctx.measureText(ch).width;
        chars.push({
          ch, x: cx + w / 2, y: cy, w, line: li, index: chars.length, wordIndex,
        });
        cx += w;
      }
      cx += ctx.measureText(' ').width;
      wordIndex++;
    });
  });

  return { chars, totalHeight, totalWords: wordIndex };
}

// Local, self-contained hex helpers (this engine's established
// convention - generateEffects.js/layerStyles.js/noiseEffects.js/
// textExtrude.js each keep their own tiny copy rather than sharing one
// cross-module util) so a per-character "color" animator delta and a
// highlight chip's fill can both blend toward a target hex color.
function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function lerpColorHex(fromHex, toHex, t) {
  const [r1, g1, b1] = hexToRgb(fromHex);
  const [r2, g2, b2] = hexToRgb(toHex);
  const r = Math.round(lerp(r1, r2, t));
  const g = Math.round(lerp(g1, g2, t));
  const b = Math.round(lerp(b1, b2, t));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Draws one highlight chip (a rounded rect behind a contiguous run of
 * selected characters, on ONE line - a run never spans a line break,
 * matching how the reference "word highlight" look always boxes a
 * single line of text) per contiguous run of chars whose selector
 * strength clears `threshold`. Drawn BEFORE the character pass so text
 * renders on top of its own chip.
 */
function drawHighlights(ctx, chars, fontSize, highlights, t, totalChars, totalWords) {
  const threshold = 0.5;
  for (const hl of highlights) {
    const {
      selector, color, gradient, paddingX = 8, paddingY = 4, cornerRadius = 6,
    } = hl;
    // Real, confirmed bug found via a production render (2026-09-03):
    // this selector is a static word-position top-hat with no time
    // component at all, so a highlight chip used to be fully visible
    // for the ENTIRE beat regardless of whether the word it's behind
    // has actually been revealed yet - on a real beat where the
    // highlighted word lands late in the sentence, that showed up as a
    // fully opaque colored box floating with no text under it for over
    // a second. appearAt (sceneSchema.js's ensureHighlightChip, backed
    // by narrationPrefetch's real per-word audio timing once available)
    // says when the target word actually lands; defaults to 0 so a
    // hand-authored highlight with no appearAt behaves exactly as
    // before.
    const appearAt = typeof hl.appearAt === 'number' ? hl.appearAt : 0;
    const fadeInDuration = typeof hl.fadeInDuration === 'number' && hl.fadeInDuration > 0 ? hl.fadeInDuration : 0.25;
    const timeGate = clamp01((t - appearAt) / fadeInDuration);
    let run = null;
    let strengthSum = 0;

    const flush = () => {
      if (!run) return;
      const alpha = clamp01(strengthSum / run.count) * timeGate;
      if (alpha <= 0) { run = null; strengthSum = 0; return; }
      const left = run.minX - paddingX;
      const right = run.maxX + paddingX;
      const top = run.y - fontSize * 0.55 - paddingY;
      const bottom = run.y + fontSize * 0.45 + paddingY;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (gradient) {
        const grad = ctx.createLinearGradient(left, run.y, right, run.y);
        grad.addColorStop(0, gradient.from);
        grad.addColorStop(1, gradient.to);
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = color || '#ffff00';
      }
      const w = right - left, h = bottom - top;
      const r = Math.min(cornerRadius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(left + r, top);
      ctx.arcTo(right, top, right, bottom, r);
      ctx.arcTo(right, bottom, left, bottom, r);
      ctx.arcTo(left, bottom, left, top, r);
      ctx.arcTo(left, top, right, top, r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      run = null; strengthSum = 0;
    };

    for (const c of chars) {
      const unit = {
        charIndex: c.index, totalChars, wordIndex: c.wordIndex, totalWords, t,
      };
      const strength = selector(unit);
      const selected = strength > threshold;
      if (selected && run && run.line === c.line) {
        run.minX = Math.min(run.minX, c.x - c.w / 2);
        run.maxX = Math.max(run.maxX, c.x + c.w / 2);
        run.count += 1;
        strengthSum += strength;
      } else if (selected) {
        flush();
        run = {
          line: c.line, minX: c.x - c.w / 2, maxX: c.x + c.w / 2, y: c.y, count: 1,
        };
        strengthSum = strength;
      } else {
        flush();
      }
    }
    flush();
  }
}

// ---------------------------------------------------------------------
// Rendering: layout once, then for every animator/character pair,
// blend "base" (strength 0) toward "base + property delta" (strength
// 1) by that character's combined selection strength.
// ---------------------------------------------------------------------

// Real, previously-unnoticed cost: layoutText (word-wrap + a
// ctx.measureText() call for every word AND every character) has zero
// dependency on `t` - a beat's text content/font/box never changes
// across its own frames, only the PER-CHARACTER ANIMATION strengths
// (computed separately, below) do. Every caller (sceneBuilder.js's
// buildTextDraw) already builds ONE closure per beat per text layer
// and calls it once per frame with that same closure - so layoutText
// was being redone from scratch on EVERY SINGLE FRAME of a beat's
// entire duration (dozens of measureText calls x every frame x every
// text layer x every beat), recomputing the byte-for-byte identical
// result every time. Cached here keyed by the exact inputs that can
// affect layout - if the caller passes the SAME `layoutCache` object
// across calls (as buildTextDraw does, scoped to one beat), a cache
// hit skips layoutText entirely; any input actually changing (should
// never happen mid-beat by this schema's own design - text-layout
// fields aren't part of the keyframe/Property system - but checked
// anyway rather than assumed) transparently recomputes instead of
// silently serving a stale layout.
function renderAnimatedText(ctx, text, t, opts) {
  const {
    fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY, textAlign = 'center',
    fillStyle = '#FFFFFF', animators = [], highlights = [], layoutCache = null,
  } = opts;

  const layoutKey = `${text}|${fontFamily}|${fontWeight}|${fontSize}|${lineHeight}|${maxWidth}|${centerX}|${centerY}|${textAlign}`;
  let layout;
  if (layoutCache && layoutCache.key === layoutKey) {
    layout = layoutCache.result;
  } else {
    layout = layoutText(ctx, text, {
      fontFamily, fontWeight, fontSize, lineHeight, maxWidth, centerX, centerY, textAlign,
    });
    if (layoutCache) { layoutCache.key = layoutKey; layoutCache.result = layout; }
  }
  const { chars, totalWords } = layout;
  const totalChars = chars.length;

  if (highlights.length > 0) drawHighlights(ctx, chars, fontSize, highlights, t, totalChars, totalWords);

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    let dx = 0, dy = 0, scaleMul = 1, dRotation = 0, opacityDelta = 0;
    let colorMix = null;
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
      // Color isn't additive like the deltas above - each animator that
      // sets "color" blends the RUNNING mix toward its own target color
      // by this character's strength (0 = untouched, 1 = fully that
      // animator's color), same "0=base/1=fully applied" convention as
      // every other property here, just via lerp instead of +=.
      if (p.color) colorMix = lerpColorHex(colorMix || fillStyle, p.color, clamp01(strength));
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
    ctx.fillStyle = colorMix || fillStyle;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

module.exports = {
  rangeSelector, wigglySelector, expressionSelector, combineSelectors,
  layoutText, renderAnimatedText,
};
