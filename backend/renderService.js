const path = require('path');
const fs = require('fs');
const os = require('os');
const { renderVideo } = require('@revideo/renderer');

/**
 * Renders one job's validated scene JSON via Revideo (headless Chromium
 * under the hood) and returns the local path to the produced mp4.
 * The caller (server.js) is responsible for uploading it to Supabase
 * and cleaning up the temp file afterward.
 */
async function renderJobToFile(jobId, sceneJSON) {
  const outDir = path.join(os.tmpdir(), 'shortform-renders');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outputFileName = `${jobId}.mp4`;

  await renderVideo({
    projectFile: path.join(__dirname, 'project.ts'),
    variables: { sceneJSON },
    settings: {
      outDir,
      outFile: outputFileName,
      logProgress: true,
      // Vertical short-form: 1080x1920. Adjust if you add landscape too.
      workers: 1,
    },
  });

  const outputPath = path.join(outDir, outputFileName);
  if (!fs.existsSync(outputPath)) {
    throw new Error('Revideo render finished but output file was not found');
  }
  return outputPath;
}

module.exports = { renderJobToFile };
