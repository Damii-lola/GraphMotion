// Runs as a separate process via child_process.fork() in server.js.
// Even though Skia rendering is lightweight compared to the old
// Chrome-based pipeline, this isolation is kept deliberately: if
// anything unexpected crashes mid-render, only this one job dies -
// the main server and every other in-flight request keep running.

const { generateSceneJSON } = require('./mistralClient');
const { renderJobToFile } = require('./renderEngine');

let currentJobId = null;

/**
 * process.send() is asynchronous - calling process.exit() right after
 * it risks the message never actually reaching the parent. This waits
 * for the actual flush callback before exiting. (Confirmed necessary
 * and confirmed fixed via direct testing in the previous architecture
 * - same fix carried over here since the risk is identical.)
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
