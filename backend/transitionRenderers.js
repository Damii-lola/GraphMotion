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
    case 'zoomPunch':
      zoomPunch(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'verticalWipe':
      verticalWipe(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'cardFlip':
      cardFlip(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'crossZoom':
      crossZoom(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'rippleWave':
      rippleWave(ctx, t, width, height, accentColor, visualSystemName);
      break;
    case 'glitchStatic':
      glitchStatic(ctx, t, width, height, accentColor, visualSystemName);
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

/**
 * Concentric rings expanding outward from center, like a wave through
 * water - curved motion, distinct from crossZoom's straight angular
 * rays and irisMorph's single solid circle (this is multiple thin
 * expanding rings, none of them ever solid-fill the frame).
 */
function rippleWave(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const maxRadius = Math.hypot(width, height) * 0.75;
  const ringCount = 4;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < ringCount; i++) {
    const ringDelay = i * 0.08;
    const ringT = clamp01((progress - ringDelay) / (1 - ringDelay));
    if (ringT <= 0) continue;
    const radius = lerp(0, maxRadius, easeOutExpo(ringT));
    const alpha = (1 - ringT) * 0.7;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = lerp(8, 1, ringT);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const coverT = clamp01((progress - 0.3) / 0.5);
  if (coverT > 0) {
    ctx.save();
    ctx.globalAlpha = coverT < 0.5 ? easeInOutCubic(coverT * 2) : easeInOutCubic((1 - coverT) * 2);
    ctx.fillStyle = system.bgColorOuter;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

/**
 * A brief burst of blocky static/glitch rectangles - channel-glitch
 * feel built entirely from safe primitives (plain fillRect blocks at
 * random-seeded positions, NOT drawImage of any canvas source, which
 * is confirmed to leak severely in this Skia binding - see atmosphere
 * .js's grain history). Fast, chaotic, brief - distinct energy from
 * every other transition's smoother motion.
 */
function glitchStatic(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const intensity = progress < 0.5
    ? easeOutExpo(progress / 0.5)
    : lerp(1, 0, easeInOutCubic((progress - 0.5) / 0.5));

  if (intensity < 0.02) return;

  let seed = Math.floor(t * 97) % 100000;
  function rand() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }

  ctx.save();
  const blockCount = Math.round(lerp(4, 22, intensity));
  for (let i = 0; i < blockCount; i++) {
    const bw = rand() * width * 0.6 + 30;
    const bh = rand() * 14 + 3;
    const bx = rand() * width;
    const by = rand() * height;
    ctx.globalAlpha = intensity * (0.3 + rand() * 0.4);
    ctx.fillStyle = i % 3 === 0 ? accentColor : (rand() > 0.5 ? '#FFFFFF' : system.bgColorInner);
    ctx.fillRect(bx, by, bw, bh);
  }

  ctx.globalAlpha = intensity * 0.5;
  ctx.fillStyle = system.bgColorOuter;
  ctx.fillRect(0, 0, width, height * rand() * 0.1);
  ctx.restore();
}

/**
 * Fake-3D card flip: horizontal scale squishes to a sliver (simulating
 * the card turning edge-on to camera) then expands back out - a
 * genuinely different feel from every other transition (they're all
 * either radial, directional-slide, or flash; this is the only one
 * that reads as a physical object rotating in space).
 */
function cardFlip(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  let scaleX;
  if (progress < 0.5) {
    scaleX = lerp(1, 0.02, easeInOutCubic(progress / 0.5));
  } else {
    scaleX = lerp(0.02, 1, easeOutBack(clamp01((progress - 0.5) / 0.5)));
  }

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(Math.max(0.02, scaleX), 1);
  ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = system.bgColorOuter;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // Edge glow at the "spine" of the card, brightest when thinnest.
  if (scaleX < 0.5) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 25;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 1 - scaleX * 2;
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * A radial burst - thin lines shoot outward from center to fill the
 * frame, hold briefly, then the next scene zooms in from a point at
 * center. Explosive, energetic, radial motion distinct from
 * irisMorph's smooth circular close (this is angular/linear rays, not
 * a soft circle) and from zoomPunch (whole-frame scale vs individual
 * radiating lines).
 */
function crossZoom(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const maxLen = Math.hypot(width, height);

  let rayProgress, coverAlpha;
  if (progress < 0.45) {
    rayProgress = easeOutExpo(progress / 0.45);
    coverAlpha = rayProgress;
  } else {
    rayProgress = 1;
    coverAlpha = lerp(1, 0, easeInOutCubic((progress - 0.45) / 0.55));
  }

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.strokeStyle = accentColor;
  ctx.globalCompositeOperation = 'screen';
  const rayCount = 16;
  for (let i = 0; i < rayCount; i++) {
    const angle = (Math.PI * 2 * i) / rayCount;
    const len = maxLen * rayProgress;
    ctx.globalAlpha = 0.7 * (1 - rayProgress * 0.3);
    ctx.lineWidth = lerp(1, 4, rayProgress);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = clamp01(coverAlpha);
  ctx.fillStyle = system.bgColorOuter;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * A hard scale-punch on a focal point - the frame rockets inward past
 * 100% zoom (whip-pan energy, not a smooth ease), briefly whites out
 * at the peak of the punch, then the next scene snaps in at rest
 * scale. Fast, aggressive, front-loaded - distinct from every other
 * transition's more measured pace, good for high-energy beat changes.
 */
function zoomPunch(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);

  let scale, whiteout;
  if (progress < 0.35) {
    // Punch in - fast, accelerating.
    const p = progress / 0.35;
    scale = lerp(1, 4.5, p * p * p);
    whiteout = easeOutExpo(p);
  } else if (progress < 0.5) {
    scale = 4.5;
    whiteout = 1;
  } else {
    // Snap out to rest scale for the incoming scene.
    const p = (progress - 0.5) / 0.5;
    scale = lerp(4.5, 1, easeOutExpo(p));
    whiteout = lerp(1, 0, easeInOutCubic(p));
  }

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = system.bgColorOuter;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  if (whiteout > 0.01) {
    ctx.save();
    ctx.globalAlpha = clamp01(whiteout);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

/**
 * Vertical complement to slideDisplace - a pane drops down from
 * above while a second, dimmer pane rises from below at a different
 * speed (opposing directions, not just "the same wipe rotated 90
 * degrees") - reads as fundamentally different from the horizontal
 * version, not a reskin.
 */
function verticalWipe(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const eased = easeInOutCubic(progress);

  // Rising pane from below: slower, dimmer, arrives later.
  const riseY = lerp(height * 1.1, -height * 0.1, easeInOutCubic(clamp01((progress - 0.1) / 0.8)));
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = system.mutedTextColor;
  ctx.fillRect(0, riseY, width, height * 1.1);
  ctx.restore();

  // Dropping pane from above: faster, opaque, leads.
  const dropY = lerp(-height * 1.15, height * 1.15, eased) - height * 1.15;
  ctx.save();
  ctx.fillStyle = system.bgColorOuter;
  ctx.fillRect(0, dropY, width, height * 1.15);
  ctx.restore();

  if (progress > 0.05 && progress < 0.95) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const edgeY = dropY + height * 1.15;
    const grad = ctx.createLinearGradient(0, edgeY - 25, 0, edgeY + 25);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, accentColor);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, edgeY - 25, width, 50);
    ctx.restore();
  }
}
