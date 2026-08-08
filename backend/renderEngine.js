const { createCanvas } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { drawTemplate } = require('./templateRenderers');
const { drawTransition, TRANSITION_DURATION } = require('./transitionRenderers');

const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;

/**
 * Builds a flat list of timeline "segments" (scenes and the
 * transitions between them) with absolute start/end times, so a given
 * global frame time can be mapped to exactly one segment plus a local
 * time within it. This is the direct replacement for what Revideo's
 * generator-based scene sequencing did automatically.
 */
function buildTimeline(sceneJSON) {
  const segments = [];
  let cursor = 0;

  sceneJSON.scenes.forEach((scene, i) => {
    if (i > 0 && scene.transition) {
      segments.push({
        kind: 'transition',
        name: scene.transition,
        start: cursor,
        end: cursor + TRANSITION_DURATION,
      });
      cursor += TRANSITION_DURATION;
    }

    segments.push({
      kind: 'scene',
      template: scene.template,
      params: scene.params,
      start: cursor,
      end: cursor + scene.params.duration,
    });
    cursor += scene.params.duration;
  });

  return { segments, totalDuration: cursor };
}

function findSegment(segments, globalTime) {
  for (const seg of segments) {
    if (globalTime >= seg.start && globalTime < seg.end) return seg;
  }
  return segments[segments.length - 1];
}

/**
 * Renders the full video for one job's validated scene JSON to
 * outputPath (an mp4). onProgress, if given, is called with an
 * integer 0-100 as frames are produced.
 */
async function renderJobToFile(jobId, sceneJSON, onProgress) {
  const { segments, totalDuration } = buildTimeline(sceneJSON);
  const totalFrames = Math.ceil(totalDuration * FPS);

  const outDir = path.join(os.tmpdir(), 'shortform-renders');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `${jobId}.mp4`);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const ffmpeg = spawn(ffmpegPath, [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${WIDTH}x${HEIGHT}`,
    '-framerate', String(FPS),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);

  let ffmpegErr = '';
  ffmpeg.stderr.on('data', (d) => { ffmpegErr += d.toString(); });

  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegErr.slice(-500)}`));
    });
    ffmpeg.on('error', reject);
  });

  for (let frame = 0; frame < totalFrames; frame++) {
    const globalTime = frame / FPS;
    const segment = findSegment(segments, globalTime);
    const localTime = globalTime - segment.start;

    if (segment.kind === 'scene') {
      drawTemplate(ctx, segment.template, segment.params, localTime, WIDTH, HEIGHT);
    } else {
      drawTransition(ctx, segment.name, localTime, WIDTH, HEIGHT);
    }

    const raw = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;

    // Backpressure: wait for the write to actually drain before
    // producing the next frame, rather than buffering the whole video
    // in memory if ffmpeg can't keep up.
    const canContinue = ffmpeg.stdin.write(Buffer.from(raw));
    if (!canContinue) {
      await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
    }

    if (onProgress && frame % 5 === 0) {
      onProgress(Math.round((frame / totalFrames) * 100));
    }
  }

  ffmpeg.stdin.end();
  await ffmpegDone;

  if (onProgress) onProgress(100);
  return outputPath;
}

module.exports = { renderJobToFile, WIDTH, HEIGHT, FPS };
