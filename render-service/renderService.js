const path = require('path');
const fs = require('fs');
const os = require('os');
const { renderVideo } = require('@revideo/renderer');

/**
 * Renders one job's validated scene JSON via Revideo (headless Chromium
 * under the hood) and returns the local path to the produced mp4.
 * The caller (server.js) is responsible for uploading it to Supabase
 * and cleaning up the temp file afterward.
 *
 * onProgress, if provided, is called with an integer 0-100 as Revideo
 * reports rendering progress (its own callback reports 0-1).
 */
async function renderJobToFile(jobId, sceneJSON, onProgress) {
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
      // Vertical short-form. Deliberately 720x1280, not full 1080x1920 -
      // see project.ts for why (memory: pixel count scales with
      // width*height, so this is a ~55% cut in per-frame raster memory).
      // Set redundantly here too via projectSettings (the actual
      // documented key for a per-render-call override, confirmed
      // against @revideo/renderer's own type definitions rather than
      // assumed) as a second guarantee on top of project.ts's default.
      workers: 1,
      projectSettings: {
        size: { x: 720, y: 1280 },
      },
      // Render's containers (and most PaaS/Docker environments) don't
      // support Chrome's sandbox without extra privileges - without
      // these flags Chrome fails to launch at all in that environment.
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // Everything below reduces Chrome's memory footprint - not
          // optional extras. On a 512MB instance (Render's free tier),
          // Chrome's default GPU/compositor/extension overhead is
          // often enough by itself to get the whole process OOM-killed
          // mid-render, which takes the entire Node server down with
          // it (not just the one job) - that's the most likely cause
          // of jobs endpoints going down, not just the render itself.
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--mute-audio',
          '--no-first-run',
          '--single-process',
        ],
      },
      progressCallback: onProgress
        ? (_id, progress) => onProgress(Math.round(progress * 100))
        : undefined,
    },
  });

  const outputPath = path.join(outDir, outputFileName);
  if (!fs.existsSync(outputPath)) {
    throw new Error('Revideo render finished but output file was not found');
  }
  return outputPath;
}

module.exports = { renderJobToFile };
