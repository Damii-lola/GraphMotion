const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { drawBeatContent } = require('./templateRenderers');
const { drawHeroVisual } = require('./heroVisual');
const { drawAtmosphere, drawWorldParticles } = require('./atmosphere');
const { drawComposition } = require('./sceneComposition');
const { drawHeroImage } = require('./imageComposite');
const { getVisualSystem } = require('./visualSystems');
const { deriveSecondaryColor } = require('./colorUtils');
const {
  layoutWorldAnchors,
  getCameraTransform,
  applyCameraTransform,
  getVisibleBeatIndices,
  getBeatCameraOpacity,
} = require('./worldSpace');

const WIDTH = 720;
const HEIGHT = 1280;
// Physical output resolution is smaller than the WIDTH/HEIGHT logical
// drawing space above - every draw function in this codebase (and every
// fixed-pixel layout constant in sharedRenderHelpers.js: TYPE_SCALE,
// LAYOUT.heroSize, etc, all tuned assuming a 720-wide canvas) keeps
// operating completely unchanged in that 720x1280 logical space. The
// canvas itself is created at the smaller OUTPUT_WIDTH/OUTPUT_HEIGHT
// and RENDER_SCALE below maps every existing drawing call into it via
// a single ctx.scale() - real per-frame cost (fills, gradients, blur
// filters, composite ops) scales with how many PHYSICAL pixels get
// touched, and PNG/ffmpeg encode time scales with pixel count too, so
// this is a direct, proportional cut to actual render cost without
// touching a single layout number or risking the "text/icons look
// wrong at a different resolution" regression a raw WIDTH/HEIGHT
// change would have risked.
const OUTPUT_WIDTH = 540;
const OUTPUT_HEIGHT = 960;
const RENDER_SCALE = OUTPUT_WIDTH / WIDTH; // 0.75 -> ~44% fewer physical pixels per frame
// Dropped from 30 - short-form vertical video reads as perfectly
// smooth at 24fps, and it's a direct ~20% cut to both total frames
// drawn (less cumulative Skia native allocation per chunk process
// before it exits) and wall-clock render time, which is exactly what
// was needed against the production per-chunk timeout.
const FPS = 24;

const FALLBACK_TAGS = {
  kineticTextReveal: 'INSIGHT', rippleDrop: 'ALERT', statCounter: 'DATA',
  iconCallout: 'NOTE', shapeReveal: 'FOCUS', splitCompare: 'COMPARE',
  listReveal: 'GUIDE', quoteCallout: 'QUOTE', progressBar: 'PROGRESS',
  countdownTimer: 'URGENT', gridReveal: 'FEATURES', checklistTick: 'STEPS',
  bigNumberStat: 'KEY STAT', pieChartReveal: 'DATA', duoStatCompare: 'COMPARE',
  badgeUnlock: 'UNLOCKED', tickerScroll: 'HIGHLIGHTS', statGrid: 'METRICS',
  arrowFlow: 'PROCESS', calloutBubble: 'TESTIMONIAL', barChartCompare: 'DATA',
  avatarStack: 'COMMUNITY',
};

/**
 * THE REBUILD. Every scene used to be an independent slideshow slide
 * stitched to the next by a transition effect - a hard cut dressed
 * up. This builds ONE continuous world instead: every beat gets a
 * fixed position in world space (worldSpace.js), and the camera
 * physically pans/zooms between them over the whole video's duration.
 * There is no transition step anymore - the camera arriving at a
 * beat's position IS how it's revealed, and it leaving IS how the
 * previous one goes. transitionRenderers.js is now genuinely unused
 * by this path, not just deprioritized.
 */
