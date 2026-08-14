const { createCanvas } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * MECHANICAL SKELETON ONLY. Every template/visual-system/camera/icon
 * module this file used to call into was deleted in a deliberate,
 * planned teardown of the entire video-generation/design layer - see
 * the plan this was executed from for the full rationale. What's left
 * here is exactly the "rendering agent" the teardown was scoped to
 * keep: canvas lifecycle, the frame-by-frame PNG encode loop, the
 * chunk-range interface longVideoOrchestrator.js/renderChunkWorker.js
 * depend on, and the ffmpeg encode step - none of it knows or cares
 * WHAT gets drawn. The frame body below is an inert flat-color
 * placeholder on purpose; a follow-up rebuild supplies real content
 * through this same mechanical shell. Exported names/signatures
 * (renderJobToFile, renderTimelineRange, buildTimeline, WIDTH, HEIGHT,
 * FPS) are unchanged so nothing upstream needed editing.
 */

const WIDTH = 720;
const HEIGHT = 1280;
const OUTPUT_WIDTH = 540;
const OUTPUT_HEIGHT = 960;
const RENDER_SCALE = OUTPUT_WIDTH / WIDTH;
const FPS = 24;

/**
 * Stripped to the one thing longVideoOrchestrator.js actually reads
 * off this (totalDuration, to decide whether to chunk) - no camera/
 * anchor/tag/color logic left, that all lived in the deleted
 * worldSpace.js/visualSystems.js.
 */
function buildTimeline(sceneJSON) {
  const totalDuration = (sceneJSON.scenes || []).reduce(
    (sum, scene) => sum + Math.max(0.4, Number(scene.params?.duration) || 3),
    0
  );
  return { totalDuration };
}

async function renderTimelineRange(sceneJSON, timeStart, timeEnd, outputPath, onProgress) {
  const startFrame = Math.floor(timeStart * FPS);
  const endFrame = Math.ceil(timeEnd * FPS);
  const totalFrames = endFrame - startFrame;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const framesDir = path.join(outDir, `.frames-${path.basename(outputPath, '.mp4')}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const canvas = createCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);

  const renderStartedAt = Date.now();
  console.log(`[renderEngine] range ${timeStart}-${timeEnd}s: ${totalFrames} frames (placeholder content - design layer deleted pending rebuild), +0.0s`);

  try {
    for (let frame = startFrame; frame < endFrame; frame++) {
      // Inert placeholder - flat fill, no template/camera/icon content.
      // This is the exact hook point a rebuilt engine draws through.
      ctx.fillStyle = '#111114';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      const png = canvas.encodeSync('png');
      const frameIndex = frame - startFrame;
      fs.writeFileSync(path.join(framesDir, `f${String(frameIndex).padStart(6, '0')}.png`), png);

      if (frameIndex % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (onProgress && frameIndex % 5 === 0) {
        onProgress(Math.round((frameIndex / totalFrames) * 90));
      }
      if (frameIndex % 30 === 0) {
        console.log(`[renderEngine] frame ${frameIndex}/${totalFrames}, +${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);
      }
    }

    if (onProgress) onProgress(90);
    console.log(`[renderEngine] frames done, +${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s - starting ffmpeg encode`);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-y',
        '-framerate', String(FPS),
        '-i', path.join(framesDir, 'f%06d.png'),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        outputPath,
      ]);
      let ffmpegErr = '';
      ffmpeg.stderr.on('data', (d) => { ffmpegErr += d.toString(); });
      ffmpeg.on('close', (code) => {
        console.log(`[renderEngine] ffmpeg encode ${code === 0 ? 'done' : 'FAILED'}, +${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegErr.slice(-500)}`));
      });
      ffmpeg.on('error', reject);
    });
  } finally {
    fs.rm(framesDir, { recursive: true, force: true }, () => {});
  }

  if (onProgress) onProgress(100);
  return outputPath;
}

async function renderJobToFile(jobId, sceneJSON, onProgress) {
  const { totalDuration } = buildTimeline(sceneJSON);
  const outDir = path.join(os.tmpdir(), 'shortform-renders');
  const outputPath = path.join(outDir, `${jobId}.mp4`);
  return renderTimelineRange(sceneJSON, 0, totalDuration, outputPath, onProgress);
}

module.exports = { renderJobToFile, renderTimelineRange, buildTimeline, WIDTH, HEIGHT, FPS };
