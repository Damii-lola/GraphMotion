// This file runs as a SEPARATE PROCESS via child_process.fork() in
// server.js - not required/imported directly by the main server.
//
// Why: the render pipeline (Mistral call + Vite bundling + Puppeteer/
// Chrome orchestration) is heavy enough that running it in-process
// alongside Express was making the ENTIRE server unresponsive for the
// whole render duration - including trivial GET /api/jobs/:id reads.
// That's what produced sustained 502s on every endpoint, not just slow
// renders. Running it in a child process means:
//   1. The main server's event loop stays free to serve requests no
//      matter how busy this process is.
//   2. If THIS process gets OOM-killed, only this one job dies - the
//      main server (and every other in-flight job) keeps running.
//
// The finished mp4 is left on local disk and only its PATH is sent
// back over IPC - the parent process (which already has Supabase
// wired up) reads the file and uploads it. Sending the actual file
// bytes through IPC would get JSON-serialized byte-by-byte, which is
// both slow and memory-heavy for a multi-MB video.

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '.puppeteer-cache');

const { generateSceneJSON } = require('./mistralClient');
const { renderJobToFile } = require('./renderService');

function send(message) {
  if (process.send) process.send(message);
}

let currentJobId = null;

process.on('message', async ({ jobId, prompt }) => {
  currentJobId = jobId;

  try {
    send({ type: 'status', jobId, status: 'writing_scenes' });
    const sceneJSON = await generateSceneJSON(prompt);

    send({ type: 'scenes_ready', jobId, sceneJSON });
    send({ type: 'status', jobId, status: 'rendering', progress: 0 });

    const localFilePath = await renderJobToFile(jobId, sceneJSON, (pct) => {
      send({ type: 'progress', jobId, progress: pct });
    });

    send({ type: 'render_complete', jobId, localFilePath });
  } catch (err) {
    send({ type: 'failed', jobId, error: String((err && err.message) || err) });
  } finally {
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  send({ type: 'failed', jobId: currentJobId, error: String((err && err.message) || err) });
  process.exit(1);
});
