const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
// From the canvas-free timeline module, not renderEngine.js directly -
// this file runs in the PARENT process, which NEVER draws a frame
// itself, for a short video or a long/chunked one - every actual render
// happens in a forked chunk-worker process (see renderSingleChunk
// below), always with --expose-gc, even for a video short enough to be
// "one chunk." Requiring renderEngine.js here would load @napi-rs/canvas
// into this long-lived parent for no reason, since this file itself
// never calls into it directly. See engine/timeline.js's own doc
// comment for the real, measured cost this avoids.
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
// Renamed from CHUNK_SIZE_SECONDS (2026-09-16, real production finding -
// see computeChunkRanges below, kept in sync with render-worker's own
// copy of this same fix): this is now a CEILING on a chunk's length,
// not a fixed size every chunk actually used.
const MAX_CHUNK_SECONDS = 3;
// Must match renderEngine.js's own FPS - deliberately duplicated, not
// imported, since this file never requires renderEngine.js (would load
// @napi-rs/canvas and the whole effects chain into this long-lived
// parent process for no reason). Needed so chunk boundaries can be
// snapped to an exact frame time - see computeChunkRanges' own doc
// comment (render-worker/longVideoOrchestrator.js has the full writeup;
// kept here only where it differs from that copy).
const FPS = 30;
// A single beat only gets force-split once its own duration exceeds
// this - see render-worker/longVideoOrchestrator.js's own copy of this
// constant for the full real-numbers reasoning (production per-frame
// cost vs. the 4-minute chunk timeout).
const SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS = 4;

/**
 * See render-worker/longVideoOrchestrator.js's own copy of this function
 * for the full doc comment (real production finding, the sliver-chunk
 * false start, and the frame-snapping correctness requirement) - kept
 * identical here so this fallback (local-render) path produces the same
 * chunk boundaries a worker would.
 */
function computeChunkRanges(sceneJSON) {
  const { totalDuration, beatRanges } = buildTimeline(sceneJSON);
  const snap = (t) => Math.round(t * FPS) / FPS;
  const snappedBeats = beatRanges.map((r) => ({ start: snap(r.start), end: snap(r.end) }));
  const snappedTotal = snap(totalDuration);

  const chunkRanges = [];
  const pushChunk = (start, end) => {
    const clippedEnd = Math.min(end, snappedTotal);
    if (clippedEnd <= start) return;
    chunkRanges.push({ start, end: clippedEnd });
  };

  let pendingStart = 0;
  for (let i = 0; i < snappedBeats.length; i++) {
    const beat = snappedBeats[i];
    const beatDuration = beat.end - beat.start;

    if (beatDuration > SINGLE_BEAT_SPLIT_THRESHOLD_SECONDS) {
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
      pushChunk(pendingStart, beat.start);
      pendingStart = beat.start;
    }
  }
  if (pendingStart < snappedTotal) pushChunk(pendingStart, snappedTotal);
  return chunkRanges;
}

// See render-worker/longVideoOrchestrator.js's own copy of these for the
// full real-production-incident writeup (a chunk failure had ZERO retry
// logic on this fallback-local-render path, and a direct user
// requirement to wait before retrying so residual memory pressure has a
// real chance to clear rather than repeating an identical doomed
// attempt). Kept identical here so local fallback rendering behaves the
// same way a worker does.
const CHUNK_RETRY_MAX_ATTEMPTS = 3;
const CHUNK_RETRY_DELAY_MS = 15 * 1000;

async function renderChunkWithRetries(jobId, sceneJSON, start, end, chunkPath, index, onChunkProgress) {
  let attempt = 1;
  for (;;) {
    try {
      await renderSingleChunk(jobId, sceneJSON, start, end, chunkPath, index, onChunkProgress);
      return;
    } catch (err) {
      if (attempt >= CHUNK_RETRY_MAX_ATTEMPTS) {
        throw new Error(`chunk ${index} failed ${attempt} time(s), giving up: ${err.message}`);
      }
      console.warn(`[longVideoOrchestrator] job ${jobId} chunk ${index} failed (attempt ${attempt}/${CHUNK_RETRY_MAX_ATTEMPTS}): ${err.message} - waiting ${CHUNK_RETRY_DELAY_MS / 1000}s then retrying`);
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_DELAY_MS));
    }
  }
}

/**
 * Renders sceneJSON to outputPath, transparently chunking if the
 * video is long enough to need it. onProgress receives 0-100 across
 * the WHOLE video regardless of how many chunks it took internally.
 *
 * Real, live production memory-safety bug fixed here (2026-09-03,
 * direct user report: "the memory problem... that is very dangerous"):
 * this used to call renderJobToFile DIRECTLY, in-process, for any video
 * <= CHUNK_THRESHOLD_SECONDS - meaning it ran inside the SAME long-lived
 * server process that handles every job, with no --expose-gc.
 * renderEngine.js's own periodic global.gc() call is a silent no-op
 * without that flag (see its own doc comment), so native Skia pixel
 * memory piled up UNRECLAIMED for the whole render. Confirmed directly,
 * not assumed: identical content measured a flat ~150MB RSS with
 * --expose-gc present versus climbing past 2.4GB without it, for
 * literally the same 5-second, 2-beat render. Worse than a one-off
 * spike: because this ran in the SHARED, PERSISTENT process rather than
 * a disposable fork, that unreclaimed memory never came back down when
 * the job finished - it permanently raised the server's own baseline,
 * compounding with every short video rendered over the process's
 * uptime, a real path to eventually OOM-killing the whole service
 * regardless of any single job's size. Fixed by routing it through the
 * exact same renderSingleChunk fork (--expose-gc included) the
 * long-video path already uses and trusts, treating a short video as a
 * single chunk spanning its own whole [0, totalDuration) -
 * concatChunks isn't needed for just one file, so this renames it
 * straight to the final path.
 */
async function renderLongFormVideo(jobId, sceneJSON, onProgress) {
  const { totalDuration } = buildTimeline(sceneJSON);

  if (totalDuration <= CHUNK_THRESHOLD_SECONDS) {
    const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-chunks`);
    fs.mkdirSync(workDir, { recursive: true });
    const chunkPath = path.join(workDir, 'chunk-0.mp4');
    await renderChunkWithRetries(jobId, sceneJSON, 0, totalDuration, chunkPath, 0, (pct) => {
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
    const { start, end } = chunkRanges[i];
    const chunkPath = path.join(workDir, `chunk-${i}.mp4`);

    try {
      await renderChunkWithRetries(jobId, sceneJSON, start, end, chunkPath, i, (chunkPct) => {
        if (onProgress) {
          const overallPct = Math.round(((i + chunkPct / 100) / chunkRanges.length) * 100);
          onProgress(Math.min(99, overallPct)); // hold at 99 until concat actually finishes
        }
      });
    } catch (err) {
      for (const p of chunkPaths) fs.unlink(p, () => {});
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      throw err;
    }

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

module.exports = { renderLongFormVideo, CHUNK_THRESHOLD_SECONDS, MAX_CHUNK_SECONDS, computeChunkRanges };
