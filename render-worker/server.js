require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const { prefetchBeatImages, cleanupBeatImages } = require('./imagePrefetch');
const {
  renderLongFormVideo, RenderCancelledError, CHUNK_THRESHOLD_SECONDS,
  computeChunkRanges, renderSingleChunk, concatChunks,
} = require('./longVideoOrchestrator');
const { muxNarrationOntoVideo, speedUpVideo } = require('./audioMux');
const { updateJob, uploadRenderedVideo } = require('./supabaseClient');
const { getAvailableSibling, requestHelp } = require('./chunkDispatch');

/**
 * Render-only worker service. Part of a coordinator/worker split added
 * to work around a real memory ceiling: the main backend (../backend)
 * does prompt -> Gemini scene JSON -> narration (TTS + the audio QA
 * judge), then hands a fully-narrated job off to one of these - each
 * worker does ONLY image/icon prefetch + the actual Skia render + ffmpeg
 * mux, then uploads straight to Supabase and updates the job row
 * itself. The frontend already polls the main backend's /api/jobs/:id,
 * which just reads that same Supabase row, so nothing routes back
 * through the coordinator - the result "just appears" once this worker
 * finishes. See ../backend/renderDispatch.js for the coordinator side
 * (capacity-based worker selection, retry/fallback to local rendering
 * if no worker is available).
 *
 * Deployed as its own Render service with this folder as its Root
 * Directory - a sibling to /backend, not nested inside it, since
 * Render's per-service deploy only ships the configured root
 * directory's contents. That's also why the render-path files this
 * needs (renderEngine.js, sceneBuilder.js, engine/, audioMux.js,
 * imagePrefetch.js, imageGen.js, iconFetch(Worker).js,
 * renderChunkWorker.js, longVideoOrchestrator.js, supabaseClient.js)
 * are copied here rather than required from ../backend - reaching
 * outside this folder wouldn't resolve on a deployed instance where
 * only render-worker/ exists. Keep these in sync with ../backend
 * manually if the rendering logic itself changes.
 */

const app = express();
// Narration audio for a whole video is small (a few hundred KB) but
// base64 inflates that ~33% - 25mb is generous headroom, not a real
// payload size expectation.
app.use(express.json({ limit: '25mb' }));

process.on('unhandledRejection', (reason) => {
  console.error('[render-worker] unhandledRejection, staying up despite:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[render-worker] uncaughtException, staying up despite:', err);
});

// Direct user instruction: 3 concurrent renders per worker.
const MAX_CONCURRENT_RENDERS = 3;
let activeRenders = 0;

// jobIds the coordinator has asked to cancel - checked between chunks
// in renderLongFormVideo (see its own isCancelled param). A Set, not a
// per-job object, since this worker doesn't otherwise track individual
// job state outside the single handleRenderJob call handling it.
const cancelledJobs = new Set();

app.get('/health', (req, res) => {
  res.json({ ok: true, activeRenders, maxConcurrent: MAX_CONCURRENT_RENDERS });
});

// Direct user request (cancel button). Best-effort and fire-and-forget
// from the coordinator's side (see ../backend/renderDispatch.js's
// cancelJobOnWorker) - always returns 200 whether or not this jobId is
// actually running here right now, since the coordinator doesn't wait
// on this to confirm anything and a job that already finished or was
// never dispatched here isn't an error case worth surfacing.
app.post('/cancel/:jobId', (req, res) => {
  cancelledJobs.add(req.params.jobId);
  res.json({ ok: true });
});

// Polled by the coordinator (../backend/renderDispatch.js) to pick a
// worker with a free slot - the SAME request also serves as the
// keep-alive ping that stops this service's Render free-tier instance
// from sleeping (Render sleeps on inbound-traffic idleness, so an
// internal setInterval here couldn't accomplish that on its own; the
// coordinator's periodic hit on this endpoint is what does it).
app.get('/capacity', (req, res) => {
  res.json({ activeRenders, maxConcurrent: MAX_CONCURRENT_RENDERS, available: activeRenders < MAX_CONCURRENT_RENDERS });
});

function iconsDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-icons`);
}
function cleanupIcons(jobId) {
  fs.rm(iconsDirFor(jobId), { recursive: true, force: true }, () => {});
}

/** Same disposable-child-process isolation as ../backend/renderWorker.js's own prefetchIconsIsolated - @resvg/resvg-js's native SVG rasterizer cost is paid and reclaimed in a throwaway process rather than sitting in this long-lived worker for its whole uptime. */
function prefetchIconsIsolated(sceneJSON, jobId) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'iconFetchWorker.js'), {
      execArgv: ['--max-old-space-size=150'],
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('icon fetch worker timed out'));
    }, 30000);

    child.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (msg && msg.ok) resolve(msg.renderSceneJSON);
      else reject(new Error((msg && msg.error) || 'icon fetch worker failed with no error message'));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`icon fetch worker exited unexpectedly (code ${code})`));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.send({ sceneJSON, jobId });
  });
}

function narrationDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-narration`);
}

/**
 * Real, measured cause found after a direct user report ("using a ton
 * of memory" / "incredibly slow"): longVideoOrchestrator.js's own
 * extensive history (see its doc comments) already fought hard to get
 * ONE active chunk-render's real peak RSS down to ~245-589MB on a
 * memory-capped host - that number is native Skia buffer memory,
 * entirely outside what --max-old-space-size bounds. That work assumed
 * only ONE chunk-worker is ever active at a time, which was true when
 * this ran as a single job per process. It stopped being true here:
 * MAX_CONCURRENT_RENDERS lets up to 3 jobs be in flight on one worker,
 * and each job's OWN chunks are sequential, but nothing stopped
 * DIFFERENT jobs' active chunk-workers from overlapping - 3 concurrent
 * jobs could mean 3 simultaneous ~245-589MB native processes, up to
 * ~1.8GB of real pressure, which explains both symptoms directly: the
 * memory spike, AND the slowness (memory pressure causes exactly the
 * V8 GC-thrashing longVideoOrchestrator.js's own history already
 * documents for the single-job case - not a coincidence, the same
 * mechanism, just re-triggered by concurrency instead of chunk size).
 *
 * Fix: keep accepting up to MAX_CONCURRENT_RENDERS jobs (image/icon
 * prefetch - network I/O, low memory - still runs concurrently across
 * them), but serialize the actual chunk-rendering step itself through
 * this lock, so only ONE job's Skia rendering is ever active on this
 * worker at a time regardless of how many jobs are in flight. Restores
 * the single-render memory ceiling all that prior tuning was actually
 * calibrated for.
 */
let renderLockTail = Promise.resolve();
function withRenderLock(fn) {
  const run = renderLockTail.then(fn, fn);
  renderLockTail = run.then(() => {}, () => {});
  return run;
}

/**
 * Handles a sibling's help request (see chunkDispatch.js and
 * renderWithPossibleHelp below) - renders exactly the chunk ranges
 * asked for and returns them as base64, nothing else. Does its OWN
 * full image/icon prefetch even though it's only rendering a SUBSET of
 * the video's beats - a chunk's own rendered frames can still
 * reference any beat's image/icon depending on where that beat's own
 * on-screen time falls, and these fetches use free keyless URLs, so
 * redundant fetching across the primary and this helper costs a little
 * duplicate network time, never correctness. Goes through the SAME
 * withRenderLock as a normal /render job - a help request is exactly
 * as memory-heavy as a normal one while it's actually rendering, and
 * this worker still only has room for one such active render at a time
 * regardless of which route asked for it.
 */
