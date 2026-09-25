'use strict';
/*
 * Pull-based image->video worker link. A free GPU box (a Kaggle / Colab notebook running LTX-Video) has no public address, so
 * IT calls US: it long-polls /api/vworker/next for a clip job, generates it, and posts the mp4 back to /api/vworker/done/:id.
 * videoGen.js enqueues jobs here when VIDEO_WORKER_SECRET is set. If no worker has polled recently the enqueue fails fast, so the
 * generator falls back to the stills engine instead of making a customer wait.
 */
const crypto = require('crypto');
const express = require('express');

const SECRET = () => process.env.VIDEO_WORKER_SECRET || '';
const jobs = new Map();          // id -> { id, payload, state: 'queued'|'taken'|'done'|'error', resolve, reject, t }
const waiters = [];              // long-poll responses waiting for a job
let lastSeen = 0, loaderVersion = null, handlerVersion = null;

const online = () => Date.now() - lastSeen < 45000;
const authed = (req) => { const s = SECRET(); const h = String(req.headers.authorization || ''); return !!s && h.length === s.length + 7 && crypto.timingSafeEqual(Buffer.from(h), Buffer.from('Bearer ' + s)); };

function dispatch() {
  while (waiters.length) {
    const job = [...jobs.values()].find((j) => j.state === 'queued'); if (!job) return;
    const w = waiters.shift(); if (w.res.writableEnded || w.res.destroyed) continue;
    job.state = 'taken'; job.taken = Date.now(); clearTimeout(w.timer);
    w.res.json({ id: job.id, ...job.payload });
  }
}

/** Ask the worker for a clip. payload: { prompt, seed, frames, width, height, image (base64) } -> Buffer (mp4). */
function enqueue(payload, timeoutMs = 300000) {
  if (!online()) return Promise.reject(new Error('the video worker is offline'));
  const id = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    const job = { id, payload, state: 'queued', resolve, reject, t: Date.now() };
    job.timer = setTimeout(() => { jobs.delete(id); reject(new Error('the video worker took too long')); }, timeoutMs);
    jobs.set(id, job); dispatch();
  });
}

function register(app) {
  app.post('/api/vworker/next', (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    lastSeen = Date.now(); if (req.headers['x-worker-loader']) loaderVersion = String(req.headers['x-worker-loader']).slice(0, 10);
    for (const j of jobs.values()) if (j.state === 'taken' && Date.now() - j.taken > 330000) j.state = 'queued';   // a worker that vanished: hand the job on
    const w = { res, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); if (!res.writableEnded) res.status(204).end(); }, 25000) };
    req.on('close', () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); clearTimeout(w.timer); });
    waiters.push(w); dispatch();
  });
  app.post('/api/vworker/done/:id', express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    lastSeen = Date.now();
    const job = jobs.get(req.params.id); if (!job) return res.status(404).json({ error: 'unknown job' });
    jobs.delete(job.id); clearTimeout(job.timer);
    if (req.headers['x-handler']) handlerVersion = String(req.headers['x-handler']).slice(0, 10);
    const err = req.headers['x-error'];
    if (err) job.reject(new Error('video worker: ' + String(err).slice(0, 300)));
    else if (Buffer.isBuffer(req.body) && req.body.length > 1000) job.resolve(req.body);
    else job.reject(new Error('video worker sent an empty clip'));
    res.json({ ok: true });
  });
  app.get('/api/vworker/handler', (req, res) => {              // the notebook downloads its clip-making code from here for every job
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    res.type('text/plain').send(require('fs').readFileSync(require('path').join(__dirname, 'vworker', 'handler.py'), 'utf8'));
  });
  app.get('/api/vworker/status', (req, res) => res.json({ online: online(), queued: [...jobs.values()].filter((j) => j.state === 'queued').length, loader: loaderVersion, handler: handlerVersion }));
}

module.exports = { register, enqueue, online };
