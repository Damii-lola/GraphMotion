'use strict';
// Forked by siteVideo.js. Runs ONE recording in its own process so Chrome's
// memory (and any crash) can never take the API server down with it.
const fs = require('fs');
const { record } = require('./siteRecorder');

let stop = false;
process.on('message', (m) => { if (m && m.type === 'cancel') stop = true; });
process.once('message', async ({ jobId, url, out, opts }) => {
  const send = (m) => { if (process.send) process.send({ jobId, ...m }); };
  try {
    let lastSent = 0;
    const res = await record({ ...opts, url, out, isCancelled: () => stop }, (e) => {
      const now = Date.now();
      if (e.stage === 'done' || now - lastSent < 700) return; // 'done' is reported by the message below, after the upload
      lastSent = now;
      send({ type: 'progress', stage: e.stage, progress: e.progress, eta: e.eta, note: e.note, detail: e.detail });
    });
    let publicUrl = null;
    try { // durable copy so the link survives a server restart; failure is fine, the local file is still served
      const { uploadRenderedVideo } = require('./supabaseClient');
      publicUrl = await uploadRenderedVideo('site_' + jobId, out, fs.readFileSync(out));
    } catch (e) { console.warn('[site-video] supabase upload skipped:', e.message); }
    send({ type: 'done', publicUrl, seconds: res.seconds });
  } catch (e) {
    if (e && e.message === 'cancelled') send({ type: 'cancelled' }); else send({ type: 'error', error: e.message || String(e) });
  }
  setTimeout(() => process.exit(0), 200);
});
