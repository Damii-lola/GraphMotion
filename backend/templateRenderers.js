const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');
const { getVisualSystem } = require('./visualSystems');
const { drawFramingCard, LAYOUT, TYPE_SCALE, layoutKineticChars, drawKineticChars } = require('./sharedRenderHelpers');
const { buildShadeGradient } = require('./colorUtils');
const { splitCompare, listReveal, quoteCallout, progressBar, countdownTimer, gridReveal, checklistTick, bigNumberStat, pieChartReveal, duoStatCompare, badgeUnlock, tickerScroll, statGrid, arrowFlow, calloutBubble, barChartCompare, avatarStack } = require('./templateRenderersExtended');

/**
 * FLAIR RULES v4 - v3 fixed "one lonely element" via drawComposition.
 * This version fixes a DIFFERENT real problem: every video looked the
 * same regardless of topic, because atmosphere/composition/hero-content
 * colors and treatment were hardcoded to one dark-glow look. Every
 * hero-content function now takes `system` (from visualSystems.js) and
 * uses system.heroTextColor/fontFamily/fontWeight instead of hardcoded
 * '#F5F5F5'/sans-serif, and gates its glow (shadowBlur) on
 * system.heroUsesGlow - softEditorial and boldGraphic render flat,
 * no neon glow, matching their register instead of being a recolor of
 * hudTerminal.
 */

const FALLBACK_TAGS = {
  kineticTextReveal: 'INSIGHT',
  rippleDrop: 'ALERT',
  statCounter: 'DATA',
  iconCallout: 'NOTE',
  shapeReveal: 'FOCUS',
  splitCompare: 'COMPARE',
  listReveal: 'GUIDE',
  quoteCallout: 'QUOTE',
  progressBar: 'PROGRESS',
  countdownTimer: 'URGENT',
  gridReveal: 'FEATURES',
  checklistTick: 'STEPS',
  bigNumberStat: 'KEY STAT',
  pieChartReveal: 'DATA',
  duoStatCompare: 'COMPARE',
  badgeUnlock: 'UNLOCKED',
  tickerScroll: 'HIGHLIGHTS',
  statGrid: 'METRICS',
  arrowFlow: 'PROCESS',
  calloutBubble: 'TESTIMONIAL',
  barChartCompare: 'DATA',
  avatarStack: 'COMMUNITY',
};

/**
 * Renders ONLY a beat's hero content - no atmosphere, no per-scene
 * camera push, no composition chrome. Those all moved to the
 * top-level render loop (renderEngine.js), which now draws atmosphere
 * ONCE per frame (screen-space) and applies ONE continuous world
 * camera transform before calling this for each visible beat,
 * translated to that beat's own world position. Every individual
 * template function below is completely UNCHANGED internally - they
 * still reference width/2, height*0.42, etc. exactly as before; the
 * caller compensates by translating so that "width/2, height/2" in
 * this local coordinate system lands at the beat's actual world
 * anchor instead of screen-center. This avoids having to rewrite
 * twenty-plus template functions individually.
 */
function drawBeatContent(ctx, template, params, localTime, width, height, visualSystemName) {
  const system = getVisualSystem(visualSystemName);

  switch (template) {
    case 'kineticTextReveal':
      kineticTextReveal(ctx, params, localTime, width, height, system);
      break;
    case 'rippleDrop':
      rippleDrop(ctx, params, localTime, width, height, system);
      break;
    case 'statCounter':
      statCounter(ctx, params, localTime, width, height, system);
      break;
    case 'iconCallout':
      iconCallout(ctx, params, localTime, width, height, system);
      break;
    case 'shapeReveal':
      shapeReveal(ctx, params, localTime, width, height, system);
      break;
    case 'splitCompare':
      splitCompare(ctx, params, localTime, width, height, system);
      break;
    case 'listReveal':
      listReveal(ctx, params, localTime, width, height, system);
      break;
    case 'quoteCallout':
      quoteCallout(ctx, params, localTime, width, height, system);
      break;
    case 'progressBar':
      progressBar(ctx, params, localTime, width, height, system);
      break;
    case 'countdownTimer':
      countdownTimer(ctx, params, localTime, width, height, system);
      break;
    case 'gridReveal':
      gridReveal(ctx, params, localTime, width, height, system);
      break;
    case 'checklistTick':
      checklistTick(ctx, params, localTime, width, height, system);
      break;
    case 'bigNumberStat':
      bigNumberStat(ctx, params, localTime, width, height, system);
      break;
    case 'pieChartReveal':
      pieChartReveal(ctx, params, localTime, width, height, system);
      break;
    case 'duoStatCompare':
      duoStatCompare(ctx, params, localTime, width, height, system);
      break;
    case 'badgeUnlock':
      badgeUnlock(ctx, params, localTime, width, height, system);
      break;
    case 'tickerScroll':
      tickerScroll(ctx, params, localTime, width, height, system);
      break;
    case 'statGrid':
      statGrid(ctx, params, localTime, width, height, system);
      break;
    case 'arrowFlow':
      arrowFlow(ctx, params, localTime, width, height, system);
      break;
    case 'calloutBubble':
      calloutBubble(ctx, params, localTime, width, height, system);
      break;
    case 'barChartCompare':
      barChartCompare(ctx, params, localTime, width, height, system);
      break;
    case 'avatarStack':
      avatarStack(ctx, params, localTime, width, height, system);
      break;
    default:
      throw new Error(`No renderer implemented for template "${template}"`);
  }
}

/**
 * Shared card-framing helper, extracted from kineticTextReveal so the
 * other text-heavy templates get the same real per-beat variety
 * instead of duplicating this logic four times. Takes an explicit
 * center + size rather than measuring text itself, since each
 * template's own layout (digit-roll, multi-line quotes, etc.) already
 * knows its own bounds better than a generic helper could guess.
 */
