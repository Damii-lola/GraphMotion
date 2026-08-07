// This is a SEPARATE Render service from the main API (backend/server.js).
// Its only job: receive a render trigger over HTTP, run it through the
// same one-at-a-time queue + forked-worker pattern used before, and
// write status/progress/results directly to the SAME shared Supabase
// project the API service uses. It never talks to the API service back -
// the API service just polls Supabase directly via GET /api/jobs/:id,
// same as it always has.
//
// Why a separate service at all: this box's entire 512MB (or whatever
// plan you're on) is now dedicated ONLY to rendering - it doesn't share
// memory with the API server's Express/Supabase/Mistral traffic anymore.

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '.puppeteer-cache');

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const { updateJob, uploadRenderedVideo } = require('./supabaseClient');

const app = express();
app.use(express.json({ limit: '1mb' }));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] renderer staying up despite:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] renderer staying up despite:', err);
});

// Shared secret so random people on the internet can't trigger renders
// (and burn your Mistral credits/compute) by hitting this endpoint
// directly. The API service sends this same value in an Authorization
// header - set RENDER_SHARED_SECRET to the SAME value on BOTH services.
const RENDER_SHARED_SECRET = process.env.RENDER_SHARED_SECRET;

function requireSharedSecret(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!RENDER_SHARED_SECRET) {
    console.error('[renderer] RENDER_SHARED_SECRET is not set - refusing all requests until it is configured.');
    return res.status(500).json({ error: 'Renderer misconfigured' });
  }
  if (token !== RENDER_SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Same concurrency-limiting queue as before - only one render (one
// forked Chrome instance) runs at a time on this box.
const MAX_CONCURRENT_RENDERS = 1;
let activeRenders = 0;
const renderQueue = [];

function scheduleRender(jobId, prompt) {
  renderQueue.push({ jobId, prompt });
  drainQueue();
}

function drainQueue() {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) return;
  const next = renderQueue.shift();
  if (!next) return;

  activeRenders++;
  startRenderWorker(next.jobId, next.prompt, () => {
    activeRenders--;
    drainQueue();
  });
}

app.post('/render', requireSharedSecret, (req, res) => {
  const { jobId, prompt } = req.body || {};

  if (!jobId || !prompt) {
    return res.status(400).json({ error: 'jobId and prompt are required' });
  }

  // Acknowledge immediately - the actual render happens in the
  // background via the queue, same as the API service's own endpoint
  // used to work before the split.
  res.status(202).json({ accepted: true, jobId });

  scheduleRender(jobId, prompt);
});

function startRenderWorker(jobId, prompt, onSettled) {
  const child = fork(path.join(__dirname, 'renderWorker.js'), { stdio: 'inherit' });

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
          updateJob(jobId, { progress: msg.progress }).catch(() => {});
          break;

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
      const isLikelyOOM = signal === 'SIGKILL' || code === 137;
      const reason = isLikelyOOM
        ? 'Render process was killed (SIGKILL) - almost certainly ran out of memory.'
        : `Render process exited unexpectedly (code ${code}, signal ${signal || 'none'}).`;

      console.error(`[renderWorker] job ${jobId} child exited unexpectedly - code: ${code}, signal: ${signal}`);
      updateJob(jobId, { status: 'failed', error: reason }).catch(() => {});
      settled = true;
      onSettled();
    }
  });

  child.send({ jobId, prompt });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[renderer] listening on port ${PORT}`);
});
