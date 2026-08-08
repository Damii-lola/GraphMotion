const { easeOutExpo, easeInOutCubic, lerp, clamp01 } = require('./easing');

/**
 * Transitions get their own dedicated time slot in the master timeline
 * (see renderEngine.js's scene scheduler) - they are not composited
 * over real outgoing/incoming scene frames, they're their own brief
 * animated segment between two scenes. That means the goal here is
 * just "a good-looking traveling glitch effect for half a second",
 * not "hide content while it changes underneath".
 */

const TRANSITION_DURATION = 0.5; // seconds, fixed for all transitions

function drawTransition(ctx, name, t, width, height) {
  switch (name) {
    case 'lightStreakDrag':
      lightStreakDrag(ctx, t, width, height);
      break;
    case 'glitchWipe':
    default:
      glitchWipe(ctx, t, width, height);
      break;
  }
}

function glitchWipe(ctx, t, width, height) {
  ctx.fillStyle = '#0A0A0B';
  ctx.fillRect(0, 0, width, height);

  const progress = clamp01(t / TRANSITION_DURATION);
  // Leading edge travels the full width plus margin, so the fringe is
  // actually visible crossing the frame instead of saturating instantly.
  const eased = progress < 0.5
    ? easeOutExpo(progress * 2) * 0.5
    : 0.5 + easeInOutCubic((progress - 0.5) * 2) * 0.5;
  const edgeX = lerp(-40, width + 40, eased);

  const edgeWidth = 50;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.65;
  ctx.fillStyle = '#FF2E6C';
  ctx.fillRect(edgeX - edgeWidth / 2 - 10, 0, edgeWidth, height);
  ctx.fillStyle = '#2EFFD5';
  ctx.fillRect(edgeX - edgeWidth / 2 + 10, 0, edgeWidth, height);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(edgeX - edgeWidth / 2, 0, edgeWidth, height);
  ctx.restore();
}

function lightStreakDrag(ctx, t, width, height) {
  ctx.fillStyle = '#0A0A0B';
  ctx.fillRect(0, 0, width, height);

  const progress = clamp01(t / TRANSITION_DURATION);
  const x = lerp(-80, width + 80, easeInOutCubic(progress));

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const grad = ctx.createLinearGradient(x - 80, 0, x + 80, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - 80, 0, 160, height);
  ctx.restore();
}

module.exports = { drawTransition, TRANSITION_DURATION };