function buildWorldTimeline(sceneJSON) {
  // Was hunting through individual scene params for a stray color
  // value, which only ~2 of 20+ templates even had a field for -
  // meaning almost every real video fell through to the same
  // hardcoded orange regardless of content. videoColor is now a real
  // top-level field Mistral is explicitly instructed to choose based
  // on THIS prompt's subject/mood, not a per-scene afterthought.
  const accentColor = sceneJSON.videoColor || '#FF5C1A';

  const beats = [];
  let cursor = 0;
  sceneJSON.scenes.forEach((scene, i) => {
    const params = { ...scene.params, color: accentColor };
    // Guards zero/NaN (the old `|| 3`) AND negative values, which would
    // break the [start,end) tiling invariant getVisibleBeatIndices
    // depends on and leave a gap of frames with no beat drawn at all.
    const duration = Math.max(0.4, Number(params.duration) || 3);
    beats.push({
      template: scene.template,
      params,
      tag: params.tag || FALLBACK_TAGS[scene.template] || 'INSIGHT',
      start: cursor,
      end: cursor + duration,
      duration,
    });
    cursor += duration;
  });

  const anchors = layoutWorldAnchors(beats.length, WIDTH, HEIGHT);
  const worldWidth = beats.length > 0 ? anchors[anchors.length - 1].x + WIDTH * 1.5 : WIDTH;

  return {
    beats,
    anchors,
    totalDuration: cursor,
    accentColor,
    secondaryColor: deriveSecondaryColor(accentColor),
    visualSystem: sceneJSON.visualSystem,
    worldWidth,
  };
}

/**
 * Screen-locked corner tag, cross-fading between the outgoing and
 * incoming beat's label during a camera move - the one piece of UI
 * that stays fixed to the screen rather than panning with the world,
 * like a persistent HUD readout.
 */
