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

module.exports = { splitCompare, listReveal, quoteCallout, progressBar, countdownTimer, gridReveal, checklistTick, bigNumberStat, pieChartReveal, duoStatCompare, badgeUnlock, tickerScroll, statGrid, arrowFlow, calloutBubble, barChartCompare, avatarStack };

/**
 * Vertical animated bars comparing several values - a genuine new
 * viz type (Cartesian bars), distinct from pieChartReveal (radial)
 * and progressBar (single horizontal fill). Bars grow with staggered
 * timing and settle with a slight overshoot bounce.
 */
function barChartCompare(ctx, params, t, width, height, system) {
  const { bars, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(bars) ? bars : []).slice(0, 4);
  if (list.length === 0) return;

  const maxValue = Math.max(...list.map((b) => Number(b.value) || 0), 1);
  const chartH = 220;
  const chartBottom = height * 0.48;
  const barW = 56;
  const gap = 30;
  const totalW = list.length * barW + (list.length - 1) * gap;
  const startX = width / 2 - totalW / 2 + barW / 2;

  list.forEach((bar, i) => {
    const itemStart = i * duration * 0.1;
    const entranceT = clamp01((t - itemStart) / (duration * 0.15));
    if (entranceT <= 0) return;
    const opacity = easeOutCubic(entranceT);

    const growT = clamp01((t - itemStart - duration * 0.1) / (duration * 0.45));
    const value = Number(bar.value) || 0;
    const barHeight = lerp(0, (value / maxValue) * chartH, easeOutBack(growT));
    const cx = startX + i * (barW + gap);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = opacity * 0.9;
    roundRectPathBar(ctx, cx - barW / 2, chartBottom - Math.max(0, barHeight), barW, Math.max(2, barHeight), 8);
    ctx.fill();

    ctx.globalAlpha = opacity;
    ctx.fillStyle = system.heroTextColor;
    ctx.textAlign = 'center';
    ctx.font = `700 20px ${system.fontFamily}`;
    ctx.fillText(String(value), cx, chartBottom - Math.max(0, barHeight) - 16);

    ctx.font = `500 15px ${system.fontFamily}`;
    ctx.fillStyle = system.mutedTextColor;
    ctx.fillText(String(bar.label || ''), cx, chartBottom + 24);
    ctx.restore();
  });

  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = system.mutedTextColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(startX - barW, chartBottom);
  ctx.lineTo(startX + totalW, chartBottom);
  ctx.stroke();
  ctx.restore();
}

