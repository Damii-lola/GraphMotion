const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');

/**
 * ---------------------------------------------------------------
 * ARCHITECTURE: each template is a pure function of TIME, not a
 * generator/sequence like the old Revideo version. Given (ctx, params,
 * localTime, duration, width, height), it must compute and draw
 * exactly what the frame should look like AT THAT INSTANT. This is
 * the fundamental adaptation needed to move off a browser-based
 * animation engine onto a plain canvas we drive frame-by-frame
 * ourselves.
 *
 * FLAIR RULES (unchanged from the original design, engine-independent):
 *   1. Multi-property choreography, never a single opacity fade.
 *   2. Overshoot/spring easing on entrances, never linear.
 *   3. A secondary "settle" motion after the primary motion lands.
 * ---------------------------------------------------------------
 */

function drawTemplate(ctx, template, params, localTime, width, height) {
  switch (template) {
    case 'kineticTextReveal':
      kineticTextReveal(ctx, params, localTime, width, height);
      break;
    case 'rippleDrop':
      rippleDrop(ctx, params, localTime, width, height);
      break;
    case 'statCounter':
      statCounter(ctx, params, localTime, width, height);
      break;
    case 'iconCallout':
      iconCallout(ctx, params, localTime, width, height);
      break;
    case 'shapeReveal':
      shapeReveal(ctx, params, localTime, width, height);
      break;
    default:
      throw new Error(`No renderer implemented for template "${template}"`);
  }
}

function clearBackground(ctx, width, height) {
  ctx.fillStyle = '#0A0A0B';
  ctx.fillRect(0, 0, width, height);
}

function kineticTextReveal(ctx, params, t, width, height) {
  const { text, duration } = params;
  clearBackground(ctx, width, height);

  const entranceT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(entranceT);
  const scaleT = clamp01(t / (duration * 0.45));
  const scale = lerp(1.35, 1, easeOutBack(scaleT));

  // Secondary motion: glow ramps in AFTER the text has mostly landed,
  // then pulses gently while held on screen.
  const glowStartT = duration * 0.25;
  const glowT = clamp01((t - glowStartT) / (duration * 0.25));
  const baseGlow = lerp(0, 30, easeOutExpo(glowT));
  const pulse = t > duration * 0.5 ? Math.sin((t - duration * 0.5) * 3) * 6 : 0;
  const glow = Math.max(0, baseGlow + pulse);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);

  ctx.font = 'bold 52px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#FF5C1A';
  ctx.shadowBlur = glow;
  ctx.fillStyle = '#F5F5F5';

  wrapText(ctx, text, 0, 0, width * 0.8, 60);
  ctx.restore();
}

