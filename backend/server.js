require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const { generateSceneJSON } = require('./mistralClient');
const { renderJobToFile } = require('./renderService');
const {
  createJob,
  updateJob,
  getJob,
  countJobsToday,
  uploadRenderedVideo,
} = require('./supabaseClient');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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
 * This kicks the job off SYNCHRONOUSLY for now (simplest correct version).
 * Once render times grow, swap this for: create job -> return jobId
 * immediately -> render in background -> client polls /api/jobs/:id.
 * The job row + status columns already support that without changes.
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

  try {
    await updateJob(job.id, { status: 'writing_scenes' });
    const sceneJSON = await generateSceneJSON(prompt.trim());
    await updateJob(job.id, { scene_json: sceneJSON, status: 'rendering' });

    const localFilePath = await renderJobToFile(job.id, sceneJSON);

    await updateJob(job.id, { status: 'uploading' });
    const fileBuffer = fs.readFileSync(localFilePath);
    const videoUrl = await uploadRenderedVideo(job.id, localFilePath, fileBuffer);

    fs.unlink(localFilePath, () => {});

    const finalJob = await updateJob(job.id, { status: 'done', video_url: videoUrl });
    return res.json({ job: finalJob });
  } catch (err) {
    console.error(`[POST /api/generate] job ${job.id} failed:`, err);
    await updateJob(job.id, { status: 'failed', error: String(err.message || err) }).catch(() => {});
    return res.status(500).json({ error: 'Video generation failed', jobId: job.id });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