async function handleRenderChunksRequest(jobId, sceneJSON, chunkRanges) {
  const imageResolvedSceneJSON = await prefetchBeatImages(sceneJSON, jobId);
  const renderSceneJSON = await prefetchIconsIsolated(imageResolvedSceneJSON, jobId);

  const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-help-chunks`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    return await withRenderLock(async () => {
      const results = [];
      for (const range of chunkRanges) {
        const chunkPath = path.join(workDir, `chunk-${range.index}.mp4`);
        await renderSingleChunk(jobId, renderSceneJSON, range.start, range.end, chunkPath, range.index, () => {});
        results.push({ index: range.index, base64: fs.readFileSync(chunkPath).toString('base64') });
      }
      return results;
    });
  } finally {
    cleanupBeatImages(jobId);
    cleanupIcons(jobId);
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Drop-in replacement for calling renderLongFormVideo directly - tries
 * to split a long video's chunks across this worker and ONE available
 * sibling before falling back to rendering every chunk itself, exactly
 * as renderLongFormVideo already does. Short videos (no chunking
 * needed at all) and the case where no sibling has room both fall
 * through to the ORIGINAL, unchanged solo path - this only changes
 * behavior when there's real chunked work AND real help available.
 *
 * Splits roughly in half by chunk COUNT (not by content) - simple, and
 * each chunk costs about the same regardless of what it contains, so
 * an even split is already a good balance. Kicks off the sibling
 * request and this worker's own half CONCURRENTLY (Promise.all), not
 * sequentially, since that's the entire point - waiting on one before
 * starting the other would throw away the parallelism this exists for.
 * If the sibling request fails for any reason, its assigned chunks are
 * rendered locally as a fallback (slower than the happy path, but
 * still correct - a flaky sibling should never lose real chunks).
 */
// Real, severe, confirmed-live bug fixed here (2026-09-04, direct user
// report with the actual video attached: a watermark icon rendering
// fine for the first several seconds of a beat then vanishing outright
// mid-beat, never to return, while everything else - text, highlight
// chip, sparkles - kept going completely normally). Root-caused by
// reading this file's own doc comments against what iconFetch.js
// actually does, not by guessing: this function used to receive
// sceneJSON with icons ALREADY resolved (handleRenderJob called
// prefetchIconsIsolated before ever calling this) - fine for the solo
// path, but the moment a sibling gets involved, `requestHelp` forwards
// that SAME already-resolved sceneJSON to the sibling, whose own icon
// layers had their "icon" field already DELETED by THIS worker's
// resolution pass (iconFetch.js deletes it once resolved, leaving only
// a local "src" file path) - a path that only exists on THIS worker's
// disk. The sibling's own prefetchIconsIsolated call (in
// handleRenderChunksRequest below) finds zero icon layers left to
// resolve and renders the scene exactly as received, complete with a
// "src" pointing at a file that doesn't exist on ITS filesystem -
// silently producing an invisible icon for every frame it renders.
// Confirmed directly: a 7-chunk video splits primary/sibling exactly
// at chunk 4 (t=12s at 3s/chunk) - precisely where the reported video's
// icon disappeared. This file's own doc comment on
// handleRenderChunksRequest even said redundant re-fetching across
// primary and sibling "costs a little duplicate network time, never
// correctness" - true for hero images (imagePrefetch.js never deletes
// "imagePrompt", so a sibling harmlessly redoes that work), but NOT
// true for icons once the delete was added - an assumption that held
// for one prefetch step silently stopped holding for its neighbor.
//
// Fixed by deferring icon resolution until AFTER the split decision:
// `sceneJSON` here stays icon-RAW (the "icon" field intact) all the way
// through until it's actually needed. The sibling gets the raw
// version and resolves its own copy on its own disk exactly as
// designed; this worker resolves its own separate local copy
// (`renderSceneJSON`) just for its own chunks, right where it used to
// resolve the one shared copy.
async function renderWithPossibleHelp(jobId, sceneJSON, onProgress, isCancelled) {
  const chunkRanges = computeChunkRanges(sceneJSON);

  if (chunkRanges.length <= 1) {
    // Not even chunked (CHUNK_THRESHOLD_SECONDS not exceeded) - nothing
    // to split, renderLongFormVideo's own short-video direct-render
    // path handles this exactly as before.
    const renderSceneJSON = await prefetchIconsIsolated(sceneJSON, jobId);
    return renderLongFormVideo(jobId, renderSceneJSON, onProgress, isCancelled);
  }

  const siblingUrl = await getAvailableSibling();
  if (!siblingUrl) {
    const renderSceneJSON = await prefetchIconsIsolated(sceneJSON, jobId);
    return renderLongFormVideo(jobId, renderSceneJSON, onProgress, isCancelled);
  }

  console.log(`[chunkDispatch] job ${jobId} splitting ${chunkRanges.length} chunks with ${siblingUrl}`);
  const splitAt = Math.ceil(chunkRanges.length / 2);
  const myRanges = chunkRanges.slice(0, splitAt);
  const helperRanges = chunkRanges.slice(splitAt);

  const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-chunks`);
  fs.mkdirSync(workDir, { recursive: true });

  // Icon-RAW sceneJSON, deliberately - see this function's own doc
  // comment above for why the sibling must resolve icons itself rather
  // than inherit this worker's already-resolved (and since-deleted)
  // copy.
  const helperPromise = requestHelp(siblingUrl, jobId, sceneJSON, helperRanges).catch((err) => {
    console.warn(`[chunkDispatch] job ${jobId} sibling ${siblingUrl} failed, rendering its ${helperRanges.length} chunk(s) locally instead: ${err.message}`);
    return null;
  });

  // This worker's OWN resolved copy, used only for myRanges/the local
  // fallback below - kept separate from the icon-raw `sceneJSON` above,
  // which the sibling still needs unresolved.
  const renderSceneJSON = await prefetchIconsIsolated(sceneJSON, jobId);

  const myChunkPaths = [];
  for (let i = 0; i < myRanges.length; i++) {
    if (isCancelled && isCancelled()) {
      for (const p of myChunkPaths) fs.unlink(p, () => {});
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      throw new RenderCancelledError(jobId);
    }
    const { start, end, index } = myRanges[i];
    const chunkPath = path.join(workDir, `chunk-${index}.mp4`);
    await renderSingleChunk(jobId, renderSceneJSON, start, end, chunkPath, index, (chunkPct) => {
      // My own half's progress only, scaled into the first ~50% of the
      // overall bar - the second half jumps in once the sibling's
      // result (or the local fallback for it) is actually in hand.
      if (onProgress) onProgress(Math.min(48, Math.round(((i + chunkPct / 100) / myRanges.length) * 48)));
    });
    myChunkPaths.push(chunkPath);
    if (i < myRanges.length - 1) await sleep(400);
  }

  if (onProgress) onProgress(50);

  const helperChunks = await helperPromise;
  const helperChunkPaths = [];
  if (helperChunks) {
    for (const chunk of helperChunks) {
      const p = path.join(workDir, `chunk-${chunk.index}.mp4`);
      fs.writeFileSync(p, Buffer.from(chunk.base64, 'base64'));
      helperChunkPaths.push(p);
    }
  } else {
    // Sibling failed entirely - render its assigned ranges myself,
    // sequentially, exactly like the ordinary solo path would. Uses
    // this worker's own resolved copy, same reasoning as myRanges above.
    for (const { start, end, index } of helperRanges) {
      if (isCancelled && isCancelled()) {
        for (const p of [...myChunkPaths, ...helperChunkPaths]) fs.unlink(p, () => {});
        fs.rm(workDir, { recursive: true, force: true }, () => {});
        throw new RenderCancelledError(jobId);
      }
      const chunkPath = path.join(workDir, `chunk-${index}.mp4`);
      await renderSingleChunk(jobId, renderSceneJSON, start, end, chunkPath, index, () => {});
      helperChunkPaths.push(chunkPath);
    }
  }

  if (onProgress) onProgress(90);

  const allChunkPaths = [...myChunkPaths, ...helperChunkPaths];
  const finalOutputPath = path.join(os.tmpdir(), 'shortform-renders', `${jobId}.mp4`);
  await concatChunks(allChunkPaths, finalOutputPath);

  for (const p of allChunkPaths) fs.unlink(p, () => {});
  fs.rm(workDir, { recursive: true, force: true }, () => {});

  if (onProgress) onProgress(100);
  return finalOutputPath;
}