function roundRectPathBar(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Overlapping circular avatars with initials, like a "12k people use
 * this" social-proof visual - a distinct content type nothing else
 * covers (real people/community framing vs data/features/process).
 */
function avatarStack(ctx, params, t, width, height, system) {
  const { initials, caption, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(initials) ? initials : []).slice(0, 5);
  if (list.length === 0) return;

  const radius = 32;
  const overlap = 20;
  const totalW = radius * 2 + (list.length - 1) * (radius * 2 - overlap);
  const startX = width / 2 - totalW / 2 + radius;
  const cy = height * 0.4;

  // Draw right-to-left so earlier avatars overlap ON TOP of later
  // ones, matching how these stacks read left-to-right in real UIs.
  for (let i = list.length - 1; i >= 0; i--) {
    const itemStart = i * duration * 0.1;
    const entranceT = clamp01((t - itemStart) / (duration * 0.3));
    if (entranceT <= 0) continue;

    const opacity = easeOutCubic(entranceT);
    const scale = easeOutBack(entranceT);
    const cx = startX + i * (radius * 2 - overlap);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    ctx.fillStyle = system.bgColorOuter;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = i % 3 === 2 ? accentColor : system.mutedTextColor;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = system.bgColorInner;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 20px ${system.fontFamily}`;
    ctx.fillText(String(list[i]).slice(0, 2).toUpperCase(), 0, 1);
    ctx.restore();
  }

  if (caption) {
    const capT = clamp01((t - duration * 0.5) / (duration * 0.3));
    ctx.save();
    ctx.globalAlpha = easeOutCubic(capT);
    ctx.textAlign = 'center';
    ctx.font = `500 22px ${system.fontFamily}`;
    ctx.fillStyle = system.heroTextColor;
    ctx.fillText(caption, width / 2, cy + radius + 50);
    ctx.restore();
  }
}

/**
 * 4 small numbers in a grid, each counting up independently - distinct
 * from gridReveal (icon+label, no animation on the values themselves)
 * and duoStatCompare (only 2 items, side by side not grid).
 */
const STAT_GRID_POS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

function statGrid(ctx, params, t, width, height, system) {
  const { stats, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(stats) ? stats : []).slice(0, 4);

  const cellW = width * 0.4;
  const cellH = 140;
  const perItemDelay = duration * 0.1;

  list.forEach((stat, i) => {
    const [dx, dy] = STAT_GRID_POS[i];
    const itemStart = i * perItemDelay;
    const entranceT = clamp01((t - itemStart) / (duration * 0.3));
    if (entranceT <= 0) return;

    const opacity = easeOutCubic(entranceT);
    const scale = easeOutBack(entranceT);
    const countT = clamp01((t - itemStart) / (duration * 0.5));
    const targetValue = Number(stat.value) || 0;
    // Preserve decimal precision for values like a 4.8 rating - always
    // rounding to an integer was silently turning 4.8 into "5", wrong
    // for any stat that isn't naturally a whole number.
    const isDecimal = !Number.isInteger(targetValue);
    const rawCurrent = lerp(0, targetValue, easeOutExpo(countT));
    const current = isDecimal ? rawCurrent.toFixed(1) : Math.round(rawCurrent);

    const cx = width / 2 + dx * (cellW / 2 + 10);
    const cy = height * 0.4 + dy * (cellH / 2 + 10);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.font = `800 44px ${system.fontFamily}`;
    ctx.fillStyle = accentColor;
    ctx.fillText(`${current}${stat.suffix || ''}`, 0, -8);
    ctx.font = `500 16px ${system.fontFamily}`;
    ctx.fillStyle = system.mutedTextColor;
    ctx.fillText(String(stat.label || ''), 0, 22);
    ctx.restore();
  });
}

/**
 * A horizontal sequence of connected steps with arrows between them -
 * a process/flow framing, distinct from listReveal's vertical simple
 * list and checklistTick's completion motion. Each step + arrow
 * enters in sequence, left to right, matching reading direction.
 */
function arrowFlow(ctx, params, t, width, height, system) {
  const { steps, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(steps) ? steps : []).slice(0, 3);
  if (list.length === 0) return;

  const cellW = width * 0.24;
  const totalW = list.length * cellW + (list.length - 1) * 50;
  const startX = width / 2 - totalW / 2 + cellW / 2;
  const perStepDelay = duration * 0.22;

  list.forEach((step, i) => {
    const stepStart = i * perStepDelay;
    const entranceT = clamp01((t - stepStart) / (duration * 0.3));
    if (entranceT <= 0) return;

    const opacity = easeOutCubic(entranceT);
    const scale = easeOutBack(entranceT);
    const cx = startX + i * (cellW + 50);
    const cy = height * 0.4;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, -30, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = accentColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 20px ${system.fontFamily}`;
    ctx.fillText(String(i + 1), 0, -30);

    ctx.fillStyle = system.heroTextColor;
    ctx.font = `500 16px ${system.fontFamily}`;
    const words = String(step).split(' ');
    ctx.fillText(words.slice(0, 2).join(' '), 0, 10);
    if (words.length > 2) ctx.fillText(words.slice(2).join(' '), 0, 30);
    ctx.restore();

    if (i < list.length - 1) {
      const arrowT = clamp01((t - stepStart - duration * 0.15) / (duration * 0.2));
      if (arrowT > 0) {
        ctx.save();
        ctx.globalAlpha = arrowT;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2;
        // Absolute coordinates - drawn AFTER the per-step save/restore
        // above, so cy must be added explicitly here. Using bare -30
        // (as if still inside that translated block) was a real bug:
        // it placed the arrow near the canvas's literal top edge
        // instead of beside the step circle, which is why it never
        // appeared in the rendered frame despite the math otherwise
        // computing a valid arrowT.
        const ax = cx + cellW / 2 + 8;
        const ay = cy - 30;
        const arrowLen = lerp(0, 30, easeOutCubic(arrowT));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + arrowLen, ay);
        ctx.moveTo(ax + arrowLen - 6, ay - 6);
        ctx.lineTo(ax + arrowLen, ay);
        ctx.lineTo(ax + arrowLen - 6, ay + 6);
        ctx.stroke();
        ctx.restore();
      }
    }
  });
}

/**
 * A speech-bubble callout with a tail pointer - conversational
 * framing, distinct register from quoteCallout's formal accent-bar
 * quote treatment. Good for "what people are saying" or dialogue-
 * style content.
 */
