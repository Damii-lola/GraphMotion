// GraphMotion backend
// Single server.js, complete code, no hardcoded data.
//
// Wiring: GitHub (this repo) -> Render (native Node service) -> Supabase (service role) -> Mistral (AI text calls)
//
// Free preview is now 100% client-side: this server generates Remotion
// component code via Mistral and hands the code straight back — the
// browser transpiles and plays it live via @remotion/player. No headless
// Chromium, no ffmpeg, no waiting, for the free path.
//
// Server-side rendering (headless Chromium + ffmpeg, via @remotion/bundler
// + @remotion/renderer) only happens in /api/export, for a real mp4 file —
// that's meant for the future paid tier and isn't wired to any button yet.
//
// Required env vars (set these in Render's dashboard, NOT in code):
//   SUPABASE_URL               - your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY  - Supabase service role key (server-side only, never expose to frontend)
//   MISTRAL_API_KEY            - Mistral API key
//   ALLOWED_ORIGIN              - the GitHub Pages origin allowed to call this API (e.g. https://you.github.io)
//   IP_HASH_SALT                 - any random string, used to hash visitor IPs before storing them
//   PORT                        - Render sets this automatically, defaults to 3000 locally
//
// Deployed as a plain Render Node service — no Dockerfile, no Chromium,
// no ffmpeg. That's intentional: the free preview path (Mistral -> code
// -> browser) needs none of that. /api/export below still calls
// @remotion/renderer, which needs a real Chromium to actually run — it
// will not work on this native environment as-is. It's left in as real,
// working code for whenever the paid export tier gets built; at that
// point this service needs to move back to a Docker environment with
// Chromium + ffmpeg installed (an earlier version of this file's
// Dockerfile had the exact apt-get list for that).

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(
  cors({
    // .trim() each entry — a stray space after a comma in the Render env
    // var (e.g. "https://a.com, https://b.com") makes an exact string
    // match fail silently: the cors package just skips the header
    // instead of erroring, which is exactly what produced this bug.
    origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map((o) => o.trim()) : '*',
  })
);

function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(String(ip) + (IP_HASH_SALT || 'graphmotion-dev-salt'))
    .digest('hex');
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'graphmotion-backend', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Waitlist signup
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
// One free generation per visitor, enforced server-side by IP hash AND a
// client-generated device id. Stores the generated CODE (not a video file —
// there isn't one for the free tier), so a locked-out visitor's previous
// result can be replayed client-side from the stored code.
//
//   create table free_generations (
//     id uuid primary key default gen_random_uuid(),
//     ip_hash text not null,
//     device_id text,
//     prompt text,
//     code text,
//     video_url text,
//     created_at timestamptz default now()
//   );
//   create index free_generations_ip_hash_idx on free_generations (ip_hash);
//   create index free_generations_device_id_idx on free_generations (device_id);
//
// If you already created this table for the old video_url-only version,
// just run: alter table free_generations add column code text;
// ---------------------------------------------------------------------------
async function findExistingFreeGeneration(ipHash, deviceId) {
  const filters = [`ip_hash.eq.${ipHash}`];
  if (deviceId) filters.push(`device_id.eq.${deviceId}`);

  const { data, error } = await supabase
    .from('free_generations')
    .select('prompt, code, created_at')
    .or(filters.join(','))
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('Supabase free_generations lookup error:', error);
    return null;
  }
  return data && data[0] ? data[0] : null;
}