/**
 * Writes the base64 narration clips the coordinator sent into local
 * files and reconstructs the same Map<beatIndex, {path, duration}>
 * shape muxNarrationOntoVideo already expects (see ../backend's
 * narrationPrefetch.js - this mirrors its audioFiles output exactly).
 * `duration` is passed through as-received rather than re-measured -
 * the coordinator already measured it once via ffmpeg during
 * narration; no reason to redo that work here.
 */
function writeNarrationClips(jobId, narrationAudio) {
  const dir = narrationDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const audioFiles = new Map();
  for (const clip of narrationAudio || []) {
    const filePath = path.join(dir, `${clip.index}.mp3`);
    fs.writeFileSync(filePath, Buffer.from(clip.base64, 'base64'));
    audioFiles.set(clip.index, { path: filePath, duration: clip.duration });
  }
  return { dir, audioFiles };
}

async function handleRenderJob(jobId, sceneJSON, narrationAudio) {
  const { dir: narrationDir, audioFiles } = writeNarrationClips(jobId, narrationAudio);

  // Same throttle as ../backend/server.js's own progress handling -
  // progress ticks arrive roughly 6x/second per chunk with no
  // throttling at the source, and the frontend only polls every 2s
  // anyway, so firing an unthrottled Supabase write per tick is pure
  // waste (and, at 3 concurrent renders per worker, three times the
  // waste of the single-job case that pattern was fixed for).
  let lastProgressUpdateAt = 0;
  const PROGRESS_UPDATE_MIN_INTERVAL_MS = 1500;

  try {
    // Icons deliberately NOT resolved here anymore - see
    // renderWithPossibleHelp's own doc comment for the real, confirmed-
    // live bug this fixes. Hero images stay resolved this early since
    // imagePrefetch.js never deletes "imagePrompt", so a sibling
    // worker's own redundant re-resolution of it is harmless (just a
    // little duplicate work), unlike icons.
    const imageResolvedSceneJSON = await prefetchBeatImages(sceneJSON, jobId);

    const renderedPath = await withRenderLock(() => renderWithPossibleHelp(jobId, imageResolvedSceneJSON, (pct) => {
      const now = Date.now();
      const isFinal = pct >= 100;
      if (isFinal || now - lastProgressUpdateAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS) {
        lastProgressUpdateAt = now;
        // Best-effort, matches ../backend/server.js's own precedent for
        // the exact same progress field - fire-and-forget, a missed
        // progress tick isn't worth failing a render over.
        updateJob(jobId, { progress: pct }).catch(() => {});
      }
    }, () => cancelledJobs.has(jobId)));

    // imageResolvedSceneJSON, not any icon-resolved copy - confirmed
    // muxNarrationOntoVideo never reads per-beat image/icon fields at
    // all (only narration/duration timing), so the icon-raw version is
    // exactly as good here and there's no single "the" resolved copy
    // anymore now that the primary and a possible sibling each hold
    // their own.
    const muxedPath = await muxNarrationOntoVideo(renderedPath, imageResolvedSceneJSON, audioFiles, jobId, os.tmpdir());

    // Direct user request: speed up the finished video (video + audio
    // together, staying in sync) before it's ever uploaded or shown to
    // anyone - see speedUpVideo's own doc comment for the real added
    // cost (a genuine re-encode, not free).
    const localFilePath = muxedPath.replace(/\.mp4$/, '-sped-up.mp4');
    await speedUpVideo(muxedPath, localFilePath);
    fs.unlink(muxedPath, () => {});
    const fileBuffer = fs.readFileSync(localFilePath);

    await updateJob(jobId, { status: 'uploading', progress: 100 });
    const videoUrl = await uploadRenderedVideo(jobId, localFilePath, fileBuffer);
    await updateJob(jobId, { status: 'done', video_url: videoUrl });
    console.log(`[render-worker] job ${jobId} done -> ${videoUrl}`);
  } catch (err) {
    if (err instanceof RenderCancelledError) {
      console.log(`[render-worker] job ${jobId} cancelled by user`);
      await updateJob(jobId, { status: 'cancelled', error: 'Cancelled by user' }).catch(() => {});
    } else {
      console.error(`[render-worker] job ${jobId} failed:`, err);
      await updateJob(jobId, { status: 'failed', error: String((err && err.message) || err) }).catch(() => {});
    }
  } finally {
    cleanupBeatImages(jobId);
    cleanupIcons(jobId);
    cancelledJobs.delete(jobId);
    fs.rm(narrationDir, { recursive: true, force: true }, () => {});
  }
}

