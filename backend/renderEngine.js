const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { buildBeatVisual, loadBeatImages } = require('./sceneBuilder');
const { gradientRamp } = require('./engine/generateEffects');

// Real, previously-unnoticed root cause of "the font/animation still
// looks wrong" complaints surviving every prompt-wording change: this
// engine never bundled or registered a SINGLE real font file of its
// own - every "fontFamily" the AI was ever told to use ("Futura
// Condensed", "Arial Black", etc.) was just a name handed to the host
// OS's own font lookup, with NO guarantee that name resolves to
// anything real on whatever machine actually renders it. Confirmed
// directly: on this dev machine, ctx.measureText() with
// "Futura Condensed" produced the IDENTICAL glyph metrics as a
// deliberately made-up, guaranteed-nonexistent font name - meaning it
// was silently falling back to some generic default the entire time,
// not the bold geometric look the prompt was asking for. Render's own
// Linux container has an entirely different (and likely much sparser)
// font set than this Windows dev machine, so the SAME prompt could
// have been producing a DIFFERENT wrong fallback there too - the exact
// "looks nothing like the reference" gap no amount of font-name
// tuning in the prompt could ever fix, since the name was never being
// honored anywhere.
//
// Fixed by bundling real, redistributable (SIL Open Font License)
// Poppins weight files directly in the repo and registering them here
// with explicit family aliases, so "Poppins Black"/"Poppins Bold"/
// "Poppins Medium"/"Poppins Italic" resolve to the ACTUAL requested
// glyphs identically on every host, dev machine or Render container,
// regardless of what's otherwise installed there.
const FONTS_DIR = path.join(__dirname, 'assets', 'fonts');
const FONT_REGISTRATIONS = [
  ['Poppins-Black.ttf', 'Poppins Black'],
  ['Poppins-Bold.ttf', 'Poppins Bold'],
  ['Poppins-Medium.ttf', 'Poppins Medium'],
  ['Poppins-Italic.ttf', 'Poppins Italic'],
];
for (const [file, alias] of FONT_REGISTRATIONS) {
  const fontPath = path.join(FONTS_DIR, file);
  if (fs.existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, alias);
  } else {
    console.warn(`[renderEngine] font file missing, "${alias}" will fall back to a host default: ${fontPath}`);
  }
}

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

// Real production incident, not a style choice: this used to render
// everything at 720x1280 (WIDTH/HEIGHT, the size every beat/layer/
// composition actually gets built at) and downscale to a 540x960
// OUTPUT canvas via ctx.scale() purely for supersampled anti-aliasing.
// That meant EVERY intermediate canvas throughout the whole pipeline
// (the layer-stack accumulator, per-layer buffers, 3D layer buffers,
// warp scratch/crop canvases, generate backgrounds) was paying for
// 720x1280 = 921,600 pixels when only 540x960 = 518,400 were ever
// actually delivered - 78% more pixel-processing cost than necessary,
// multiplied through nearly every operation in the render (fills,
// getImageData/putImageData reads, compositing, warping), not just one
// hot spot. Confirmed as a real, measured cost: a live render on
// Render's actual host was still timing out after the GC-cadence fix
// (10 minutes to go from 10% to 48% progress) - CPU time, not memory,
// was the remaining bottleneck. Now renders NATIVELY at the delivered
// resolution - no separate OUTPUT_WIDTH/OUTPUT_HEIGHT/RENDER_SCALE, no
// supersampling pass. The real quality cost (slightly less smooth
// anti-aliasing on diagonal/curved edges, since there's no extra
// downscale-blur step) is an accepted, deliberate tradeoff for a
// system that was outright failing to finish rendering at all.
const WIDTH = 540;
const HEIGHT = 960;
// 24 -> 20: total frame count (and so total render time, all else
// equal) scales directly with FPS - a real, zero-risk lever with none
// of the resolution change's coordinate-system implications (FPS never
// affects authored pixel positions). Part of the same emergency
// speed pass as the resolution change above.
const FPS = 20;

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
 * Deterministic per-video seed, hashed from stable sceneJSON content
 * only (never Date.now/Math.random-without-a-seed/anything process-
 * local) - board positions below are computed independently by EVERY
 * chunk-worker process for a long video (each chunk is a fresh forked
 * process per longVideoOrchestrator.js, receiving the same sceneJSON
 * but otherwise sharing no state at all), so every chunk MUST derive
 * the identical layout or beats would visibly jump between chunk
 * boundaries in the final concatenated video. A simple FNV-1a-style
 * hash over each beat's own duration/layer-count is enough entropy to
 * vary between different videos while staying perfectly reproducible
 * for the same one.
 */