function calloutBubble(ctx, params, t, width, height, system) {
  const { text, speaker, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(entranceT);
  const scale = lerp(0.85, 1, easeOutBack(entranceT));

  const bubbleW = width * 0.72;
  const bubbleY = height * 0.38;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, bubbleY);
  ctx.scale(scale, scale);

  ctx.font = `500 24px ${system.fontFamily}`;
  ctx.textAlign = 'center';
  const words = text.split(' ');
  const lines = [];
  let current = '';
  const maxW = bubbleW - 60;
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxW && current) {
      lines.push(current);
      current = word;
    } else current = test;
  }
  if (current) lines.push(current);
  const bubbleH = lines.length * 32 + 60;

  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.globalAlpha = opacity * 0.8;
  roundRectPath3(ctx, -bubbleW / 2, -bubbleH / 2, bubbleW, bubbleH, 20);
  ctx.stroke();

  // Tail pointer.
  ctx.beginPath();
  ctx.moveTo(-20, bubbleH / 2);
  ctx.lineTo(-5, bubbleH / 2 + 20);
  ctx.lineTo(10, bubbleH / 2);
  ctx.stroke();

  ctx.globalAlpha = opacity;
  ctx.fillStyle = system.heroTextColor;
  ctx.textBaseline = 'middle';
  const startY = -((lines.length - 1) * 32) / 2;
  lines.forEach((line, i) => ctx.fillText(line, 0, startY + i * 32));
  ctx.restore();

  if (speaker) {
    const speakerT = clamp01((t - duration * 0.4) / (duration * 0.25));
    ctx.save();
    ctx.globalAlpha = easeOutCubic(speakerT);
    ctx.textAlign = 'center';
    ctx.font = `600 18px ${system.fontFamily}`;
    ctx.fillStyle = accentColor;
    ctx.fillText(`— ${speaker}`, width / 2, bubbleY + bubbleH / 2 + 45);
    ctx.restore();
  }
}

