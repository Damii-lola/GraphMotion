const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
// From the canvas-free timeline module, not renderEngine.js directly -
// this file runs in the PARENT process (renderWorker.js), which NEVER
// draws a frame itself, for a short video or a long/chunked one - every
// actual render happens in a forked chunk-worker process (see
// renderSingleChunk below), always with --expose-gc, even for a video
// short enough to be "one chunk." Requiring renderEngine.js here would
// load @napi-rs/canvas into this long-lived parent for no reason, since
// this file itself never calls into it directly. See engine/timeline.js's
// own doc comment for the real, measured cost this avoids.
const { buildTimeline } = require('./engine/timeline');

// Below this, still forked (see renderLongFormVideo's own doc comment
// for the real memory-safety bug that used to skip the fork here), just
// as a single chunk rather than several - no concatChunks/multi-chunk
// bookkeeping needed. Above it, split into CHUNK_SIZE_SECONDS pieces, each rendered by a
// FRESH forked process - measured, verified necessary: this Skia
// binding accumulates native memory under long sustained renders in
// a way that survives canvas recycling and per-frame yielding within
// one process, but is fully reclaimed when that process exits.
// The PNG-based frame pipeline (renderEngine.js) resolved the actual
// memory issue directly - the old raw-pixel-piping approach leaked
// catastrophically under sustained rendering regardless of chunk size;
// this doesn't. These no longer need to be pushed to their previous
// safety-margin extremes (5s/6s) - restored to more reasonable values
// that reduce per-chunk process-spawn overhead, now that the
// underlying cause is actually fixed rather than worked around.
//
// Pulled back down from 20s/15s after the loadImage-timeout and
// chunk-scoped-image fixes still weren't enough on the real 512MB
// production host - each chunk's own peak (frame buffers + Skia
// native growth + decoded hero images) scales with how much work one
// forked process does before it exits and gets reclaimed. Smaller
// chunks mean more frequent full reclamation and a lower per-process
// ceiling, at the cost of more fork/spawn overhead - worth it when
// the alternative is an OOM-flavored timeout.
//
// Pulled down AGAIN (8 -> 5) after this exact scenario played out for
// real: 8s (192 frames) reliably hit the per-chunk timeout on
// production once frames started rendering genuinely real content
// (real per-frame throughput on Render's actual - meaningfully slower/
// shared - CPU turned out to be ~1.4s/frame even after the memory
// fixes, so 192 frames needed ~270s against a 3-minute timeout). This
// number was calibrated back when a frame was a trivial flat-fill
// placeholder and is stale now that frames do real, heavier
// rendering - smaller chunks are the direct lever for "one chunk's
// total work fits comfortably inside its own timeout" regardless of
// exactly how much slower Render's CPU is than local dev, which isn't
// something measurable from here.
//
// Pulled down a THIRD time (5 -> 3) after 5s chunks STILL timed out in
// production (observed: 10 minutes to cover 10%->48% overall progress,
// implying multiple chunks each taking several minutes). Paired this
// time with real, measured per-frame cost reductions rather than
// chunk-size alone: renderEngine.js's WIDTH/HEIGHT dropped 720x1280 ->
// 540x960 (a controlled, isolated A/B on identical content measured a
// real ~41% time reduction from this alone) and FPS dropped 24 -> 20.
// Smaller chunks are still kept as an independent safety margin on top
// of those - they bound worst-case per-chunk time directly, which
// matters given Render's real throughput relative to local dev still
// isn't something reliably measurable from here.
const CHUNK_THRESHOLD_SECONDS = 10;
// Renamed from CHUNK_SIZE_SECONDS (2026-09-16, real production finding):
// this is now a CEILING on a chunk's length, not a fixed size every
// chunk actually used - see computeChunkRanges below for why a blind
// fixed-clock tick was a real, measured cost, not just an aesthetic
// preference. Kept at the same value the old fixed-size scheme used, so
// worst-case per-chunk frame count/timeout risk is provably no worse
// than before this change - only HOW a cut is chosen changed, not how
// big a chunk can ever get.
const MAX_CHUNK_SECONDS = 3;
// Must match renderEngine.js's own FPS - deliberately duplicated, not
// imported, since this file's own top-of-file comment explains exactly
// why it never requires renderEngine.js (would load @napi-rs/canvas and
// the whole effects chain into this long-lived parent process for no
// reason). Needed here so chunk boundaries can be snapped to an exact
// frame time - see computeChunkRanges' own doc comment for why that
// matters.
const FPS = 30;

