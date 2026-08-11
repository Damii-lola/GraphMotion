const { easeInOutCubic, lerp, clamp01 } = require('./easing');

/**
 * THE CORE OF THE REBUILD. Replaces the old model entirely: instead
 * of independent scenes stitched by a transition effect, every beat
 * lives at a fixed position in one continuous world, and the camera
 * physically pans/zooms between them. There is no "cut" - the camera
 * arriving at a beat's position IS how it gets revealed, and moving
 * away IS how the previous one leaves. This is why every old
 * transition (luminanceFlashCut, irisMorph, shapeMorph, etc.) is
 * genuinely unused in this model, not just deprioritized - there is
 * no moment in this design where a transition effect would even run.
 *
 * Layout: beats are placed along a gently wandering horizontal path
 * (not a straight line - a slight vertical sine wander) so a long
 * video doesn't feel like one mechanical linear pan the whole way
 * through. Spacing is deliberately tight (1.15x screen width) so the
 * camera's pan between beats always has SOMETHING nearby in frame,
 * never a long empty traverse through blank world space.
 */

const WORLD_SPACING_X = 1.15; // multiples of screen width between beat anchors
const WANDER_AMPLITUDE = 0.16; // multiples of screen height
const WANDER_FREQUENCY = 0.9; // radians per beat index

/**
 * Assigns each beat a fixed world-space anchor point. Called once per
 * render from the beat list - deterministic given the same beat
 * count, so nothing here depends on time.
 */
function layoutWorldAnchors(beatCount, width, height) {
  const anchors = [];
  for (let i = 0; i < beatCount; i++) {
    anchors.push({
      x: i * width * WORLD_SPACING_X,
      y: height / 2 + Math.sin(i * WANDER_FREQUENCY) * height * WANDER_AMPLITUDE,
      // Content within a beat frames off-center from the camera's
      // rest point (rule-of-thirds), alternating by index - this is
      // what actually stops content from landing dead-center even
      // when the camera is fully at rest on a beat, which a purely
      // anchor-based camera alone would NOT fix (the camera would
      // just center on the anchor and reproduce the exact "always
      // centered" problem this whole rebuild exists to solve).
      contentOffsetX: (i % 2 === 0 ? 1 : -1) * width * 0.09,
      contentOffsetY: (i % 3 === 0 ? -1 : 1) * height * 0.03,
    });
  }
  return anchors;
}

/**
 * Given the full beat list (with start/end times already computed)
 * and their world anchors, returns {camX, camY, camZoom} for any
 * globalTime - a single continuous function covering the whole
 * video, not per-beat state. Beat[i]'s "arrival window" is the first
 * ARRIVAL_FRACTION of its own duration - during that window the
 * camera eases from the previous beat's rest position to this one's;
 * for the rest of the beat's duration the camera holds at rest
 * (with a barely-perceptible organic drift so it never looks frozen).
 */
const ARRIVAL_FRACTION = 0.35;

function getCameraTransform(globalTime, beats, anchors) {
  let beatIndex = beats.findIndex((b) => globalTime >= b.start && globalTime < b.end);
  if (beatIndex === -1) beatIndex = globalTime < beats[0].start ? 0 : beats.length - 1;

  const beat = beats[beatIndex];
  const anchor = anchors[beatIndex];
  const restX = anchor.x + anchor.contentOffsetX;
  const restY = anchor.y + anchor.contentOffsetY;

  const localT = globalTime - beat.start;
  const arrivalWindow = beat.duration * ARRIVAL_FRACTION;

  let camX, camY;

  if (beatIndex === 0 || localT >= arrivalWindow) {
    // At rest (or the very first beat, which has nowhere to arrive
    // from) - hold position with a slow, tiny organic drift so it
    // never reads as a frozen frame.
    const drift = Math.sin(globalTime * 0.3) * 6;
    camX = restX + drift;
    camY = restY + Math.cos(globalTime * 0.22) * 4;
  } else {
    // Arriving: ease from the previous beat's rest position to this
    // one's over the arrival window.
    const prevAnchor = anchors[beatIndex - 1];
    const prevRestX = prevAnchor.x + prevAnchor.contentOffsetX;
    const prevRestY = prevAnchor.y + prevAnchor.contentOffsetY;
    const t = easeInOutCubic(clamp01(localT / arrivalWindow));
    camX = lerp(prevRestX, restX, t);
    camY = lerp(prevRestY, restY, t);
  }

  // A very slight zoom-out during the arrival move (pulling back to
  // "see the path" while traveling) and zoom-in once settled -
  // camera movement, not just a translate, matching how a real
  // physical camera move reads.
  let camZoom;
  if (beatIndex === 0 || localT >= arrivalWindow) {
    // Was settling zoom over an ADDITIONAL window after position had
    // already finished arriving - position stops, then zoom keeps
    // drifting alone for another beat.duration*0.2 seconds afterward.
    // That disconnect between "the pan is done" and "the camera is
    // still doing something" is exactly what reads as lag. Now both
    // finish at the same instant - one unified move, not two
    // staggered ones.
    camZoom = 1;
  } else {
    const t = clamp01(localT / arrivalWindow);
    const bow = Math.sin(t * Math.PI); // 0 -> 1 -> 0 across the move
    camZoom = lerp(1, 0.94, bow);
  }

  return { camX, camY, camZoom, beatIndex };
}

