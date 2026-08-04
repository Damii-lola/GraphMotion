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
//   IP_HASH_SALT                 - any random string, used to hash visitor IPs before storing them
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
  IP_HASH_SALT,
  PORT,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
}
if (!MISTRAL_API_KEY) {
  console.error('Missing MISTRAL_API_KEY env var.');
}
if (!IP_HASH_SALT) {
  console.warn('IP_HASH_SALT not set — using an insecure default. Set this in Render.');
}

// Service role key => server-side only client, full DB access, bypasses RLS.
// Never send this key to the frontend.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
// Render sits in front of this service as a proxy — without this, req.ip
// resolves to Render's internal proxy address, not the visitor's real IP,
// and the free-generation limit becomes trivially bypassable.
app.set('trust proxy', true);

app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',') : '*',
  })
);

function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(String(ip) + (IP_HASH_SALT || 'graphmotion-dev-salt'))
    .digest('hex');
}

function getClientIp(req) {
  // req.ip already respects X-Forwarded-For once 'trust proxy' is set.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'graphmotion-backend', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Waitlist signup — stores an email from the landing page into Supabase
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
// Free-generation gate
//
// One free render per visitor, enforced server-side by IP hash AND a
// client-generated device id — either match locks them out, so clearing
// localStorage alone (new device id, same IP) or switching networks alone
// (new IP, same device id) doesn't get around it.
//
//   create table free_generations (
//     id uuid primary key default gen_random_uuid(),
//     ip_hash text not null,
//     device_id text,
//     prompt text,
//     video_url text,
//     created_at timestamptz default now()
//   );
//   create index free_generations_ip_hash_idx on free_generations (ip_hash);
//   create index free_generations_device_id_idx on free_generations (device_id);
// ---------------------------------------------------------------------------
async function findExistingFreeGeneration(ipHash, deviceId) {
  const filters = [`ip_hash.eq.${ipHash}`];
  if (deviceId) filters.push(`device_id.eq.${deviceId}`);

  const { data, error } = await supabase
    .from('free_generations')
    .select('prompt, video_url, created_at')
    .or(filters.join(','))
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('Supabase free_generations lookup error:', error);
    return null;
  }
  return data && data[0] ? data[0] : null;
}

// Lets the frontend know, on page load, whether this visitor already has a
// free generation on file — so it can render the locked state immediately
// instead of flashing the input then locking it after a request.
app.get('/api/free-status', async (req, res) => {
  try {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : null;
    const ipHash = hashIp(getClientIp(req));

    const existing = await findExistingFreeGeneration(ipHash, deviceId);

    if (existing) {
      return res.json({
        ok: true,
        used: true,
        prompt: existing.prompt,
        url: existing.video_url,
      });
    }

    return res.json({ ok: true, used: false });
  } catch (err) {
    console.error('Unexpected /api/free-status error:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// Mistral-powered scene plan (text only, no render) — kept for internal use.
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
// ---------------------------------------------------------------------------
const RENDER_DIR = path.join(__dirname, 'render');
const SCENE_FILE = path.join(RENDER_DIR, 'src', 'scenes', 'generated.tsx');
const PROJECT_FILE = path.join(RENDER_DIR, 'src', 'project.ts');
const OUTPUT_DIR = path.join(RENDER_DIR, 'output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use('/renders', express.static(OUTPUT_DIR));

const jobs = new Map(); // jobId -> { status, progress, file, error, ipHash, deviceId, prompt, createdAt }
let renderBusy = false;

const SCENE_SYSTEM_PROMPT = `You write Revideo/Motion Canvas .tsx scene code for GraphMotion.

Output ONLY the contents of a single .tsx file. No markdown fences, no
explanation, no text before or after the code.

Hard rules:
- Imports allowed: only from '@revideo/2d' and '@revideo/core'.
- Must have exactly one default export, in this exact shape:
  export default makeScene2D('generated', function* (view) { ... });
- Start the generator with view.fill('#0B0C10') (or another appropriate hex) to set the background.
- Build the scene from primitives such as Txt, Rect, Circle, Line, and Node.
- Animate with generator-style tweens driven by yield*, e.g.
  yield* someRef().opacity(1, 0.8);
  yield* waitFor(1);
- Do not reference any image, video, audio, or font file that doesn't already
  exist in the project — text and vector shapes only.
- Keep the whole scene under ~20 seconds of animated content.
- Frame the scene for a 9:16 vertical video.`;

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

  code = code.trim();
  if (code.startsWith('```')) {
    code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }

  return code;
}

async function runRender(jobId) {
  const job = jobs.get(jobId);
  try {
    job.status = 'generating';
    const sceneCode = await generateSceneCode(job.prompt);

    // Defensive: make sure the scenes directory actually exists before
    // writing into it. This is what was throwing ENOENT — writeFileSync
    // fails if the parent directory is missing, it doesn't create it.
    fs.mkdirSync(path.dirname(SCENE_FILE), { recursive: true });
    fs.writeFileSync(SCENE_FILE, sceneCode, 'utf-8');
    job.code = sceneCode;

    job.status = 'rendering';

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

    const finalFile = path.basename(file || outFile);
    const videoUrl = `/renders/${finalFile}`;

    // Record this as the visitor's one free generation.
    const { error } = await supabase.from('free_generations').insert([
      {
        ip_hash: job.ipHash,
        device_id: job.deviceId || null,
        prompt: job.prompt,
        video_url: videoUrl,
      },
    ]);
    if (error) console.error('Failed to record free_generation:', error);

    job.status = 'done';
    job.progress = 1;
    job.file = finalFile;
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
  const { prompt, deviceId } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'A prompt string is required.' });
  }

  const ipHash = hashIp(getClientIp(req));

  const existing = await findExistingFreeGeneration(ipHash, deviceId);
  if (existing) {
    return res.status(403).json({
      ok: false,
      locked: true,
      error: 'Free generation already used.',
      prompt: existing.prompt,
      url: existing.video_url,
    });
  }

  if (renderBusy) {
    return res.status(409).json({ ok: false, error: 'A render is already in progress. Try again shortly.' });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    status: 'queued',
    progress: 0,
    file: null,
    error: null,
    ipHash,
    deviceId: deviceId || null,
    prompt,
    createdAt: Date.now(),
  });
  renderBusy = true;

  runRender(jobId);

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

  // Send the generated .tsx as soon as it exists so the UI can reveal it
  // in the code panel while the render itself is still in progress.
  if (job.code) {
    payload.code = job.code;
  }

  if (job.status === 'done' && job.file) {
    payload.url = `/renders/${job.file}`;
  }

  res.json(payload);
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`GraphMotion backend listening on port ${port}`);
});
