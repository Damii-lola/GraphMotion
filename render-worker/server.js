require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const { prefetchBeatImages, cleanupBeatImages } = require('./imagePrefetch');
const { harmonizeSceneColors } = require('./renderEngine');
const {
  renderLongFormVideo, RenderCancelledError, CHUNK_THRESHOLD_SECONDS,
  computeChunkRanges, renderSingleChunk, concatChunks,
} = require('./longVideoOrchestrator');
const { muxNarrationOntoVideo, speedUpVideo } = require('./audioMux');
const { updateJob, uploadRenderedVideo } = require('./supabaseClient');
const { getAvailableSiblings, requestHelp } = require('./chunkDispatch');

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

// Direct user instruction (2026-09-09, 3 -> 2): confirmed every service
// (backend AND this worker) runs on Render's free tier, ruling out a
// tier mismatch as the "fast before the coordinator/worker split, slow
// after" cause. withRenderLock already serializes actual Skia rendering
// to one job at a time regardless of this number (see its own doc
// comment) - this only bounds how many jobs can be ACCEPTED (and
// therefore queued behind each other in that same lock) before a new
// one gets a 503 and the coordinator falls back to local rendering
// instead. On a single free-tier instance, admitting a 3rd job just
// means it queues longer behind two others with no extra throughput to
// show for it - accepting fewer, faster-clearing jobs is a better fit
// for this tier than accepting more that all wait longer.
const MAX_CONCURRENT_RENDERS = 2;
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

/** Same disposable-child-process isolation as ../backend/renderWorker.js's own prefetchIconsIsolated - @resvg/resvg-js's native SVG rasterizer cost is paid and reclaimed in a throwaway process rather than sitting in this long-lived worker for its whole uptime. `mode:'embed'` (jobId unused/null) runs embedIconDataInScene instead of the original per-job-directory prefetchIcons - see iconFetchWorker.js's own doc comment. */
function prefetchIconsIsolated(sceneJSON, jobId, mode) {
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

    child.send({ sceneJSON, jobId, mode });
  });
}

/**
 * Real, confirmed-live bug fixed here (2026-09-10, see iconFetch.js's
 * own embedIconDataInScene doc comment for the full picture): resolves
 * every distinct icon in the WHOLE job exactly ONCE, embedding the PNG
 * bytes directly into the returned scene JSON, before ANY chunk-level
 * work (this worker's own render, or any sibling's /render-chunks call)
 * begins. Every downstream prefetchIcons call then just decodes already-
 * embedded bytes locally - zero further Iconify calls per chunk, no
 * matter how many chunks or workers the job ends up splitting across.
 */
