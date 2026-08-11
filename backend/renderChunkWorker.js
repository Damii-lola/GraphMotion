// Forked ONE PER CHUNK by renderWorker.js for long videos - this is
// the piece that actually delivers real memory safety for 2-minute
// videos on a 512MB instance. Each chunk gets a genuinely fresh OS
// process; when it exits, the OS reclaims everything, native memory
// included, unconditionally. That's the only approach confirmed (via
// direct testing) to actually reset the native memory growth found in
// this Skia binding under long sustained renders - neither canvas
// recycling nor per-frame yielding fully solved it within one
// long-lived process.
//
// Deliberately does NOT call Mistral - sceneJSON is generated once by
// renderWorker.js and passed to every chunk unchanged, so the same
// full timeline is available to every chunk; each chunk just renders
// its own [timeStart, timeEnd) slice of it.

const { renderTimelineRange } = require('./renderEngine');

let currentJobId = null;

function sendAndFlush(message) {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, () => resolve());
  });
}

process.on('message', async ({ jobId, sceneJSON, timeStart, timeEnd, outputPath, chunkIndex }) => {
  currentJobId = jobId;

  try {
    await renderTimelineRange(sceneJSON, timeStart, timeEnd, outputPath, (pct) => {
      if (process.send) process.send({ type: 'chunk_progress', jobId, chunkIndex, progress: pct });
    });
    await sendAndFlush({ type: 'chunk_complete', jobId, chunkIndex, outputPath });
  } catch (err) {
    await sendAndFlush({ type: 'chunk_failed', jobId, chunkIndex, error: String((err && err.message) || err) });
  } finally {
    process.exit(0);
  }
});

process.on('uncaughtException', async (err) => {
  await sendAndFlush({ type: 'chunk_failed', jobId: currentJobId, error: String((err && err.message) || err) });
  process.exit(1);
});