/** Thrown by renderLongFormVideo when a job is cancelled mid-render - callers (render-worker/server.js) check for this specific error to write status 'cancelled' instead of 'failed'. */
class RenderCancelledError extends Error {
  constructor(jobId) {
    super(`Render cancelled for job ${jobId}`);
    this.name = 'RenderCancelledError';
  }
}

// A single beat only gets force-split into multiple pieces once its OWN
// duration exceeds this - anything at or under it becomes ONE chunk by
// itself even if that's somewhat past MAX_CHUNK_SECONDS, rather than
// splitting it into an awkward "cap-sized piece + tiny sliver". Sized
// off real production numbers, not a guess: a real job's own chunks
// (render-worker logs, 2026-09-16) measured 0.7-1.65s/frame depending on
// content (worst case 1.65s/frame on a heavy chunk), against a hard
// 4-minute (240s) per-chunk timeout. 4s x FPS(30) = 120 frames x 1.65s
// = 198s, ~40s/17% margin under the timeout - deliberately NOT pushed
// higher (e.g. 2x MAX_CHUNK_SECONDS = 6s/180 frames would cost up to
// 297s, already past the timeout on the worst observed real per-frame
// cost). A beat past this still gets split into MAX_CHUNK_SECONDS-target
// pieces below, the same worst-case chunk size this file has always used.
const SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS = 4;

/**
 * Extracted out of renderLongFormVideo so cross-worker chunk-splitting
 * (see ../chunkDispatch.js) can compute the SAME chunk boundaries a
 * solo render would use, without needing to actually start rendering -
 * a "primary" worker needs this list up front to decide how much to
 * hand off to a sibling before either of them starts real work.
 *
 * Real, measured finding (2026-09-16, from a real production job's own
 * logs): the old version cut a fixed MAX_CHUNK_SECONDS-wide window
 * starting at 0, with zero awareness of where beats actually start/end.
 * renderEngine.js's own frame-building always includes any beat
 * overlapping a chunk's window PLUS that beat's immediate predecessor
 * (needed for the incoming camera pan) - so a chunk landing cleanly
 * inside ONE beat only ever needs 2 beats built (it + predecessor), but
 * a chunk whose window happened to straddle TWO beat boundaries (very
 * likely with a blind fixed tick, since beat lengths are narration-
 * duration-derived and essentially never line up with a clean multiple
 * of MAX_CHUNK_SECONDS) needed 3 - real production chunks were measured
 * at 230-372MB depending purely on which arrangement they landed on, and
 * a beat straddled by two different chunks got its ENTIRE layer set
 * rebuilt from scratch in BOTH of them - real wasted CPU on top of the
 * memory cost.
 *
 * FIRST attempt at fixing this (extend a chunk to the latest beat
 * boundary that fits under MAX_CHUNK_SECONDS, falling back to a raw
 * MAX_CHUNK_SECONDS-wide cut whenever none fit) traded one real problem
 * for another: a beat only slightly over the cap (e.g. 3.2s against a 3s
 * cap) produced a normal-sized chunk PLUS a near-useless 0.2s "sliver"
 * chunk for the remainder - a whole fork/prefetch/ffmpeg-encode's worth
 * of fixed overhead spent on a handful of frames, worse than the
 * problem being solved. Fixed by walking beats directly instead of
 * hunting for boundaries: accumulate consecutive whole beats into one
 * chunk up to MAX_CHUNK_SECONDS, and let a single beat that's already
 * close to (or moderately over) the cap keep its own whole chunk rather
 * than being cut - see SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS above for
 * exactly where "moderately over" stops and a real split starts. Only a
 * beat past that threshold gets internally divided, into
 * MAX_CHUNK_SECONDS-target pieces (never combined with a neighbor's
 * own sliver). Net effect: a chunk needs more than 2 beats built only
 * when it deliberately groups several short beats to make good use of
 * the cap, never as an accident of a boundary landing mid-beat - and
 * every beat gets built in exactly the chunk(s) that actually need its
 * frames, never redundantly in a neighbor over a fragment it barely
 * touches.
 *
 * Every boundary is snapped to an exact FRAME time (Math.round, not the
 * raw beat-end float) before being used as a cut - required for
 * correctness, not just cleanliness: renderTimelineRange computes
 * startFrame/endFrame via Math.floor(time*FPS)/Math.ceil(time*FPS),
 * which only agree across a chunk boundary (no duplicated or dropped
 * frame in the final concat) when that boundary lands on a WHOLE frame
 * number. The old fixed-multiples-of-MAX_CHUNK_SECONDS boundaries
 * satisfied this by construction (MAX_CHUNK_SECONDS*FPS was already a
 * whole number); a raw beat-end time generally does not, so using one
 * unsnapped would render the same frame twice at every single cut - a
 * real, visible freeze at every beat boundary. Snapping costs at most
 * half a frame's worth of timing deviation, well inside the frame
 * quantization every beat's own animation timing already goes through -
 * this only affects where a CHUNK splits, never a beat's own recorded
 * start/end used for its actual animation math.
 */
