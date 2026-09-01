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
function buildTimeline(sceneJSON) {
  let cursor = 0;
  const beatRanges = (sceneJSON.scenes || []).map((scene) => {
    const duration = Math.max(0.4, Number(scene.params?.duration) || 3);
    const start = cursor;
    cursor += duration;
    return {
      scene, duration, start, end: cursor,
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

module.exports = { buildTimeline, findActiveBeatIndex };