/**
 * Applies the camera transform to the canvas - everything drawn
 * after this call happens in world space until restored. Content
 * drawing at its own anchor position (not width/2, height/2) will
 * land in the right place on screen automatically.
 */
function applyCameraTransform(ctx, camX, camY, camZoom, width, height) {
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(camZoom, camZoom);
  ctx.translate(-camX, -camY);
}

/**
 * A beat is visible (worth drawing this frame) if globalTime falls
 * within its own [start,end] OR within the arrival window of the
 * NEXT beat (so the outgoing beat keeps rendering, fading out, while
 * the camera pans away from it toward the next one) OR within its
 * own arrival window (fading in while the camera arrives). Returns
 * the list of beat indices to draw this frame, almost always 1, briefly
 * 2 during a camera move.
 */
function getVisibleBeatIndices(globalTime, beats) {
  const visible = [];
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    if (globalTime >= beat.start && globalTime < beat.end) {
      visible.push(i);
    }
  }
  // Keep the previous beat drawing (fading out) during the next
  // beat's arrival window, even though globalTime has technically
  // passed its own end - this is what makes the outgoing content
  // visibly leave as the camera pans away, instead of vanishing the
  // instant the clock crosses the boundary.
  const currentIdx = visible[0];
  if (currentIdx !== undefined && currentIdx > 0) {
    const beat = beats[currentIdx];
    const localT = globalTime - beat.start;
    const arrivalWindow = beat.duration * ARRIVAL_FRACTION;
    if (localT < arrivalWindow) {
      visible.unshift(currentIdx - 1);
    }
  }
  return visible;
}

/**
 * Opacity multiplier for a beat at the given globalTime, on top of
 * whatever entrance/exit animation the template itself already does
 * internally. 1 when fully in its own active window, fading to 0
 * during the NEXT beat's arrival window (this beat becoming beatIndex
 * - 1 relative to whichever beat is arriving).
 */
function getBeatCameraOpacity(beatIdx, globalTime, beats) {
  const beat = beats[beatIdx];
  if (globalTime >= beat.start && globalTime < beat.end) {
    // Still within its own window - check if the NEXT beat has
    // already started arriving (i.e. we're in the shared overlap
    // region right at the end of this beat).
    const next = beats[beatIdx + 1];
    if (next) {
      const nextLocalT = globalTime - next.start;
      if (nextLocalT >= 0 && nextLocalT < next.duration * ARRIVAL_FRACTION) {
        const fadeT = clamp01(nextLocalT / (next.duration * ARRIVAL_FRACTION));
        return lerp(1, 0, easeInOutCubic(fadeT));
      }
    }
    return 1;
  }
  // Being drawn because the NEXT beat is arriving and pulled us in
  // via getVisibleBeatIndices.
  const next = beats[beatIdx + 1];
  if (next) {
    const nextLocalT = globalTime - next.start;
    const fadeT = clamp01(nextLocalT / (next.duration * ARRIVAL_FRACTION));
    return lerp(1, 0, easeInOutCubic(fadeT));
  }
  return 0;
}

module.exports = {
  layoutWorldAnchors,
  getCameraTransform,
  applyCameraTransform,
  getVisibleBeatIndices,
  getBeatCameraOpacity,
  ARRIVAL_FRACTION,
};
