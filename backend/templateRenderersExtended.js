const { easeOutCubic, easeOutBack, easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');

/**
 * Four new templates, each chosen to unlock a genuinely different
 * CONTENT STRUCTURE, not just a new skin on the same "text pops in"
 * idea - a comparison, a build-up list, a stylized quote, and a
 * progress/completion metaphor. Same flair rules as every other
 * template in this codebase: overshoot+settle on every landing,
 * secondary motion, contact shadows, system-aware color/font, nothing
 * arrives via a flat linear fade.
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

function wrapText(ctx, text, x, y, maxWidth, lineHeight, align = 'center') {
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
  return lines.length;
}

/**
 * Two labeled columns sliding in from opposite edges with offset
 * timing (not simultaneous - left settles slightly before right
 * starts its own settle, so it doesn't read as one mechanical move),
 * a divider growing AFTER both land as the "lock-in" beat.
 */
function splitCompare(ctx, params, t, width, height, system) {
  const { leftLabel, rightLabel, leftText, rightText, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const leftT = clamp01(t / (duration * 0.4));
  const rightT = clamp01((t - duration * 0.08) / (duration * 0.4));
  const leftX = lerp(-width * 0.32, -width * 0.22, easeOutBack(leftT));
  const rightX = lerp(width * 0.32, width * 0.22, easeOutBack(rightT));
  const leftOpacity = easeOutCubic(clamp01(t / (duration * 0.3)));
  const rightOpacity = easeOutCubic(clamp01((t - 0.08) / (duration * 0.3)));

  ctx.save();
  ctx.globalAlpha = leftOpacity;
  ctx.translate(width / 2 + leftX, height * 0.42);
  ctx.textAlign = 'center';
  ctx.font = `700 22px ${system.fontFamily}`;
  ctx.fillStyle = accentColor;
  ctx.fillText(leftLabel, 0, -50);
  ctx.font = `${system.fontWeight} 28px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  wrapText(ctx, leftText, 0, 10, width * 0.36, 34);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = rightOpacity;
  ctx.translate(width / 2 + rightX, height * 0.42);
  ctx.textAlign = 'center';
  ctx.font = `700 22px ${system.fontFamily}`;
  ctx.fillStyle = accentColor;
  ctx.fillText(rightLabel, 0, -50);
  ctx.font = `${system.fontWeight} 28px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  wrapText(ctx, rightText, 0, 10, width * 0.36, 34);
  ctx.restore();

  // Divider grows in AFTER both columns land - the "lock-in" beat
  // that visually confirms the comparison is now set, not still moving.
  const dividerT = clamp01((t - duration * 0.45) / (duration * 0.25));
  if (dividerT > 0) {
    const dividerHeight = lerp(0, height * 0.4, easeOutExpo(dividerT));
    ctx.save();
    ctx.globalAlpha = dividerT;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width / 2, height * 0.42 - dividerHeight / 2);
    ctx.lineTo(width / 2, height * 0.42 + dividerHeight / 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Items build up CUMULATIVELY (each stays visible as the next enters,
 * unlike other templates which replace content) - each item pops in
 * with its own number badge and overshoot, staggered top to bottom.
 */
function listReveal(ctx, params, t, width, height, system) {
  const { items, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = Array.isArray(items) ? items.slice(0, 4) : [];

  const itemHeight = 74;
  const totalHeight = list.length * itemHeight;
  const startY = height * 0.42 - totalHeight / 2 + itemHeight / 2;
  const perItemDelay = duration * 0.18;

  list.forEach((item, i) => {
    const itemStart = i * perItemDelay;
    const itemT = clamp01((t - itemStart) / (duration * 0.35));
    if (itemT <= 0) return;

    const opacity = easeOutCubic(itemT);
    const slideX = lerp(-40, 0, easeOutBack(itemT));
    const badgeScale = easeOutBack(clamp01((t - itemStart) / (duration * 0.25)));
    const y = startY + i * itemHeight;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(width / 2 + slideX, y);

    drawContactShadow(ctx, -width * 0.32, 4, 20, 6, opacity * 0.3);
    ctx.save();
    ctx.scale(badgeScale, badgeScale);
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(-width * 0.32, 0, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = system.bgColorInner;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 18px ${system.fontFamily}`;
    ctx.fillText(String(i + 1), -width * 0.32, 1);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `600 26px ${system.fontFamily}`;
    ctx.fillStyle = system.heroTextColor;
    ctx.fillText(item, -width * 0.32 + 34, 1);
    ctx.restore();
  });
}

/**
 * A large stylized quote with a vertical accent bar that grows in
 * FIRST (before the text), giving the beat a "someone is about to
 * speak" anticipation pause, then the quote text settles, then the
 * attribution fades in last as a quiet coda.
 */
function quoteCallout(ctx, params, t, width, height, system) {
  const { quote, attribution, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const barT = clamp01(t / (duration * 0.2));
  const barHeight = lerp(0, 90, easeOutExpo(barT));

  const textT = clamp01((t - duration * 0.15) / (duration * 0.35));
  const textOpacity = easeOutCubic(textT);
  const textScale = lerp(0.96, 1, easeOutCubic(textT));

  const attrT = clamp01((t - duration * 0.55) / (duration * 0.25));
  const attrOpacity = easeOutCubic(attrT);

  ctx.save();
  ctx.globalAlpha = barT;
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(width * 0.15, height * 0.34 - barHeight / 2);
  ctx.lineTo(width * 0.15, height * 0.34 + barHeight / 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = textOpacity;
  ctx.translate(width / 2 + 20, height * 0.4);
  ctx.scale(textScale, textScale);
  ctx.textAlign = 'center';
  ctx.font = `italic ${system.fontWeight === '900' ? '700' : system.fontWeight} 32px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  wrapText(ctx, `"${quote}"`, 0, 0, width * 0.7, 42);
  ctx.restore();

  if (attribution) {
    ctx.save();
    ctx.globalAlpha = attrOpacity;
    ctx.textAlign = 'center';
    ctx.font = `600 20px ${system.fontFamily}`;
    ctx.fillStyle = accentColor;
    ctx.fillText(`— ${attribution}`, width / 2 + 20, height * 0.58);
    ctx.restore();
  }
}

/**
 * A fill bar with the percentage counting up in sync (non-linear,
 * same easeOutExpo language as statCounter's number), a bright
 * leading edge that glows brighter than the rest of the fill - "light
 * traveling along the bar" rather than a flat color block growing.
 */
function progressBar(ctx, params, t, width, height, system) {
  const { label, toPercent, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.25));
  const opacity = easeOutCubic(entranceT);

  const fillT = clamp01((t - duration * 0.15) / (duration * 0.55));
  const fillPct = lerp(0, toPercent, easeOutExpo(fillT));

  const barW = width * 0.7;
  const barH = 16;
  const barX = width / 2 - barW / 2;
  const barY = height * 0.42;

  ctx.save();
  ctx.globalAlpha = opacity;

  ctx.font = `600 22px ${system.fontFamily}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = system.mutedTextColor;
  ctx.fillText(label, barX, barY - 24);

  ctx.font = `700 22px ${system.fontFamily}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = system.heroTextColor;
  ctx.fillText(`${Math.round(fillPct)}%`, barX + barW, barY - 24);

  ctx.fillStyle = system.mutedTextColor;
  ctx.globalAlpha = opacity * 0.25;
  roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fill();

  ctx.globalAlpha = opacity;
  const fillWidth = Math.max(barH, (fillPct / 100) * barW);
  ctx.fillStyle = accentColor;
  roundRectPath(ctx, barX, barY, fillWidth, barH, barH / 2);
  ctx.fill();

  if (fillT > 0 && fillT < 1) {
    ctx.save();
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(barX + fillWidth - barH / 2, barY + barH / 2, barH / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

module.exports = { splitCompare, listReveal, quoteCallout, progressBar, countdownTimer, gridReveal, checklistTick, bigNumberStat };

/**
 * Number counts DOWN with urgency - color and glow intensify as it
 * approaches zero (warm-to-hot shift, not just a static color), a
 * faster pulse rate near the end. Distinct urgency-driven motion
 * language from statCounter's steady count-up.
 */
function countdownTimer(ctx, params, t, width, height, system) {
  const { label, fromValue, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.25));
  const opacity = easeOutCubic(entranceT);

  const countT = clamp01(t / (duration * 0.85));
  const current = Math.max(0, Math.ceil(lerp(fromValue, 0, countT)));
  const urgency = 1 - current / fromValue; // 0 at start, 1 at zero

  const pulseSpeed = lerp(2, 8, urgency);
  const pulse = 1 + Math.sin(t * pulseSpeed) * lerp(0.01, 0.05, urgency);

  drawContactShadow(ctx, width / 2, height * 0.42 + 60, 90, 18, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.42);
  ctx.scale(pulse, pulse);
  ctx.textAlign = 'center';
  ctx.shadowColor = urgency > 0.6 ? '#FF3B3B' : accentColor;
  ctx.shadowBlur = lerp(10, 40, urgency);
  ctx.font = `900 84px ${system.fontFamily}`;
  ctx.fillStyle = urgency > 0.6 ? lerp(0, 1, urgency) > 0.8 ? '#FF3B3B' : system.heroTextColor : system.heroTextColor;
  ctx.fillText(String(current), 0, -10);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.font = `500 24px ${system.fontFamily}`;
  ctx.fillStyle = system.mutedTextColor;
  ctx.fillText(label, width / 2, height * 0.42 + 40);
  ctx.restore();
}

/**
 * A 2x2 grid of icon+label cells, each entering with its own stagger
 * and overshoot - real grid density in one template, distinct from
 * listReveal's single vertical column.
 */
const GRID_ICON_GLYPHS_POS = [
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

function gridReveal(ctx, params, t, width, height, system) {
  const { items, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(items) ? items : []).slice(0, 4);

  const cellW = width * 0.36;
  const cellH = 130;
  const gapX = width * 0.06;
  const gapY = 20;
  const perItemDelay = duration * 0.12;

  list.forEach((item, i) => {
    const [dx, dy] = GRID_ICON_GLYPHS_POS[i];
    const itemStart = i * perItemDelay;
    const itemT = clamp01((t - itemStart) / (duration * 0.35));
    if (itemT <= 0) return;

    const opacity = easeOutCubic(itemT);
    const scale = easeOutBack(itemT);
    const cx = width / 2 + dx * (cellW / 2 + gapX / 2);
    const cy = height * 0.42 + dy * (cellH / 2 + gapY / 2);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    ctx.strokeStyle = accentColor;
    ctx.globalAlpha = opacity * 0.5;
    ctx.lineWidth = 1.5;
    roundRectPath2(ctx, -cellW / 2, -cellH / 2, cellW, cellH, 12);
    ctx.stroke();

    ctx.globalAlpha = opacity;
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(0, -20, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = system.heroTextColor;
    ctx.textAlign = 'center';
    ctx.font = `600 18px ${system.fontFamily}`;
    const words = String(item).split(' ');
    const line1 = words.slice(0, Math.ceil(words.length / 2)).join(' ');
    const line2 = words.slice(Math.ceil(words.length / 2)).join(' ');
    ctx.fillText(line1, 0, 15);
    if (line2) ctx.fillText(line2, 0, 38);
    ctx.restore();
  });
}

function roundRectPath2(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Items appear normally, then each gets a checkmark that draws on and
 * a strikethrough that sweeps across - a genuine "completion" motion,
 * distinct from listReveal's simple cumulative build (nothing in
 * listReveal ever changes state after it lands; here every item does).
 */
function checklistTick(ctx, params, t, width, height, system) {
  const { items, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(items) ? items : []).slice(0, 4);

  const itemHeight = 74;
  const totalHeight = list.length * itemHeight;
  const startY = height * 0.42 - totalHeight / 2 + itemHeight / 2;
  const perItemDelay = duration * 0.2;

  list.forEach((item, i) => {
    const itemStart = i * perItemDelay;
    const appearT = clamp01((t - itemStart) / (duration * 0.25));
    if (appearT <= 0) return;

    const tickStart = itemStart + duration * 0.22;
    const tickT = clamp01((t - tickStart) / (duration * 0.2));

    const opacity = easeOutCubic(appearT);
    const y = startY + i * itemHeight;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(width / 2, y);

    // Checkbox outline, fills with accent + draws a check mark once ticked.
    const boxX = -width * 0.32;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    roundRectPath2(ctx, boxX - 14, -14, 28, 28, 6);
    ctx.stroke();

    if (tickT > 0) {
      ctx.save();
      ctx.globalAlpha = opacity * tickT;
      ctx.fillStyle = accentColor;
      roundRectPath2(ctx, boxX - 14, -14, 28, 28, 6);
      ctx.fill();
      ctx.strokeStyle = system.bgColorInner;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const checkT = clamp01(tickT * 1.5);
      ctx.beginPath();
      ctx.moveTo(boxX - 7, 0);
      if (checkT > 0.5) {
        ctx.lineTo(boxX - 2, 6);
        ctx.lineTo(boxX + lerp(-2, 8, clamp01((checkT - 0.5) * 2)), lerp(6, -6, clamp01((checkT - 0.5) * 2)));
      } else {
        ctx.lineTo(boxX - 2 + lerp(-5, 0, checkT * 2), 6 * clamp01(checkT * 2));
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `500 24px ${system.fontFamily}`;
    ctx.fillStyle = tickT > 0.9 ? system.mutedTextColor : system.heroTextColor;
    ctx.fillText(item, boxX + 26, 1);

    if (tickT > 0.3) {
      const textWidth = ctx.measureText(item).width;
      const strikeT = clamp01((tickT - 0.3) / 0.5);
      ctx.strokeStyle = system.mutedTextColor;
      ctx.lineWidth = 2;
      ctx.globalAlpha = opacity * strikeT;
      ctx.beginPath();
      ctx.moveTo(boxX + 26, 0);
      ctx.lineTo(boxX + 26 + textWidth * strikeT, 0);
      ctx.stroke();
    }
    ctx.restore();
  });
}

/**
 * A single massive number as the entire hero - minimal supporting
 * chrome, dramatic bloom growth on landing. Distinct from statCounter
 * (which always pairs a number with a label at moderate scale) - this
 * is a "impact moment" template, built for one huge stat with nothing
 * competing with it.
 */
function bigNumberStat(ctx, params, t, width, height, system) {
  const { value, suffix, caption, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.4));
  const opacity = easeOutCubic(clamp01(t / (duration * 0.3)));
  const scale = lerp(1.5, 1, easeOutBack(entranceT));

  const bloomT = clamp01((t - duration * 0.35) / (duration * 0.3));
  const bloom = lerp(20, 55, easeOutExpo(bloomT));

  drawContactShadow(ctx, width / 2, height * 0.48, 140, 26, opacity * 0.5);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.42);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = bloom;
  ctx.font = `900 128px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  ctx.fillText(`${value}${suffix || ''}`, 0, 0);
  ctx.restore();

  if (caption) {
    const capT = clamp01((t - duration * 0.5) / (duration * 0.3));
    ctx.save();
    ctx.globalAlpha = easeOutCubic(capT);
    ctx.textAlign = 'center';
    ctx.font = `500 26px ${system.fontFamily}`;
    ctx.fillStyle = system.mutedTextColor;
    ctx.fillText(caption, width / 2, height * 0.42 + 90);
    ctx.restore();
  }
}
