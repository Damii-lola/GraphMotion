const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');
const { drawAtmosphere } = require('./atmosphere');
const { drawComposition } = require('./sceneComposition');
const { getVisualSystem } = require('./visualSystems');

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
};

function drawTemplate(ctx, template, params, localTime, globalT, width, height, sceneIndex, sceneCount, visualSystemName) {
  const accentColor = params.color || '#FF5C1A';
  const tag = params.tag || FALLBACK_TAGS[template] || 'INSIGHT';
  const accentShape = params.accentShape || 'bracket';
  const system = getVisualSystem(visualSystemName);

  drawAtmosphere(ctx, globalT, width, height, accentColor, system);
  applyCameraPush(ctx, globalT, width, height);
  drawComposition(ctx, tag, accentShape, localTime, params.duration, globalT, width, height, accentColor, sceneIndex, sceneCount, system);

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
    default:
      throw new Error(`No renderer implemented for template "${template}"`);
  }

  ctx.restore(); // matches the save() in applyCameraPush
}

function applyCameraPush(ctx, globalT, width, height) {
  ctx.save();
  const cycle = (globalT % 20) / 20;
  const scale = lerp(1, 1.035, easeInOutCubic(Math.sin(cycle * Math.PI * 2) * 0.5 + 0.5));
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-width / 2, -height / 2);
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
  const { text, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  ctx.font = `${system.fontWeight} 50px ${system.fontFamily}`;
  const words = text.split(' ');
  const lineHeight = 58;

  const maxWidth = width * 0.82;
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

  const totalHeight = lines.length * lineHeight;
  const startY = height * 0.42 - totalHeight / 2 + lineHeight / 2;

  const chars = [];
  lines.forEach((line, li) => {
    const lineWidth = ctx.measureText(line).width;
    let cx = width / 2 - lineWidth / 2;
    const cy = startY + li * lineHeight;
    for (const ch of line) {
      const w = ctx.measureText(ch).width;
      chars.push({ ch, x: cx + w / 2, y: cy, index: chars.length });
      cx += w;
    }
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

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(c.x, c.y + jitter);
    ctx.scale(scale, scale);
    if (system.heroUsesGlow) {
      ctx.shadowColor = accentColor;
      ctx.shadowBlur = lerp(0, 16, clamp01((t - charStart - duration * 0.15) / (duration * 0.2)));
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

  const countT = clamp01(t / (duration * 0.55));
  const current = Math.round(lerp(fromValue, toValue, easeOutExpo(countT)));

  const landT = clamp01((t - duration * 0.55) / (duration * 0.2));
  const punchScale = countT >= 1 ? lerp(1.15, 1, easeOutBack(landT)) : 1;
  const landedGlow = countT >= 1 ? lerp(0, 28, landT) : 0;

  drawContactShadow(ctx, width / 2, height * 0.42 + 60, 90, 18, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.42 + yOffset);

  ctx.save();
  ctx.scale(punchScale, punchScale);
  ctx.textAlign = 'center';
  if (system.heroUsesGlow) {
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = landedGlow;
  }
  ctx.font = `900 76px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  ctx.fillText(`${current}${suffix}`, 0, -10);
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
