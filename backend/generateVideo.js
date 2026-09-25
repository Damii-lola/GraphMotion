'use strict';
/*
 * /api/generate-video - "type your company's details, get a marketing video".
 *
 *   POST /api/generate-video          { company, details, focus, notes?, logo?, images? }  -> 202 { id }
 *   GET  /api/generate-video/:id      -> { status, label, progress, eta, error?, videoUrl?, downloadUrl?, mp4Url? }
 *   POST /api/generate-video/:id/cancel
 *
 * The id is a string of digits and doubles as the preview id: the AI-generated ad page is stored under /preview/<id>/
 * (previewStore.js, also mirrored in Supabase), the recorder films that page (siteVideo.js) and the finished MKV/MP4 is served
 * by the site-video file routes. The visitor only ever sees two labels: "Cloudflare is generating your video" and "Rendering video".
 *
 * Cloudflare neurons are protected three ways: one generation at a time (the per-run ceiling in neuronBudget is process-wide),
 * the daily ceiling, and the client's own photos replacing Flux images (free). A refused generation is reported as capacity.
 */
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('./previewStore');
const { generateSite, renderPage } = require('./siteGenerator');

const MAX_PENDING = 6;
const KEEP_MS = 2 * 60 * 60 * 1000;
const MAX_IMAGES = 6, MAX_IMAGE_BYTES = 5 * 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

/** data URL -> Buffer, only real JPEG / PNG / WebP (checked by magic bytes, never by the claimed type). */
function decodeImage(v) {
  const m = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(v || ''));
  if (!m) throw new Error('Images must be JPG, PNG or WebP.');
  const b = Buffer.from(m[1], 'base64');
  const ok = (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
  if (!ok) throw new Error('One of the images is not a valid JPG, PNG or WebP file.');
  if (b.length > MAX_IMAGE_BYTES) throw new Error('One of the images is too large (max 5 MB each).');
  return b;
}

function validate(b) {
  const company = text(b.company, 60), details = text(b.details, 2400), focus = text(b.focus, 2400), notes = text(b.notes, 2400);
  if (!company) throw new Error('Please enter your company name.');
  if (details.length < 20) throw new Error("Please describe your company in a few sentences (Company's Details).");
  if (!focus) throw new Error('Please tell us the main focus of the video.');
  let logo = null, images = [], total = 0;
  if (b.logo) { logo = decodeImage(b.logo); total += logo.length; }
  if (Array.isArray(b.images)) for (const v of b.images.slice(0, MAX_IMAGES)) { const im = decodeImage(v); total += im.length; images.push(im); }
  if (total > MAX_TOTAL_BYTES) throw new Error('The images are too large in total.');
  return { company, details, focus, notes, logo, images };
}

const friendly = (e) => {
  const m = String((e && e.message) || e);
  if (/Neuron guard/i.test(m)) return "SmartClips' own daily safety limit for AI usage was reached. Please try again tomorrow.";
  if (/daily free allocation|10,?000 neurons|4006|status.{0,6}429|rate limit/i.test(m)) return "Cloudflare says the free AI allowance of the account this server uses is used up. Please try again tomorrow.";
  if (/could not write the ad script/i.test(m)) return 'The AI could not write the video this time. Please try again.';
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
};