/**
 * Shared card-framing helper lives in sharedRenderHelpers.js now -
 * had to move it out of this file specifically to avoid a circular
 * require with templateRenderersExtended.js (confirmed directly: it
 * broke silently, not theoretically).
 */
function drawContactShadow(ctx, x, y, radiusX, radiusY, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radiusX);
  grad.addColorStop(0, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function kineticTextReveal(ctx, params, t, width, height, system) {
  // Named lineGroupParam (not "lines") to avoid colliding with the
  // word-wrap "lines" array built further down in this same function's
  // single-statement path - confirmed the hard way (a real
  // SyntaxError: Identifier 'lines' has already been declared).
  const { text, lines: lineGroupParam, duration, style, textFrame } = params;
  const accentColor = params.color || '#FF5C1A';

  // Multi-line mode: 2-4 short RELATED phrases stacked and revealed as
  // a group in ONE beat, at full kinetic-text size/energy - this is
  // what "grouped content" is supposed to look like. Direct response
  // to real feedback: routing grouped content through the small-UI-
  // widget templates (checkbox lists, bullet lists, grid cards) reads
  // as a dated dashboard component, not bold video typography. This
  // keeps the exact same big/bold/glowing per-character kinetic
  // reveal as a single statement, just several of them in sequence.
  if (Array.isArray(lineGroupParam) && lineGroupParam.length > 0) {
    return kineticMultiLineReveal(ctx, lineGroupParam.slice(0, 4), accentColor, t, duration, width, height, system, textFrame);
  }

  const isMixedWeight = style === 'mixed-weight';
  // Real per-beat framing variety, not the same flat-glow treatment
  // every time - direct response to reference feedback ("sometimes
  // the box containing text changes, sometimes the color changes
  // with a gradient"). 'none' keeps the exact original look.
  const frame = ['card', 'gradient', 'highlight'].includes(textFrame) ? textFrame : 'none';

  // mixed-weight: the single longest word gets rendered larger/heavier
  // than the rest, creating real typographic hierarchy within the
  // sentence - per the original craft notes ("emphasis animated, not
  // just typed in caps"). This was declared in the schema since round
  // 1 but never actually implemented - params.style was never even
  // read. bold-glow's behavior is completely unchanged below.
  const words = text.split(' ');
  let emphasisWordIndex = -1;
  if (isMixedWeight && words.length > 1) {
    let longest = 0;
    words.forEach((w, i) => { if (w.length > longest) { longest = w.length; emphasisWordIndex = i; } });
  }

  const baseFontSize = TYPE_SCALE.title;
  const emphasisFontSize = TYPE_SCALE.emphasis;
  const lineHeight = baseFontSize * 1.16;
  const maxWidth = width * 0.82;

  // Word-wrap using the base font size for measurement - emphasis
  // words run larger, but the wrap boundary uses base size consistently
  // so layout stays predictable rather than reflowing unexpectedly.
  ctx.font = `${system.fontWeight} ${baseFontSize}px ${system.fontFamily}`;
  const lines = [];
  let current = [];
  let currentWidth = 0;
  words.forEach((word, wi) => {
    const wordFontSize = (isMixedWeight && wi === emphasisWordIndex) ? emphasisFontSize : baseFontSize;
    ctx.font = `${system.fontWeight} ${wordFontSize}px ${system.fontFamily}`;
    const wordWidth = ctx.measureText(word + ' ').width;
    if (currentWidth + wordWidth > maxWidth && current.length > 0) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push({ word, wordIndex: wi, fontSize: wordFontSize });
    currentWidth += wordWidth;
  });
  if (current.length) lines.push(current);

  const totalHeight = lines.length * lineHeight;
  const startY = height * LAYOUT.contentCenterY - totalHeight / 2 + lineHeight / 2;

  const chars = [];
  lines.forEach((lineWords, li) => {
    ctx.font = `${system.fontWeight} ${baseFontSize}px ${system.fontFamily}`;
    const lineWidth = lineWords.reduce((sum, w) => {
      ctx.font = `${system.fontWeight} ${w.fontSize}px ${system.fontFamily}`;
      return sum + ctx.measureText(w.word + ' ').width;
    }, 0);
    let cx = width / 2 - lineWidth / 2;
    const cy = startY + li * lineHeight;
    lineWords.forEach(({ word, wordIndex, fontSize }) => {
      ctx.font = `${system.fontWeight} ${fontSize}px ${system.fontFamily}`;
      for (const ch of word + ' ') {
        const w = ctx.measureText(ch).width;
        chars.push({ ch, x: cx + w / 2, y: cy, index: chars.length, fontSize, isEmphasis: wordIndex === emphasisWordIndex, lineIndex: li });
        cx += w;
      }
    });
  });

  const staggerWindow = duration * 0.4;
  const perCharDelay = chars.length > 1 ? staggerWindow / chars.length : 0;

  // Card background: drawn ONCE behind all characters, using the real
  // bounding box of the laid-out text (not a guessed size) - sized
  // and revealed together with the overall entrance, not per-character.
  if (frame === 'card' && chars.length > 0) {
    const minX = Math.min(...chars.map((c) => c.x)) - 24;
    const maxX = Math.max(...chars.map((c) => c.x)) + 24;
    const minY = startY - lineHeight / 2 - 16;
    const maxY = startY + (lines.length - 1) * lineHeight + lineHeight / 2 + 16;
    drawFramingCard(ctx, (minX + maxX) / 2, (minY + maxY) / 2, maxX - minX, maxY - minY, t, duration, accentColor);
  }

  // Highlight: a marker-style bar sweeping in behind each LINE
  // (independently timed per line, not per character - a highlighter
  // marks a phrase at a time, not letter by letter), with a slight
  // fixed rotation and overshoot past the line's own edges so it reads
  // as a real hand-drawn mark rather than a precise UI rectangle.
  if (frame === 'highlight' && chars.length > 0) {
    for (let li = 0; li < lines.length; li++) {
      const lineChars = chars.filter((c) => c.lineIndex === li);
      if (lineChars.length === 0) continue;
      const minX = Math.min(...lineChars.map((c) => c.x)) - 10;
      const maxX = Math.max(...lineChars.map((c) => c.x)) + 10;
      const cy = lineChars[0].y;
      const lineStart = lineChars[0].index * perCharDelay;
      const sweepT = clamp01((t - lineStart - duration * 0.05) / (duration * 0.22));
      if (sweepT <= 0) continue;
      const sweepWidth = lerp(0, maxX - minX, easeOutCubic(sweepT));
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = accentColor;
      ctx.translate(minX, cy);
      ctx.rotate(-0.02 + (li % 2 === 0 ? 0.012 : -0.012));
      ctx.fillRect(0, -baseFontSize * 0.42, sweepWidth, baseFontSize * 0.86);
      ctx.restore();
    }
  }

  // Gradient fill: computed once (not per-character) for performance,
  // spanning the full text width so the gradient reads as one
  // continuous sweep across the whole line, not a repeating pattern
  // per letter.
  let gradientFill = null;
  if (frame === 'gradient' && chars.length > 0) {
    const minX = Math.min(...chars.map((c) => c.x));
    const maxX = Math.max(...chars.map((c) => c.x));
    gradientFill = ctx.createLinearGradient(minX, 0, maxX, 0);
    gradientFill.addColorStop(0, system.heroTextColor);
    gradientFill.addColorStop(1, accentColor);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    const charStart = c.index * perCharDelay;
    const charT = clamp01((t - charStart) / (duration * 0.28));
    if (charT <= 0) continue;

    const opacity = easeOutCubic(charT);
    const scale = lerp(1.4, 1, easeOutBack(charT));
    // Was a fixed per-character offset (a function of index only, never
    // of time) - looked staggered on arrival but every character froze
    // in place the instant it landed. Now continuously bobs for as long
    // as it's on screen, still phase-offset per character so they don't
    // all move in lockstep.
    const jitter = Math.sin(t * 1.8 + c.index * 12.9898) * 2.6;

    ctx.font = `${system.fontWeight} ${c.fontSize}px ${system.fontFamily}`;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(c.x, c.y + jitter);
    ctx.scale(scale, scale);
    if (system.heroUsesGlow) {
      ctx.shadowColor = accentColor;
      // Emphasis word glows a bit brighter, reinforcing the size
      // hierarchy instead of every character getting identical glow.
      // Ramps up on landing, then keeps a slow rhythmic pulse rather
      // than holding one static blur value for the rest of the beat.
      const glowRamp = clamp01((t - charStart - duration * 0.15) / (duration * 0.2));
      const glowPulse = 1 + Math.sin(t * 2.2 + c.index * 0.5) * 0.35 * glowRamp;
      ctx.shadowBlur = lerp(0, c.isEmphasis ? 24 : 16, glowRamp) * glowPulse;
    }
    ctx.fillStyle = gradientFill || system.heroTextColor;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

/**
 * Several short related lines, stacked and revealed as a GROUP in one
 * beat - each line gets its own full-size kinetic per-character reveal
 * (same mechanism as single-statement kineticTextReveal, via the
 * shared layoutKineticChars/drawKineticChars helpers), staggered so
 * line 2 starts landing shortly after line 1, not simultaneously and
 * not one continuous sentence. A thin accent-colored marker sits to the
 * left of each line - not a checkbox, not a numbered badge, not a
 * bullet dot - just enough structure to read as "these belong
 * together" without looking like list-app UI.
 */
function kineticMultiLineReveal(ctx, lineList, accentColor, t, duration, width, height, system, textFrame) {
  const frame = ['card', 'highlight'].includes(textFrame) ? textFrame : 'none';
  const fontSize = lineList.length >= 4 ? TYPE_SCALE.subhead + 6 : TYPE_SCALE.title;
  const lineHeight = fontSize * 1.3;
  const maxWidth = width * 0.78;
  const centerX = width / 2 + 18;
  const perLineDelay = Math.min(duration * 0.28, 0.55);

  // REAL BUG, confirmed via direct repro: layoutKineticChars does its
  // OWN internal word-wrap, so any group-line phrase too long to fit
  // maxWidth at this font size (schema allows up to 40 chars per line,
  // easily enough to wrap) silently became TWO internal lines - but
  // this used to reserve exactly one fixed `lineHeight` slot per
  // group-line regardless, so a wrapped line's second row spilled
  // straight into the NEXT group-line's slot. Both then animate their
  // own per-character stagger reveal on top of each other at the same
  // position - illegible interleaved characters, not just a visual
  // overlap. Fix: measure each group-line's REAL height first (cheap -
  // layoutKineticChars only does ctx.measureText here, no drawing),
  // then stack by actual measured height instead of assuming one line
  // each.
  const measured = lineList.map((line) => layoutKineticChars(ctx, line, {
    fontFamily: system.fontFamily, fontWeight: system.fontWeight, fontSize,
    lineHeight, maxWidth, centerX, centerY: 0,
  }));
  const totalHeight = measured.reduce((sum, m) => sum + m.totalHeight, 0);
  let cursorY = height * LAYOUT.contentCenterY - totalHeight / 2;

  if (frame === 'card') {
    const cardT = clamp01(t / (duration * 0.2));
    if (cardT > 0) {
      drawFramingCard(ctx, width / 2, height * LAYOUT.contentCenterY, width * 0.88, totalHeight + 48, t, duration, accentColor);
    }
  }

  lineList.forEach((line, li) => {
    const lineStart = li * perLineDelay;
    const lineLocalT = t - lineStart;
    const lineDuration = duration - lineStart;
    const cy = cursorY + measured[li].totalHeight / 2;
    cursorY += measured[li].totalHeight;
    if (lineLocalT <= 0) return;

    const layout = layoutKineticChars(ctx, line, {
      fontFamily: system.fontFamily, fontWeight: system.fontWeight, fontSize,
      lineHeight, maxWidth, centerX, centerY: cy,
    });

    // Accent marker - a short vertical bar that grows in just before
    // its line's text starts, echoing quoteCallout's accent-bar
    // language rather than introducing a new UI element.
    const markerT = clamp01((lineLocalT - 0.02) / 0.25);
    if (markerT > 0 && layout.chars.length > 0) {
      const minX = Math.min(...layout.chars.map((c) => c.x)) - 26;
      ctx.save();
      ctx.globalAlpha = markerT;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 3;
      const barH = lerp(0, fontSize * 0.7, easeOutCubic(markerT));
      ctx.beginPath();
      ctx.moveTo(minX, cy - barH / 2);
      ctx.lineTo(minX, cy + barH / 2);
      ctx.stroke();
      ctx.restore();
    }

    let gradientFill = null;
    if (frame === 'highlight' && layout.chars.length > 0) {
      const minX = Math.min(...layout.chars.map((c) => c.x)) - 10;
      const maxX = Math.max(...layout.chars.map((c) => c.x)) + 10;
      const sweepT = clamp01((lineLocalT - 0.05) / 0.28);
      if (sweepT > 0) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = accentColor;
        ctx.fillRect(minX, cy - fontSize * 0.42, lerp(0, maxX - minX, easeOutCubic(sweepT)), fontSize * 0.86);
        ctx.restore();
      }
    }

    drawKineticChars(ctx, layout.chars, lineLocalT, lineDuration, {
      fontFamily: system.fontFamily, fontWeight: system.fontWeight, fontSize,
      fillStyle: gradientFill || system.heroTextColor,
      glowColor: system.heroUsesGlow ? accentColor : null,
      staggerWindow: Math.min(lineDuration * 0.35, 0.4),
    });
  });
}

function rippleDrop(ctx, params, t, width, height, system) {
  const { caption, duration } = params;
  const color = params.color || '#FF5C1A';

  const centerX = width / 2;
  const landY = height * (LAYOUT.contentCenterY - 0.1);
  const startY = height * 0.2;

  const dropT = clamp01(t / (duration * 0.55));
  const y = lerp(startY, landY, easeOutCubic(dropT));

  const impactWindow = 0.12;
  const timeSinceLand = t - duration * 0.55;
  let squashX = 1, squashY = 1;
  if (dropT >= 1 && timeSinceLand < impactWindow) {
    const impactT = timeSinceLand / impactWindow;
    const squashAmount = Math.sin(impactT * Math.PI) * 0.35;
    squashX = 1 + squashAmount;
    squashY = 1 - squashAmount;
  }

  if (dropT >= 1) {
    const rippleT = (t - duration * 0.55) / (duration * 0.45);
    for (let ring = 0; ring < 3; ring++) {
      const ringT = clamp01(rippleT - ring * 0.15);
      if (ringT <= 0) continue;
      const radius = lerp(30, 150, easeOutExpo(ringT));
      const alpha = (1 - ringT) * 0.4;
      ctx.strokeStyle = system.name === 'softEditorial'
        ? `rgba(42,38,34,${alpha.toFixed(3)})`
        : `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(centerX, landY, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawContactShadow(ctx, centerX, landY + 12, 34 * squashX, 10, dropT >= 1 ? 0.5 : lerp(0.1, 0.5, dropT));

  ctx.save();
  ctx.translate(centerX, y);
  ctx.scale(squashX, squashY);
  if (system.heroUsesGlow) {
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (caption) {
    const captionT = clamp01((t - duration * 0.5) / (duration * 0.3));
    ctx.save();
    ctx.globalAlpha = easeOutCubic(captionT);
    ctx.font = `${system.fontWeight} ${TYPE_SCALE.subhead}px ${system.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = system.heroTextColor;
    ctx.fillText(caption, centerX, height * LAYOUT.captionY);
    ctx.restore();
  }
}

function statCounter(ctx, params, t, width, height, system) {
  const { label, fromValue, toValue, suffix, duration, textFrame } = params;
  const accentColor = params.color || '#FF5C1A';
  const frame = ['card', 'gradient'].includes(textFrame) ? textFrame : 'none';

  const entranceT = clamp01(t / (duration * 0.3));
  const opacity = easeOutCubic(entranceT);
  const yOffset = lerp(20, 0, easeOutBack(clamp01(t / (duration * 0.35))));

  drawContactShadow(ctx, width / 2, height * LAYOUT.contentCenterY + 85, 120, 22, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * LAYOUT.contentCenterY + yOffset);

  if (frame === 'card') {
    ctx.font = `900 ${TYPE_SCALE.hero}px ${system.fontFamily}`;
    const approxWidth = ctx.measureText(`${toValue}${suffix || ''}`).width;
    drawFramingCard(ctx, 0, -6, approxWidth + 72, 178, t, duration, accentColor);
  }

  ctx.save();
  ctx.textAlign = 'center';
  if (system.heroUsesGlow) ctx.shadowColor = accentColor;
  ctx.font = `900 ${TYPE_SCALE.hero}px ${system.fontFamily}`;
  if (frame === 'gradient') {
    const halfWidth = ctx.measureText(`${toValue}${suffix || ''}`).width / 2;
    const grad = ctx.createLinearGradient(-halfWidth, 0, halfWidth, 0);
    grad.addColorStop(0, system.heroTextColor);
    grad.addColorStop(1, accentColor);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = system.heroTextColor;
  }
  drawDigitRoll(ctx, fromValue, toValue, suffix, t, duration, system.heroUsesGlow, 0, -14);
  ctx.restore();

  ctx.font = `500 ${TYPE_SCALE.body}px ${system.fontFamily}`;
  ctx.fillStyle = system.mutedTextColor;
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, 56);
  ctx.restore();
}

function roundRectPathIcon(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

function drawIconPath(ctx, icon, size, options = {}) {
  const s = size;
  ctx.beginPath();
  switch (icon) {
    case 'lock':
      ctx.arc(0, -s * 0.15, s * 0.28, Math.PI, 0, false);
      return { strokeOnly: true, filledBody: () => ctx.fillRect(-s * 0.4, -s * 0.15, s * 0.8, s * 0.55) };
    case 'check':
      ctx.moveTo(-s * 0.35, 0);
      ctx.lineTo(-s * 0.1, s * 0.3);
      ctx.lineTo(s * 0.4, -s * 0.3);
      return { strokeOnly: true };
    case 'clock':
      ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2);
      ctx.moveTo(0, 0); ctx.lineTo(0, -s * 0.28);
      ctx.moveTo(0, 0); ctx.lineTo(s * 0.18, s * 0.08);
      return { strokeOnly: true };
    case 'alert':
      ctx.moveTo(0, -s * 0.4);
      ctx.lineTo(s * 0.4, s * 0.35);
      ctx.lineTo(-s * 0.4, s * 0.35);
      ctx.closePath();
      return { strokeOnly: false };
    case 'spark':
      for (let i = 0; i < 4; i++) {
        const angle = (Math.PI / 2) * i;
        const tipX = Math.cos(angle) * s * 0.45, tipY = Math.sin(angle) * s * 0.45;
        const midAngle = angle + Math.PI / 4;
        const midX = Math.cos(midAngle) * s * 0.12, midY = Math.sin(midAngle) * s * 0.12;
        if (i === 0) ctx.moveTo(tipX, tipY); else ctx.lineTo(tipX, tipY);
        ctx.lineTo(midX, midY);
      }
      ctx.closePath();
      return { strokeOnly: false };
    case 'heart':
      ctx.moveTo(0, s * 0.32);
      ctx.bezierCurveTo(-s * 0.6, -s * 0.15, -s * 0.2, -s * 0.5, 0, -s * 0.15);
      ctx.bezierCurveTo(s * 0.2, -s * 0.5, s * 0.6, -s * 0.15, 0, s * 0.32);
      return { strokeOnly: false };
    case 'chart':
      return { strokeOnly: false, isChart: true };
    case 'watch': {
      ctx.arc(0, 0, s * 0.32, 0, Math.PI * 2);
      // Crown (the little knob on the side used to set the time).
      ctx.moveTo(s * 0.32, -s * 0.06);
      ctx.lineTo(s * 0.42, -s * 0.06);
      ctx.lineTo(s * 0.42, s * 0.06);
      ctx.lineTo(s * 0.32, s * 0.06);
      // Strap lugs, top and bottom.
      ctx.moveTo(-s * 0.14, -s * 0.32);
      ctx.lineTo(s * 0.14, -s * 0.32);
      ctx.moveTo(-s * 0.14, s * 0.32);
      ctx.lineTo(s * 0.14, s * 0.32);
      // Hands, offset like a real clock face (not 12:00, reads as "set").
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -s * 0.18);
      ctx.moveTo(0, 0);
      ctx.lineTo(s * 0.13, s * 0.09);
      return { strokeOnly: true };
    }
    case 'phone': {
      const w = s * 0.42, h = s * 0.68;
      roundRectPathIcon(ctx, -w / 2, -h / 2, w, h, s * 0.1);
      ctx.moveTo(-s * 0.08, s * 0.24);
      ctx.lineTo(s * 0.08, s * 0.24);
      return { strokeOnly: true };
    }
    case 'house': {
      ctx.moveTo(-s * 0.4, s * 0.05);
      ctx.lineTo(0, -s * 0.38);
      ctx.lineTo(s * 0.4, s * 0.05);
      ctx.moveTo(-s * 0.28, -s * 0.02);
      ctx.lineTo(-s * 0.28, s * 0.35);
      ctx.lineTo(s * 0.28, s * 0.35);
      ctx.lineTo(s * 0.28, -s * 0.02);
      ctx.moveTo(-s * 0.08, s * 0.35);
      ctx.lineTo(-s * 0.08, s * 0.12);
      ctx.lineTo(s * 0.1, s * 0.12);
      ctx.lineTo(s * 0.1, s * 0.35);
      return { strokeOnly: true };
    }
    case 'car': {
      // A real template, not one fixed shape - body silhouette varies
      // by style, and an optional badge (actual initials, not a
      // decorative flourish) lets the same base template read as a
      // DIFFERENT specific vehicle depending on what the prompt
      // actually names, instead of every car request producing an
      // identical generic silhouette.
      const bodyStyle = ['sedan', 'suv', 'sports'].includes(options.carBodyStyle) ? options.carBodyStyle : 'sedan';
      if (bodyStyle === 'suv') {
        // Taller cabin, boxier stance.
        ctx.moveTo(-s * 0.44, s * 0.05);
        ctx.lineTo(-s * 0.34, -s * 0.22);
        ctx.lineTo(s * 0.34, -s * 0.22);
        ctx.lineTo(s * 0.44, s * 0.05);
        ctx.lineTo(s * 0.44, s * 0.24);
        ctx.lineTo(-s * 0.44, s * 0.24);
      } else if (bodyStyle === 'sports') {
        // Low, raked, sleeker cabin.
        ctx.moveTo(-s * 0.46, s * 0.14);
        ctx.lineTo(-s * 0.22, -s * 0.06);
        ctx.lineTo(s * 0.22, -s * 0.06);
        ctx.lineTo(s * 0.46, s * 0.14);
        ctx.lineTo(s * 0.46, s * 0.2);
        ctx.lineTo(-s * 0.46, s * 0.2);
      } else {
        // sedan - the original balanced silhouette.
        ctx.moveTo(-s * 0.42, s * 0.1);
        ctx.lineTo(-s * 0.3, -s * 0.12);
        ctx.lineTo(s * 0.3, -s * 0.12);
        ctx.lineTo(s * 0.42, s * 0.1);
        ctx.lineTo(s * 0.42, s * 0.22);
        ctx.lineTo(-s * 0.42, s * 0.22);
      }
      ctx.closePath();
      return { strokeOnly: false, hasCarWheels: true, hasCarBadge: !!options.carBadgeText, carBadgeShape: options.carBadgeShape, carBadgeText: options.carBadgeText };
    }
    case 'gift': {
      const w = s * 0.6, h = s * 0.45;
      ctx.rect(-w / 2, -h / 2 + s * 0.08, w, h);
      ctx.moveTo(0, -h / 2 + s * 0.08);
      ctx.lineTo(0, h / 2 + s * 0.08);
      ctx.moveTo(-w / 2, -s * 0.05);
      ctx.lineTo(w / 2, -s * 0.05);
      // Bow loops on top.
      ctx.moveTo(0, -h / 2 + s * 0.08);
      ctx.bezierCurveTo(-s * 0.05, -h / 2 - s * 0.15, -s * 0.28, -h / 2 - s * 0.1, -s * 0.02, -h / 2 + s * 0.06);
      ctx.moveTo(0, -h / 2 + s * 0.08);
      ctx.bezierCurveTo(s * 0.05, -h / 2 - s * 0.15, s * 0.28, -h / 2 - s * 0.1, s * 0.02, -h / 2 + s * 0.06);
      return { strokeOnly: true };
    }
    case 'trophy': {
      // Cup bowl: two bezier curves from a wide rim narrowing to the
      // neck, mirrored left/right.
      ctx.moveTo(-s * 0.26, -s * 0.32);
      ctx.bezierCurveTo(-s * 0.26, -s * 0.05, -s * 0.12, s * 0.08, 0, s * 0.08);
      ctx.bezierCurveTo(s * 0.12, s * 0.08, s * 0.26, -s * 0.05, s * 0.26, -s * 0.32);
      ctx.closePath();
      // Side handles.
      ctx.moveTo(-s * 0.26, -s * 0.26);
      ctx.bezierCurveTo(-s * 0.42, -s * 0.26, -s * 0.42, -s * 0.02, -s * 0.24, -s * 0.02);
      ctx.moveTo(s * 0.26, -s * 0.26);
      ctx.bezierCurveTo(s * 0.42, -s * 0.26, s * 0.42, -s * 0.02, s * 0.24, -s * 0.02);
      // Stem and base.
      ctx.moveTo(-s * 0.05, s * 0.08);
      ctx.lineTo(-s * 0.05, s * 0.24);
      ctx.lineTo(s * 0.05, s * 0.24);
      ctx.lineTo(s * 0.05, s * 0.08);
      ctx.moveTo(-s * 0.18, s * 0.24);
      ctx.lineTo(s * 0.18, s * 0.24);
      ctx.lineTo(s * 0.14, s * 0.34);
      ctx.lineTo(-s * 0.14, s * 0.34);
      ctx.closePath();
      return { strokeOnly: false };
    }
    case 'rocket': {
      ctx.moveTo(0, -s * 0.45);
      ctx.bezierCurveTo(s * 0.22, -s * 0.15, s * 0.2, s * 0.15, s * 0.13, s * 0.28);
      ctx.lineTo(-s * 0.13, s * 0.28);
      ctx.bezierCurveTo(-s * 0.2, s * 0.15, -s * 0.22, -s * 0.15, 0, -s * 0.45);
      ctx.closePath();
      ctx.moveTo(-s * 0.13, s * 0.15);
      ctx.lineTo(-s * 0.28, s * 0.32);
      ctx.lineTo(-s * 0.1, s * 0.28);
      ctx.moveTo(s * 0.13, s * 0.15);
      ctx.lineTo(s * 0.28, s * 0.32);
      ctx.lineTo(s * 0.1, s * 0.28);
      return { strokeOnly: false, hasWindowCutout: true };
    }
    case 'camera': {
      const w = s * 0.62, h = s * 0.45;
      roundRectPathIcon(ctx, -w / 2, -h / 2 + s * 0.05, w, h, s * 0.06);
      ctx.moveTo(-s * 0.12, -h / 2 + s * 0.05);
      ctx.lineTo(-s * 0.06, -h / 2 - s * 0.06);
      ctx.lineTo(s * 0.1, -h / 2 - s * 0.06);
      ctx.lineTo(s * 0.16, -h / 2 + s * 0.05);
      ctx.moveTo(s * 0.12, s * 0.05);
      ctx.arc(0, s * 0.05, s * 0.14, 0, Math.PI * 2);
      return { strokeOnly: true };
    }
    case 'briefcase': {
      const w = s * 0.62, h = s * 0.4;
      ctx.rect(-w / 2, -h / 2 + s * 0.08, w, h);
      ctx.moveTo(-s * 0.12, -h / 2 + s * 0.08);
      ctx.lineTo(-s * 0.12, -h / 2 - s * 0.04);
      ctx.lineTo(s * 0.12, -h / 2 - s * 0.04);
      ctx.lineTo(s * 0.12, -h / 2 + s * 0.08);
      ctx.moveTo(-w / 2, s * 0.08);
      ctx.lineTo(w / 2, s * 0.08);
      return { strokeOnly: true };
    }
    case 'coffee': {
      ctx.moveTo(-s * 0.22, -s * 0.12);
      ctx.lineTo(-s * 0.18, s * 0.28);
      ctx.lineTo(s * 0.18, s * 0.28);
      ctx.lineTo(s * 0.22, -s * 0.12);
      ctx.closePath();
      ctx.moveTo(s * 0.22, -s * 0.04);
      ctx.bezierCurveTo(s * 0.42, -s * 0.06, s * 0.42, s * 0.14, s * 0.2, s * 0.12);
      ctx.moveTo(-s * 0.12, -s * 0.24);
      ctx.bezierCurveTo(-s * 0.16, -s * 0.34, -s * 0.06, -s * 0.36, -s * 0.1, -s * 0.46);
      ctx.moveTo(s * 0.05, -s * 0.24);
      ctx.bezierCurveTo(s * 0.01, -s * 0.34, s * 0.11, -s * 0.36, s * 0.07, -s * 0.46);
      return { strokeOnly: true };
    }
    case 'money':
    default:
      return { strokeOnly: false, isText: true };
  }
}

function iconCallout(ctx, params, t, width, height, system) {
  const { icon, text } = params;
  // Defensive default, not just at the dash-offset call site - a
  // missing/undefined duration here cascades into NaN through every
  // clamp01(t/duration) below, and NaN reaching this Skia binding's
  // line-dash implementation crashes the whole render natively rather
  // than failing softly. This should never actually be undefined in
  // real usage (validateSceneJSON always fills it in first), but the
  // render function itself shouldn't depend on that being true to
  // stay alive.
  const duration = Number.isFinite(params.duration) && params.duration > 0 ? params.duration : 2.2;
  const accentColor = params.color || '#FF5C1A';

  const drawT = clamp01(t / (duration * 0.4));
  const opacity = easeOutCubic(clamp01(t / (duration * 0.25)));
  const popScale = easeOutBack(clamp01(t / (duration * 0.4)));

  // iconCallout draws its own icon in place of a separate hero visual
  // (see TEMPLATES_WITH_OWN_ICON in renderEngine.js) - it's the ONLY
  // visual in this beat, so it gets real hero-scale size, not the small
  // ~70px treatment a decorative icon would get.
  const iconCenterY = height * LAYOUT.heroPositionY + 20;
  drawContactShadow(ctx, width / 2, iconCenterY + 100, 60, 16, opacity * 0.35);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, iconCenterY);
  ctx.scale(popScale, popScale);
  if (system.heroUsesGlow) {
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 18;
  }
  const size = 150;
  const iconShade = buildShadeGradient(ctx, accentColor, -size * 0.55, -size * 0.55, size * 0.55, size * 0.55);
  ctx.strokeStyle = iconShade;
  ctx.fillStyle = iconShade;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (icon === 'money') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(size * 0.9)}px ${system.fontFamily}`;
    ctx.globalAlpha = opacity * drawT;
    ctx.fillText('$', 0, size * 0.05);
  } else if (icon === 'chart') {
    const bars = [
      { x: -size * 0.35, h: size * 0.5 },
      { x: -size * 0.09, h: size * 0.7 },
      { x: size * 0.17, h: size * 0.85 },
    ];
    bars.forEach((bar, i) => {
      const barT = clamp01((drawT - i * 0.15) / 0.5);
      const h = bar.h * easeOutCubic(barT);
      ctx.fillRect(bar.x, size * 0.4 - h, size * 0.18, h);
    });
  } else {
    const shape = drawIconPath(ctx, icon, size, { carBodyStyle: params.carBodyStyle, carBadgeText: params.carBadgeText, carBadgeShape: params.carBadgeShape });
    if (shape.strokeOnly !== undefined) {
      const approxLength = size * 4;
      // Real hardening, not just a debug print: a missing/NaN duration
      // anywhere upstream used to cascade into a NaN dash-offset,
      // which crashes this Skia binding outright (a native "Make line
      // dash path effect failed" error) instead of failing gracefully.
      // Confirmed directly by forcing this exact condition. Falling
      // back to a safe default here means malformed input degrades to
      // a static icon instead of taking down the whole render.
      const safeDrawT = Number.isFinite(drawT) ? drawT : 1;
      ctx.setLineDash([approxLength]);
      ctx.lineDashOffset = approxLength * (1 - easeOutCubic(safeDrawT));
      if (!shape.strokeOnly) ctx.globalAlpha = opacity * safeDrawT;
      ctx.stroke();
      if (!shape.strokeOnly) ctx.fill();
      ctx.setLineDash([]);
      if (shape.filledBody && drawT > 0.6) {
        ctx.globalAlpha = opacity * clamp01((drawT - 0.6) / 0.4);
        shape.filledBody();
      }
      if (icon === 'alert' && drawT > 0.5) {
        ctx.globalAlpha = clamp01((drawT - 0.5) / 0.3);
        ctx.fillStyle = system.bgColorInner;
        ctx.fillRect(-size * 0.05, -size * 0.15, size * 0.1, size * 0.25);
        ctx.beginPath();
        ctx.arc(0, size * 0.22, size * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
      if (shape.hasWindowCutout && drawT > 0.5) {
        ctx.globalAlpha = clamp01((drawT - 0.5) / 0.3);
        ctx.fillStyle = system.bgColorInner;
        ctx.beginPath();
        ctx.arc(0, -size * 0.1, size * 0.08, 0, Math.PI * 2);
        ctx.fill();
      }
      if (shape.hasCarWheels && drawT > 0.5) {
        const wheelAlpha = clamp01((drawT - 0.5) / 0.3);
        [-size * 0.22, size * 0.22].forEach((wx) => {
          ctx.globalAlpha = wheelAlpha;
          ctx.fillStyle = system.bgColorInner;
          ctx.beginPath();
          ctx.arc(wx, size * 0.22, size * 0.1, 0, Math.PI * 2);
          ctx.fill();
          // Bright rim so the wheel reads as a distinct wheel, not just
          // a hole punched in the body.
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }
      if (shape.hasCarBadge && drawT > 0.6) {
        // A real emblem with actual initials, not decoration - this is
        // the whole point: the SAME car template reads as a different
        // specific vehicle depending on what text gets stamped here.
        const badgeAlpha = clamp01((drawT - 0.6) / 0.4);
        ctx.globalAlpha = badgeAlpha;
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
    }
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.font = `600 ${TYPE_SCALE.subhead}px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  wrapText(ctx, text, width / 2, height * LAYOUT.contentCenterY + 40, width * 0.78, 50);
  ctx.restore();
}

