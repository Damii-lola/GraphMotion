require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const rateLimit = require('express-rate-limit');
const { startWorkerKeepAlive, cancelJobOnWorker } = require('./renderDispatch');

const {
  supabase,
  createJob,
  updateJob,
  getJob,
  listJobsForUser,
  deleteJob,
  uploadRenderedVideo,
} = require('./supabaseClient');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] server staying up despite:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] server staying up despite:', err);
});

// Raised 1 -> 5 once real per-chunk memory was brought down to a
// consistent ~103-106MB (see renderEngine.js's own canvas-pooling/
// gradient-caching history) - 5 concurrent chunk-worker processes at
// that ceiling is ~530MB, plus the main server process itself; this is
// a real product tradeoff (concurrency vs. total host memory), not a
// free change, so it should be revisited if the host's actual memory
// budget doesn't comfortably cover that math.
const MAX_CONCURRENT_RENDERS = 5;
let activeRenders = 0;
const renderQueue = [];

function scheduleRender(jobId, prompt, targetDurationSeconds, parentSceneJSON) {
  renderQueue.push({ jobId, prompt, targetDurationSeconds, parentSceneJSON });
  drainQueue();
}

function drainQueue() {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) return;
  const next = renderQueue.shift();
  if (!next) return;

  activeRenders++;
  startRenderWorker(next.jobId, next.prompt, next.targetDurationSeconds, next.parentSceneJSON, () => {
    activeRenders--;
    drainQueue();
  });
}

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

// A concrete, checkable marker for exactly this situation - rather
// than trust "I deployed it" indirectly, hit this endpoint after
// deploying. This GENUINELY inspects the deployed file's own source
// at runtime (not a hardcoded claim) - if longVideoOrchestrator.js on
// the live server doesn't actually contain the fix, this reports
// false, full stop, no more guessing about whether a deploy worked.
app.get('/health', async (req, res) => {
  let chunkHandoffFixPresent = false;
  let liveChunkConfig = null;
  try {
    const orchestratorSource = fs.readFileSync(path.join(__dirname, 'longVideoOrchestrator.js'), 'utf8');
    chunkHandoffFixPresent = orchestratorSource.includes('hasExited') && orchestratorSource.includes('maybeFinish');
    const { CHUNK_THRESHOLD_SECONDS, CHUNK_SIZE_SECONDS } = require('./longVideoOrchestrator');
    liveChunkConfig = { CHUNK_THRESHOLD_SECONDS, CHUNK_SIZE_SECONDS };
  } catch (err) {
    chunkHandoffFixPresent = null;
  }

  // Answers "is the edit-a-video feature actually deployed" directly
  // and unambiguously, rather than everyone guessing from symptoms.
  // Checks the CODE (is the function even present) and the DATABASE
  // (does the column it depends on actually exist) separately, since
  // those are two genuinely independent things that both have to be
  // true - a code deploy without running the schema migration would
  // otherwise look identical to "nothing was deployed" from the
  // outside, and this tells you exactly which one is missing.
  let editFeatureCodePresent = false;
  try {
    const geminiSource = fs.readFileSync(path.join(__dirname, 'geminiClient.js'), 'utf8');
    const supabaseSource = fs.readFileSync(path.join(__dirname, 'supabaseClient.js'), 'utf8');
    editFeatureCodePresent =
      geminiSource.includes('generateEditedSceneJSON') &&
      supabaseSource.includes('parent_job_id');
  } catch (err) {
    editFeatureCodePresent = null;
  }

  let parentJobIdColumnExists = null;
  try {
    const { error } = await supabase.from('render_jobs').select('parent_job_id').limit(1);
    parentJobIdColumnExists = !error;
  } catch (err) {
    parentJobIdColumnExists = false;
  }

  res.json({
    ok: true,
    time: new Date().toISOString(),
    build: {
      chunkHandoffFix: chunkHandoffFixPresent,
      progressThrottleFix: true,
      liveChunkConfig,
      editFeature: {
        codeDeployed: editFeatureCodePresent,
        databaseMigrated: parentJobIdColumnExists,
        fullyWorking: editFeatureCodePresent === true && parentJobIdColumnExists === true,
      },
    },
  });
});