function register(app, { siteVideo }) {
  const jobs = new Map();
  let chain = Promise.resolve();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests - please wait a minute.' } });
  const bigJson = express.json({ limit: '24mb' });

  const label = (j) => (j.phase === 'generating' ? 'Cloudflare is generating your video' : j.phase === 'rendering' ? 'Rendering video' : j.phase === 'done' ? 'Your video is ready' : j.phase === 'cancelled' ? 'Cancelled' : 'Something went wrong');

  function view(j) {
    const r = j.render && siteVideo.view(j.render);
    const out = { id: j.id, status: j.phase, label: label(j), progress: 0, eta: null, error: j.error || null, errorDetail: j.errorDetail || null, position: 0, videoUrl: null, downloadUrl: null, mp4Url: null };
    if (j.phase === 'generating') {
      let gp = j.genProgress;
      if (/^Writing the ad script/.test(j.genStage || '')) gp = 0.05 + 0.05 * (1 - Math.exp(-(Date.now() - j.stageAt) / 40000));   // the single AI call has no sub-steps: creep gently so the bar never looks frozen
      out.progress = 0.02 + 0.38 * gp;
      out.position = [...jobs.values()].filter((x) => x.phase === 'generating' && !x.started && x.created < j.created).length;
      out.detail = out.position ? 'Waiting for the AI - ' + out.position + ' ahead of you' : j.genStage || 'Getting started';
    } else if (j.phase === 'rendering' && r) {
      out.progress = 0.4 + 0.6 * r.progress; out.eta = r.eta; out.position = r.position;
      out.detail = r.status === 'queued' ? 'Waiting for the video recorder' + (r.position > 1 ? ' - ' + (r.position - 1) + ' ahead of you' : '')
        : r.status === 'loading' ? 'Opening your ad in a phone-sized browser' : r.status === 'recording' ? 'Filming your ad frame by frame (60 fps)' : /^Encoding the video: /.test(r.detail || '') ? r.detail : 'Encoding the video';
    }
    else if (j.phase === 'done' && r) { out.progress = 1; out.videoUrl = r.videoUrl; out.downloadUrl = r.downloadUrl; out.mp4Url = r.mp4Url; }
    return out;
  }

  /** Phase 1 (serialised): the AI writes and paints the ad. Resolves true when the page is ready to be filmed. */
  async function generate(j, input) {
    j.started = true; j.genStage = 'Getting started'; j.stageAt = Date.now();
    const seen = (e) => { if (j.cancelled) throw new Error('cancelled'); if (e.stage !== j.genStage) { j.genStage = e.stage; j.stageAt = Date.now(); } j.genProgress = e.progress; };
    try {
      if (j.cancelled) throw new Error('cancelled');
      const dir = store.dirFor(j.id);
      let result;
      if (process.env.GENERATE_MOCK === '1') result = await require('./mockGenerate')(input, dir, seen);   // local testing only: no Cloudflare
      else {
        result = await generateSite({
          company: { name: input.company, details: input.details, focus: input.focus, notes: input.notes }, logo: input.logo, images: input.images, outDir: dir,
          onProgress: seen,
        });
      }
      j.genProgress = 1;
      if (j.cancelled) throw new Error('cancelled');
      await store.persist(j.id, { company: input.company, spec: result.spec, dir });   // the job id + ad script are stored (Supabase) before recording starts
      return true;
    } catch (e) { fail(j, e); return false; }
  }

  /** Phase 2 (the recorder has its own queue): film the stored page and hand back the video. */
  async function render(j) {
    try {
      const dir = store.dirFor(j.id);
      j.phase = 'rendering';
      j.render = siteVideo.submit({ dir }, { sceneSeconds: 3.5, fps: 30, preset: 'film', holdStart: 0, holdEnd: 1, crf: 21, captureBudgetSeconds: +process.env.AD_CAPTURE_BUDGET_S || 420 });   // constants: 720x1280, 30 fps, 3.5 s per scene; no dead intro (the hook is on screen from frame 1), 1 s to linger on the CTA card
      while (!['done', 'error', 'cancelled'].includes(j.render.status)) { if (j.cancelled) siteVideo.cancel(j.render); await new Promise((r) => setTimeout(r, 1000)); }
      if (j.render.status === 'done') { j.phase = 'done'; store.setStatus(j.id, { status: 'done', video_url: j.render.publicUrl || null }); }
      else if (j.render.status === 'cancelled') j.phase = 'cancelled';
      else { j.phase = 'error'; j.error = friendly({ message: j.render.error }); }
    } catch (e) { fail(j, e); } finally { setTimeout(() => { jobs.delete(j.id); }, KEEP_MS).unref(); }
  }

  function fail(j, e) {
    if (e && e.message === 'cancelled') j.phase = 'cancelled';
    else { j.phase = 'error'; j.error = friendly(e); j.errorDetail = String((e && e.message) || e).slice(0, 300); console.error(`[generate-video] job ${j.id} failed:`, e && e.message); }
    setTimeout(() => { jobs.delete(j.id); }, KEEP_MS).unref();
  }

  app.post('/api/generate-video', limiter, bigJson, (req, res) => {
    let input;
    try { input = validate(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
    const busy = [...jobs.values()].filter((j) => j.phase === 'generating' || j.phase === 'rendering').length;
    if (busy >= MAX_PENDING) return res.status(429).json({ error: 'We are busy right now - please try again in a few minutes.' });
    const j = { id: store.newId(), phase: 'generating', genProgress: 0, created: Date.now() };
    jobs.set(j.id, j);
    console.log(`[generate-video] job ${j.id}: "${input.company}" (${input.images.length} images${input.logo ? ', logo' : ''})`);
    chain = chain.then(async () => { if (await generate(j, input)) render(j); });   // one generation at a time (neuron accounting is process-wide); rendering runs on in the background
    res.status(202).json({ id: j.id });
  });

  app.get('/api/generate-video/:id', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'Unknown or expired job.' });
    res.json(view(j));
  });

  app.post('/api/generate-video/:id/cancel', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'Unknown or expired job.' });
    j.cancelled = true; if (j.render) siteVideo.cancel(j.render);
    res.json(view(j));
  });

  store.register(app, renderPage);
}

module.exports = { register, validate };
