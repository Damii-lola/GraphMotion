// GraphMotion backend
// Single server.js, complete code, no hardcoded data.
//
// Wiring: GitHub (this repo) -> Render (Docker service) -> Supabase (service role) -> Mistral (AI text calls)
//                                        -> Revideo/Motion Canvas (.tsx render -> mp4, via headless Chromium + ffmpeg)
//
// Required env vars (set these in Render's dashboard, NOT in code):
//   SUPABASE_URL               - your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY  - Supabase service role key (server-side only, never expose to frontend)
//   MISTRAL_API_KEY            - Mistral API key
//   ALLOWED_ORIGIN              - the GitHub Pages origin allowed to call this API (e.g. https://you.github.io)
//   PORT                        - Render sets this automatically, defaults to 3000 locally
//
// Deploy this as a Render DOCKER service (see Dockerfile) — rendering needs
// headless Chromium + ffmpeg, which Render's native Node runtime doesn't have.

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  MISTRAL_API_KEY,
  ALLOWED_ORIGIN,
  PORT,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
}
if (!MISTRAL_API_KEY) {
  console.error('Missing MISTRAL_API_KEY env var.');
}

// Service role key => server-side only client, full DB access, bypasses RLS.
// Never send this key to the frontend.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',') : '*',
  })
);