function drawScreenTag(ctx, visibleBeatIndices, beats, globalTime, width, height, accentColor, system) {
  visibleBeatIndices.forEach((idx) => {
    const beat = beats[idx];
    const opacity = getBeatCameraOpacity(idx, globalTime, beats);
    if (opacity <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(60, 90);
    ctx.font = `600 18px ${system.fontFamily}`;
    const label = beat.tag;
    const textWidth = ctx.measureText(label).width;
    const padX = 14, boxH = 30;
    const boxW = textWidth + padX * 2;
    ctx.strokeStyle = accentColor;
    ctx.globalAlpha = opacity * 0.7;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(boxH / 2, -boxH / 2);
    ctx.arcTo(boxW, -boxH / 2, boxW, boxH / 2, boxH / 2);
    ctx.arcTo(boxW, boxH / 2, 0, boxH / 2, boxH / 2);
    ctx.arcTo(0, boxH / 2, 0, -boxH / 2, boxH / 2);
    ctx.arcTo(0, -boxH / 2, boxW, -boxH / 2, boxH / 2);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(padX - 6, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = system.heroTextColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, padX + 4, 1);
    ctx.restore();
  });
}

async function renderTimelineRange(sceneJSON, timeStart, timeEnd, outputPath, onProgress) {
  const { beats, anchors, accentColor, secondaryColor, visualSystem, worldWidth } = buildWorldTimeline(sceneJSON);
  const system = getVisualSystem(visualSystem);
  const startFrame = Math.floor(timeStart * FPS);
  const endFrame = Math.ceil(timeEnd * FPS);
  const totalFrames = endFrame - startFrame;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const framesDir = path.join(outDir, `.frames-${path.basename(outputPath, '.mp4')}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const canvas = createCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  const ctx = canvas.getContext('2d');
  // Every draw call below still targets the 720x1280 logical space -
  // this single scale (never undone; every ctx.save()/restore() pair
  // in the frame loop nests inside it, never below it) is what maps
  // that down to the smaller physical canvas for the whole render.
  ctx.scale(RENDER_SCALE, RENDER_SCALE);

  // Beats with a resolved `imagePath` (set by imagePrefetch.js, already
  // a local file - no network access from inside the render loop) get
  // their image decoded ONCE here, not per-frame. A chunk that doesn't
  // touch a given beat simply never asks for it; a chunk that does
  // loads the same local file cheaply (disk read + decode, no network)
  // independently of any other chunk, since each chunk is its own
  // forked process with no shared memory.
  //
  // Timeout-guarded, not a bare await - confirmed directly (a real
  // "Chunk N timed out" failure, hard to diagnose after the fact since
  // it just looks like a stall) that a malformed/corrupted image file
  // - entirely possible from a free, unauthenticated generator like
  // Pollinations - can make this native decoder hang indefinitely
  // instead of rejecting, with nothing here to catch it. That hang sat
  // directly inside the per-chunk render path, silently consuming the
  // whole 5-minute chunk safety timeout in longVideoOrchestrator.js.
  // Same "external I/O must never be trusted to fail cleanly on its
  // own" lesson as ttsGen.js's timeout, applied here too.
  const IMAGE_LOAD_TIMEOUT_MS = 8000;
  function loadImageWithTimeout(imagePath) {
    return Promise.race([
      loadImage(imagePath),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`loadImage timed out after ${IMAGE_LOAD_TIMEOUT_MS}ms`)), IMAGE_LOAD_TIMEOUT_MS)),
    ]);
  }

  // Real memory bug, not just wasted decode time: this used to loop
  // over EVERY beat in the whole video regardless of this call's own
  // [timeStart, timeEnd) - meaning every chunk of a long, image-heavy
  // video independently decoded and held ALL of that video's images in
  // memory at once, not just the ones its own ~15s slice could ever
  // draw. On a 512MB container that's exactly the kind of thing that
  // turns into swapping/thrashing (which LOOKS like a hang from the
  // outside, hence "Chunk N timed out" even after the loadImage
  // timeout fix) or an outright OOM kill. A small buffer around the
  // range covers the arrival-window crossfade, where the outgoing
  // beat can still be drawn slightly past its own nominal `end`.
  const CHUNK_RANGE_BUFFER_SECONDS = 2;
  const heroImages = new Map();
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const imagePath = beat.params.imagePath;
    if (!imagePath) continue;
    const overlapsThisChunk = beat.start < timeEnd + CHUNK_RANGE_BUFFER_SECONDS
      && beat.end > timeStart - CHUNK_RANGE_BUFFER_SECONDS;
    if (!overlapsThisChunk) continue;
    try {
      heroImages.set(i, await loadImageWithTimeout(imagePath));
    } catch (err) {
      console.warn(`[renderEngine] failed to load image for beat ${i}, falling back to procedural: ${err.message}`);
    }
  }

  // Diagnostic only, cheap - stdio:'inherit' on both fork() calls means
  // this lands directly in Render's log stream. "Chunk N timed out" has
  // survived three rounds of fixes with no way to reproduce the real
  // host's constraints locally, so the next failure needs to show
  // exactly which stage (image load / which frame / ffmpeg encode) it
  // actually got stuck in instead of another blind guess.
  const renderStartedAt = Date.now();
  console.log(`[renderEngine] range ${timeStart}-${timeEnd}s: ${totalFrames} frames, ${heroImages.size} images loaded, +${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);

  try {
    for (let frame = startFrame; frame < endFrame; frame++) {
      const globalTime = frame / FPS;

      // Screen-space lighting (gradient/vignette/grain/glow) - fixed
      // to the screen, doesn't pan with the world.
      drawAtmosphere(ctx, globalTime, WIDTH, HEIGHT, accentColor, system);

      const cam = getCameraTransform(globalTime, beats, anchors);
      applyCameraTransform(ctx, cam.camX, cam.camY, cam.camZoom, WIDTH, HEIGHT);

      // World-space embers - pan with the camera like real objects
      // living in the world, giving actual parallax continuity.
      drawWorldParticles(ctx, globalTime, worldWidth, HEIGHT, accentColor, system);

      const visibleBeatIndices = getVisibleBeatIndices(globalTime, beats);
      for (const idx of visibleBeatIndices) {
        const beat = beats[idx];
        const anchor = anchors[idx];
        const localTime = globalTime - beat.start;
        const opacity = getBeatCameraOpacity(idx, globalTime, beats);
        if (opacity <= 0.01) continue;

        ctx.save();
        ctx.globalAlpha = opacity;
        // Compensating translate, not a translate to (0,0) - lands
        // this beat's UNCHANGED internal width/2-based drawing at its
        // actual world anchor instead of screen-center. See
        // templateRenderers.js's drawBeatContent for the full
        // reasoning.
        ctx.translate(anchor.x + anchor.contentOffsetX - WIDTH / 2, anchor.y + anchor.contentOffsetY - HEIGHT / 2);

        // Grid/scanlines/data-chips/secondary-accent-shapes density layer -
        // drawn in this beat's own local WIDTH x HEIGHT frame (same trick as
        // drawHeroVisual/drawBeatContent below), so it lines up correctly
        // once the camera settles on this beat. tagLabel/sceneIndex/
        // sceneCount are omitted (null/undefined) because drawScreenTag
        // below already owns the corner-tag job with proper camera-opacity
        // crossfade - passing them here too would draw two overlapping tags.
        drawComposition(
          ctx, null, beat.params.accentShape || 'bracket', localTime, beat.duration,
          globalTime, WIDTH, HEIGHT, accentColor, undefined, undefined, system, secondaryColor
        );

        // iconCallout already draws its own icon as primary content -
        // adding a separate hero visual on top duplicated the same
        // shape twice in one frame, confirmed by actually looking at
        // rendered output. Only templates that are purely text/number
        // based (no icon of their own) get the added hero visual.
        const TEMPLATES_WITH_OWN_ICON = new Set(['iconCallout', 'badgeUnlock']);
        const heroImage = heroImages.get(idx);
        if (beat.template === 'visualMoment') {
          // Genuinely text-free - direct response to "I just want a
          // visual, I don't want text." Every other template pairs a
          // hero visual WITH text; this is the one that doesn't, so
          // it gets the shape at real scale (2.4x normal) and dead
          // center, not squeezed into the small "leaves room for text
          // below" position every other beat uses.
          if (heroImage) {
            drawHeroImage(ctx, heroImage, WIDTH, HEIGHT, accentColor, localTime, beat.duration, system, idx);
          } else {
            const heroShape = beat.params.heroVisual || 'mark';
            drawHeroVisual(ctx, heroShape, accentColor, localTime, beat.duration, WIDTH, HEIGHT, system, {
              carBodyStyle: beat.params.carBodyStyle,
              carBadgeText: beat.params.carBadgeText,
              carBadgeShape: beat.params.carBadgeShape,
            }, beat.params.customShapeRecipe, 0.4, 460);
          }
        } else {
          if (heroImage && !TEMPLATES_WITH_OWN_ICON.has(beat.template)) {
            drawHeroImage(ctx, heroImage, WIDTH, HEIGHT, accentColor, localTime, beat.duration, system, idx);
          } else if (!TEMPLATES_WITH_OWN_ICON.has(beat.template)) {
            const heroShape = beat.params.heroVisual || 'mark';
            drawHeroVisual(ctx, heroShape, accentColor, localTime, beat.duration, WIDTH, HEIGHT, system, {
              carBodyStyle: beat.params.carBodyStyle,
              carBadgeText: beat.params.carBadgeText,
              carBadgeShape: beat.params.carBadgeShape,
            }, beat.params.customShapeRecipe);
          }
          drawBeatContent(ctx, beat.template, beat.params, localTime, WIDTH, HEIGHT, visualSystem);
        }
        ctx.restore();
      }

      ctx.restore(); // end camera transform

      drawScreenTag(ctx, visibleBeatIndices, beats, globalTime, WIDTH, HEIGHT, accentColor, system);

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
        // ultrafast over veryfast - encode speed matters far more than
        // the small bitrate-efficiency loss for short-form vertical
        // video, and this runs once per chunk on the memory-capped host.
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
  const { totalDuration } = buildWorldTimeline(sceneJSON);
  const outDir = path.join(os.tmpdir(), 'shortform-renders');
  const outputPath = path.join(outDir, `${jobId}.mp4`);
  return renderTimelineRange(sceneJSON, 0, totalDuration, outputPath, onProgress);
}

module.exports = { renderJobToFile, renderTimelineRange, buildTimeline: buildWorldTimeline, WIDTH, HEIGHT, FPS };
