const { easeOutExpo, easeInOutCubic, easeOutBack, lerp, clamp01 } = require('./easing');
const { drawAtmosphere } = require('./atmosphere');

/**
 * The old RGB-split bar wipe is gone entirely - it's the single most
 * reused, most recognizable "stock AE template" transition that
 * exists, and per the design notes, a transition should either be
 * invisible or BE the content, never decoration slapped on top.
 *
 * Both replacements below follow "transition-as-content": the
 * climax/peak of the outgoing beat and the transition are the same
 * event, not a separate effect bolted between two scenes.
 */

const TRANSITION_DURATION = 0.55;

function drawTransition(ctx, name, t, width, height, accentColor) {
  switch (name) {
    case 'irisMorph':
      irisMorph(ctx, t, width, height, accentColor);
      break;
    case 'luminanceFlashCut':
    default:
      luminanceFlashCut(ctx, t, width, height, accentColor);
      break;
  }
}

/**
 * The outgoing scene's glow overexposes to a full white flash at the
 * peak, which becomes the cut itself - a luminance match, not a
 * separate wipe device. Heavily eased with a slight overshoot past
 * full white before settling, so the flash has weight instead of
 * moving like a linear opacity ramp.
 */
function luminanceFlashCut(ctx, t, width, height, accentColor) {
  drawAtmosphere(ctx, t, width, height, accentColor);

  const progress = clamp01(t / TRANSITION_DURATION);
  // Fast rise to peak brightness (ease-out, front-loaded), slightly
  // overshoots past 1.0 intensity, then eases back down into the next
  // scene - "overshoot and settle" applied to a flash instead of a move.
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

  // A whisper of accent color bleeds through the flash rather than
  // pure white, tying the transition to the piece's color system
  // instead of a generic effect.
  if (intensity > 0.3 && intensity < 1) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = (1 - intensity) * 0.3;
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

/**
 * A circular iris closes to a point then reopens - built from a
 * shared primitive (a circle) rather than a generic bar, matching
 * "find a shared geometric primitive and let one become the other."
 * Heavily eased in on the close, slight overshoot (undershoots past
 * zero radius won't render, so the overshoot lives in the REOPEN,
 * which briefly overshoots past its target size before settling).
 */
function irisMorph(ctx, t, width, height, accentColor) {
  const progress = clamp01(t / TRANSITION_DURATION);
  const maxRadius = Math.hypot(width, height) * 0.6;

  drawAtmosphere(ctx, t, width, height, accentColor);

  let radius;
  if (progress < 0.45) {
    // Closing: fast ease-in, accelerating toward the point.
    radius = lerp(maxRadius, 0, easeInOutCubic(progress / 0.45));
  } else if (progress < 0.5) {
    radius = 0;
  } else {
    // Reopening: overshoots slightly past maxRadius, then the next
    // scene's own content covers the rest - the overshoot gives the
    // reveal physical weight instead of a flat linear reopen.
    const reopenT = (progress - 0.5) / 0.5;
    radius = lerp(0, maxRadius * 1.06, easeOutBack(reopenT));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.arc(width / 2, height / 2, Math.max(0, radius), 0, Math.PI * 2, true);
  ctx.closePath();
  ctx.fillStyle = '#08080A';
  ctx.fill('evenodd');
  ctx.restore();

  // Thin glowing rim on the iris edge - ties back to the piece's
  // accent color and gives the closing shape presence, not just a
  // flat mask edge.
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

module.exports = { drawTransition, TRANSITION_DURATION };
