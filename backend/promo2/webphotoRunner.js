'use strict';
/*
 * Runs the official-site photo scan (webphotos.discover, a second real Chrome browser) in its OWN child process instead of in-process.
 * Why: that scan crashed the shared Render server three times in a row live (see feedback_web_photo_scan_disabled memory note) - a native
 * OOM kill or Chrome crash inside the same process as the API server takes the WHOLE server down, wiping every other user's in-flight job.
 * A child process gives the same result the safe way: if IT dies (crash, OOM kill, hang), only it dies - this process just sees that and
 * falls back to the cheaper photo sources, instead of the entire backend restarting.
 * Also serialised (one scan at a time, server-wide): this is already the rare, last-resort path (only for a video with no client photo/link
 * whose own website search failed), so bounding it to a single extra Chrome instance at once keeps its worst-case memory cost fixed
 * regardless of how many videos are generating at once - see feedback_design_for_concurrent_users.
 */
const { spawn } = require('child_process');
const path = require('path');

const ENTRY = path.join(__dirname, 'webphotoWorkerEntry.js');
const HARD_TIMEOUT_MS = 60000;

let queue = Promise.resolve();   // one scan at a time, server-wide

function runOnce(plan, company) {
  return new Promise((resolve) => {
    let done = false, child;
    const finish = (found) => { if (done) return; done = true; try { if (child && !child.killed) child.kill('SIGKILL'); } catch (_) { /* already gone */ } resolve(found); };
    try {
      child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.warn('[webphotoRunner] could not spawn the scan process: ' + String(e.message).slice(0, 150));
      return resolve([]);
    }
    const timer = setTimeout(() => { console.warn('[webphotoRunner] scan process timed out after ' + HARD_TIMEOUT_MS + 'ms, killing it'); finish([]); }, HARD_TIMEOUT_MS);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); console.warn('[webphotoRunner] scan process error: ' + String(e.message).slice(0, 150)); finish([]); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (err.trim()) console.warn('[webphotoRunner] ' + err.trim().slice(0, 300));
      if (code !== 0 || signal) { console.warn('[webphotoRunner] scan process exited abnormally (code=' + code + ' signal=' + signal + '): treated as no photos found, never as a server crash'); return finish([]); }
      try {
        const parsed = JSON.parse(out || '{}'), found = (parsed.found || []).map((f) => ({ buf: Buffer.from(f.b64, 'base64'), label: f.label || '' }));
        finish(found);
      } catch (e) { console.warn('[webphotoRunner] could not parse the scan process output: ' + String(e.message).slice(0, 150)); finish([]); }
    });
    try { child.stdin.write(JSON.stringify({ plan, company })); child.stdin.end(); } catch (e) { finish([]); }
  });
}

/** discover(plan, company) -> [{ buf, label }] - same shape as webphotos.discover, but the actual work happens in an isolated child process. */
function discover(plan, company) {
  const run = () => runOnce(plan, company);
  const p = queue.then(run, run);   // this call waits for whatever is already queued, but a previous failure never blocks it
  queue = p.catch(() => {});
  return p;
}

module.exports = { discover };
