'use strict';
/*
 * /api/site-video - "enter a web page, get a TikTok-size video".
 *
 *   POST /api/site-video            { page, sceneSeconds?, preset?, fps? } -> { id }
 *   GET  /api/site-video/:id        -> { status, progress, eta, error?, videoUrl? }
 *   GET  /api/site-video/:id/file   -> the mp4 (Range ok; ?download=1 forces a download)
 *
 * One recording at a time (headless Chrome + WebGL is the heaviest thing this
 * server does). A recording only starts once no text->video render is active,
 * and while it runs new text->video renders wait in their own queue instead
 * of competing for memory (see hooks.onIdle).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const rateLimit = require('express-rate-limit');
const { resolveTarget } = require('./siteRecorder');

const MAX_QUEUE = 4;
const TIMEOUT_MS = (+process.env.SITE_VIDEO_TIMEOUT_MIN || 30) * 60 * 1000;
const KEEP_MS = 60 * 60 * 1000;
const clamp = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };

function register(app, hooks = {}) {
  const jobs = new Map();
  const queue = [];
  let current = null;
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 4, standardHeaders: true, legacyHeaders: false });
  const dir = path.join(os.tmpdir(), 'site-video-out');
  fs.mkdirSync(dir, { recursive: true });

  const isActive = () => !!current;

  function view(j) {
    return {
      id: j.id, status: j.status, progress: +j.progress.toFixed(3), eta: j.eta == null ? null : Math.round(j.eta),
      error: j.error || null, note: j.note || null, position: j.status === 'queued' ? queue.indexOf(j) + 1 : 0,
      videoUrl: j.status === 'done' ? (j.publicUrl || `/api/site-video/${j.id}/file`) : null,
      downloadUrl: j.status === 'done' ? `/api/site-video/${j.id}/file?download=1` : null,
    };
  }

  function pump() {
    if (current || !queue.length) return;
    if (hooks.rendersActive && hooks.rendersActive()) { setTimeout(pump, 2000); return; } // wait for text->video renders to finish
    const job = queue.shift();
    current = job; job.status = 'loading'; job.progress = 0.01;
    const child = fork(path.join(__dirname, 'siteVideoWorker.js'), { stdio: 'inherit', execArgv: ['--max-old-space-size=192'] });
    let settled = false;
    const finish = (status, extra = {}) => {
      if (settled) return;
      settled = true; clearTimeout(killer);
      Object.assign(job, { status }, extra);
      if (status === 'done') { job.progress = 1; job.eta = 0; }
      current = null;
      try { child.kill(); } catch (_) { /* already gone */ }
      setTimeout(() => { jobs.delete(job.id); fs.rm(job.file, { force: true }, () => {}); }, KEEP_MS).unref();
      if (hooks.onIdle) hooks.onIdle();
      setImmediate(pump);
    };
    const killer = setTimeout(() => finish('error', { error: 'The recording took too long and was stopped.' }), TIMEOUT_MS);
    child.on('message', (m) => {
      if (!m || m.jobId !== job.id) return;
      if (m.type === 'progress') {
        job.status = m.stage === 'encoding' ? 'encoding' : m.stage === 'recording' ? 'recording' : 'loading';
        job.progress = Math.max(job.progress, m.progress); job.eta = m.eta; if (m.note) job.note = m.note;
      } else if (m.type === 'done') finish('done', { publicUrl: m.publicUrl || null });
      else if (m.type === 'error') finish('error', { error: m.error });
    });
    child.on('exit', (code) => { if (!settled) finish('error', { error: 'The recorder crashed' + (code ? ` (code ${code})` : '') + ' - the server probably ran out of memory.' }); });
    child.on('error', (e) => finish('error', { error: 'Could not start the recorder: ' + e.message }));
    child.send({ jobId: job.id, url: job.url, out: job.file, opts: job.opts });
  }

  app.post('/api/site-video', limiter, async (req, res) => {
    try {
      const b = req.body || {};
      if (queue.length >= MAX_QUEUE) return res.status(429).json({ error: 'The recorder is busy right now - try again in a few minutes.' });
      const url = await resolveTarget(b.page);
      const id = crypto.randomBytes(6).toString('hex');
      const job = {
        id, url, status: 'queued', progress: 0, eta: null, file: path.join(dir, id + '.mp4'),
        opts: { sceneSeconds: clamp(b.sceneSeconds, 2, 10, 5), fps: clamp(b.fps, 24, 30, 30), preset: b.preset === 'small' ? 'small' : 'tiktok', duration: 30 },
      };
      jobs.set(id, job); queue.push(job); pump();
      res.status(202).json({ id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/site-video/:id', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'Unknown or expired job.' });
    res.json(view(j));
  });

  app.get('/api/site-video/:id/file', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.status !== 'done' || !fs.existsSync(j.file)) return res.status(404).end();
    const size = fs.statSync(j.file).size, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    if (req.query.download) head['Content-Disposition'] = `attachment; filename="smartclips-${j.id}.mp4"`;
    if (m) {
      const a = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${e}/${size}`, 'Content-Length': e - a + 1 });
      return fs.createReadStream(j.file, { start: a, end: e }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    fs.createReadStream(j.file).pipe(res);
  });

  return { isActive };
}

module.exports = { register };