function computeChunkRanges(sceneJSON) {
  const { totalDuration, beatRanges } = buildTimeline(sceneJSON);
  const snap = (t) => Math.round(t * FPS) / FPS;
  // Snapped ONCE, up front, and used everywhere below (comparisons,
  // pendingStart, chunk edges) - a real bug turned up testing this: an
  // earlier version snapped only at the moment a chunk got pushed but
  // carried the RAW beat.start forward into `pendingStart` for the next
  // iteration, so a chunk's own (snapped) end and the next chunk's
  // (unsnapped) start could differ by half a frame - reintroducing the
  // exact duplicate-frame bug snapping exists to prevent, just moved to
  // a different boundary. Working from one already-snapped array of
  // {start,end} for the rest of this function closes that gap - nothing
  // downstream ever touches a raw beatRanges value again.
  const snappedBeats = beatRanges.map((r) => ({ start: snap(r.start), end: snap(r.end) }));
  const snappedTotal = snap(totalDuration);

  const chunkRanges = [];
  let index = 0;
  const pushChunk = (start, end) => {
    const clippedEnd = Math.min(end, snappedTotal);
    if (clippedEnd <= start) return; // guards float rounding from ever emitting a zero/negative-length chunk
    chunkRanges.push({ start, end: clippedEnd, index: index++ });
  };

  let pendingStart = 0; // start of whatever run of whole beats is currently being accumulated into one chunk
  for (let i = 0; i < snappedBeats.length; i++) {
    const beat = snappedBeats[i];
    const beatDuration = beat.end - beat.start;

    if (beatDuration > SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS) {
      // This one beat alone needs its own split - flush whatever whole
      // beats were already accumulated first (ending exactly at this
      // beat's own start, a real boundary), then divide just this beat
      // into MAX_CHUNK_SECONDS-target pieces.
      if (pendingStart < beat.start) pushChunk(pendingStart, beat.start);
      const pieces = Math.ceil(beatDuration / MAX_CHUNK_SECONDS);
      const pieceLen = beatDuration / pieces;
      let pieceStart = beat.start;
      for (let p = 0; p < pieces; p++) {
        const pieceEnd = p === pieces - 1 ? beat.end : snap(pieceStart + pieceLen);
        pushChunk(pieceStart, pieceEnd);
        pieceStart = pieceEnd;
      }
      pendingStart = beat.end;
    } else if (beat.end - pendingStart > MAX_CHUNK_SECONDS && pendingStart < beat.start) {
      // Including this beat would push the accumulated run past the
      // cap - flush what's already accumulated (ending at this beat's
      // own start) and start a fresh run from here. The `pendingStart
      // < beat.start` guard is what lets a FIRST beat in a fresh run
      // keep its own whole chunk even when it's alone past the cap
      // (nothing to flush ahead of it yet) - the whole point of
      // SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS existing as a separate,
      // more generous threshold than this accumulation cap.
      pushChunk(pendingStart, beat.start);
      pendingStart = beat.start;
    }
    // else: still fits - keep accumulating, this beat's own end becomes
    // the tentative chunk end whenever the run above is next flushed.
  }
  if (pendingStart < snappedTotal) pushChunk(pendingStart, snappedTotal);
  return chunkRanges;
}

