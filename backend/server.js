require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const rateLimit = require('express-rate-limit');

const {
  createJob,
  updateJob,
  getJob,
  countJobsToday,
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

const FREE_TIER_DAILY_LIMIT = Number(process.env.FREE_TIER_DAILY_LIMIT || 3);

// One render at a time, everything else queues. Cheap insurance -
// Skia rendering is lightweight, but there's no reason to risk
// multiple ffmpeg encodes competing for CPU simultaneously either.
const MAX_CONCURRENT_RENDERS = 1;
let activeRenders = 0;
const renderQueue = [];

function scheduleRender(jobId, prompt, targetDurationSeconds) {
  renderQueue.push({ jobId, prompt, targetDurationSeconds });
  drainQueue();
}

function drainQueue() {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) return;
  const next = renderQueue.shift();
  if (!next) return;

  activeRenders++;
  startRenderWorker(next.jobId, next.prompt, next.targetDurationSeconds, () => {
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

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/generate', generateLimiter, async (req, res) => {
  const { prompt, userId, targetDurationSeconds } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt is required (min 3 chars)' });
  }

  // Clamp to a sane range regardless of what the client sends - 8s
  // floor matches the shortest videos already supported, 120s (2min)
  // is the new ceiling. Defaults to the original short-form length
  // when omitted, so existing callers get identical behavior to
  // before this feature existed.
  let duration = Number(targetDurationSeconds);
  if (!Number.isFinite(duration)) duration = 12;
  duration = Math.max(8, Math.min(120, Math.round(duration)));

  const identifier = userId || req.ip;

  let job;
  try {
    const usedToday = await countJobsToday(identifier);
    if (usedToday >= FREE_TIER_DAILY_LIMIT) {
      return res.status(429).json({
        error: `Daily free tier limit reached (${FREE_TIER_DAILY_LIMIT}/day). Try again tomorrow.`,
      });
    }

    job = await createJob({ userId: identifier, prompt: prompt.trim() });
  } catch (err) {
    console.error('[POST /api/generate] job creation failed:', err);
    return res.status(500).json({ error: 'Failed to create job' });
  }

  res.status(202).json({ job });

  scheduleRender(job.id, prompt.trim(), duration);
});

function startRenderWorker(jobId, prompt, targetDurationSeconds, onSettled) {
  const child = fork(path.join(__dirname, 'renderWorker.js'), { stdio: 'inherit' });

  let settled = false;
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
          settled = true;
          await updateJob(jobId, { status: 'uploading', progress: 100 });
          const fileBuffer = fs.readFileSync(msg.localFilePath);
          const videoUrl = await uploadRenderedVideo(jobId, msg.localFilePath, fileBuffer);
          fs.unlink(msg.localFilePath, () => {});
          await updateJob(jobId, { status: 'done', video_url: videoUrl });
          onSettled();
          break;
        }

        case 'failed':
          settled = true;
          console.error(`[renderWorker] job ${jobId} failed:`, msg.error);
          await updateJob(jobId, { status: 'failed', error: String(msg.error) });
          onSettled();
          break;
      }
    } catch (err) {
      console.error(`[startRenderWorker] job ${jobId} handling "${msg.type}" failed:`, err);
    }
  });

  child.on('exit', (code, signal) => {
    if (!settled) {
      console.error(`[renderWorker] job ${jobId} child exited unexpectedly - code: ${code}, signal: ${signal}`);
      updateJob(jobId, {
        status: 'failed',
        error: `Render process exited unexpectedly (code ${code}, signal ${signal || 'none'}).`,
      }).catch(() => {});
      settled = true;
      onSettled();
    }
  });

  child.send({ jobId, prompt, targetDurationSeconds });
}

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
