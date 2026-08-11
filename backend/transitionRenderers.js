const { easeOutExpo, easeInExpo, easeInOutCubic, easeOutBack, easeOutCubic, lerp, clamp01 } = require('./easing');
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
/**
 * Replaces the old slideDisplace, which was honestly just two flat
 * rectangles sliding across the frame - the single most generic,
 * recognizable "cheap template" transition move that exists,
 * regardless of the parallax dressing it had. This is a genuine
 * rebuild: the frame shatters into angular shard wedges that burst
 * apart with independent rotation and staggered timing, rim-lit on
 * their leading edges - built from angular polygon geometry, nothing
 * about it reduces to a sliding rectangle.
 */
function slideDisplace(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  const centerX = width / 2;
  const centerY = height / 2;
  const wedgeCount = 6;
  const farRadius = Math.hypot(width, height) * 0.75;

  for (let i = 0; i < wedgeCount; i++) {
    const stagger = i * 0.025;
    const wedgeT = clamp01((progress - stagger) / (1 - stagger));
    if (wedgeT <= 0) continue;

    const angleStart = (Math.PI * 2 * i) / wedgeCount;
    const angleEnd = (Math.PI * 2 * (i + 1)) / wedgeCount;
    const bisector = (angleStart + angleEnd) / 2;

    // Burst outward with an accelerating start (shatter impulse), not
    // a linear/eased-only slide - the wedge should feel like it's
    // being flung, not gliding.
    const flyDistance = lerp(0, farRadius * 0.9, easeInExpo(wedgeT));
    const rotation = lerp(0, (i % 2 === 0 ? 1 : -1) * 0.6, easeOutCubic(wedgeT));
    const fadeOut = lerp(1, 0, easeInOutCubic(clamp01((wedgeT - 0.5) / 0.5)));

    const offsetX = Math.cos(bisector) * flyDistance;
    const offsetY = Math.sin(bisector) * flyDistance;

    ctx.save();
    ctx.translate(centerX + offsetX, centerY + offsetY);
    ctx.rotate(rotation);
    ctx.translate(-centerX, -centerY);

    ctx.globalAlpha = fadeOut;
    ctx.fillStyle = system.bgColorOuter;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX + Math.cos(angleStart) * farRadius, centerY + Math.sin(angleStart) * farRadius);
    ctx.lineTo(centerX + Math.cos(angleEnd) * farRadius, centerY + Math.sin(angleEnd) * farRadius);
    ctx.closePath();
    ctx.fill();

    // Rim light on the wedge's leading radial edge only, not the whole
    // outline - reads as a shard catching light as it tumbles, not a
    // uniformly outlined shape.
    if (fadeOut > 0.05) {
      ctx.globalCompositeOperation = 'screen';
      ctx.strokeStyle = accentColor;
      ctx.shadowColor = accentColor;
      ctx.shadowBlur = 15;
      ctx.lineWidth = 2;
      ctx.globalAlpha = fadeOut * 0.8;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + Math.cos(angleStart) * farRadius, centerY + Math.sin(angleStart) * farRadius);
      ctx.stroke();
    }
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
/**
 * Replaces the old verticalWipe, which was the vertical twin of the
 * same generic sliding-pane problem. This simulates an actual fold -
 * a panel hinged at the top, swinging shut via a perspective-
 * narrowing trapezoid (the far edge compresses as it approaches the
 * hinge, implying rotation through depth), closes fully, then swings
 * back open with a slight overshoot for physical weight. Reads as a
 * lid or page folding, not a flat rectangle dropping.
 */
function verticalWipe(ctx, t, width, height, accentColor, visualSystemName) {
  const system = getVisualSystem(visualSystemName);
  drawAtmosphere(ctx, t, width, height, accentColor, system);

  const progress = clamp01(t / TRANSITION_DURATION);
  let panelHeight, edgeInset;

  if (progress < 0.45) {
    // Swinging shut: height grows from 0 to full, far edge narrows in
    // (perspective) as it approaches closed.
    const closeT = easeInOutCubic(progress / 0.45);
    panelHeight = lerp(0, height, closeT);
    edgeInset = lerp(width * 0.22, 0, closeT);
  } else if (progress < 0.52) {
    panelHeight = height;
    edgeInset = 0;
  } else {
    // Swinging back open, with a slight overshoot past full-open
    // before settling - the same "weight on landing" language used
    // throughout every other transition in this file.
    const openT = clamp01((progress - 0.52) / 0.48);
    panelHeight = lerp(height, 0, easeOutBack(openT));
    edgeInset = lerp(0, width * 0.22, easeOutCubic(openT));
  }

  panelHeight = Math.max(0, panelHeight);
  const farY = panelHeight;
  const inset = Math.max(0, edgeInset);

  ctx.save();
  ctx.fillStyle = system.bgColorOuter;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width - inset, farY);
  ctx.lineTo(inset, farY);
  ctx.closePath();
  ctx.fill();

  // Fold-crease shadow near the hinge - darkens toward the top,
  // implying the panel catching less light right at the fold.
  const creaseGrad = ctx.createLinearGradient(0, 0, 0, Math.min(80, farY));
  creaseGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
  creaseGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = creaseGrad;
  ctx.fill();
  ctx.restore();

  // Bright leading edge along the panel's moving (far) border only.
  if (farY > 2 && farY < height - 2) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(inset, farY);
    ctx.lineTo(width - inset, farY);
    ctx.stroke();
    ctx.restore();
  }
}
