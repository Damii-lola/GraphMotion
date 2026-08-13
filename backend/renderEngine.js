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
const FPS = 30;

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

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

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

  const heroImages = new Map();
  for (let i = 0; i < beats.length; i++) {
    const imagePath = beats[i].params.imagePath;
    if (!imagePath) continue;
    try {
      heroImages.set(i, await loadImageWithTimeout(imagePath));
    } catch (err) {
      console.warn(`[renderEngine] failed to load image for beat ${i}, falling back to procedural: ${err.message}`);
    }
  }

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