app.post('/render', (req, res) => {
  const { jobId, sceneJSON, narrationAudio } = req.body || {};
  if (!jobId || !sceneJSON) {
    res.status(400).json({ error: 'jobId and sceneJSON are required' });
    return;
  }
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    res.status(503).json({ error: 'worker at capacity' });
    return;
  }

  activeRenders++;
  // Acknowledge receipt immediately, then render in the background -
  // the coordinator doesn't wait on the HTTP response for the whole
  // render (which can run well past a minute); it just needs to know
  // the job was accepted before moving on. Real completion is reported
  // via the Supabase job row, not this response.
  res.json({ accepted: true, jobId });

  handleRenderJob(jobId, sceneJSON, narrationAudio).finally(() => {
    activeRenders--;
  });
});

// Handles a SIBLING worker's request for help rendering a subset of
// chunks - see chunkDispatch.js and renderWithPossibleHelp above for
// the full picture. Deliberately synchronous (unlike /render, which
// acknowledges immediately and works in the background): the calling
// worker is actively AWAITING these exact bytes to assemble the final
// video, so there's nothing useful to do except hold the connection
// open until the chunks are actually ready - see the server's own
// requestTimeout override below for why that's safe to do here.
app.post('/render-chunks', (req, res) => {
  const { jobId, sceneJSON, chunkRanges } = req.body || {};
  if (!jobId || !sceneJSON || !Array.isArray(chunkRanges) || chunkRanges.length === 0) {
    res.status(400).json({ error: 'jobId, sceneJSON, and a non-empty chunkRanges array are required' });
    return;
  }
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    res.status(503).json({ error: 'worker at capacity' });
    return;
  }

  activeRenders++;
  handleRenderChunksRequest(jobId, sceneJSON, chunkRanges)
    .then((chunks) => res.json({ chunks }))
    .catch((err) => {
      console.error(`[render-worker] /render-chunks failed for job ${jobId}:`, err);
      res.status(500).json({ error: String((err && err.message) || err) });
    })
    .finally(() => { activeRenders--; });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`[render-worker] listening on port ${PORT}, maxConcurrent=${MAX_CONCURRENT_RENDERS}`));
// Node's default HTTP server timeout closes an in-flight request after
// 5 minutes of inactivity - fine for /render (which responds in
// milliseconds and works in the background) but /render-chunks
// deliberately holds the connection open for as long as real rendering
// takes, which measured logs show can genuinely run several minutes
// for a real chunk subset on Render's actual host. Raised well past
// chunkDispatch.js's own HELP_REQUEST_TIMEOUT_MS (8 min) so the
// CALLER's timeout is always what fires first, not this server
// dropping an otherwise-still-working connection out from under it.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000 + 5000;