/**
 * Renders sceneJSON to outputPath, transparently chunking if the
 * video is long enough to need it. onProgress receives 0-100 across
 * the WHOLE video regardless of how many chunks it took internally.
 * `isCancelled` (optional) is checked between chunks - direct user
 * request for a cancel button. Only checked at chunk boundaries, not
 * mid-chunk: chunks are already small (at most a few seconds of video
 * each, see MAX_CHUNK_SECONDS/SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS above),
 * so the worst case is finishing one chunk
 * already in flight before actually stopping, not a real delay. The
 * short-video branch below is now just a single chunk covering the
 * whole video, so it gets the same one cancel-check the multi-chunk
 * loop gives each of its own chunks.
 *
 * Real, live production memory-safety bug fixed here (2026-09-03,
 * direct user report: "the memory problem... that is very dangerous"):
 * this used to call renderJobToFile DIRECTLY, in-process, for any video
 * <= CHUNK_THRESHOLD_SECONDS - meaning it ran inside the SAME long-lived
 * render-worker server process that handles every job, with no
 * --expose-gc. renderEngine.js's own periodic global.gc() call is a
 * silent no-op without that flag (see its own doc comment), so native
 * Skia pixel memory piled up UNRECLAIMED for the whole render. Confirmed
 * directly, not assumed: identical content measured a flat ~150MB RSS
 * with --expose-gc present versus climbing past 2.4GB without it, for
 * literally the same 5-second, 2-beat render. Worse than a one-off
 * spike: because this ran in the SHARED, PERSISTENT process rather than
 * a disposable fork, that unreclaimed memory never came back down when
 * the job finished - it permanently raised the server's own baseline,
 * compounding with every short video rendered over the process's
 * uptime, a real path to eventually OOM-killing the whole service
 * regardless of any single job's size. This file's own top-of-file
 * comment already documented the INTENDED architecture ("this file...
 * never draws a frame itself... that's exclusively done in forked
 * chunk-worker processes") - the short-video branch was the one
 * violation of it. Fixed by routing it through the exact same
 * renderSingleChunk fork (--expose-gc included) the long-video path
 * already uses and trusts, treating a short video as a single chunk
 * spanning its own whole [0, totalDuration) - concatChunks isn't needed
 * for just one file, so this renames it straight to the final path.
 */