// ---------------------------------------------------------------------------
// Health check — used by Render and for a quick manual sanity check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'graphmotion-backend', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Waitlist signup — stores an email from the landing page into Supabase
//
// Expected table (run this in the Supabase SQL editor):
//
//   create table waitlist (
//     id uuid primary key default gen_random_uuid(),
//     email text unique not null,
//     source text,
//     created_at timestamptz default now()
//   );
// ---------------------------------------------------------------------------
app.post('/api/waitlist', async (req, res) => {
  try {
    const { email, source } = req.body || {};

    if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    }

    const { data, error } = await supabase
      .from('waitlist')
      .insert([{ email: email.trim().toLowerCase(), source: source || 'landing_page' }])
      .select()
      .single();

    if (error) {
      // Unique violation = already signed up, treat as success so the UI stays friendly
      if (error.code === '23505') {
        return res.status(200).json({ ok: true, alreadySignedUp: true });
      }
      console.error('Supabase insert error:', error);
      return res.status(500).json({ ok: false, error: 'Could not save signup.' });
    }

    return res.status(201).json({ ok: true, data });
  } catch (err) {
    console.error('Unexpected /api/waitlist error:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// Mistral-powered scene plan (kept from earlier wiring — returns a text plan,
// not code). Useful for previewing what a render will contain before paying
// the cost of an actual render.
// ---------------------------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ ok: false, error: 'A prompt string is required.' });
    }

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [
          {
            role: 'system',
            content:
              "You are GraphMotion's generation engine. Given a video topic prompt, respond with a short scene-by-scene plan for a code-driven motion graphics video (no stock footage, no avatars).",
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!mistralRes.ok) {
      const errText = await mistralRes.text();
      console.error('Mistral API error:', mistralRes.status, errText);
      return res.status(502).json({ ok: false, error: 'Generation service failed.' });
    }

    const mistralData = await mistralRes.json();
    const text = mistralData?.choices?.[0]?.message?.content || '';

    return res.json({ ok: true, plan: text });
  } catch (err) {
    console.error('Unexpected /api/generate error:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// Render pipeline: prompt -> Mistral writes a Revideo/Motion Canvas .tsx
// scene -> Revideo renders it headlessly to mp4 -> file is served back.
//
// This runs one render at a time (renderBusy lock below). Revideo's
// renderVideo() spins up a Vite dev server + headless Chromium per call,
// which is heavy — running several concurrently on a single Render
// instance is a good way to run out of memory. If you need concurrency,
// look at renderVideo()'s `settings.workers` option or queue jobs into
// something like BullMQ backed by Redis.
//
// Jobs are tracked in memory only — they don't survive a restart/redeploy.
// For anything beyond solo testing, write job status into Supabase instead.
// ---------------------------------------------------------------------------
const RENDER_DIR = path.join(__dirname, 'render');
const SCENE_FILE = path.join(RENDER_DIR, 'src', 'scenes', 'generated.tsx');
const PROJECT_FILE = path.join(RENDER_DIR, 'src', 'project.ts');
const OUTPUT_DIR = path.join(RENDER_DIR, 'output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Serve finished renders at /renders/<file>.mp4
app.use('/renders', express.static(OUTPUT_DIR));

const jobs = new Map(); // jobId -> { status, progress, file, error, createdAt }
let renderBusy = false;

const SCENE_SYSTEM_PROMPT = `You write Revideo/Motion Canvas .tsx scene code for GraphMotion.

Output ONLY the contents of a single .tsx file. No markdown fences, no
explanation, no text before or after the code.

Hard rules:
- Imports allowed: only from '@revideo/2d' and '@revideo/core'.
- Must have exactly one default export, in this exact shape:
  export default makeScene2D('generated', function* (view) { ... });
- Start the generator with view.fill('#0B0C10') (or another dark hex) to set the background.
- Build the scene from primitives such as Txt, Rect, Circle, Line, and Node.
- Animate with generator-style tweens driven by yield*, e.g.
  yield* someRef().opacity(1, 0.8);
  yield* waitFor(1);
- Do not reference any image, video, audio, or font file that doesn't already
  exist in the project — text and vector shapes only.
- Keep the whole scene under ~20 seconds of animated content.`;

async function generateSceneCode(prompt) {
  const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [
        { role: 'system', content: SCENE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!mistralRes.ok) {
    const errText = await mistralRes.text();
    throw new Error(`Mistral scene generation failed: ${mistralRes.status} ${errText}`);
  }

  const data = await mistralRes.json();
  let code = data?.choices?.[0]?.message?.content || '';

  // Defensive cleanup in case the model wraps the code in fences anyway.
  code = code.trim();
  if (code.startsWith('```')) {
    code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }

  return code;
}

async function runRender(jobId, prompt) {
  const job = jobs.get(jobId);
  try {
    job.status = 'generating';
    const sceneCode = await generateSceneCode(prompt);
    fs.writeFileSync(SCENE_FILE, sceneCode, 'utf-8');

    job.status = 'rendering';

    // @revideo/renderer is ESM-only; server.js is CommonJS, so import it dynamically.
    const { renderVideo } = await import('@revideo/renderer');

    const outFile = `${jobId}.mp4`;

    const file = await renderVideo({
      projectFile: PROJECT_FILE,
      settings: {
        outDir: OUTPUT_DIR,
        outFile,
        logProgress: true,
        puppeteer: {
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        progressCallback: (_workerId, progress) => {
          job.progress = progress;
        },
      },
    });

    job.status = 'done';
    job.progress = 1;
    job.file = path.basename(file || outFile);
  } catch (err) {
    console.error(`Render job ${jobId} failed:`, err);
    job.status = 'error';
    job.error = err.message || 'Unknown render error.';
  } finally {
    renderBusy = false;
  }
}

// Kick off a render job. Returns immediately with a jobId to poll.
app.post('/api/render', async (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'A prompt string is required.' });
  }

  if (renderBusy) {
    return res.status(409).json({ ok: false, error: 'A render is already in progress. Try again shortly.' });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'queued', progress: 0, file: null, error: null, createdAt: Date.now() });
  renderBusy = true;

  // Fire and forget — the client polls GET /api/render/:jobId for status.
  runRender(jobId, prompt);

  res.status(202).json({ ok: true, jobId });
});

// Poll a render job's status. When status is "done", `url` points at the mp4.
app.get('/api/render/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Unknown job id.' });
  }

  const payload = {
    ok: true,
    status: job.status,
    progress: job.progress,
    error: job.error,
  };

  if (job.status === 'done' && job.file) {
    payload.url = `/renders/${job.file}`;
  }

  res.json(payload);
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`GraphMotion backend listening on port ${port}`);
});
