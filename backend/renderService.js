// This file runs as a SEPARATE PROCESS via child_process.fork() in
// server.js - not required/imported directly by the main server.
//
// Why: the render pipeline (Mistral call + Vite bundling + Puppeteer/
// Chrome orchestration) is heavy enough that running it in-process
// alongside Express was making the ENTIRE server unresponsive for the
// whole render duration - including trivial GET /api/jobs/:id reads.
// Running it in a child process means:
//   1. The main server's event loop stays free to serve requests no
//      matter how busy this process is.
//   2. If THIS process gets OOM-killed, only this one job dies - the
//      main server (and every other in-flight job) keeps running.
//
// The finished mp4 is left on local disk and only its PATH is sent
// back over IPC - the parent reads the file and uploads it itself.

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '.puppeteer-cache');

const { generateSceneJSON } = require('./mistralClient');
const { renderJobToFile } = require('./renderService');

let currentJobId = null;

/**
 * process.send() is ASYNCHRONOUS - it queues the message onto the IPC
 * pipe and returns immediately, before the message has actually been
 * written through. Calling process.exit() right after it is a real
 * race condition: the process can die before the write completes, and
 * the parent never receives the message at all. process.send() accepts
 * a callback that fires once the message is actually flushed - this
 * helper waits for that before resolving, so callers can safely exit
 * afterward without losing the message.
 */
function sendAndFlush(message) {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, () => resolve());
  });
}

process.on('message', async ({ jobId, prompt }) => {
  currentJobId = jobId;

  try {
    await sendAndFlush({ type: 'status', jobId, status: 'writing_scenes' });
    const sceneJSON = await generateSceneJSON(prompt);

    await sendAndFlush({ type: 'scenes_ready', jobId, sceneJSON });
    await sendAndFlush({ type: 'status', jobId, status: 'rendering', progress: 0 });

    const localFilePath = await renderJobToFile(jobId, sceneJSON, (pct) => {
      // Progress updates are frequent and best-effort - not worth
      // blocking the render loop on flush confirmation for every one.
      if (process.send) process.send({ type: 'progress', jobId, progress: pct });
    });

    await sendAndFlush({ type: 'render_complete', jobId, localFilePath });
  } catch (err) {
    await sendAndFlush({ type: 'failed', jobId, error: String((err && err.message) || err) });
  } finally {
    process.exit(0);
  }
});

process.on('uncaughtException', async (err) => {
  await sendAndFlush({ type: 'failed', jobId: currentJobId, error: String((err && err.message) || err) });
  process.exit(1);
});
