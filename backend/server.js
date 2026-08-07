require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');

const {
  createJob,
  updateJob,
  getJob,
  countJobsToday,
} = require('./supabaseClient');

const app = express();

// Render (and most PaaS) sits behind a reverse proxy, so Express needs
// this to correctly read X-Forwarded-For - without it, express-rate-limit
// can't reliably tell users apart by IP, and req.ip used for the
// anonymous free-tier key falls back to the proxy's IP for everyone.
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

// This service no longer renders anything itself - it hands the actual
// work off to a SEPARATE Render service (render-service/) dedicated
// purely to rendering, over a simple authenticated HTTP call. That
// service has its own independent memory budget instead of sharing
// this one, and this service in turn stays extremely light (no
// Puppeteer, no Vite, no @revideo/* packages at all) since it never
// touches any of that anymore.
const RENDERER_SERVICE_URL = process.env.RENDERER_SERVICE_URL;
const RENDER_SHARED_SECRET = process.env.RENDER_SHARED_SECRET;

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
 * Responds immediately with the job (status: queued), then triggers
 * the separate renderer service over HTTP. This request does NOT wait
 * for that render to finish - it only waits for the renderer to
 * acknowledge it received the job (a fast, trivial response), then
 * returns. The client polls GET /api/jobs/:id (this service, reading
 * the same shared Supabase the renderer writes to) to watch progress.
 */
app.post('/api/generate', generateLimiter, async (req, res) => {
  const { prompt, userId } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt is required (min 3 chars)' });
  }

  if (!RENDERER_SERVICE_URL || !RENDER_SHARED_SECRET) {
    console.error('[POST /api/generate] RENDERER_SERVICE_URL or RENDER_SHARED_SECRET not configured');
    return res.status(500).json({ error: 'Server misconfigured - renderer service not set up' });
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

  // Fire-and-forget from this request's point of view. If the renderer
  // is asleep (free tier spin-down), this call itself will take up to
  // ~30-60s to wake it - that's fine since we already responded to the
  // client above; the job just sits at 'queued' a bit longer, visible
  // via polling, not a failure.
  triggerRemoteRender(job.id, prompt.trim()).catch((err) => {
    console.error(`[triggerRemoteRender] job ${job.id} failed to reach renderer service:`, err);
    updateJob(job.id, {
      status: 'failed',
      error: `Could not reach the render service: ${err.message || err}`,
    }).catch(() => {});
  });
});

async function triggerRemoteRender(jobId, prompt) {
  const res = await fetch(`${RENDERER_SERVICE_URL}/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RENDER_SHARED_SECRET}`,
    },
    body: JSON.stringify({ jobId, prompt }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Renderer service responded ${res.status}: ${text}`);
  }
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
