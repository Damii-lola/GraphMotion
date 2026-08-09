const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');
const { drawAtmosphere } = require('./atmosphere');
const { drawComposition } = require('./sceneComposition');

/**
 * FLAIR RULES v3 - v2 added polish (glow/grain/shadow/stagger) to a
 * composition that was still structurally ONE element alone on
 * screen. That was the real problem, and polish never fixes a
 * structural problem. v3's actual fix: drawComposition() below
 * GUARANTEES a background motif + corner tag + secondary accent
 * shape on every single scene, before the hero content ever draws -
 * it is now structurally impossible to render "one lonely thing
 * again," and hero content is positioned off dead-center (rule of
 * thirds) instead of always centered.
 */

/**
 * Fallback only - used if a scene somehow arrives without a tag
 * (shouldn't happen now that sceneTemplates.js gives every template a
 * defaulted "tag" param, but a hardcoded default here doesn't hurt).
 */
const FALLBACK_TAGS = {
  kineticTextReveal: 'INSIGHT',
  rippleDrop: 'ALERT',
  statCounter: 'DATA',
  iconCallout: 'NOTE',
  shapeReveal: 'FOCUS',
};

function drawTemplate(ctx, template, params, localTime, globalT, width, height) {
  const accentColor = params.color || '#FF5C1A';
  const tag = params.tag || FALLBACK_TAGS[template] || 'INSIGHT';
  const accentShape = params.accentShape || 'bracket';

  drawAtmosphere(ctx, globalT, width, height, accentColor);
  applyCameraPush(ctx, globalT, width, height);
  drawComposition(ctx, tag, accentShape, localTime, params.duration, globalT, width, height, accentColor);

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

  ctx.restore(); // matches the save() in applyCameraPush
}

/**
 * A near-imperceptible continuous zoom (1.0 -> ~1.035 over 20s, then
 * loops) applied as a transform around the canvas center before any
 * content draws. This alone was named as "the single biggest missing
 * ingredient" in the notes - a video where nothing ever looks static
 * because the camera never stops moving, even subtly.
 */
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

/**
 * Character-level staggered reveal, replacing the old single-block
 * fade+scale. Each character gets its own entrance offset in time (a
 * "stagger") so the line assembles with a ripple instead of switching
 * on as one flat unit - directly the #1 typography note.
 */
function kineticTextReveal(ctx, params, t, width, height) {
  const { text, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  ctx.font = 'bold 50px sans-serif';
  const words = text.split(' ');
  const lineHeight = 58;

  // Wrap into lines first (measuring against a max width), same
  // constraint as before, but now we need per-CHARACTER positions
  // rather than just per-line, so layout happens before animation.
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

  // Flatten to characters with their target (x, y) so we can stagger
  // each one's entrance independently.
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

  const staggerWindow = duration * 0.4; // all characters finish entering by 40% of scene duration
  const perCharDelay = chars.length > 1 ? staggerWindow / chars.length : 0;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const c of chars) {
    const charStart = c.index * perCharDelay;
    const charT = clamp01((t - charStart) / (duration * 0.28));
    if (charT <= 0) continue;

    const opacity = easeOutCubic(charT);
    const scale = lerp(1.4, 1, easeOutBack(charT));
    // Tiny per-character vertical offset ("baseline jitter") so the
    // line reads as handmade rather than a perfectly uniform grid.
    const jitter = Math.sin(c.index * 12.9898) * 1.5;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(c.x, c.y + jitter);
    ctx.scale(scale, scale);
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = lerp(0, 16, clamp01((t - charStart - duration * 0.15) / (duration * 0.2)));
    ctx.fillStyle = '#F5F5F5';
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
}

function rippleDrop(ctx, params, t, width, height) {
  const { caption, duration } = params;
  const color = params.color || '#FF5C1A';

  const centerX = width / 2;
  const landY = height * 0.38;
  const startY = height * 0.18;

  const dropT = clamp01(t / (duration * 0.55));
  const y = lerp(startY, landY, easeOutCubic(dropT));

  // Squash/stretch on impact: right at landing, the ball briefly
  // flattens (wide, short) then springs back to round - implies mass
  // and impact instead of a rigid circle just stopping.
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
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
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
  ctx.globalCompositeOperation = 'screen';
  ctx.shadowColor = color;
  ctx.shadowBlur = 30;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
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
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.3));
  const opacity = easeOutCubic(entranceT);
  const yOffset = lerp(20, 0, easeOutBack(clamp01(t / (duration * 0.35))));

  const countT = clamp01(t / (duration * 0.55));
  const current = Math.round(lerp(fromValue, toValue, easeOutExpo(countT)));

  // Overshoot-punch on landing: the final number briefly scales past
  // 100% then eases back, so it "hits" instead of just arriving -
  // directly the notes' counter-finale note.
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
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = landedGlow;
  ctx.font = '900 76px sans-serif';
  ctx.fillStyle = '#F5F5F5';
  ctx.fillText(`${current}${suffix}`, 0, -10);
  ctx.restore();

  ctx.font = '500 26px sans-serif';
  ctx.fillStyle = '#B5B5B8';
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, 40);
  ctx.restore();
}

/**
 * Icons are hand-drawn vector paths (not fonts - see earlier fix) and
 * now draw themselves on via an animated stroke offset where the icon
 * is stroke-based, rather than popping in at full opacity/scale. This
 * is the canvas equivalent of an AE trim-paths reveal.
 */
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

function iconCallout(ctx, params, t, width, height) {
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
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = 18;
  ctx.strokeStyle = accentColor;
  ctx.fillStyle = accentColor;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const size = 70;
  if (icon === 'money') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(size * 0.9)}px sans-serif`;
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
      // Alert's exclamation mark is carved out after the triangle
      // fills in - lost in an earlier pass of this rewrite, restored
      // here as its own follow-up draw once the triangle is mostly in.
      if (icon === 'alert' && drawT > 0.5) {
        ctx.globalAlpha = clamp01((drawT - 0.5) / 0.3);
        ctx.fillStyle = '#08080A';
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
  ctx.font = '600 32px sans-serif';
  ctx.fillStyle = '#F5F5F5';
  wrapText(ctx, text, width / 2, height * 0.42 + 20, width * 0.75, 40);
  ctx.restore();
}

function shapeReveal(ctx, params, t, width, height) {
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
  ctx.globalCompositeOperation = 'screen';
  ctx.shadowColor = color;
  ctx.shadowBlur = 35;
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
