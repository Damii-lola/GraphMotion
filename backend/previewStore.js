'use strict';
/*
 * Where generated ad pages live. Every ad gets a numeric job id (a string of digits) and is served at /preview/<id>/.
 *
 *   - the page + images are written to local disk first (fast, and it is what the recorder films);
 *   - Supabase is the durable copy: table `site_previews` (row per job id, see supabase_site_previews.sql) holds the
 *     ad script + status, and the storage bucket holds the images under previews/<id>/. Render's disk is wiped on every
 *     restart, so /preview/<id>/ rebuilds the page from the stored script and redirects image requests to the bucket.
 *   - Supabase is best effort: if the keys or the table are missing the flow still works from local disk, and the log says so.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.PREVIEW_DIR || path.join(os.tmpdir(), 'smartclips-previews');
const ID_RE = /^\d{10,20}$/;
const FILE_RE = /^(images\/[A-Za-z0-9_-]+\.(webp|png)|audio\.wav|movie\.webm|site\.json)$/;
const MIME = { '.webp': 'image/webp', '.png': 'image/png', '.wav': 'audio/wav', '.webm': 'video/webm', '.json': 'application/json' };
fs.mkdirSync(ROOT, { recursive: true });

let sb = null, bucket = null, warned = false;
function db() {
  if (sb) return sb;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try { const m = require('./supabaseClient'); sb = m.supabase; bucket = process.env.SUPABASE_STORAGE_BUCKET || 'rendered-videos'; } catch (_) { return null; }
  return sb;
}
const warnOnce = (msg) => { if (warned) return; warned = true; console.warn('[preview] ' + msg); };

/** A fresh job id: only digits (13-digit millisecond timestamp + 3 random digits). */
const newId = () => String(Date.now()) + String(crypto.randomInt(0, 1000)).padStart(3, '0');
const isId = (id) => ID_RE.test(String(id));
const dirFor = (id) => { if (!isId(id)) throw new Error('bad job id'); return path.join(ROOT, String(id)); };

async function persist(id, { company, spec, dir }) {
  const c = db();
  if (!c) { warnOnce('Supabase is not configured here - previews are kept on local disk only.'); return false; }
  try {
    const { error } = await c.from('site_previews').upsert({ job_id: String(id), company: String(company || '').slice(0, 80), status: 'ready', spec, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    const files = [];
    for (const sub of ['images']) { const d = path.join(dir, sub); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) files.push(`${sub}/${f}`); }
    if (fs.existsSync(path.join(dir, 'movie.webm'))) files.push('movie.webm');
    for (const rel of files) {
      if (!FILE_RE.test(rel)) continue;
      const { error: e2 } = await c.storage.from(bucket).upload(`previews/${id}/${rel}`, fs.readFileSync(path.join(dir, rel)), { contentType: MIME[path.extname(rel)] || 'application/octet-stream', upsert: true });
      if (e2) throw new Error(e2.message);
    }
    return true;
  } catch (e) { warnOnce(`could not store preview ${id} in Supabase (${e.message}). Run backend/supabase_site_previews.sql once in the Supabase SQL editor.`); return false; }
}

async function setStatus(id, patch) {
  const c = db(); if (!c) return;
  try { await c.from('site_previews').update({ ...patch, updated_at: new Date().toISOString() }).eq('job_id', String(id)); } catch (_) { /* best effort */ }
}

async function remoteRow(id) {
  const c = db(); if (!c) return null;
  try { const { data } = await c.from('site_previews').select('job_id, company, status, video_url, spec').eq('job_id', String(id)).maybeSingle(); return data || null; } catch (_) { return null; }
}

const remoteImageUrl = (id, rel) => { const c = db(); return c ? c.storage.from(bucket).getPublicUrl(`previews/${id}/${rel}`).data.publicUrl : null; };

function register(app, renderPage) {
  const html = (res, body) => { res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.send(body); };
  app.get(/^\/preview\/(\d{10,20})$/, (req, res) => res.redirect(301, `/preview/${req.params[0]}/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));
  app.get(/^\/preview\/(\d{10,20})\/$/, async (req, res) => {
    const id = req.params[0], f = path.join(dirFor(id), 'index.html');
    if (fs.existsSync(f)) return html(res, fs.readFileSync(f, 'utf8'));
    const row = await remoteRow(id);                       // restart wiped the disk: rebuild from the stored ad script
    if (row && row.spec) return html(res, renderPage(row.spec));
    res.status(404).type('text').send('This preview does not exist (or has expired).');
  });
  app.get(/^\/preview\/(\d{10,20})\/(.+)$/, async (req, res) => {
    const id = req.params[0], rel = req.params[1];
    if (!FILE_RE.test(rel)) return res.status(404).end();
    const f = path.join(dirFor(id), rel);
    if (fs.existsSync(f)) return res.sendFile(f, { headers: { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' } });   // sendFile answers Range requests: a <video> can seek
    const url = remoteImageUrl(id, rel);
    if (url) return res.redirect(302, url);
    res.status(404).end();
  });
  // public, read-only: lets the smartclips.org /preview viewer show what a job id is
  app.get(/^\/api\/preview\/(\d{10,20})$/, async (req, res) => {
    const id = req.params[0], f = path.join(dirFor(id), 'site.json');
    let company = null, videoUrl = null, found = false;
    if (fs.existsSync(f)) { found = true; try { company = JSON.parse(fs.readFileSync(f, 'utf8')).brand || null; } catch (_) { /* keep null */ } }
    const row = await remoteRow(id);                                  // the durable copy also knows where the finished video is
    if (row) { found = true; company = company || row.company; videoUrl = row.video_url || null; }
    if (!found) return res.status(404).json({ error: 'Unknown or expired preview.' });
    res.json({ id, company, videoUrl, pageUrl: `/preview/${id}/` });
  });
}

module.exports = { newId, isId, dirFor, persist, setStatus, remoteRow, register, ROOT };