function shapeReveal(ctx, params, t, width, height, system) {
  const { shape, motion, duration } = params;
  const color = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(entranceT);
  let scale = easeOutBack(entranceT);

  const holdT = clamp01((t - duration * 0.35) / (duration * 0.65));
  let squashX = 1, squashY = 1;
  if (motion === 'pulse') {
    const pulse = Math.sin(holdT * Math.PI * 2) * 0.06;
    squashX = 1 + pulse; squashY = 1 - pulse * 0.6;
  } else if (motion === 'grow') {
    scale *= lerp(1, 1.4, easeOutCubic(holdT));
  }

  drawContactShadow(ctx, width / 2, height * LAYOUT.contentCenterY + 150, 95 * scale, 20, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  if (system.heroUsesGlow) {
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = color;
    ctx.shadowBlur = 35;
  }
  ctx.translate(width / 2, height * LAYOUT.contentCenterY);
  ctx.scale(scale * squashX, scale * squashY);
  ctx.fillStyle = buildShadeGradient(ctx, color, -135, -135, 135, 135);

  if (shape === 'square') {
    ctx.fillRect(-125, -125, 250, 250);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 135, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, startY + i * lineHeight));
}

module.exports = { drawBeatContent, drawIconPath };

/**
 * Slot-machine / odometer style digit roll - each digit position locks
 * in independently, left to right, with a rapid cycling spin before
 * settling and a small punch-scale bounce on landing. This is the
 * actual visual mechanic the original craft notes called for ("like a
 * slot machine settling") - previously only the EASING matched that
 * description, never the digit behavior itself. Digit width is fixed
 * from the FINAL string from frame one, so digits don't reflow as
 * they lock in - a real mechanical counter's slots don't resize while
 * spinning.
 */
