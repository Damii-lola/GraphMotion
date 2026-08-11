const { easeOutExpo, easeInOutCubic, easeOutBack, lerp, clamp01 } = require('./easing');
const { drawAtmosphere } = require('./atmosphere');
const { getVisualSystem } = require('./visualSystems');

/**
 * The old RGB-split bar wipe is gone entirely - it's the single most
 * reused, most recognizable "stock AE template" transition that
 * exists, and per the design notes, a transition should either be
 * invisible or BE the content, never decoration slapped on top.
 *
 * Both replacements below follow "transition-as-content": the
 * climax/peak of the outgoing beat and the transition are the same
 * event, not a separate effect bolted between two scenes. Both now
 * also take `visualSystemName` so the transition's own atmosphere and
 * iris fill color match whichever system the rest of the video is
 * using, instead of always rendering the dark hudTerminal look
 * regardless of what system the surrounding scenes picked.
 */

const TRANSITION_DURATION = 0.55;

function drawTransition(ctx, name, t, width, height, accentColor, visualSystemName) {
  switch (name) {
    case 'irisMorph':
      irisMorph(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'shapeMorph':
      shapeMorph(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'slideDisplace':
      slideDisplace(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'luminanceFlashCut':
    default:
      luminanceFlashCut(ctx, t, width, height, accentColor, visualSystemName);
      break;
  }
}

function luminanceFlashCut(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  let intensity;
  if (progress < 0.4) {
    intensity = easeOutExpo(progress / 0.4);
  } else if (progress < 0.55) {
    intensity = lerp(1, 1.08, (progress - 0.4) / 0.15);
  } else {
    intensity = lerp(1.08, 0, easeInOutCubic((progress - 0.55) / 0.45));
  }
  intensity = Math.max(0, intensity);

  ctx.save();
  ctx.globalAlpha = clamp01(intensity);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  if (intensity > 0.3 && intensity < 1) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = (1 - intensity) * 0.3;
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

function irisMorph(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  const progress = clamp01(t / TRANSITION_DURATION);
  const maxRadius = Math.hypot(width, height) * 0.6;

  drawAtmosphere(ctx, t, width, height, accentColor, system);

  let radius;
  if (progress < 0.45) {
    radius = lerp(maxRadius, 0, easeInOutCubic(progress / 0.45));
  } else if (progress < 0.5) {
    radius = 0;
  } else {
    const reopenT = (progress - 0.5) / 0.5;
    radius = lerp(0, maxRadius * 1.06, easeOutBack(reopenT));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.arc(width / 2, height / 2, Math.max(0, radius), 0, Math.PI * 2, true);
  ctx.closePath();
  // Was hardcoded dark (#08080A) - now uses the active system's own
  // background color, so the iris close/reopen matches softEditorial's
  // light background instead of always cutting to a dark disc.
  ctx.fillStyle = system.bgColorOuter;
  ctx.fill('evenodd');
  ctx.restore();

  if (radius > 2 && radius < maxRadius) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 20;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * A square rotates while scaling up to fully cover the frame, then
 * continues rotating as it scales back down to reveal the next scene
 * - angular, geometric motion language, genuinely distinct from
 * irisMorph's circular close/reopen. The rotation never stops or
 * reverses direction, so the whole transition reads as one continuous
 * spin rather than two separate moves stitched together.
 */
function shapeMorph(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const maxSize = Math.hypot(width, height) * 1.3;

  let scale;
  if (progress < 0.45) {
    scale = lerp(0, 1, easeOutExpo(progress / 0.45));
  } else if (progress < 0.55) {
    scale = 1;
  } else {
    scale = lerp(1, 0, easeInOutCubic((progress - 0.55) / 0.45));
  }
  const rotation = progress * Math.PI * 1.5;

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(rotation);
  ctx.fillStyle = system.bgColorOuter;
  const size = maxSize * scale;
  ctx.fillRect(-size / 2, -size / 2, size, size);

  if (scale > 0.02 && scale < 1) {
    ctx.strokeStyle = accentColor;
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 20;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.8;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
  }
  ctx.restore();
}

/**
 * Two panes slide across horizontally at DIFFERENT speeds (a nearer,
 * darker pane moving faster than a dimmer, further one behind it) -
 * real parallax depth applied to a transition, not just a flat wipe.
 * Directional, not radial - genuinely distinct feel from both flash
 * and iris/morph.
 */
function slideDisplace(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const eased = easeInOutCubic(progress);

  // Back pane: slower, dimmer, arrives later - reads as "further away."
  const backX = lerp(-width * 1.1, width * 1.1, easeInOutCubic(clamp01((progress - 0.08) / 0.84)));
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = system.mutedTextColor;
  ctx.fillRect(backX, 0, width * 1.1, height);
  ctx.restore();

  // Front pane: faster, fully opaque, leads the motion.
  const frontX = lerp(-width * 1.15, width * 1.15, eased);
  ctx.save();
  ctx.fillStyle = system.bgColorOuter;
  ctx.fillRect(frontX, 0, width * 1.15, height);
  ctx.restore();

  // Bright leading edge on the front pane, like a light catching its
  // moving border.
  if (progress > 0.05 && progress < 0.95) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const edgeX = frontX + width * 1.15;
    const grad = ctx.createLinearGradient(edgeX - 30, 0, edgeX + 30, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, accentColor);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(edgeX - 30, 0, 60, height);
    ctx.restore();
  }
}

module.exports = { drawTransition, TRANSITION_DURATION };
