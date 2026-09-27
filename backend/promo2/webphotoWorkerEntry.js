'use strict';
/*
 * A standalone entry point for the official-site photo scan, run as its OWN child process (see webphotoRunner.js, which spawns this).
 * The scan launches a second real Chrome browser to render a guessed product/brand site - by far the heaviest, riskiest step in real-photo
 * search. Running it here, out of process, means a crash or an OOM kill here can NEVER take the main API server down with it: the parent
 * just sees this process exit and falls back, instead of losing every other user's in-flight job when the whole server restarts.
 * Protocol: the parent writes one line of JSON ({ plan, company }) to this process's stdin, then closes it. This process replies with one
 * line of JSON ({ found: [{ b64, label }] }) on stdout and exits 0. Any internal error is caught and still replies { found: [] } / exits 0 -
 * only a genuine crash (segfault, OOM kill) should ever produce a non-zero exit or no output, which is exactly the case the parent handles.
 */
const webphotos = require('./webphotos');

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let out = { found: [] };
  try {
    const { plan, company } = JSON.parse(input || '{}');
    const log = (...a) => process.stderr.write(a.join(' ').slice(0, 300) + '\n');   // stdout is reserved for the one JSON reply line
    const found = await webphotos.discover(plan, company || {}, log);
    out.found = found.map((f) => ({ b64: f.buf.toString('base64'), label: f.label || '' }));
  } catch (e) {
    process.stderr.write('[webphotoWorkerEntry] ' + String((e && e.message) || e).slice(0, 300) + '\n');
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
