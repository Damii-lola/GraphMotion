/**
 * buildTimeline/findActiveBeatIndex, extracted out of renderEngine.js
 * into their own canvas-free module. Real, directly measured reason
 * this exists: audioMux.js and longVideoOrchestrator.js both only ever
 * needed this pure timing math, but both used to get it via
 * `require('./renderEngine')` - and requiring that module ALWAYS loads
 * @napi-rs/canvas as a side effect (it's required unconditionally at
 * the top of the file), regardless of which export you actually use.
 * Since renderWorker.js requires both of those modules directly (the
 * PARENT process, never the one that actually draws a frame - that's
 * exclusively done in forked chunk-worker processes), the parent was
 * paying the full canvas-loading cost for no reason: measured live, a
 * real job's parent process sat at a STABLE ~127MB RSS for its entire
 * render (flat across 9 chunks, not growing - a real cost, not a
 * leak), versus ~84MB before rendering started. Multiplied across
 * every concurrently-running job (MAX_CONCURRENT_RENDERS), this was a
 * real, uncounted-for contributor to total memory that had nothing to
 * do with actual frame rendering.
 */
// Real, direct user requirement (2026-09-10): "the scene shouldn't
// start until the camera has finished moving to that scene position."
// Before this, the incoming beat's own content clock and the camera's
// pan-in both started counting from the SAME localT=0 at once - so a
// fast entrance (squareSpin's own sub-1s spin, most notably) could
// finish, or nearly finish, BEFORE the camera had actually arrived,
// leaving little or nothing left to see once it did. Every beat except
// the first now reserves this much REAL EXTRA time up front
// specifically for the incoming pan - renderEngine.js's own frame loop
// clamps the beat's own content clock to hold at its very first frame
// for exactly this long before it starts advancing (see its own
// `beatLocalT` comment). Single source of truth for both files -
// renderEngine.js imports this rather than keeping its own copy, so
// the timeline math here and the frame loop's own pan math can never
// silently drift out of sync with each other.
const DEFAULT_PAN_DURATION_SECONDS = 0.75;
const MAX_PAN_DURATION_SECONDS = 2.0;

function buildTimeline(sceneJSON) {
  let cursor = 0;
  const beatRanges = (sceneJSON.scenes || []).map((scene, i) => {
    const contentDuration = Math.max(0.4, Number(scene.params?.duration) || 3);
    const requestedPanDuration = Number(scene.visual?.transitionIn?.duration) || DEFAULT_PAN_DURATION_SECONDS;
    const panDuration = i > 0 ? Math.min(Math.max(0.05, requestedPanDuration), MAX_PAN_DURATION_SECONDS) : 0;
    const duration = contentDuration + panDuration;
    const start = cursor;
    cursor += duration;
    return {
      scene, duration, contentDuration, panDuration, start, end: cursor,
    };
  });
  return { totalDuration: cursor, beatRanges };
}

/** The beat active at global time `t` - clamps to the last beat once `t` reaches/exceeds totalDuration (Math.ceil rounding on the final chunk's endFrame can land one frame past the true end). */
function findActiveBeatIndex(beatRanges, t) {
  for (let i = 0; i < beatRanges.length; i++) {
    if (t < beatRanges[i].end || i === beatRanges.length - 1) return i;
  }
  return beatRanges.length - 1;
}

module.exports = {
  buildTimeline, findActiveBeatIndex, DEFAULT_PAN_DURATION_SECONDS, MAX_PAN_DURATION_SECONDS,
};
