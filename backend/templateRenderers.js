const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');
const { getVisualSystem } = require('./visualSystems');
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
  const { text, duration, style, textFrame } = params;
  const accentColor = params.color || '#FF5C1A';
  const isMixedWeight = style === 'mixed-weight';
  // Real per-beat framing variety, not the same flat-glow treatment
  // every time - direct response to reference feedback ("sometimes
  // the box containing text changes, sometimes the color changes
  // with a gradient"). 'none' keeps the exact original look.
  const frame = ['card', 'gradient'].includes(textFrame) ? textFrame : 'none';

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

  const baseFontSize = 50;
  const emphasisFontSize = 66;
  const lineHeight = 58;
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
  const startY = height * 0.42 - totalHeight / 2 + lineHeight / 2;

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
        chars.push({ ch, x: cx + w / 2, y: cy, index: chars.length, fontSize, isEmphasis: wordIndex === emphasisWordIndex });
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
    const cardT = easeOutCubic(clamp01(t / (duration * 0.3)));
    const cardWidth = lerp(0, maxX - minX, cardT);
    ctx.save();
    ctx.globalAlpha = cardT * 0.14;
    ctx.fillStyle = accentColor;
    const cx = (minX + maxX) / 2;
    ctx.beginPath();
    const r = 14;
    const cw = cardWidth, ch2 = maxY - minY;
    ctx.moveTo(cx - cw / 2 + r, minY);
    ctx.arcTo(cx + cw / 2, minY, cx + cw / 2, minY + r, r);
    ctx.arcTo(cx + cw / 2, maxY, cx + cw / 2 - r, maxY, r);
    ctx.arcTo(cx - cw / 2, maxY, cx - cw / 2, maxY - r, r);
    ctx.arcTo(cx - cw / 2, minY, cx - cw / 2 + r, minY, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = accentColor;
    ctx.globalAlpha = cardT * 0.5;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
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
    const jitter = Math.sin(c.index * 12.9898) * 1.5;

    ctx.font = `${system.fontWeight} ${c.fontSize}px ${system.fontFamily}`;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(c.x, c.y + jitter);
    ctx.scale(scale, scale);
    if (system.heroUsesGlow) {
      ctx.shadowColor = accentColor;
      // Emphasis word glows a bit brighter, reinforcing the size
      // hierarchy instead of every character getting identical glow.
      ctx.shadowBlur = lerp(0, c.isEmphasis ? 24 : 16, clamp01((t - charStart - duration * 0.15) / (duration * 0.2)));
    }
    ctx.fillStyle = gradientFill || system.heroTextColor;
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

function rippleDrop(ctx, params, t, width, height, system) {
  const { caption, duration } = params;
  const color = params.color || '#FF5C1A';

  const centerX = width / 2;
  const landY = height * 0.38;
  const startY = height * 0.18;

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
    ctx.font = `${system.fontWeight} 34px ${system.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = system.heroTextColor;
    ctx.fillText(caption, centerX, height * 0.62);
    ctx.restore();
  }
}

function statCounter(ctx, params, t, width, height, system) {
  const { label, fromValue, toValue, suffix, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.3));
  const opacity = easeOutCubic(entranceT);
  const yOffset = lerp(20, 0, easeOutBack(clamp01(t / (duration * 0.35))));

  drawContactShadow(ctx, width / 2, height * 0.42 + 60, 90, 18, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.42 + yOffset);

  ctx.save();
  ctx.textAlign = 'center';
  if (system.heroUsesGlow) ctx.shadowColor = accentColor;
  ctx.font = `900 76px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  drawDigitRoll(ctx, fromValue, toValue, suffix, t, duration, system.heroUsesGlow, 0, -10);
  ctx.restore();

  ctx.font = `500 26px ${system.fontFamily}`;
  ctx.fillStyle = system.mutedTextColor;
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, 40);
  ctx.restore();
}

function roundRectPathIcon(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

function drawIconPath(ctx, icon, size) {
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
      ctx.moveTo(-s * 0.42, s * 0.1);
      ctx.lineTo(-s * 0.3, -s * 0.12);
      ctx.lineTo(s * 0.3, -s * 0.12);
      ctx.lineTo(s * 0.42, s * 0.1);
      ctx.lineTo(s * 0.42, s * 0.22);
      ctx.lineTo(-s * 0.42, s * 0.22);
      ctx.closePath();
      return { strokeOnly: false, hasCarWheels: true };
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
  const { icon, text, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const drawT = clamp01(t / (duration * 0.4));
  const opacity = easeOutCubic(clamp01(t / (duration * 0.25)));
  const popScale = easeOutBack(clamp01(t / (duration * 0.4)));

  drawContactShadow(ctx, width / 2, height * 0.42 - 20, 44, 12, opacity * 0.35);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.42 - 60);
  ctx.scale(popScale, popScale);
  if (system.heroUsesGlow) {
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 18;
  }
  ctx.strokeStyle = accentColor;
  ctx.fillStyle = accentColor;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const size = 70;
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
    const shape = drawIconPath(ctx, icon, size);
    if (shape.strokeOnly !== undefined) {
      const approxLength = size * 4;
      ctx.setLineDash([approxLength]);
      ctx.lineDashOffset = approxLength * (1 - easeOutCubic(drawT));
      if (!shape.strokeOnly) ctx.globalAlpha = opacity * drawT;
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
    }
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.font = `600 32px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  wrapText(ctx, text, width / 2, height * 0.42 + 20, width * 0.75, 40);
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

  drawContactShadow(ctx, width / 2, height * 0.42 + 110, 70 * scale, 16, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  if (system.heroUsesGlow) {
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = color;
    ctx.shadowBlur = 35;
  }
  ctx.fillStyle = color;
  ctx.translate(width / 2, height * 0.42);
  ctx.scale(scale * squashX, scale * squashY);

  if (shape === 'square') {
    ctx.fillRect(-90, -90, 180, 180);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 100, 0, Math.PI * 2);
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