function hashSceneJSONToSeed(sceneJSON) {
  const s = (sceneJSON.scenes || []).map((sc) => `${sc.params?.duration || 0}|${(sc.visual?.layers || []).length}`).join(';');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small, seeded PRNG (mulberry32) - deterministic across processes given the same seed, unlike Math.random(). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small, self-contained hex helpers (deliberately duplicated rather
// than imported from sceneSchema.js - that module stays dependency-
// free from the render engine, and this needs its OWN version anyway
// since sceneSchema.js's equivalent picks colors via Math.random(),
// which is NOT safe here - see buildBoardLayoutAndBackground's doc
// comment for why every random choice in this file has to come from
// the one seeded stream instead.
function hexToRgbLocal(hex) {
  const clean = String(hex).replace('#', '');
  const num = parseInt(clean, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function rgbToHexLocal([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
function adjustLightness(hex, factor) {
  const [r, g, b] = hexToRgbLocal(hex);
  const mix = (c) => (factor >= 0 ? c + (255 - c) * factor : c + c * factor);
  return rgbToHexLocal([mix(r), mix(g), mix(b)]);
}
const BOARD_BACKGROUND_HUES = ['#0A2435', '#1A1035', '#2A0A1F', '#0A2A1A', '#241A0A', '#1A2A24'];

/**
 * Explicit product direction: ONE continuous background for the whole
 * video, not a separate one per beat - the camera pans across DIFFERENT
 * REGIONS of that SAME background as it moves between beats, rather
 * than introducing a new one each time. Replaces the earlier per-beat-
 * gradient version of this board (each beat used to bring its own
 * "visual.background"): now the render engine owns the ONE shared
 * background outright, sized to the full bounding box every beat's
 * position spans (computed by the caller, once positions are known),
 * and beats render with a transparent backdrop so this shows through
 * everywhere there's no text.
 *
 * Both the board layout AND the background's color/shape draw from the
 * SAME seeded rand() stream, in a fixed order - this is what keeps a
 * long video's chunked rendering consistent: every chunk is a
 * SEPARATELY FORKED process (longVideoOrchestrator.js) that only
 * shares the sceneJSON itself, so any call to plain Math.random() here
 * would make each chunk pick a DIFFERENT background/layout and the
 * final video would visibly jump at every chunk boundary. Deterministic
 * per-video, verified identical across separate real process
 * invocations before this was trusted (see the original board-layout
 * commit's own verification for the methodology, unchanged here).
 */
function buildBoardLayoutAndBackground(sceneJSON, beatRanges) {
  const rand = mulberry32(hashSceneJSONToSeed(sceneJSON));
  const positions = [{ x: 0, y: 0 }];
  for (let i = 1; i < beatRanges.length; i++) {
    const angle = rand() * Math.PI * 2;
    // Explicit product direction: pan noticeably further than this
    // originally shipped with (200-450px, kept deliberately tight back
    // when the ONLY thing filling space between two beats' own canvases
    // was each other - a wider gap would have shown a bare gap through
    // to nothing). That constraint no longer applies now that ONE
    // shared background covers the board's full extent underneath
    // everything (see this function's own doc comment) - a longer pan
    // just glides across more of that same continuous backdrop, no
    // gap risk at all, so distance is free to be a real, dramatic
    // sweep instead of a cautious short hop.
    // Raised again (700-1300 -> 1600-2600) - still too close per
    // direct follow-up feedback even after the first increase. Same
    // reasoning holds even more strongly at this distance: the shared
    // background covers however far the camera travels, so there is
    // still no gap risk to weigh against going further.
    const distance = 1600 + rand() * 1000;
    const prev = positions[i - 1];
    positions.push({
      x: Math.round(prev.x + Math.cos(angle) * distance),
      y: Math.round(prev.y + Math.sin(angle) * distance),
    });
  }

  const baseColor = BOARD_BACKGROUND_HUES[Math.floor(rand() * BOARD_BACKGROUND_HUES.length)];
  const lighten = rand() < 0.5;
  const otherColor = adjustLightness(baseColor, (lighten ? 1 : -1) * (0.28 + rand() * 0.14));
  const [startColor, endColor] = lighten ? [otherColor, baseColor] : [baseColor, otherColor];
  const shape = rand() < 0.5 ? 'linear' : 'radial';

  return { positions, background: { startColor, endColor, shape } };
}

/** Standard ease-in-out-cubic - explicitly requested ("MAKE SURE THE MOVEMENT IS CUBIC") for the camera pan, smooth acceleration then deceleration rather than a linear/robotic glide. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// Default camera-pan duration - a beat can still override it via its
// existing "transitionIn.duration" field for pacing control (the
// TYPE field, e.g. "crossDissolve"/"linearWipe", is no longer used at
// all - every beat-to-beat change is now a pan, unconditionally, not
// just beats that happen to set a transitionIn).
const DEFAULT_PAN_DURATION_SECONDS = 0.6;

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
  const { positions: boardPositions, background: boardBackgroundDef } = buildBoardLayoutAndBackground(sceneJSON, beatRanges);

  // The ONE shared background, logically covering every position the
  // camera can ever be parked at (each beat's own WIDTHxHEIGHT
  // footprint on the board) - but NOT pre-built as one giant canvas
  // that size. Real, measured incident: with pan distances raised to
  // 1600-2600px (this session's own repeated "pan further" requests) a
  // typical 4-beat board bounding box already reaches ~1978x5798 =
  // 11.5Mpx - nearly 22x a single video frame's 540x960 = 0.52Mpx - and
  // building that ONE canvas up front measured at ~93MB of RSS by
  // itself (isolated A/B: 54MB before, 147MB after, on identical
  // content), the single largest identifiable contributor to a real
  // ~240MB per-chunk-process floor found while chasing a 100MB target.
  // Fixed by keeping the background a WORLD-SPACE gradient definition
  // only (below) and rendering just the current WIDTHxHEIGHT viewport
  // of it fresh each frame (drawBoardBackground, in the frame loop) -
  // same per-frame cost as any other 540x960 canvas already in the
  // budget, regardless of how far the board's bounding box spans.
  const boardMinX = Math.min(...boardPositions.map((p) => p.x));
  const boardMinY = Math.min(...boardPositions.map((p) => p.y));
  const boardMaxX = Math.max(...boardPositions.map((p) => p.x)) + WIDTH;
  const boardMaxY = Math.max(...boardPositions.map((p) => p.y)) + HEIGHT;
  const boardW = boardMaxX - boardMinX;
  const boardH = boardMaxY - boardMinY;
  console.log(`[renderEngine] board bounding box: ${boardW}x${boardH} = ${((boardW * boardH) / 1e6).toFixed(1)}Mpx (${beatRanges.length} beat(s)) - background rendered per-viewport, not pre-built at this size`);
  // World-space anchor points for the gradient axis, in the SAME
  // coordinate space as boardPositions/camX/camY - radial needs
  // genuinely distinct start/end points (identical points collapse the
  // radius to a 1px dot, the exact degenerate-gradient bug already
  // fixed once in sceneSchema.js's own background validation).
  const boardBgStartPoint = boardBackgroundDef.shape === 'radial'
    ? [boardMinX + boardW / 2, boardMinY + boardH / 2] : [boardMinX, boardMinY];
  const boardBgEndPoint = boardBackgroundDef.shape === 'radial'
    ? [boardMinX + boardW, boardMinY + boardH] : [boardMinX, boardMinY + boardH];

  // Every beat overlapping this chunk's own [timeStart,timeEnd) range
  // needs its own frames rendered here - chunking forks a fresh OS
  // process per chunk (renderChunkWorker.js/longVideoOrchestrator.js's
  // own memory-safety design, untouched by this file), so nothing about
  // a beat built in an earlier/later chunk carries over; each chunk
  // rebuilds whatever beats it actually needs from the SAME full
  // sceneJSON it's always been given. A beat's own immediate
  // PREDECESSOR is also always built too (its own frames might belong
  // to an earlier chunk) - EVERY beat-to-beat change now pans the
  // camera against whatever the previous beat "ended on" (its own
  // final frame, held), unconditionally, not just beats that happened
  // to set a transitionIn - so that predecessor's visual has to exist
  // here too whenever the pan window falls inside this chunk.
  const neededIndices = new Set();
  beatRanges.forEach((range, i) => {
    if (range.end > timeStart && range.start < timeEnd) {
      neededIndices.add(i);
      if (i > 0) neededIndices.add(i - 1);
    }
  });

  const built = new Map();
  for (const i of neededIndices) {
    built.set(i, await buildOneBeat(beatRanges[i]));
  }

  // A pan's "outgoing" side is always the SAME frozen moment
  // (prevBeat.range.duration - see the doc comment above) for every
  // single frame of the pan window, yet the naive version of this loop
  // re-rendered that identical frame from scratch on every one of those
  // frames - real, wasted CPU work, and (found via direct memory
  // profiling, not assumed) a real contributor to peak memory:
  // re-running a full beat's render (potentially a whole scene with
  // several layers) repeatedly, once per pan frame, when it only ever
  // needed to happen ONCE per beat per chunk. Cached here, keyed by the
  // outgoing beat's own index.
  const frozenFrameCache = new Map();

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  // Reused across every transition frame instead of allocated fresh
  // each time - found via direct memory profiling (614MB peak RSS on a
  // real 4-beat scene, far above this project's 100MB target): the
  // main `canvas` above was already a persistent, reused buffer, but
  // this one (the "current beat, mid-transition" scratch canvas) was
  // being createCanvas()'d fresh on EVERY transition frame, on top of
  // the 2-3 more canvases each transition function in transitions.js
  // allocates internally per call - a real burst of native Skia buffer
  // churn concentrated specifically in transition windows, exactly the
  // kind of native-memory-GC-doesn't-feel-pressured-by growth this
  // file's own gc()-cadence comment above already describes for the
  // unrelated layer-stack case.
  const transitionCurrCanvas = createCanvas(WIDTH, HEIGHT);
  const transitionCurrCtx = transitionCurrCanvas.getContext('2d');

  const renderStartedAt = Date.now();
  console.log(`[renderEngine] range ${timeStart}-${timeEnd}s: ${totalFrames} frames, ${neededIndices.size} beat(s) built, +0.0s`);

  try {
    for (let frame = startFrame; frame < endFrame; frame++) {
      const globalT = frame / FPS;
      const beatIndex = findActiveBeatIndex(beatRanges, globalT);
      const { range, visualObj } = built.get(beatIndex);
      const localT = globalT - range.start;

      // Pan duration still honors an authored "transitionIn.duration"
      // for pacing control (the TYPE field is ignored entirely now -
      // every beat-to-beat change pans, unconditionally, not just
      // beats that set one). Clamped to the CURRENT beat's own
      // duration so a short beat can't end while still mid-pan into
      // itself, which would leave it overlapping the NEXT beat's own
      // incoming pan.
      const requestedPanDuration = Number(range.scene.visual?.transitionIn?.duration) || DEFAULT_PAN_DURATION_SECONDS;
      const panDuration = beatIndex > 0 ? Math.min(Math.max(0.05, requestedPanDuration), range.duration * 0.8) : 0;
      const inPan = beatIndex > 0 && localT < panDuration;

      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      // Camera position, in BOARD space, is a cubic-eased interpolation
      // from the previous beat's own spot to this beat's WHILE panning,
      // or simply parked exactly on the current beat's spot otherwise -
      // computed ONCE and reused for both the shared background draw
      // and the beat canvas(es) below, so they always agree on exactly
      // what the viewport is looking at.
      let camX, camY;
      if (inPan) {
        const progress = easeInOutCubic(Math.min(1, Math.max(0, localT / panDuration)));
        const prevPos = boardPositions[beatIndex - 1];
        const currPos = boardPositions[beatIndex];
        camX = prevPos.x + (currPos.x - prevPos.x) * progress;
        camY = prevPos.y + (currPos.y - prevPos.y) * progress;
      } else {
        camX = boardPositions[beatIndex].x;
        camY = boardPositions[beatIndex].y;
      }

      // The ONE shared background, panned under everything else - beats
      // themselves render with a transparent backdrop now (no more
      // per-beat "visual.background"), so this shows through everywhere
      // there's no text, both while parked on a beat and mid-pan.
      // Rendered fresh each frame at just this WIDTHxHEIGHT viewport
      // (see the setup comment above for why - avoids ever allocating a
      // canvas sized to the whole, potentially huge, board bounding
      // box). "dither:false" is deliberate here, not an oversight: the
      // dithered version's noise is anchored to ITS OWN canvas's local
      // pixel grid, not world space - regenerating a dithered canvas
      // fresh each frame at a shifting world-space offset would make
      // the dither noise visibly "swim" in place instead of panning
      // smoothly with the content, a worse artifact than the mild
      // banding risk a flat gradient this large might otherwise show.
      const viewportBg = gradientRamp(WIDTH, HEIGHT, {
        startPoint: [boardBgStartPoint[0] - camX, boardBgStartPoint[1] - camY],
        endPoint: [boardBgEndPoint[0] - camX, boardBgEndPoint[1] - camY],
        startColor: boardBackgroundDef.startColor,
        endColor: boardBackgroundDef.endColor,
        shape: boardBackgroundDef.shape,
        dither: false,
      });
      ctx.drawImage(viewportBg, 0, 0);

      if (inPan) {
        const prevBeat = built.get(beatIndex - 1);
        let prevCanvas = frozenFrameCache.get(beatIndex - 1);
        if (!prevCanvas) {
          prevCanvas = createCanvas(WIDTH, HEIGHT);
          prevBeat.visualObj.render(prevCanvas.getContext('2d'), prevBeat.range.duration);
          frozenFrameCache.set(beatIndex - 1, prevCanvas);
        }
        transitionCurrCtx.clearRect(0, 0, WIDTH, HEIGHT);
        visualObj.render(transitionCurrCtx, localT);

        // Drawing each beat's canvas at (itsBoardPos - camera) is what
        // actually produces the pan: at progress 0 the previous beat's
        // canvas lands exactly at (0,0) (camera still parked on it) and
        // the incoming beat is offset fully off-screen; at progress 1
        // it's the reverse.
        const prevPos = boardPositions[beatIndex - 1];
        const currPos = boardPositions[beatIndex];
        ctx.drawImage(prevCanvas, prevPos.x - camX, prevPos.y - camY);
        ctx.drawImage(transitionCurrCanvas, currPos.x - camX, currPos.y - camY);
      } else {
        visualObj.render(ctx, localT);
      }

      // JPEG, not PNG: measured directly (not assumed) via a controlled
      // encode-only benchmark on realistic frame content - PNG's
      // lossless DEFLATE compression cost ~37ms/frame here, JPEG at
      // quality 90 cost ~11ms/frame, a real ~3.5x reduction on a step
      // that runs on literally every single frame. Safe because these
      // files are purely transient (written here, read once by ffmpeg
      // below, deleted after) - the FINAL delivered video is H.264
      // (itself lossy, no alpha channel) either way, so JPEG's small
      // quality loss on an already-lossy pipeline's intermediate step is
      // imperceptible in the actual output.
      const jpeg = canvas.encodeSync('jpeg', 90);
      const frameIndex = frame - startFrame;
      fs.writeFileSync(path.join(framesDir, `f${String(frameIndex).padStart(6, '0')}.jpg`), jpeg);

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
      // measured directly, not assumed: calling global.gc() alone left
      // RSS growing identically to no gc() at all (both reached
      // multiple GB over the same run). The native finalizers that
      // actually release napi-rs's Skia pixel buffers apparently need
      // an event-loop tick to run - they are not completed synchronously
      // inside a single global.gc() call. The REAL fix, confirmed by
      // direct A/B measurement on identical content: gc() -> yield to
      // the event loop -> gc() AGAIN.
      //
      // Cadence: a REAL production incident, not a hypothetical one,
      // forced a second round of tuning here. Running this EVERY frame
      // kept memory excellent (~245MB peak) but was measured to make
      // frame generation ~4x slower locally - and on Render's actual
      // (meaningfully slower/shared) CPU, that pushed a single 8s chunk
      // (192 frames) well past its 3-minute timeout mid-render, taking
      // the whole site down a second time. Swept several cadences on
      // identical real content: every-frame = ~140s/~245MB; every-2nd-
      // frame = ~38s/~316MB; every-3rd = ~38s/~431MB; every-5th =
      // ~39s/~589MB. The cliff is specifically between "every frame"
      // and "every other frame" - cadence 2 gets nearly all of the
      // speed of looser cadences while keeping memory closest to the
      // every-frame result, so that's what's used: real evidence, not a
      // guess at a "reasonable" number. --max-old-space-size (already
      // set on the render worker forks) never covered any of this - it
      // only bounds the JS heap, which was never where this memory
      // actually lived. Requires --expose-gc on the forked render
      // process (server.js/longVideoOrchestrator.js); guarded so this
      // is a silent no-op (not a crash) if that flag is ever missing,
      // though production must always pass it for this fix to actually
      // take effect.
      // inPan frames render TWO full beats' worth of content (the
      // frozen outgoing canvas plus the live incoming one) instead of
      // one - a real, concentrated burst of native memory churn the
      // every-2nd-frame cadence above wasn't tuned for (that cadence
      // was benchmarked on ordinary, single-beat frames). Forcing
      // every-frame gc() ONLY for this short, bounded window (pans are
      // well under a second) buys back most of the peak-memory cost of
      // that churn without paying the ~4x slowdown of every-frame gc()
      // across the WHOLE video - the cheaper cadence still applies
      // everywhere else.
      if ((inPan || frameIndex % 2 === 0) && global.gc) {
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
        // RSS (not heapUsed) deliberately - the dominant real cost here
        // is native Skia pixel memory (see the gc() cadence comment
        // above), which never shows up in heapUsed at all. Kept as a
        // permanent, cheap log line (not a one-off debug print) since
        // "Chunk N timed out" has a real, documented history of only
        // ever showing up on the actual Render host and never
        // reproducing locally - this is what actually lets a NEXT
        // occurrence show real numbers from production instead of
        // another blind guess.
        const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[renderEngine] frame ${frameIndex}/${totalFrames}, +${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s, rss=${rssMB}MB`);
      }
    }

    if (onProgress) onProgress(90);
    console.log(`[renderEngine] frames done, +${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s - starting ffmpeg encode`);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-y',
        '-framerate', String(FPS),
        '-i', path.join(framesDir, 'f%06d.jpg'),
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