app.get('/api/free-status', async (req, res) => {
  try {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : null;
    const ipHash = hashIp(getClientIp(req));

    const existing = await findExistingFreeGeneration(ipHash, deviceId);

    if (existing) {
      return res.json({ ok: true, used: true, prompt: existing.prompt, code: existing.code });
    }
    return res.json({ ok: true, used: false });
  } catch (err) {
    console.error('Unexpected /api/free-status error:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// Mistral -> Remotion component code
//
// Two Mistral calls, not one: first the person's short prompt gets
// expanded by a "creative director" pass into a detailed cinematic brief
// (camera movement, depth staging, a deliberate palette, one or two hero
// effects) — then THAT brief, not the raw prompt, is what actually gets
// turned into code. This is what makes a two-word prompt like "a circle"
// come back looking directed instead of literal.
//
// The exact same code shape is used for both the free client-side preview
// (transpiled and eval'd in-browser, imports stripped first) and the
// server-side export pipeline (used as a real ES module, imports intact).
// ---------------------------------------------------------------------------
const PROMPT_DIRECTOR_SYSTEM_PROMPT = `You are a creative director for GraphMotion, an AI motion-graphics video generator.

Given a short, plain user prompt describing a video, rewrite it into a
detailed creative brief for an 8-second, 1080x1920 animated scene.

Your brief must specify, concretely and specifically to this topic (not
generically):
- A camera-like move for the shot (a slow push-in, a drift, a rack focus —
  pick one that fits the subject).
- Depth staging: what sits in the background, midground, and foreground.
- ONE or TWO deliberate hero effects from: film grain, chromatic
  aberration at a transition, a light leak, a glitch moment at a reveal,
  a procedural particle field, a tilted frosted-glass panel with
  embossed/extruded title type. Do not pile on more than two.
- A specific 2-3 color palette (name actual colors/hex-ish tones) that
  suits the subject and mood — never generic black-on-white.
- The rough beat structure across the 8 seconds (what happens first,
  what happens at the midpoint, how it resolves).

Output ONLY the brief itself, as 4-8 sentences of plain prose. No headers,
no bullet points, no markdown, no code, no preamble.`;

async function enhancePrompt(rawPrompt) {
  const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [
        { role: 'system', content: PROMPT_DIRECTOR_SYSTEM_PROMPT },
        { role: 'user', content: rawPrompt },
      ],
    }),
  });

  if (!mistralRes.ok) {
    const errText = await mistralRes.text();
    throw new Error(`Mistral prompt enhancement failed: ${mistralRes.status} ${errText}`);
  }

  const data = await mistralRes.json();
  const brief = data?.choices?.[0]?.message?.content || '';
  return brief.trim() || rawPrompt; // fall back to the raw prompt if this comes back empty
}

const SCENE_SYSTEM_PROMPT = `You write Remotion component code for GraphMotion.
Output ONLY the contents of a single .tsx file. No markdown fences, no
explanation, no text before or after the code.

HARD RULES (unchanged):
- Exactly one import line, importing only from 'remotion', e.g.:
  import {AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig, Sequence, Easing} from 'remotion';
  Only import the named exports you actually use.
- Exactly one export, in this exact shape (named export, not default):
  export function GeneratedScene() { ... }
- Use useCurrentFrame() and interpolate()/spring() to drive all animation —
  never use CSS @keyframes or setTimeout/setInterval.
- Build the scene from AbsoluteFill, plain <div>/<span>/<svg> with inline
  style objects, and Sequence for timing offsets. No external images,
  video, audio, or font files — inline styles, inline SVG, and system
  fonts only.
- The composition is 1080x1920 (9:16), 30fps, 240 frames total (8 seconds).
  Design the whole scene to read as complete within frame 0–240.

VISUAL DIRECTION — cinematic, dimensional, After-Effects-style:
This must NOT read as flat slides with text fading in. Every scene needs
fake depth, atmosphere, and camera-like movement, built from these
specific techniques:

1. DEPTH & FAKE 3D (all via CSS transforms, no 3D engine):
   - Layer the scene into at least 3 depth planes (background, midground,
     foreground). Background layers move slower and are more blurred
     (filter: blur()) than foreground layers — this parallax difference
     is what sells depth.
   - Use \`perspective\`, \`rotateX\`, \`rotateY\`, \`translateZ\`, and \`scale\`
     together on container divs to simulate camera tilt/dolly moves.
     Animate these with interpolate() tied to frame, not just opacity.
   - Fake a "dolly zoom" by scaling the background up while scaling
     foreground text down slightly at the same time.
   - Use soft drop shadows (filter: drop-shadow) with an offset that
     matches an implied light direction — this alone adds significant
     dimensionality to flat shapes/text.

2. CAMERA MOVEMENT:
   - Every scene should have at least one continuous subtle camera-like
     motion across its full duration (slow scale-up "push in," a slight
     pan via translateX/Y, or a slow rotateZ drift) — never a fully
     static frame. Stillness reads as flat; drift reads as cinematic.

3. PARTICLE SYSTEMS (procedural, no assets):
   - Generate 20-60 small divs or SVG circles in a loop, each with a
     seeded pseudo-random position, size, and speed (derive randomness
     from a fixed seed + index, not Math.random(), so it's deterministic
     across renders).
   - Animate each particle's position/opacity/scale independently via
     interpolate() using its own phase offset, so they don't move in
     unison. Add slight blur to background-plane particles for depth.

4. POST-PROCESSING LOOKS (all achievable in pure CSS/SVG):
   - FILM GRAIN: an inline <svg> with a <filter> using <feTurbulence> +
     <feColorMatrix>, applied as a semi-transparent full-frame overlay.
   - CHROMATIC ABERRATION: duplicate a text/shape element 2-3 times in
     red/green/blue tints, each offset by 1-3px in slightly different
     directions, with mix-blend-mode: screen — apply only at high-energy
     moments (transitions, impacts), not constantly.
   - LIGHT LEAKS / GLOW: large soft radial-gradient divs with
     mix-blend-mode: screen or overlay, positioned off-frame-edge,
     slowly drifting.
   - VIGNETTE: a full-frame radial-gradient overlay, transparent center
     to dark edges, low opacity.
   - GLITCH MOMENTS: brief (2-5 frame) jitter using clip-path slices
     offset horizontally, plus a quick RGB-channel-split flash — use
     sparingly, only at hard cuts/reveals, not throughout.
   - DEPTH OF FIELD: blur background-plane elements more than
     foreground, and rack focus by animating blur amount on a layer
     over a few frames to simulate a focus pull.

5. GLASS SURFACES & DIMENSIONAL TYPE (high-end product-promo look):
   - GLASS/FROSTED PANELS: rounded-corner divs with a semi-transparent
     background (e.g. rgba fill at 10-20% opacity), a 1px semi-transparent
     border for the edge highlight, and backdrop-filter: blur(12-20px).
     Tilt these in 3D with perspective + rotateX (10-20deg) on the parent
     so the panel reads as a floating surface in space, not a flat card.
     Have it "settle" into position with a spring-like overshoot on
     rotateX/translateY/scale rather than easing straight to rest.
   - EMBOSSED / EXTRUDED TITLE TEXT: fake letter depth with 4-8 stacked
     text-shadow layers, each offset by ~1px more than the last in the
     same direction, darkening slightly each step, topped with a crisp
     light-colored top layer — this reads as extruded/embossed rather
     than flat. Optionally overlay a subtle repeating horizontal-line
     pattern (a scanline/hologram texture) clipped to the text shape via
     background-clip: text on a background-image of thin repeating
     gradient stripes.
   - Pair glass panels + embossed type with the fog/atmosphere background
     from the light-leak/vignette techniques above — soft, irregular,
     slowly-drifting blurred glow shapes reading as fog, never a flat
     solid background behind a "premium" scene.

6. TASTE / RESTRAINT (critical):
   - Pick ONE or TWO hero effects per scene, not all of them at once.
     A scene with grain + chromatic aberration + glitch + particles +
     light leaks simultaneously will look cluttered and cheap, not
     premium. Premium reads as restrained with one clear focal move.
   - Grain and vignette can run subtly throughout as a constant "look."
     Glitch and chromatic aberration should be reserved for transition
     moments only.
   - Maintain a deliberate, limited color palette per scene (2-3 core
     colors + neutrals) — do not default to plain black-on-white or
     rainbow gradients.

Design the whole 240-frame scene as one continuous cinematic shot with
depth, drift, and one clear atmospheric identity — not a slideshow with
effects sprinkled on top.`;