app.post('/api/generate', generateLimiter, async (req, res) => {
  const { prompt, userId, targetDurationSeconds, parentJobId } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt is required (min 3 chars)' });
  }

  // Clamp to a sane range regardless of what the client sends - 8s
  // floor matches the shortest videos already supported. Defaults to
  // the original short-form length when omitted, so existing callers
  // get identical behavior to before this feature existed.
  let duration = Number(targetDurationSeconds);
  if (!Number.isFinite(duration)) duration = 12;
  // Explicit product decision: 45s is the hard ceiling, not just a
  // soft target - no video may exceed it regardless of what the
  // user's prompt asks for. See narrationPrefetch.js's post-narration
  // trim for the real enforcement (narration-driven durations can
  // overshoot whatever's requested here).
  duration = Math.max(8, Math.min(45, Math.round(duration)));

  const identifier = userId || req.ip;

  // If this request is an edit of a previous video (not a fresh
  // generation), verify BEFORE spending a daily use or spawning a
  // worker: the parent job must actually exist, belong to THIS same
  // user (an edit request naming someone else's job id shouldn't be
  // able to piggyback on their video), and must have actually
  // finished rendering - there's nothing to edit yet if it's still in
  // progress or if it failed.
  let parentSceneJSON = null;
  let parentThreadIdForRequest = null;
  if (parentJobId) {
    let parentJob;
    try {
      parentJob = await getJob(parentJobId);
    } catch (err) {
      console.error('[POST /api/generate] parent job lookup failed:', err);
      return res.status(500).json({ error: 'Failed to look up the video being edited' });
    }
    if (!parentJob) {
      return res.status(404).json({ error: 'The video you are trying to edit no longer exists' });
    }
    if (parentJob.user_id !== identifier) {
      return res.status(403).json({ error: 'You can only edit your own videos' });
    }
    if (parentJob.status !== 'done' || !parentJob.scene_json) {
      return res.status(409).json({ error: 'That video hasn\'t finished rendering yet - wait for it to complete before editing it' });
    }
    parentSceneJSON = parentJob.scene_json;
    // Falls back to the parent's own id if its thread_id is somehow
    // unset (shouldn't happen once the migration backfill has run,
    // but this keeps a single odd row from breaking the whole chain
    // going forward instead of silently producing a null thread_id).
    parentThreadIdForRequest = parentJob.thread_id || parentJob.id;
  }

  let job;
  try {
    job = await createJob({
      userId: identifier,
      prompt: prompt.trim(),
      parentJobId: parentJobId || null,
      parentThreadId: parentThreadIdForRequest,
    });
  } catch (err) {
    console.error('[POST /api/generate] job creation failed:', err);
    return res.status(500).json({ error: 'Failed to create job' });
  }

  res.status(202).json({ job });

  scheduleRender(job.id, prompt.trim(), duration, parentSceneJSON);
});

// Explicit V8 heap ceiling for the render worker. Previously raised to
// 400 after 220/260 were found to make "Chunk N timed out" WORSE
// (theory: V8 GC-thrashing under a too-tight JS-heap cap, fighting for
// headroom instead of crashing or progressing) - but that theory
// doesn't explain chunk 0 STILL timing out at 400 either, and the
// dominant real memory cost here (native Skia pixel buffers, per
// renderEngine.js's own gc()-cadence measurements: ~245-589MB peak
// RSS depending on cadence) was never something this flag bounds in
// the first place - it only caps the JS heap. Pulled down to 100 as an
// explicit hard product requirement (the actual Render host has far
// less headroom available per-process than 400MB once the parent
// process, OS, and ffmpeg are all sharing the same instance) - see
// CHUNK_WORKER_MAX_OLD_SPACE_MB in longVideoOrchestrator.js for the
// matching change and the real RSS numbers this needs to be verified
// against going forward.
const RENDER_WORKER_MAX_OLD_SPACE_MB = 100;

// jobId -> { child, settled, cancelledByUser, workerUrl } - tracked so
// POST /api/jobs/:id/cancel (below) can find and stop a job that's
// still actually running on THIS server, regardless of which stage
// it's in. `workerUrl` is filled in once a job is handed off to a
// render-worker service (see the 'dispatched_to_worker' case below),
// since cancelling THAT job means notifying the worker too, not just
// this process - the child here will have already exited by then.
const activeJobs = new Map();

