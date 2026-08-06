// Must be set before anything (transitively) requires puppeteer, since
// puppeteer-core resolves its Chrome executable path from this env var.
// Render's build and runtime don't reliably share the default cache
// path (/opt/render/.cache), so Chrome downloaded during `postinstall`
// can vanish by the time the server actually starts. Pointing the
// cache at a path inside the project directory keeps it in whatever
// Render actually deploys.
process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '.puppeteer-cache');

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

// Render (and most PaaS) sits behind a reverse proxy, so Express needs
// this to correctly read X-Forwarded-For - without it, express-rate-limit
// can't reliably tell users apart by IP, and req.ip used for the
// anonymous free-tier key falls back to the proxy's IP for everyone.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Safety net: rendering runs headless Chrome via Puppeteer deep inside
// @revideo/renderer, and library-internal bugs there can throw in a way
// that bypasses the try/catch around renderJobToFile (an unhandled
// promise rejection instead of a rejection our await sees). Without
// these handlers that takes down the ENTIRE process - not just the one
// job - which drops every other in-flight/future request until Render
// notices and restarts the service. Log and stay up instead.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] server staying up despite:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] server staying up despite:', err);
});

const FREE_TIER_DAILY_LIMIT = Number(process.env.FREE_TIER_DAILY_LIMIT || 3);

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * POST /api/generate
 * body: { prompt: string, userId?: string }
 *
 * Responds immediately with the job (status: queued), then hands the
 * actual work to a forked child process (renderWorker.js) rather than
 * running it in this process.
 *
 * Why a child process specifically, not just "don't await it": the
 * render pipeline (Mistral call + Vite bundling + Puppeteer/Chrome
 * orchestration) is heavy enough to monopolize this process's event
 * loop even when not awaited on the request - which meant the ENTIRE
 * server, including trivial GET /api/jobs/:id reads, went unresponsive
 * for the whole render duration (that's what sustained 502s on every
 * endpoint were, not a proxy-timeout fluke). A forked child process has
 * its own event loop, so this server stays responsive no matter how
 * busy - or even crashed - the render process is. If the child gets
 * OOM-killed, only that one job dies; this server and every other
 * in-flight job keep running.
 */
app.post('/api/generate', generateLimiter, async (req, res) => {
  const { prompt, userId } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt is required (min 3 chars)' });
  }

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

  startRenderWorker(job.id, prompt.trim());
});

function startRenderWorker(jobId, prompt) {
  const child = fork(path.join(__dirname, 'renderWorker.js'), {
    // Keep the child's own stdout/stderr visible in the same log stream
    // for debugging, but its execution is fully isolated from this
    // process otherwise.
    stdio: 'inherit',
  });

  let settled = false;

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

        case 'progress':
          // Best-effort - don't let a failed write interrupt anything.
          updateJob(jobId, { progress: msg.progress }).catch(() => {});
          break;

        case 'render_complete': {
          settled = true;
          await updateJob(jobId, { status: 'uploading', progress: 100 });
          const fileBuffer = fs.readFileSync(msg.localFilePath);
          const videoUrl = await uploadRenderedVideo(jobId, msg.localFilePath, fileBuffer);
          fs.unlink(msg.localFilePath, () => {});
          await updateJob(jobId, { status: 'done', video_url: videoUrl });
          break;
        }

        case 'failed':
          settled = true;
          console.error(`[renderWorker] job ${jobId} failed:`, msg.error);
          await updateJob(jobId, { status: 'failed', error: String(msg.error) });
          break;
      }
    } catch (err) {
      console.error(`[startRenderWorker] job ${jobId} handling "${msg.type}" failed:`, err);
    }
  });

  child.on('exit', (code) => {
    if (!settled) {
      // The child died without ever sending 'render_complete' or
      // 'failed' - most likely an OOM kill (Linux SIGKILL bypasses
      // our uncaughtException handler entirely, so this is the only
      // place a silent kill like that can be detected and recorded,
      // rather than leaving the job stuck at "rendering" forever).
      console.error(`[renderWorker] job ${jobId} child exited unexpectedly (code ${code}), likely OOM-killed`);
      updateJob(jobId, {
        status: 'failed',
        error: `Render process exited unexpectedly (code ${code}), likely out of memory.`,
      }).catch(() => {});
    }
  });

  child.send({ jobId, prompt });
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