async function generateSceneCode(directedBrief) {
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
        { role: 'user', content: directedBrief },
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

// ---------------------------------------------------------------------------
// Refinement passes: take the brief + current code, tell Mistral the
// current version is too simple/flat for a premium result, and have it
// rewrite the whole thing at a higher level of craft. Run 3 times in a
// row, each pass building on the previous rewrite.
//
// Real cost of this: 3 extra sequential Mistral calls, each generating a
// full scene file — this adds real, noticeable latency on top of the
// enhance + initial-generate calls already happening. That's the direct
// tradeoff for pushing quality further per request.
// ---------------------------------------------------------------------------
const REFINE_SYSTEM_PROMPT = `You are a ruthless creative director reviewing Remotion motion-graphics code for GraphMotion. You will be given the original creative brief and the current code for the scene. The current code is not good enough — it reads as too simple, too flat, and nowhere near a premium After-Effects-style result. Rewrite it into a dramatically more sophisticated version.

You MUST still follow these hard rules exactly, no exceptions:
- Exactly one import line, importing only from 'remotion'.
- Exactly one export, in this exact shape (named export, not default):
  export function GeneratedScene() { ... }
- Use useCurrentFrame() and interpolate()/spring() to drive all animation —
  never CSS @keyframes or setTimeout/setInterval.
- No external images, video, audio, or font files — inline styles, inline
  SVG, and system fonts only.
- The composition is 1080x1920 (9:16), 30fps, 240 frames total (8 seconds).
  The whole scene must read as complete within frame 0–240.

Push further on depth staging, camera-like drift across the full
duration, materials (glass panels, embossed type, lighting), and
executing one or two hero effects with real craft and precise timing —
not by piling on more elements, but by making the existing ideas read as
more expensive and deliberate. Keep one clear atmospheric identity;
don't let effects fight each other.

Output ONLY the rewritten .tsx file. No markdown fences, no explanation,
no notes about what changed.`;

function looksLikeValidScene(code) {
  return /function\s+GeneratedScene/.test(code) && /from\s+['"]remotion['"]/.test(code);
}

async function refineSceneCode(directedBrief, currentCode) {
  const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [
        { role: 'system', content: REFINE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `CREATIVE BRIEF:\n${directedBrief}\n\nCURRENT CODE (too simple — needs a major upgrade):\n${currentCode}`,
        },
      ],
    }),
  });

  if (!mistralRes.ok) {
    const errText = await mistralRes.text();
    throw new Error(`Mistral refinement failed: ${mistralRes.status} ${errText}`);
  }

  const data = await mistralRes.json();
  let code = data?.choices?.[0]?.message?.content || '';

  code = code.trim();
  if (code.startsWith('```')) {
    code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }

  return code;
}