function startRenderWorker(jobId, prompt, targetDurationSeconds, parentSceneJSON, onSettled) {
  const child = fork(path.join(__dirname, 'renderWorker.js'), {
    stdio: 'inherit',
    // --expose-gc: REQUIRED for renderEngine.js's own periodic global.gc()
    // calls during the frame loop to actually run (real, measured fix
    // for native Skia memory piling up faster than V8's own heap-based
    // GC heuristics ever trigger for - see renderEngine.js's own doc
    // comment at the call site for the full incident/measurement).
    // Without this flag, global.gc simply doesn't exist and that
    // periodic call becomes a silent no-op, NOT a crash - but also not
    // a fix. --max-old-space-size alone (already present below) never
    // covered this; it only caps the JS heap, which stays small
    // regardless of how much native canvas memory accumulates.
    execArgv: [`--max-old-space-size=${RENDER_WORKER_MAX_OLD_SPACE_MB}`, '--expose-gc'],
  });

  const state = { child, settled: false, cancelledByUser: false, workerUrl: null };
  activeJobs.set(jobId, state);
  // Progress messages arrive roughly 6x/second per chunk with zero
  // throttling previously - every single one fired an immediate,
  // un-awaited Supabase network call from THIS process (the main
  // server, not a disposable worker). Over a multi-chunk render that's
  // potentially hundreds of overlapping outbound requests piling up
  // with no backpressure - a real, previously-unexamined way for the
  // MAIN server to degrade, not just one render job, which fits
  // "polling itself starts failing" better than a single-job crash
  // would. Also just wasted work regardless: the frontend only polls
  // every 2s, so updating Supabase faster than that is never even
  // visible.
  let lastProgressUpdateAt = 0;
  const PROGRESS_UPDATE_MIN_INTERVAL_MS = 1500;

  child.on('message', async (msg) => {
    if (!msg || msg.jobId !== jobId) return;

    try {
      switch (msg.type) {
        case 'status':
          await updateJob(jobId, {
            status: msg.status,
            ...(msg.progress !== undefined ? { progress: msg.progress } : {}),
          });
          break;

        case 'scenes_ready':
          await updateJob(jobId, { scene_json: msg.sceneJSON });
          break;

        case 'progress': {
          const now = Date.now();
          const isFinal = msg.progress >= 100;
          if (isFinal || now - lastProgressUpdateAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS) {
            lastProgressUpdateAt = now;
            updateJob(jobId, { progress: msg.progress }).catch(() => {});
          }
          break;
        }

        case 'render_complete': {
          state.settled = true;
          await updateJob(jobId, { status: 'uploading', progress: 100 });
          const fileBuffer = fs.readFileSync(msg.localFilePath);
          const videoUrl = await uploadRenderedVideo(jobId, msg.localFilePath, fileBuffer);
          fs.unlink(msg.localFilePath, () => {});
          await updateJob(jobId, { status: 'done', video_url: videoUrl });
          activeJobs.delete(jobId);
          onSettled();
          break;
        }

        case 'failed':
          state.settled = true;
          console.error(`[renderWorker] job ${jobId} failed:`, msg.error);
          await updateJob(jobId, { status: 'failed', error: String(msg.error) });
          activeJobs.delete(jobId);
          onSettled();
          break;

        // Rendering was handed off to a render-worker service (see
        // renderDispatch.js) - that worker is responsible for its own
        // progress updates, upload, and final status from here, so
        // this only needs to free up the local concurrency slot, not
        // touch Supabase itself. The job stays in activeJobs (NOT
        // deleted here) with workerUrl now set, so a cancel request
        // arriving after this point still has somewhere to route to -
        // see POST /api/jobs/:id/cancel below.
        case 'dispatched_to_worker':
          state.settled = true;
          state.workerUrl = msg.workerUrl || null;
          onSettled();
          break;
      }
    } catch (err) {
      console.error(`[startRenderWorker] job ${jobId} handling "${msg.type}" failed:`, err);
    }
  });

  child.on('exit', (code, signal) => {
    if (!state.settled) {
      // A deliberate cancel kills this same child, which lands here
      // too - the cancel endpoint already wrote the job's real status
      // itself, so this must not overwrite it with a confusing
      // "exited unexpectedly" error.
      if (!state.cancelledByUser) {
        console.error(`[renderWorker] job ${jobId} child exited unexpectedly - code: ${code}, signal: ${signal}`);
        updateJob(jobId, {
          status: 'failed',
          error: `Render process exited unexpectedly (code ${code}, signal ${signal || 'none'}).`,
        }).catch(() => {});
      }
      state.settled = true;
      onSettled();
    }
    // Dispatched-to-worker jobs deliberately stay in activeJobs after
    // this (see the case above) - only delete here for jobs that
    // rendered locally and never got a workerUrl.
    if (!state.workerUrl) activeJobs.delete(jobId);
  });

  child.send({ jobId, prompt, targetDurationSeconds, parentSceneJSON });
}