function embedIconDataInSceneIsolated(sceneJSON) {
  return prefetchIconsIsolated(sceneJSON, null, 'embed');
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
 * image/icon "prefetch" pass even though it's only rendering a SUBSET
 * of the video's beats - a chunk's own rendered frames can still
 * reference any beat's image/icon depending on where that beat's own
 * on-screen time falls. Icons cost nothing extra here: by the time this
 * runs, the sceneJSON's icon layers already carry embedded PNG bytes
 * (see handleRenderJob's own embedIconDataInSceneIsolated call and
 * iconFetch.js's embedIconDataInScene doc comment for why - a REAL,
 * confirmed-live bug once had this call independently re-fetch every
 * icon from Iconify on every single chunk request, which is exactly
 * what triggered Iconify's own rate limiting in production), so this is
 * a local decode+write, not a network call. Hero images are the one
 * piece still genuinely redundant here (imagePrefetch.js's own free,
 * keyless, un-rate-limited fetch) - a little duplicate network time,
 * never correctness. Goes through the SAME withRenderLock as a normal
 * /render job - a help request is exactly as memory-heavy as a normal
 * one while it's actually rendering, and this worker still only has
 * room for one such active render at a time regardless of which route
 * asked for it.
 */
async function handleRenderChunksRequest(jobId, sceneJSON, chunkRanges) {
  const imageResolvedSceneJSON = await prefetchBeatImages(sceneJSON, jobId);
  const renderSceneJSON = await prefetchIconsIsolated(imageResolvedSceneJSON, jobId);

  const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-help-chunks`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    return await withRenderLock(async () => {
      const results = [];
      for (let i = 0; i < chunkRanges.length; i++) {
        const range = chunkRanges[i];
        const chunkPath = path.join(workDir, `chunk-${range.index}.mp4`);
        await renderSingleChunk(jobId, renderSceneJSON, range.start, range.end, chunkPath, range.index, () => {});
        results.push({ index: range.index, base64: fs.readFileSync(chunkPath).toString('base64') });
        // Matches renderWithPossibleHelp's own primary loop below, which
        // already waits between chunks (undocumented there too, but a
        // harmless, cheap gap regardless). Investigating a real,
        // reproduced-3x-locally intermittent ENOENT on a sibling's
        // SECOND assigned chunk's own just-written frame file (2026-09-10,
        // found verifying the new N-way split with real running
        // instances): adding this gap did NOT stop it from recurring, so
        // it is NOT the fix - most likely cause found so far is Windows
        // Defender real-time protection (confirmed active on this dev
        // machine) transiently locking freshly-written frame JPGs under
        // the unusually high concurrent file-write load 3 simultaneous
        // local "workers" produce - not something a separate Linux host
        // per worker would hit in real production. Left in as a cheap,
        // harmless no-op safety margin, not a confirmed fix - the
        // per-sibling fallback in renderWithPossibleHelp is what actually
        // keeps this from ever producing a bad or missing video (every
        // local test still completed a fully correct output). Revisit if
        // this shows up in REAL production logs.
        if (i < chunkRanges.length - 1) await sleep(400);
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
 * to spread a long video's chunks across this worker plus a LIMITED
 * number of siblings (see MAX_WORKERS_PER_JOB above - capped, not
 * "every available one", direct user requirement to keep the rest of
 * the fleet free for other users generating at the same time) before
 * falling back to rendering every chunk itself, exactly as
 * renderLongFormVideo already does. Short videos (no chunking needed at
 * all) and the case where no sibling has room both fall through to the
 * ORIGINAL, unchanged solo path - this only changes behavior when
 * there's real chunked work AND real help available.
 *
 * Rebuilt as a work-stealing pool (2026-09-10, direct user request,
 * replacing a fixed-upfront-split design entirely - not layered on top
 * of it). The PREVIOUS version pre-computed one static, contiguous block
 * of chunks per worker before any rendering started - simple, but a
 * measured real production run only got ~1.76x faster with 5 workers
 * configured, far short of the expected ~5x. Root cause: a static split
 * hands every worker an equal-sized block regardless of how fast or
 * READY that worker actually turns out to be - a cold Render free-tier
 * sibling (still waking from sleep) or a genuinely slower one holds up
 * the whole job's final concat exactly as long as its own fixed block
 * takes, while faster workers that finished early just sit idle waiting.
 *
 * This version instead maintains ONE shared queue of chunk tasks; this
 * worker and every sibling each run their own loop that pulls the NEXT
 * task off the front of that queue the moment they're free, rendering
 * it, then immediately pulling the next one - repeating until the queue
 * is empty. A fast or already-warm worker naturally ends up rendering
 * more chunks than a slow or cold one, and no worker ever sits idle
 * while there's still real work left to do. Each sibling task is now
 * ONE chunk per HTTP request (not a batch) specifically so a slow
 * sibling can never "hold" more than one chunk's worth of work at a
 * time - the existing /render-chunks endpoint already accepts a
 * chunkRanges array of any length, so a single-element array needs no
 * server-side changes at all.
 *
 * Trade-off accepted deliberately: each single-chunk sibling request
 * re-runs that sibling's own image/icon prefetch from scratch (no
 * cross-request cache), the same "costs a little duplicate network
 * time, never correctness" trade-off handleRenderChunksRequest's own
 * doc comment already accepts for hero images - simpler and safer than
 * adding a per-job cache with its own cleanup-timing risk, at the cost
 * of maybe a few hundred ms of redundant icon fetching per chunk
 * request, small next to a chunk's own multi-second render+encode time.
 *
 * A task that fails on one worker is requeued for another to try
 * (rather than the old "this whole sibling's remaining chunks fall back
 * to local" model) - a real, confirmed-live-locally intermittent issue
 * (see below) showed a task can fail on one worker yet succeed cleanly
 * elsewhere, so retrying via a DIFFERENT worker is strictly more
 * resilient than always falling back to the same fixed one.
 * MAX_TASK_ATTEMPTS bounds this - a chunk failing that many times across
 * different workers is almost certainly a real, deterministic rendering
 * bug for that specific range, not worker flakiness, and should fail
 * the job loudly rather than silently ship an incomplete video.
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
//
// Original fix: deferred icon resolution until AFTER the split decision
// (icon names stayed raw here, each worker resolved its own local copy
// per chunk). Superseded 2026-09-10 by a stronger fix one level up -
// handleRenderJob now resolves every icon ONCE for the whole job via
// embedIconDataInScene and embeds the actual PNG bytes (`iconDataBase64`)
// into the sceneJSON THIS function receives, before ever calling this.
// Embedded bytes are portable across every worker's disk by construction
// (they're not a path at all), which fixes both bugs at once: the
// original "src points to a file only the resolving worker has" issue,
// AND the newer Iconify-rate-limit issue redundant per-chunk re-fetching
// caused (see iconFetch.js's own doc comment). Every sibling task below
// still sends this same sceneJSON unchanged; each worker's own
// prefetchIcons calls now just decode already-embedded bytes locally,
// no network fetch at all in the common case.
// Direct user instruction (2026-09-10): a single job used to grab EVERY
// currently-free sibling - real, measured speedup for that one job
// (~3.5x with all 5 workers), but a real, confirmed problem for anyone
// else: while that job's pool holds all 5 workers, a second user's
// generation starting at the same moment finds nothing free to help it,
// and falls back to near-solo speed. The explicit design principle
// going forward (direct user statement): assume many users could be
// generating at the exact same time, not just one - a single job's own
// speed is not worth starving the rest of the fleet for. Capped so one
// job uses at most this many workers total (itself + siblings), no
// matter how many more are sitting idle - the other workers stay free
// for whoever else shows up, even if that means this one job doesn't
// get the fastest theoretically possible time.
const MAX_WORKERS_PER_JOB = 2;

async function renderWithPossibleHelp(jobId, sceneJSON, onProgress, isCancelled) {
  const chunkRanges = computeChunkRanges(sceneJSON);

  if (chunkRanges.length <= 1) {
    // Not even chunked (CHUNK_THRESHOLD_SECONDS not exceeded) - nothing
    // to split, renderLongFormVideo's own short-video direct-render
    // path handles this exactly as before.
    const renderSceneJSON = await prefetchIconsIsolated(sceneJSON, jobId);
    return renderLongFormVideo(jobId, renderSceneJSON, onProgress, isCancelled);
  }

  const availableSiblings = await getAvailableSiblings();
  if (availableSiblings.length === 0) {
    const renderSceneJSON = await prefetchIconsIsolated(sceneJSON, jobId);
    return renderLongFormVideo(jobId, renderSceneJSON, onProgress, isCancelled);
  }

  // Picked RANDOMLY out of everyone available, not just the first N in
  // RENDER_WORKER_URL_1/2/... order - always taking the same fixed
  // prefix would load-balance unevenly across the fleet over time (the
  // early-numbered workers would get chosen as "the helper" far more
  // often than the later ones whenever more than MAX_WORKERS_PER_JOB-1
  // are free). A simple shuffle-then-slice spreads that fairly.
  const siblingUrls = availableSiblings
    .map((url) => ({ url, sortKey: Math.random() }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .slice(0, MAX_WORKERS_PER_JOB - 1)
    .map(({ url }) => url);

  console.log(`[chunkDispatch] job ${jobId} pooling ${chunkRanges.length} chunks across this worker + ${siblingUrls.length} sibling(s): ${siblingUrls.join(', ')}`);

  const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-chunks`);
  fs.mkdirSync(workDir, { recursive: true });

  // This worker's OWN resolved copy - used for every chunk THIS worker's
  // own loop below claims from the shared queue. Resolved once, up
  // front, since (unlike a sibling's per-request resolution) this
  // worker keeps the exact same in-memory object across every chunk it
  // claims - no repeated work to trade off here.
  const renderSceneJSON = await prefetchIconsIsolated(sceneJSON, jobId);

  // Shared, mutable task queue - JS's single-threaded event loop makes
  // .shift()/.push() here atomic with respect to the worker loops below
  // (no await happens between reading queue.length and claiming a task
  // inside claimTask), so this needs no separate locking.
  const queue = [...chunkRanges];
  const chunkPathsByIndex = new Map();
  const failureCounts = new Map();
  const MAX_TASK_ATTEMPTS = 3;
  let completedCount = 0;
  const totalCount = chunkRanges.length;

  function claimTask() {
    return queue.length > 0 ? queue.shift() : null;
  }

  function reportProgress() {
    // Leaves the last 10% for the concat step below, same spirit as the
    // old design's onProgress(90)/onProgress(100) split.
    if (onProgress) onProgress(Math.min(90, Math.round((completedCount / totalCount) * 90)));
  }

  // Throws once a single chunk has failed MAX_TASK_ATTEMPTS times across
  // (possibly different) workers - deliberately not swallowed, since
  // silently dropping a chunk would ship an incomplete/wrong video.
  // Otherwise requeues the task for whichever worker frees up next
  // (maybe the same one, maybe a different one) to try again.
  function requeueOrGiveUp(task, workerLabel, err) {
    const attempts = (failureCounts.get(task.index) || 0) + 1;
    failureCounts.set(task.index, attempts);
    if (attempts >= MAX_TASK_ATTEMPTS) {
      throw new Error(`chunk ${task.index} failed ${attempts} time(s) across different workers (last: ${workerLabel} - ${err.message}) - giving up`);
    }
    console.warn(`[chunkDispatch] job ${jobId} chunk ${task.index} failed on ${workerLabel} (attempt ${attempts}/${MAX_TASK_ATTEMPTS}), requeueing: ${err.message}`);
    queue.push(task);
  }

  async function localWorkerLoop() {
    let task;
    while ((task = claimTask())) {
      if (isCancelled && isCancelled()) throw new RenderCancelledError(jobId);
      const { start, end, index } = task;
      const chunkPath = path.join(workDir, `chunk-${index}.mp4`);
      try {
        await renderSingleChunk(jobId, renderSceneJSON, start, end, chunkPath, index, () => {});
        chunkPathsByIndex.set(index, chunkPath);
        completedCount++;
        reportProgress();
      } catch (err) {
        requeueOrGiveUp(task, 'this worker', err);
      }
    }
  }

  async function siblingWorkerLoop(url) {
    let task;
    while ((task = claimTask())) {
      if (isCancelled && isCancelled()) throw new RenderCancelledError(jobId);
      try {
        const [chunk] = await requestHelp(url, jobId, sceneJSON, [task]);
        const chunkPath = path.join(workDir, `chunk-${task.index}.mp4`);
        fs.writeFileSync(chunkPath, Buffer.from(chunk.base64, 'base64'));
        chunkPathsByIndex.set(task.index, chunkPath);
        completedCount++;
        reportProgress();
      } catch (err) {
        requeueOrGiveUp(task, url, err);
      }
    }
  }

  try {
    await Promise.all([localWorkerLoop(), ...siblingUrls.map((url) => siblingWorkerLoop(url))]);
  } catch (err) {
    // Clean up whatever partial per-chunk files exist before propagating
    // - covers BOTH exit-via-cancellation and exit-via-exceeded-retries,
    // generalizing what the old static-split design only handled for
    // cancellation specifically.
    for (const p of chunkPathsByIndex.values()) fs.unlink(p, () => {});
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    throw err;
  }

  // Re-sorted into original chronological order here, deliberately -
  // completion order is now arbitrary (whichever worker happened to
  // grab which task), unlike the old design's contiguous static blocks
  // where simple array concatenation already produced the right order.
  const orderedChunkPaths = chunkRanges.map((r) => chunkPathsByIndex.get(r.index));
  const finalOutputPath = path.join(os.tmpdir(), 'shortform-renders', `${jobId}.mp4`);
  await concatChunks(orderedChunkPaths, finalOutputPath);

  for (const p of orderedChunkPaths) fs.unlink(p, () => {});
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
  // waste (and, at MAX_CONCURRENT_RENDERS concurrent renders per worker,
  // that many times the waste of the single-job case that pattern was
  // fixed for).
  let lastProgressUpdateAt = 0;
  const PROGRESS_UPDATE_MIN_INTERVAL_MS = 1500;

  try {
    // Must run before ANY prefetch step touches sceneJSON - see
    // harmonizeSceneColors' own doc comment (renderEngine.js) for the
    // real, confirmed-live bug this fixes: iconFetch.js's own prefetch
    // rasterizes each icon layer's PNG using whatever iconColor it finds
    // and then deletes that field outright, so harmonizing colors any
    // later than this leaves every icon's own glow effect harmonized to
    // a different color than the icon itself ends up baked as. Mutates
    // sceneJSON in place; everything below (icon embedding, image
    // prefetch, every worker's own icon decode) all derives from this
    // same already-harmonized object.
    harmonizeSceneColors(sceneJSON);

    // Icons resolved ONCE here, for the whole job, before any chunk-level
    // work begins - see iconFetch.js's own embedIconDataInScene doc
    // comment for the real Iconify-rate-limit bug this fixes (each
    // chunk used to trigger its own full re-fetch of every icon in the
    // whole video). The result carries the actual PNG bytes embedded
    // (`iconDataBase64`), not a local file path, so it's exactly as
    // valid on a sibling's own disk as on this worker's - every
    // downstream prefetchIcons call (this worker's own render, or any
    // sibling's /render-chunks handling) just decodes it locally.
    const iconEmbeddedSceneJSON = await embedIconDataInSceneIsolated(sceneJSON);

    // Hero images stay resolved this early too since imagePrefetch.js
    // never deletes "imagePrompt", so a sibling worker's own redundant
    // re-resolution of it is harmless (just a little duplicate work) -
    // unlike icons before the fix above, this was never the cause of
    // any real problem.
    const imageResolvedSceneJSON = await prefetchBeatImages(iconEmbeddedSceneJSON, jobId);

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

    // imageResolvedSceneJSON, not any per-worker icon-resolved copy -
    // confirmed muxNarrationOntoVideo never reads per-beat image/icon
    // fields at all (only narration/duration timing), so this
    // icon-embedded-but-not-yet-locally-decoded version is exactly as
    // good here as any worker's own fully-resolved copy would be.
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