function roundRectPath3(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * An animated donut/pie arc sweeping from 0 to the target percentage -
 * a genuinely NEW visual primitive (radial data viz), nothing else in
 * this library draws data as an arc. Sweep uses the same non-linear
 * easeOutExpo language as every other counter, so it feels part of
 * the same family despite the different geometry.
 */
function pieChartReveal(ctx, params, t, width, height, system) {
  const { label, toPercent, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.25));
  const opacity = easeOutCubic(entranceT);

  const sweepT = clamp01((t - duration * 0.15) / (duration * 0.55));
  const currentPct = lerp(0, toPercent, easeOutExpo(sweepT));

  const cx = width / 2;
  const cy = height * 0.4;
  const radius = 100;
  const lineWidth = 22;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Track (full circle, dim).
  ctx.strokeStyle = system.mutedTextColor;
  ctx.globalAlpha = opacity * 0.2;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Progress arc, starting from top (12 o'clock), clockwise.
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = accentColor;
  ctx.lineCap = 'round';
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = 18;
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + (currentPct / 100) * Math.PI * 2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Center percentage readout.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 40px ${system.fontFamily}`;
  ctx.fillStyle = system.heroTextColor;
  ctx.fillText(`${Math.round(currentPct)}%`, cx, cy);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.font = `500 24px ${system.fontFamily}`;
  ctx.fillStyle = system.mutedTextColor;
  ctx.fillText(label, cx, cy + radius + 50);
  ctx.restore();
}

/**
 * Two stat counters side by side, BOTH counting up simultaneously -
 * distinct from splitCompare (static text) and statCounter (a single
 * number) - the animation itself is the comparison, not just the
 * final values.
 */
function duoStatCompare(ctx, params, t, width, height, system) {
  const { leftLabel, leftValue, rightLabel, rightValue, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const entranceT = clamp01(t / (duration * 0.3));
  const opacity = easeOutCubic(entranceT);
  const countT = clamp01(t / (duration * 0.6));
  const leftCurrent = Math.round(lerp(0, leftValue, easeOutExpo(countT)));
  const rightCurrent = Math.round(lerp(0, rightValue, easeOutExpo(clamp01((t - 0.1) / (duration * 0.6)))));

  [
    { x: -width * 0.24, value: leftCurrent, label: leftLabel },
    { x: width * 0.24, value: rightCurrent, label: rightLabel },
  ].forEach((side) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(width / 2 + side.x, height * 0.42);
    ctx.textAlign = 'center';
    ctx.font = `900 52px ${system.fontFamily}`;
    ctx.fillStyle = accentColor;
    ctx.fillText(String(side.value), 0, -10);
    ctx.font = `500 18px ${system.fontFamily}`;
    ctx.fillStyle = system.mutedTextColor;
    ctx.fillText(side.label, 0, 30);
    ctx.restore();
  });

  const dividerT = clamp01((t - duration * 0.5) / (duration * 0.2));
  if (dividerT > 0) {
    ctx.save();
    ctx.globalAlpha = dividerT * opacity;
    ctx.strokeStyle = system.mutedTextColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width / 2, height * 0.42 - 40);
    ctx.lineTo(width / 2, height * 0.42 + 40);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * A celebratory badge pop with radiating burst lines and a ring pulse
 * - genuinely different energy/purpose from every other template
 * (reward/achievement framing, not information delivery).
 */
function badgeUnlock(ctx, params, t, width, height, system) {
  const { label, duration } = params;
  const accentColor = params.color || '#FF5C1A';

  const popT = clamp01(t / (duration * 0.35));
  const opacity = easeOutCubic(popT);
  const scale = lerp(0.3, 1, easeOutBack(popT));

  const burstT = clamp01((t - duration * 0.1) / (duration * 0.4));
  if (burstT > 0 && burstT < 1) {
    const burstOpacity = (1 - burstT) * 0.6;
    const burstLength = lerp(20, 70, easeOutExpo(burstT));
    ctx.save();
    ctx.translate(width / 2, height * 0.4);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3;
    ctx.globalAlpha = burstOpacity;
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI / 4) * i;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * 60, Math.sin(angle) * 60);
      ctx.lineTo(Math.cos(angle) * (60 + burstLength), Math.sin(angle) * (60 + burstLength));
      ctx.stroke();
    }
    ctx.restore();
  }

  drawContactShadow(ctx, width / 2, height * 0.4 + 80, 60, 14, opacity * 0.4);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(width / 2, height * 0.4);
  ctx.scale(scale, scale);
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = 30;
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.moveTo(0, -60);
  for (let i = 1; i <= 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? 60 : 45;
    ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = system.bgColorInner;
  ctx.strokeStyle = system.bgColorInner;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Drawn as a vector path, not a font glyph - a checkmark character
  // (like the earlier lock-icon emoji) isn't guaranteed to exist in
  // whatever font is available on the render server, and silently
  // renders as a missing-glyph box when it doesn't. Confirmed by
  // actually looking at the output, same class of bug as before.
  ctx.beginPath();
  ctx.moveTo(-9, 0);
  ctx.lineTo(-3, 7);
  ctx.lineTo(10, -8);
  ctx.stroke();
  ctx.restore();

  const labelT = clamp01((t - duration * 0.4) / (duration * 0.3));
  if (labelT > 0) {
    ctx.save();
    ctx.globalAlpha = easeOutCubic(labelT);
    ctx.textAlign = 'center';
    ctx.font = `700 26px ${system.fontFamily}`;
    ctx.fillStyle = system.heroTextColor;
    ctx.fillText(label, width / 2, height * 0.4 + 100);
    ctx.restore();
  }
}

/**
 * A continuously horizontally-scrolling ticker of short items -
 * genuinely different, non-settling motion language (everything else
 * in this library arrives and holds; this never stops moving for the
 * whole scene). Good as a texture/rhythm beat between heavier scenes.
 */
function tickerScroll(ctx, params, t, width, height, system) {
  const { items, duration } = params;
  const accentColor = params.color || '#FF5C1A';
  const list = (Array.isArray(items) && items.length > 0) ? items : ['---'];

  const opacity = easeOutCubic(clamp01(t / (duration * 0.2)));

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `700 34px ${system.fontFamily}`;
  ctx.textBaseline = 'middle';

  // Plain ASCII separator, not a symbol glyph - the star character
  // used here originally hit the exact same missing-glyph problem as
  // badgeUnlock's checkmark above. ASCII is guaranteed present in any
  // font on any system, no exceptions.
  const separator = '   *   ';
  const parts = list.map((item) => String(item).toUpperCase() + separator);
  const segmentWidth = parts.reduce((sum, p) => sum + ctx.measureText(p).width, 0);
  const speed = 90; // px/sec
  const offset = (t * speed) % segmentWidth;

  // Repeat the whole joined sequence enough times to fill the frame
  // width plus one extra cycle, scrolling continuously leftward.
  let cursorX = -offset;
  let safetyCounter = 0;
  while (cursorX < width + segmentWidth && safetyCounter < 200) {
    for (let i = 0; i < parts.length; i++) {
      ctx.fillStyle = i % 2 === 0 ? system.heroTextColor : accentColor;
      ctx.fillText(parts[i], cursorX, height * 0.42);
      cursorX += ctx.measureText(parts[i]).width;
    }
    safetyCounter++;
  }
  ctx.restore();
}

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
  // A punchy template needs a punchy digit beat, not a slow roll - a
  // brief flicker (2-3 rapid digit changes) right as the number lands,
  // not the extended cascading roll used in statCounter/duoStatCompare
  // (which have a longer duration budget built around a count-up).
  const finalText = `${value}${suffix || ''}`;
  const flickerWindow = duration * 0.12;
  const flickerT = clamp01((t - duration * 0.05) / flickerWindow);
  if (flickerT < 1 && String(value).match(/\d/)) {
    const digits = String(value).split('');
    const flickered = digits.map((ch) => {
      if (!/\d/.test(ch)) return ch;
      const cycleIndex = Math.floor(t * 22) % 10;
      return String(cycleIndex);
    }).join('');
    ctx.fillText(`${flickered}${suffix || ''}`, 0, 0);
  } else {
    ctx.fillText(finalText, 0, 0);
  }
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