/**
 * Direct user request. Two real cases to handle, since rendering can
 * be happening in two different places by the time a cancel request
 * arrives:
 * 1. Still local (narration/generation, or the local-render fallback
 *    path) - the tracked child process is killed outright. Killing the
 *    WHOLE process is a clean, complete cancel here regardless of
 *    which internal step it's on (narration call, image prefetch,
 *    Skia render, ffmpeg mux) - there's nothing partial to clean up
 *    since nothing outside that process has been touched yet.
 * 2. Already dispatched to a render-worker service - the coordinator
 *    can't kill a process on a different machine, so it POSTs to that
 *    worker's own POST /cancel/:jobId instead (best-effort, see
 *    renderDispatch.js's cancelJobOnWorker) and marks the job
 *    cancelled here directly, rather than waiting on the worker to
 *    confirm - the user asked to cancel, so the job stops being
 *    "theirs" immediately from the frontend's perspective even if the
 *    worker takes a moment longer to actually stop.
 * A job not found in activeJobs at all has already finished (done/
 * failed) or was never running on this server - nothing to cancel.
 */
app.post('/api/jobs/:id/cancel', async (req, res) => {
  const jobId = req.params.id;
  const userId = req.query.userId;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId query param is required' });
  }

  // Same ownership check as DELETE /api/jobs/:id - this app has no
  // real auth, just per-user identifiers, so without this anyone who
  // learned another user's job id could cancel their in-progress
  // generation.
  let job;
  try {
    job = await getJob(jobId);
  } catch (err) {
    console.error(`[POST /api/jobs/:id/cancel] lookup failed for ${jobId}:`, err);
    return res.status(500).json({ error: 'Failed to look up the job' });
  }
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (job.user_id !== userId) {
    return res.status(403).json({ error: 'This job does not belong to you' });
  }

  const state = activeJobs.get(jobId);
  if (!state) {
    return res.status(409).json({ error: 'This job is not currently running, so there is nothing to cancel.' });
  }

  state.cancelledByUser = true;

  if (state.child && !state.settled) {
    state.child.kill();
  }
  if (state.workerUrl) {
    cancelJobOnWorker(state.workerUrl, jobId); // best-effort, not awaited - see its own doc comment
  }

  try {
    await updateJob(jobId, { status: 'cancelled', error: 'Cancelled by user' });
  } catch (err) {
    console.error(`[POST /api/jobs/:id/cancel] failed to update job ${jobId} status:`, err);
  }

  activeJobs.delete(jobId);
  res.json({ ok: true });
});

app.get('/api/jobs', async (req, res) => {
  const userId = req.query.userId;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId query param is required' });
  }
  try {
    const jobs = await listJobsForUser(userId);
    return res.json({ jobs });
  } catch (err) {
    console.error('[GET /api/jobs] failed:', err);
    return res.status(500).json({ error: 'Failed to fetch job history' });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json({ job });
  } catch (err) {
    console.error('[GET /api/jobs/:id] failed:', err);
    return res.status(500).json({ error: 'Failed to fetch job' });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  const userId = req.query.userId;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId query param is required' });
  }
  try {
    const result = await deleteJob(req.params.id, userId);
    if (!result.deleted) {
      const status = result.reason === 'forbidden' ? 403 : 404;
      const message = result.reason === 'forbidden' ? 'This job does not belong to you' : 'Job not found';
      return res.status(status).json({ error: message });
    }
    return res.json({ deleted: true });
  } catch (err) {
    console.error('[DELETE /api/jobs/:id] failed:', err);
    return res.status(500).json({ error: 'Failed to delete job' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
  startWorkerKeepAlive();
});
