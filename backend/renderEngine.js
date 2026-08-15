const { createCanvas } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { buildBeatVisual, loadBeatImages } = require('./sceneBuilder');
const T = require('./engine/transitions');

/**
 * The rendering agent: turns validated scene JSON (sceneSchema.js) into
 * an actual mp4, through sceneBuilder.js's real interpreter (the batch
 * 1-11 engine). This file itself still knows nothing about WHAT a beat
 * looks like - it owns exactly the mechanical concerns it always did:
 * canvas lifecycle, the per-chunk frame range this gets called with
 * (longVideoOrchestrator.js/renderChunkWorker.js's own chunking, untouched
 * by anything here), which beat is active at a given global time, PNG
 * encode, and the ffmpeg mux. Exported names/signatures (renderJobToFile,
 * renderTimelineRange, buildTimeline, WIDTH, HEIGHT, FPS) are unchanged
 * so nothing upstream needs editing.
 */

const WIDTH = 720;
const HEIGHT = 1280;
const OUTPUT_WIDTH = 540;
const OUTPUT_HEIGHT = 960;
const RENDER_SCALE = OUTPUT_WIDTH / WIDTH;
const FPS = 24;

/**
 * Computes each beat's [start,end) window in the overall timeline via a
 * running cumulative sum of `scene.params.duration` (same floor of 0.4s
 * this always used) - `totalDuration` is the one field
 * longVideoOrchestrator.js reads to decide whether to chunk; `beatRanges`
 * is additional (backward-compatible - existing callers reading only
 * totalDuration are unaffected) and is what renderTimelineRange itself
 * uses internally to know which beat is active at a given global time,
 * avoiding recomputing the same cumulative sum twice.
 */
function buildTimeline(sceneJSON) {
  let cursor = 0;
  const beatRanges = (sceneJSON.scenes || []).map((scene) => {
    const duration = Math.max(0.4, Number(scene.params?.duration) || 3);
    const start = cursor;
    cursor += duration;
    return {
      scene, duration, start, end: cursor,
    };
  });
  return { totalDuration: cursor, beatRanges };
}

/** The beat active at global time `t` - clamps to the last beat once `t` reaches/exceeds totalDuration (Math.ceil rounding on the final chunk's endFrame can land one frame past the true end). */
function findActiveBeatIndex(beatRanges, t) {
  for (let i = 0; i < beatRanges.length; i++) {
    if (t < beatRanges[i].end || i === beatRanges.length - 1) return i;
  }
  return beatRanges.length - 1;
}

/**
 * Builds the real, already-tested Node/Composition or Layer3D/Camera/
 * Light scene for ONE beat via sceneBuilder.js's buildBeatVisual - once
 * per beat (matching sceneBuilder.js's own "build once per beat, not
 * per frame" design boundary), not once per frame. Image loading
 * (loadBeatImages) is async and has to happen before buildBeatVisual
 * runs, since the returned visual's own render(ctx,t) is synchronous
 * (called many times per second of output).
 */
async function buildOneBeat(range) {
  const beatContext = {
    width: WIDTH, height: HEIGHT, duration: range.duration, imagePath: range.scene.params?.imagePath || null,
  };
  const loadedImages = await loadBeatImages(range.scene.visual, beatContext);
  const visualObj = buildBeatVisual(range.scene.visual, { ...beatContext, loadedImages });
  return { range, visualObj };
}