function rippleDrop(ctx, params, t, width, height) {
  const { caption, color, duration } = params;
  clearBackground(ctx, width, height);

  const centerX = width / 2;
  const landY = height * 0.38;
  const startY = height * 0.18;

  const dropT = clamp01(t / (duration * 0.55));
  const y = lerp(startY, landY, easeOutCubic(dropT));

  // Ripple rings fire once the ball lands.
  if (dropT >= 1) {
    const rippleT = (t - duration * 0.55) / (duration * 0.45);
    for (let ring = 0; ring < 3; ring++) {
      const ringT = clamp01(rippleT - ring * 0.15);
      if (ringT <= 0) continue;
      const radius = lerp(30, 150, ringT);
      const alpha = (1 - ringT) * 0.4;
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(centerX, landY, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.shadowColor = color;
  ctx.shadowBlur = 30;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(centerX, y, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (caption) {
    const captionT = clamp01((t - duration * 0.5) / (duration * 0.3));
    ctx.save();
    ctx.globalAlpha = easeOutCubic(captionT);
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F5F5F5';
    ctx.fillText(caption, centerX, height * 0.62);
    ctx.restore();
  }
}

function statCounter(ctx, params, t, width, height) {
  const { label, fromValue, toValue, suffix, duration } = params;
  clearBackground(ctx, width, height);

  const entranceT = clamp01(t / (duration * 0.3));
  const opacity = easeOutCubic(entranceT);
  const yOffset = lerp(20, 0, easeOutBack(clamp01(t / (duration * 0.35))));

  const countT = clamp01((t - 0) / (duration * 0.55));
  const current = Math.round(lerp(fromValue, toValue, easeOutExpo(countT)));

  const landedGlow = countT >= 1 ? lerp(0, 25, clamp01((t - duration * 0.55) / (duration * 0.15))) : 0;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height / 2 + yOffset);

  ctx.textAlign = 'center';
  ctx.shadowColor = '#FF5C1A';
  ctx.shadowBlur = landedGlow;
  ctx.font = '900 76px sans-serif';
  ctx.fillStyle = '#F5F5F5';
  ctx.fillText(`${current}${suffix}`, 0, -10);

  ctx.shadowBlur = 0;
  ctx.font = '500 26px sans-serif';
  ctx.fillStyle = '#B5B5B8';
  ctx.fillText(label, 0, 40);
  ctx.restore();
}

/**
 * Icons are hand-drawn vector shapes, NOT font glyphs/emoji. This is
 * deliberate: a bare Linux render server has no emoji font installed
 * by default (unlike a browser, which bundles its own) - confirmed by
 * actually rendering a test frame and seeing a missing-glyph box
 * instead of a lock icon. Drawing paths ourselves guarantees identical
 * output regardless of what fonts happen to be installed on whatever
 * box this runs on.
 */
function drawIcon(ctx, icon, size) {
  const s = size;
  ctx.save();
  ctx.lineWidth = s * 0.1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (icon) {
    case 'lock': {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath();
      ctx.arc(0, -s * 0.15, s * 0.28, Math.PI, 0, false);
      ctx.stroke();
      ctx.fillRect(-s * 0.4, -s * 0.15, s * 0.8, s * 0.55);
      break;
    }
    case 'check': {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath();
      ctx.moveTo(-s * 0.35, 0);
      ctx.lineTo(-s * 0.1, s * 0.3);
      ctx.lineTo(s * 0.4, -s * 0.3);
      ctx.stroke();
      break;
    }
    case 'alert': {
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.4);
      ctx.lineTo(s * 0.4, s * 0.35);
      ctx.lineTo(-s * 0.4, s * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0A0A0B';
      ctx.fillRect(-s * 0.05, -s * 0.15, s * 0.1, s * 0.25);
      ctx.beginPath();
      ctx.arc(0, s * 0.22, s * 0.05, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'spark': {
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const angle = (Math.PI / 2) * i;
        const tipX = Math.cos(angle) * s * 0.45;
        const tipY = Math.sin(angle) * s * 0.45;
        const midAngle = angle + Math.PI / 4;
        const midX = Math.cos(midAngle) * s * 0.12;
        const midY = Math.sin(midAngle) * s * 0.12;
        if (i === 0) ctx.moveTo(tipX, tipY);
        else ctx.lineTo(tipX, tipY);
        ctx.lineTo(midX, midY);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'clock': {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -s * 0.28);
      ctx.moveTo(0, 0);
      ctx.lineTo(s * 0.18, s * 0.08);
      ctx.stroke();
      break;
    }
    case 'heart': {
      ctx.beginPath();
      ctx.moveTo(0, s * 0.32);
      ctx.bezierCurveTo(-s * 0.6, -s * 0.15, -s * 0.2, -s * 0.5, 0, -s * 0.15);
      ctx.bezierCurveTo(s * 0.2, -s * 0.5, s * 0.6, -s * 0.15, 0, s * 0.32);
      ctx.fill();
      break;
    }
    case 'chart': {
      ctx.fillRect(-s * 0.35, -s * 0.1, s * 0.18, s * 0.5);
      ctx.fillRect(-s * 0.09, -s * 0.3, s * 0.18, s * 0.7);
      ctx.fillRect(s * 0.17, -s * 0.45, s * 0.18, s * 0.85);
      break;
    }
    case 'money':
    default: {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(s * 0.9)}px sans-serif`;
      ctx.fillText('$', 0, s * 0.05);
      break;
    }
  }
  ctx.restore();
}

function iconCallout(ctx, params, t, width, height) {
  const { icon, text, duration } = params;
  clearBackground(ctx, width, height);

  const entranceT = clamp01(t / (duration * 0.4));
  const opacity = easeOutCubic(clamp01(t / (duration * 0.3)));
  const scale = easeOutBack(entranceT);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height / 2 - 60);
  ctx.scale(scale, scale);
  ctx.shadowColor = '#FF5C1A';
  ctx.shadowBlur = 20;
  ctx.fillStyle = '#FF5C1A';
  drawIcon(ctx, icon, 70);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.font = '600 32px sans-serif';
  ctx.fillStyle = '#F5F5F5';
  wrapText(ctx, text, width / 2, height / 2 + 20, width * 0.75, 40);
  ctx.restore();
}

function shapeReveal(ctx, params, t, width, height) {
  const { shape, motion, color, duration } = params;
  clearBackground(ctx, width, height);

  const entranceT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(entranceT);
  let scale = easeOutBack(entranceT);

  const holdT = clamp01((t - duration * 0.35) / (duration * 0.65));
  if (motion === 'pulse') {
    scale *= 1 + Math.sin(holdT * Math.PI * 2) * 0.06;
  } else if (motion === 'grow') {
    scale *= lerp(1, 1.4, easeOutCubic(holdT));
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = 'screen';
  ctx.shadowColor = color;
  ctx.shadowBlur = 35;
  ctx.fillStyle = color;
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);

  if (shape === 'square') {
    ctx.fillRect(-90, -90, 180, 180);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 100, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Simple word-wrap helper shared by templates that render body text. */
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
  lines.forEach((line, i) => {
    ctx.fillText(line, x, startY + i * lineHeight);
  });
}

module.exports = { drawTemplate };
