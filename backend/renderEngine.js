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
 * Builds the timeline AND locks one consistent accent color for the
 * whole video (taken from the first scene that specifies one, default
 * otherwise) - per the notes, a consistent single accent color is a
 * deliberate system, not a per-scene decision. Every scene's own color
 * param is overridden to match, so nothing can drift independently.
 */
const { deriveSecondaryColor } = require('./colorUtils');

function buildTimeline(sceneJSON) {
  const firstColorScene = sceneJSON.scenes.find((s) => s.params && s.params.color);
  const accentColor = (firstColorScene && firstColorScene.params.color) || '#FF5C1A';

  const segments = [];
  let cursor = 0;

  sceneJSON.scenes.forEach((scene, i) => {
    const params = { ...scene.params, color: accentColor };

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
      params,
      sceneIndex: i,
      sceneCount: sceneJSON.scenes.length,
      start: cursor,
      end: cursor + params.duration,
    });
    cursor += params.duration;
  });

  return { segments, totalDuration: cursor, accentColor, secondaryColor: deriveSecondaryColor(accentColor), visualSystem: sceneJSON.visualSystem };
}

function findSegment(segments, globalTime) {
  for (const seg of segments) {
    if (globalTime >= seg.start && globalTime < seg.end) return seg;
  }
  return segments[segments.length - 1];
}

/**
 * Renders frames for [timeStart, timeEnd) of the full timeline into
 * outputPath. Used two ways: renderJobToFile calls this with the full
 * range for short videos (the common case, one process, no extra
 * complexity). For long videos, renderWorker.js instead calls this
 * indirectly via renderChunkWorker.js - a FRESH forked process per
 * time-slice, so memory is genuinely reclaimed by the OS between
 * chunks. That second path exists because of a real, measured
 * limitation: this Skia binding accumulates native (non-V8-heap)
 * memory under high sustained draw-call volume over a long render -
 * confirmed via forced-GC testing (JS heap stays flat, RSS does not),
 * and confirmed NOT fixable by canvas recycling or per-frame yielding
 * alone (both tested directly, neither fully resolved it on a real,
 * fully-featured render). A fresh OS process per chunk is the only
 * approach that reliably resets it, because process exit reclaims ALL
 * memory unconditionally, native or not.
 */
async function renderTimelineRange(sceneJSON, timeStart, timeEnd, outputPath, onProgress) {
  const { segments, accentColor, secondaryColor, visualSystem } = buildTimeline(sceneJSON);
  const startFrame = Math.floor(timeStart * FPS);
  const endFrame = Math.ceil(timeEnd * FPS);
  const totalFrames = endFrame - startFrame;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // PNG-sequence-to-disk instead of raw-pixel-piping to ffmpeg's stdin.
  // Verified directly: getImageData()-based piping leaked catastrophically
  // under sustained rendering (confirmed reproducible: 3.7GB and an OOM
  // kill within 30s of simulated video, in isolation, nothing else
  // running). The identical draw workload switched to
  // canvas.encodeSync('png') + writing files to disk instead stayed
  // essentially flat (~35MB growth) under the exact same test. This
  // isn't a tuning tweak - it's a different code path in the underlying
  // native binding with fundamentally different memory behavior.
  const framesDir = path.join(outDir, `.frames-${path.basename(outputPath, '.mp4')}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  try {
    for (let frame = startFrame; frame < endFrame; frame++) {
      const globalTime = frame / FPS;
      const segment = findSegment(segments, globalTime);
      const localTime = globalTime - segment.start;

      if (segment.kind === 'scene') {
        drawTemplate(ctx, segment.template, segment.params, localTime, globalTime, WIDTH, HEIGHT, segment.sceneIndex, segment.sceneCount, visualSystem, secondaryColor);
      } else {
        drawTransition(ctx, segment.name, localTime, WIDTH, HEIGHT, accentColor, visualSystem);
      }

      const png = canvas.encodeSync('png');
      const frameIndex = frame - startFrame;
      fs.writeFileSync(path.join(framesDir, `f${String(frameIndex).padStart(6, '0')}.png`), png);

      // Still yield periodically even though isolated testing showed
      // this path doesn't need it to stay safe - cheap insurance, and
      // keeps the event loop responsive for progress/IPC during a long
      // frame-writing pass.
      if (frameIndex % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      if (onProgress && frameIndex % 5 === 0) {
        // Frame-writing is ~90% of the work, the final ffmpeg mux pass
        // is fast - reserve the last 10% of progress for that.
        onProgress(Math.round((frameIndex / totalFrames) * 90));
      }
    }

    if (onProgress) onProgress(90);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-y',
        '-framerate', String(FPS),
        '-i', path.join(framesDir, 'f%06d.png'),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        outputPath,
      ]);
      let ffmpegErr = '';
      ffmpeg.stderr.on('data', (d) => { ffmpegErr += d.toString(); });
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegErr.slice(-500)}`));
      });
      ffmpeg.on('error', reject);
    });
  } finally {
    // Always clean up frame files, success or failure - these
    // accumulate real disk usage across many renders on a small
    // instance otherwise.
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