function drawDigitRoll(ctx, fromValue, toValue, suffix, t, duration, useGlow, baseX, baseY) {
  const finalStr = String(Math.round(toValue));
  const isNegative = finalStr.startsWith('-');
  const digitsStr = isNegative ? finalStr.slice(1) : finalStr;
  const numDigits = digitsStr.length;

  const countWindowEnd = duration * 0.55;
  const fullFinalText = `${finalStr}${suffix || ''}`;
  const totalWidth = ctx.measureText(fullFinalText).width;
  let cursorX = baseX - totalWidth / 2;
  const baseAlpha = ctx.globalAlpha;

  if (isNegative) {
    const w = ctx.measureText('-').width;
    ctx.fillText('-', cursorX + w / 2, baseY);
    cursorX += w;
  }

  for (let i = 0; i < numDigits; i++) {
    const finalDigit = digitsStr[i];
    const digitLockT = lerp(0, countWindowEnd, (i + 1) / numDigits);
    const digitStartT = Math.max(0, lerp(0, countWindowEnd, i / numDigits) - duration * 0.05);
    const localT = clamp01((t - digitStartT) / Math.max(0.01, digitLockT - digitStartT));

    const w = ctx.measureText(finalDigit).width;
    const dx = cursorX + w / 2;

    let displayChar = finalDigit;
    let vOffset = 0;
    let digitOpacity = 1;
    let digitGlow = 0;
    let digitScale = 1;

    if (t < digitStartT) {
      digitOpacity = 0;
    } else if (localT < 1) {
      const cycleIndex = Math.floor((t - digitStartT) * 14 + i * 3) % 10;
      displayChar = String(cycleIndex);
      vOffset = Math.sin((t - digitStartT) * 30) * 2;
      digitOpacity = 0.85;
    } else {
      const settleT = clamp01((t - digitLockT) / (duration * 0.15));
      digitScale = lerp(1.25, 1, easeOutBack(settleT));
      // Was a permanent resting glow (lerp down to 12, never to 0) -
      // meaning every digit kept paying per-frame shadowBlur cost for
      // the rest of the scene after settling, not just during the
      // brief settle beat itself. Now fades fully to 0 once settled,
      // cutting sustained per-frame cost for the remainder of the
      // scene while keeping the actual landing punch untouched.
      digitGlow = useGlow ? lerp(30, 0, Math.min(1, settleT * 1.6)) : 0;
    }

    if (digitOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = baseAlpha * digitOpacity;
      ctx.shadowBlur = digitGlow;
      ctx.translate(dx, baseY + vOffset);
      ctx.scale(digitScale, digitScale);
      ctx.fillText(displayChar, 0, 0);
      ctx.restore();
    }
    cursorX += w;
  }

  if (suffix) {
    const suffixOpacity = easeOutCubic(clamp01((t - countWindowEnd) / (duration * 0.1)));
    ctx.save();
    ctx.globalAlpha = baseAlpha * suffixOpacity;
    ctx.shadowBlur = 0;
    ctx.fillText(suffix, cursorX + ctx.measureText(suffix).width / 2, baseY);
    ctx.restore();
  }
}