async function renderLongFormVideo(jobId, sceneJSON, onProgress, isCancelled) {
  const { totalDuration } = buildTimeline(sceneJSON);

  if (totalDuration <= CHUNK_THRESHOLD_SECONDS) {
    if (isCancelled && isCancelled()) throw new RenderCancelledError(jobId);
    const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-chunks`);
    fs.mkdirSync(workDir, { recursive: true });
    const chunkPath = path.join(workDir, 'chunk-0.mp4');
    await renderSingleChunk(jobId, sceneJSON, 0, totalDuration, chunkPath, 0, (pct) => {
      if (onProgress) onProgress(Math.min(99, pct)); // hold at 99 until the rename below actually finishes, matching the multi-chunk path's own convention
    });
    const finalOutputPath = path.join(os.tmpdir(), 'shortform-renders', `${jobId}.mp4`);
    fs.renameSync(chunkPath, finalOutputPath);
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    if (onProgress) onProgress(100);
    return finalOutputPath;
  }

  const chunkRanges = computeChunkRanges(sceneJSON);

  const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-chunks`);
  fs.mkdirSync(workDir, { recursive: true });

  const chunkPaths = [];

  // Sequential, deliberately not Promise.all - running chunks
  // concurrently would multiply peak memory by however many run at
  // once, defeating the entire point of chunking. One at a time keeps
  // peak memory bounded to a single chunk regardless of total video
  // length.
  for (let i = 0; i < chunkRanges.length; i++) {
    if (isCancelled && isCancelled()) {
      for (const p of chunkPaths) fs.unlink(p, () => {});
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      throw new RenderCancelledError(jobId);
    }

    const { start, end } = chunkRanges[i];
    const chunkPath = path.join(workDir, `chunk-${i}.mp4`);

    await renderSingleChunk(jobId, sceneJSON, start, end, chunkPath, i, (chunkPct) => {
      if (onProgress) {
        const overallPct = Math.round(((i + chunkPct / 100) / chunkRanges.length) * 100);
        onProgress(Math.min(99, overallPct)); // hold at 99 until concat actually finishes
      }
    });

    chunkPaths.push(chunkPath);

    // Small explicit buffer even after the child's exit event has
    // fired - Node's 'exit' event confirms the process has terminated,
    // but full OS-level memory reclamation can trail slightly behind
    // it under real memory pressure. Cheap insurance against the exact
    // failure mode just fixed above, given how severe it was (crashed
    // every long-video render reliably at the first chunk boundary).
    if (i < chunkRanges.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  const finalOutputPath = path.join(os.tmpdir(), 'shortform-renders', `${jobId}.mp4`);
  await concatChunks(chunkPaths, finalOutputPath);

  // Clean up the working chunk files now that the final file exists.
  for (const p of chunkPaths) fs.unlink(p, () => {});
  fs.rmdir(workDir, () => {});

  if (onProgress) onProgress(100);
  return finalOutputPath;
}

// V8's default old-space ceiling scales with total system memory, which
// on a capped container is a lie the process believes until it's too
// late. History here: 220 was tried and looked like it made things
// WORSE (chunk 0, the very first and smallest slice of work, started
// timing out) - the working theory was V8 GC-thrashing under a too-
// tight JS-heap cap (fighting for headroom instead of crashing or
// progressing, indistinguishable from a hang to the outer fork-level
// timeout) rather than an actual overrun, so the cap was raised to 400
// on that theory. But chunk 0 STILL times out at 400 (see server.js's
// real /api/generate failure this was found from), which that theory
// alone doesn't explain, AND this flag was always the wrong lever for
// the actual dominant cost anyway - renderEngine.js's own measured gc()
// -cadence numbers put real peak RSS at ~245-589MB from native Skia
// pixel buffers alone, entirely outside what --max-old-space-size ever
// bounds (JS heap only). Pulled down to 100 as an explicit hard product
// requirement on real per-process memory budget (the actual host has
// far less headroom than 400MB once the parent process, OS, and ffmpeg
// share the same instance) - NOT a claim that this alone makes real RSS
// fit under 100MB, since the JS-heap cap was never what real RSS lived
// in. Getting real peak RSS down to match this requires the OTHER real
// levers (CHUNK_SIZE_SECONDS, gc() cadence, WIDTH/HEIGHT) verified
// against actual measured numbers, not this flag in isolation.
const CHUNK_WORKER_MAX_OLD_SPACE_MB = 100;

function renderSingleChunk(jobId, sceneJSON, timeStart, timeEnd, outputPath, chunkIndex, onProgress) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'renderChunkWorker.js'), {
      stdio: 'inherit',
      // --expose-gc: required for renderEngine.js's own periodic
      // global.gc() calls to actually run - see its doc comment at the
      // call site. Without this, native Skia canvas memory piles up
      // essentially unbounded within a single chunk (measured directly:
      // ~50MB/frame with no ceiling), which --max-old-space-size alone
      // never covered since it only bounds the JS heap.
      execArgv: [`--max-old-space-size=${CHUNK_WORKER_MAX_OLD_SPACE_MB}`, '--expose-gc'],
    });

    // Real bug fixed here: this used to resolve/reject the moment the
    // IPC message arrived, then the orchestrator's loop immediately
    // forked the NEXT chunk - but process.send() and process.exit()
    // are two independent async events, and the OS can still be
    // mid-teardown (reclaiming the previous chunk's Skia/ffmpeg
    // memory) when the next chunk's fork() already starts allocating
    // its own. That overlap window is a real memory spike, and it
    // explains exactly the reported symptom: a crash that reliably
    // hits at the first chunk boundary, not randomly mid-render. Now
    // BOTH the IPC result AND the actual 'exit' event must happen
    // before this promise settles, guaranteeing the previous
    // process's resources are actually reclaimed before the next
    // chunk is allowed to start.
    let settled = false;
    let ipcResult = null; // { ok: true, outputPath } | { ok: false, error }
    let hasExited = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Chunk ${chunkIndex} timed out`));
      }
    }, 4 * 60 * 1000); // 4 min per-chunk safety timeout (raised from 3min after
    // a real production timeout: an 8s/192-frame chunk hit 3 minutes
    // mid-render on Render's actual host, confirmed via the per-frame
    // logging this comment used to speculate about needing - real
    // throughput there measured at ~1.4s/frame even after the memory
    // fixes (~4x slower than local dev's per-frame cost with the same
    // fixes applied). CHUNK_SIZE_SECONDS was ALSO cut 8->5 above for the
    // same incident - the two changes together, not either alone, are
    // what actually bounds a real chunk's total time safely under this
    // limit. This margin stacks on top of that reduction rather than
    // substituting for it, since Render's exact throughput isn't
    // something reliably measurable from local dev.

    function maybeFinish() {
      if (settled || !hasExited) return;
      settled = true;
      clearTimeout(timeout);
      if (ipcResult && ipcResult.ok) {
        resolve(ipcResult.outputPath);
      } else if (ipcResult && !ipcResult.ok) {
        reject(new Error(`Chunk ${chunkIndex} failed: ${ipcResult.error}`));
      } else {
        reject(new Error(`Chunk ${chunkIndex} process exited without reporting a result (likely OOM-killed)`));
      }
    }

    child.on('message', (msg) => {
      if (!msg || msg.chunkIndex !== chunkIndex) return;
      if (msg.type === 'chunk_progress' && onProgress) {
        onProgress(msg.progress);
      } else if (msg.type === 'chunk_complete') {
        ipcResult = { ok: true, outputPath: msg.outputPath };
      } else if (msg.type === 'chunk_failed') {
        ipcResult = { ok: false, error: msg.error };
      }
    });

    child.on('exit', () => {
      hasExited = true;
      maybeFinish();
    });

    child.send({ jobId, sceneJSON, timeStart, timeEnd, outputPath, chunkIndex });
  });
}

/**
 * Stream-copy concat (no re-encode - all chunks share identical
 * codec/resolution/fps, so this is fast and lossless, not a second
 * full encode pass).
 */
function concatChunks(chunkPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + '.concat-list.txt';
    const listContent = chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
    ]);

    let err = '';
    ffmpeg.stderr.on('data', (d) => { err += d.toString(); });
    ffmpeg.on('close', (code) => {
      fs.unlink(listPath, () => {});
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg concat exited with code ${code}: ${err.slice(-500)}`));
    });
    ffmpeg.on('error', reject);
  });
}

module.exports = {
  renderLongFormVideo,
  RenderCancelledError,
  CHUNK_THRESHOLD_SECONDS,
  MAX_CHUNK_SECONDS,
  // Exported specifically for chunkDispatch.js's cross-worker split -
  // a "helper" worker renders only ITS assigned subset of chunks via
  // renderSingleChunk directly (skipping renderLongFormVideo's own
  // full chunk-range computation and concat), and the "primary" needs
  // computeChunkRanges to plan the split and concatChunks to stitch
  // its own chunks back together with whatever a helper returns.
  computeChunkRanges,
  renderSingleChunk,
  concatChunks,
};