async function renderTimelineRange(sceneJSON, timeStart, timeEnd, outputPath, onProgress) {
  const startFrame = Math.floor(timeStart * FPS);
  const endFrame = Math.ceil(timeEnd * FPS);
  const totalFrames = endFrame - startFrame;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const framesDir = path.join(outDir, `.frames-${path.basename(outputPath, '.mp4')}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const { beatRanges } = buildTimeline(sceneJSON);

  // Every beat overlapping this chunk's own [timeStart,timeEnd) range
  // needs its own frames rendered here - chunking forks a fresh OS
  // process per chunk (renderChunkWorker.js/longVideoOrchestrator.js's
  // own memory-safety design, untouched by this file), so nothing about
  // a beat built in an earlier/later chunk carries over; each chunk
  // rebuilds whatever beats it actually needs from the SAME full
  // sceneJSON it's always been given. A beat's own immediate
  // PREDECESSOR is also built even when only needed for a transition
  // (its own frames might belong to an earlier chunk) - transitionIn
  // composites against whatever the previous beat "ended on" (its own
  // final frame, held), so that predecessor's visual has to exist here
  // too whenever the transition window falls inside this chunk.
  const neededIndices = new Set();
  beatRanges.forEach((range, i) => {
    if (range.end > timeStart && range.start < timeEnd) {
      neededIndices.add(i);
      if (i > 0 && range.scene.visual?.transitionIn) neededIndices.add(i - 1);
    }
  });

  const built = new Map();
  for (const i of neededIndices) {
    built.set(i, await buildOneBeat(beatRanges[i]));
  }

  // A transition's "outgoing" side is always the SAME frozen moment
  // (prevBeat.range.duration - see the doc comment above) for every
  // single frame of the transition window, yet the naive version of
  // this loop re-rendered that identical frame from scratch on every
  // one of those frames - real, wasted CPU work, and (found via direct
  // memory profiling, not assumed) a real contributor to peak memory:
  // re-running a full beat's render (potentially a whole 3D scene with
  // several layers) repeatedly, once per transition frame, when it only
  // ever needed to happen ONCE per beat per chunk. Cached here, keyed
  // by the outgoing beat's own index.
  const frozenFrameCache = new Map();

  const canvas = createCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);

  const renderStartedAt = Date.now();
  console.log(`[renderEngine] range ${timeStart}-${timeEnd}s: ${totalFrames} frames, ${neededIndices.size} beat(s) built, +0.0s`);

  try {
    for (let frame = startFrame; frame < endFrame; frame++) {
      const globalT = frame / FPS;
      const beatIndex = findActiveBeatIndex(beatRanges, globalT);
      const { range, visualObj } = built.get(beatIndex);
      const localT = globalT - range.start;

      const transitionDef = range.scene.visual?.transitionIn;
      const transitionDuration = transitionDef ? Math.max(0.05, Number(transitionDef.duration) || 0.5) : 0;
      const inTransition = beatIndex > 0 && transitionDef && localT < transitionDuration;

      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      if (inTransition) {
        const prevBeat = built.get(beatIndex - 1);
        let prevCanvas = frozenFrameCache.get(beatIndex - 1);
        if (!prevCanvas) {
          prevCanvas = createCanvas(WIDTH, HEIGHT);
          prevBeat.visualObj.render(prevCanvas.getContext('2d'), prevBeat.range.duration);
          frozenFrameCache.set(beatIndex - 1, prevCanvas);
        }
        const currCanvas = createCanvas(WIDTH, HEIGHT);
        visualObj.render(currCanvas.getContext('2d'), localT);
        const progress = Math.min(1, Math.max(0, localT / transitionDuration));
        const transitionFn = T[transitionDef.type] || T.crossDissolve;
        const composited = transitionFn(prevCanvas, currCanvas, progress, transitionDef.params || {});
        ctx.drawImage(composited, 0, 0);
      } else {
        visualObj.render(ctx, localT);
      }

      const png = canvas.encodeSync('png');
      const frameIndex = frame - startFrame;
      fs.writeFileSync(path.join(framesDir, `f${String(frameIndex).padStart(6, '0')}.png`), png);

      // CRITICAL, not optional - real production incident (site going
      // fully unresponsive, discovered via CORS errors that were
      // actually a symptom of the whole container getting OOM-killed).
      // Measured directly, not assumed: every real frame render (via
      // sceneBuilder.js -> layerStack.js) allocates several fresh
      // full-frame canvases (the layer-stack accumulator, one per
      // layer, one more per track-matte source) - each one a small JS
      // wrapper object with several MB of NATIVE Skia pixel memory
      // attached via napi-rs. V8's own GC decides when to collect based
      // on JS HEAP size, which stays tiny here (a canvas wrapper is
      // small) regardless of how much native memory is actually piling
      // up - so V8 never feels "pressured" to collect, and native RSS
      // grows essentially unbounded.
      //
      // A SINGLE synchronous global.gc() call does NOT fix this -
      // measured directly, not assumed: calling global.gc() alone every
      // 5 frames left RSS growing identically to no gc() at all (both
      // reached ~7.2GB over the same run). The native finalizers that
      // actually release napi-rs's Skia pixel buffers apparently need
      // an event-loop tick to run - they are not completed synchronously
      // inside a single global.gc() call. The REAL fix, confirmed by
      // direct A/B measurement on identical content: gc() -> yield to
      // the event loop -> gc() AGAIN. That exact sequence held RSS
      // perfectly flat (~80MB) on a simple 2D beat; every-5-frames on a
      // heavier real render (3D layer warping + transitions, each
      // allocating far more canvases per frame) still peaked over 1GB,
      // so this runs EVERY frame, not every 5 - measured to be cheap
      // (it did not slow the render down; likely cheaper than the
      // memory-pressure/allocator overhead it avoids). --max-old-space-size
      // (already set on the render worker forks) never covered any of
      // this - it only bounds the JS heap, which was never where this
      // memory actually lived. Requires --expose-gc on the forked
      // render process (server.js/longVideoOrchestrator.js); guarded so
      // this is a silent no-op (not a crash) if that flag is ever
      // missing, though production must always pass it for this fix to
      // actually take effect.
      if (global.gc) {
        global.gc();
        await new Promise((resolve) => setImmediate(resolve));
        global.gc();
      } else if (frameIndex % 10 === 0) {
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

module.exports = {
  renderJobToFile, renderTimelineRange, buildTimeline, WIDTH, HEIGHT, FPS,
};
