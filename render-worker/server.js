require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const { prefetchBeatImages, cleanupBeatImages } = require('./imagePrefetch');
const { renderLongFormVideo } = require('./longVideoOrchestrator');
const { muxNarrationOntoVideo } = require('./audioMux');
const { updateJob, uploadRenderedVideo } = require('./supabaseClient');

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

app.get('/health', (req, res) => {
  res.json({ ok: true, activeRenders, maxConcurrent: MAX_CONCURRENT_RENDERS });
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
    const imageResolvedSceneJSON = await prefetchBeatImages(sceneJSON, jobId);
    const renderSceneJSON = await prefetchIconsIsolated(imageResolvedSceneJSON, jobId);

    const renderedPath = await withRenderLock(() => renderLongFormVideo(jobId, renderSceneJSON, (pct) => {
      const now = Date.now();
      const isFinal = pct >= 100;
      if (isFinal || now - lastProgressUpdateAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS) {
        lastProgressUpdateAt = now;
        // Best-effort, matches ../backend/server.js's own precedent for
        // the exact same progress field - fire-and-forget, a missed
        // progress tick isn't worth failing a render over.
        updateJob(jobId, { progress: pct }).catch(() => {});
      }
    }));

    const localFilePath = await muxNarrationOntoVideo(renderedPath, renderSceneJSON, audioFiles, jobId, os.tmpdir());
    const fileBuffer = fs.readFileSync(localFilePath);

    await updateJob(jobId, { status: 'uploading', progress: 100 });
    const videoUrl = await uploadRenderedVideo(jobId, localFilePath, fileBuffer);
    await updateJob(jobId, { status: 'done', video_url: videoUrl });
    console.log(`[render-worker] job ${jobId} done -> ${videoUrl}`);
  } catch (err) {
    console.error(`[render-worker] job ${jobId} failed:`, err);
    await updateJob(jobId, { status: 'failed', error: String((err && err.message) || err) }).catch(() => {});
  } finally {
    cleanupBeatImages(jobId);
    cleanupIcons(jobId);
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`[render-worker] listening on port ${PORT}, maxConcurrent=${MAX_CONCURRENT_RENDERS}`));