async function refineSceneCodeMultiPass(directedBrief, initialCode, passes) {
  let code = initialCode;

  for (let i = 1; i <= passes; i++) {
    try {
      const candidate = await refineSceneCode(directedBrief, code);
      if (looksLikeValidScene(candidate)) {
        code = candidate;
      } else {
        console.warn(`Refinement pass ${i} produced invalid code — keeping the previous version.`);
      }
    } catch (err) {
      console.error(`Refinement pass ${i} failed — keeping the previous version.`, err);
    }
  }

  return code;
}

// ---------------------------------------------------------------------------
// Free preview: prompt -> Mistral writes Remotion code -> returned directly.
// No render, no polling — the browser plays it live via @remotion/player.
// ---------------------------------------------------------------------------
app.post('/api/render', async (req, res) => {
  try {
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
        code: existing.code,
      });
    }

    const directedBrief = await enhancePrompt(prompt);
    const initialCode = await generateSceneCode(directedBrief);
    const code = await refineSceneCodeMultiPass(directedBrief, initialCode, 3);

    const { error } = await supabase.from('free_generations').insert([
      { ip_hash: ipHash, device_id: deviceId || null, prompt, code },
    ]);
    if (error) console.error('Failed to record free_generation:', error);

    res.json({ ok: true, code });
  } catch (err) {
    console.error('Unexpected /api/render error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// Export: real mp4 via headless Chromium + ffmpeg. Not gated by payment yet
// (that needs a payment flow this codebase doesn't have) and not called by
// any button in the UI today — it's here so the paid tier has something
// real to build on top of rather than starting from scratch later.
// ---------------------------------------------------------------------------
const SCENE_FILE = path.join(__dirname, 'GeneratedScene.tsx');
const ENTRY_FILE = path.join(__dirname, 'index.ts');
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/exports', express.static(OUTPUT_DIR));

let exportBusy = false;

app.post('/api/export', async (req, res) => {
  try {
    const { code } = req.body || {};

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ ok: false, error: 'Scene code is required.' });
    }
    if (exportBusy) {
      return res.status(409).json({ ok: false, error: 'An export is already in progress. Try again shortly.' });
    }

    exportBusy = true;

    fs.mkdirSync(path.dirname(SCENE_FILE), { recursive: true });
    fs.writeFileSync(SCENE_FILE, code, 'utf-8');

    if (!fs.existsSync(ENTRY_FILE)) {
      throw new Error(`Missing Remotion entry file at ${ENTRY_FILE} — check it's committed and pushed to the repo.`);
    }

    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    const bundleLocation = await bundle({
      entryPoint: ENTRY_FILE,
      onProgress: () => {},
    });

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'generated',
    });

    const outFile = `${crypto.randomUUID()}.mp4`;
    const outputLocation = path.join(OUTPUT_DIR, outFile);

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation,
      // No browserExecutable override here — there's no Docker-installed
      // Chromium on this native Node environment. This endpoint needs a
      // Docker deploy with Chromium/ffmpeg (see the note above) before
      // it'll actually run; Remotion will error clearly if Chromium isn't
      // found rather than hanging.
      chromiumOptions: { disableWebSecurity: false, ignoreCertificateErrors: false },
    });

    res.json({ ok: true, url: `/exports/${outFile}` });
  } catch (err) {
    console.error('Unexpected /api/export error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Export failed.' });
  } finally {
    exportBusy = false;
  }
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`GraphMotion backend listening on port ${port}`);
});
