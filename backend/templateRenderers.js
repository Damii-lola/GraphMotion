const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');
const { drawAtmosphere } = require('./atmosphere');
const { drawComposition } = require('./sceneComposition');
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

function drawTemplate(ctx, template, params, localTime, globalT, width, height, sceneIndex, sceneCount, visualSystemName, secondaryColor) {
  const accentColor = params.color || '#FF5C1A';
  const tag = params.tag || FALLBACK_TAGS[template] || 'INSIGHT';
  const accentShape = params.accentShape || 'bracket';
  const system = getVisualSystem(visualSystemName);

  drawAtmosphere(ctx, globalT, width, height, accentColor, system);
  applyCameraPush(ctx, localTime, params.duration, params.cameraStyle, width, height);
  drawComposition(ctx, tag, accentShape, localTime, params.duration, globalT, width, height, accentColor, sceneIndex, sceneCount, system, secondaryColor);

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

  ctx.restore(); // matches the save() in applyCameraPush
}

function applyCameraPush(ctx, localTime, duration, cameraStyle, width, height) {
  ctx.save();
  let scale;

  if (cameraStyle === 'punchIn') {
    // Accelerating push-in across the whole scene - energy building
    // toward whatever lands at the end (a stat, a number, a reveal).
    const t = clamp01(localTime / Math.max(duration, 0.01));
    scale = lerp(1, 1.08, t * t);
  } else if (cameraStyle === 'settle') {
    // Starts slightly zoomed in (as if just landing from a hard cut)
    // and settles back to rest quickly - a "camera catching its
    // breath" beat, distinct from a continuous drift.
    const t = clamp01(localTime / (duration * 0.3));
    scale = lerp(1.06, 1, easeOutCubic(t));
  } else {
    // slowDrift (default): a gentle continuous breathing motion
    // within the scene, not a global cycle spanning the whole video -
    // each scene gets its own subtle drift instead of the camera
    // being on a fixed clock unrelated to scene boundaries.
    const cycle = clamp01(localTime / Math.max(duration, 0.01));
    scale = lerp(1, 1.03, easeInOutCubic(Math.sin(cycle * Math.PI) ));
  }

  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-width / 2, -height / 2);
  return ctx;
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
  const { text, duration, style } = params;
  const accentColor = params.color || '#FF5C1A';
  const isMixedWeight = style === 'mixed-weight';

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
    ctx.fillStyle = system.heroTextColor;
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

module.exports = { drawTemplate };

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
      digitGlow = useGlow ? lerp(30, 12, settleT) : 0;
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
