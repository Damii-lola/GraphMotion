const { createCanvas } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { buildBeatVisual, loadBeatImages } = require('./sceneBuilder');
const { gradientRamp } = require('./engine/generateEffects');
const { renderWithMotionBlur } = require('./engine/motionBlur');
const { buildTimeline, findActiveBeatIndex } = require('./engine/timeline');

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
// Poppins weight files directly in the repo and registering them with
// explicit family aliases, so "Poppins Black"/"Poppins Bold"/"Poppins
// Medium"/"Poppins Italic" resolve to the ACTUAL requested glyphs
// identically on every host, dev machine or Render container,
// regardless of what's otherwise installed there. The registration
// itself now lives in ./engine/fonts.js (a process-wide, load-once
// side effect either file can trigger) - sceneSchema.js needs the same
// real metrics to predict text wrapping during validation/repair, not
// just this file at actual draw time.
require('./engine/fonts');

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
const FRAME_DURATION = 1 / FPS;

// Real, confirmed-live gap: motionBlur.js (real sub-frame accumulation
// blur, matching AE's own shutter angle/phase controls) has existed in
// this engine the whole time but was NEVER actually wired into the
// render loop below - every frame was drawn at one single instant,
// with none of the motion smoothing a real per-character reveal needs
// to read as fluid instead of stepped. Directly named as a technique in
// a reference tutorial ("enable motion blur by checking this icon") for
// exactly the kind of fast text sweep this engine already builds -
// confirmed as a real, missing piece of "why does ours look static"
// rather than a guess. AE's own default is 8 samples/frame.
//
// 8 -> 4 -> 2: each sample is a full extra render of the beat's entire
// layer stack (layerStack.js/withEffects/dropShadow, all now pooled/
// fused where possible, but each sample still needs its OWN canvas -
// samples is a direct multiplier on top of everything else). Measured
// directly, not assumed: a real dense-content frame's per-frame RSS
// growth tracks with `samples` almost linearly, and this is a real
// per-render-job memory budget this engine is being pushed toward (see
// this file's own README-adjacent memory-fix history), not just a
// render-time concern. 2 samples still gives a real, visible blur
// trail on fast motion (confirmed directly on a real entrance
// animation) - short of "no motion blur," this is the smallest sample
// count that's still recognizably blur rather than a slight double-
// exposure ghost.
// Disabled per direct user request to cut render time/memory - motion
// blur meant EVERY frame rendered the entire layer stack `samples`
// times (2, previously) and blended them, a real, measured near-2x
// multiplier on top of everything else in the frame loop, for content
// that's mostly text/icons where a blur trail is a nice-to-have, not
// essential. motionBlur.js's own fast path (samples <= 1 or !enabled)
// skips the whole sampling loop entirely and does exactly one direct
// render, so this is a real, full removal of that cost, not a
// reduction.
const MOTION_BLUR_CONFIG = { enabled: false, shutterAngle: 180, shutterPhase: -90, samples: 2 };

// buildTimeline/findActiveBeatIndex now live in ./engine/timeline.js (a
// canvas-free module, required near the top of this file) - callers that
// only need beat TIMING math (audioMux.js, longVideoOrchestrator.js) can
// require THAT directly WITHOUT the side effect of loading @napi-rs/canvas,
// which requiring THIS file always does. Both names are still re-exported
// below unchanged, so every existing importer of them from renderEngine.js
// keeps working exactly as before - see engine/timeline.js's own doc
// comment for the real, measured memory cost this split fixes.

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
// Real bug found tracing a live "we're just reusing one single color -
// no two videos should have the same bg color" complaint (2026-09-03):
// this hash only ever depended on each beat's own duration and layer
// COUNT - never anything about what the video actually is. Two totally
// different topics routinely land on near-identical beat durations
// (narration length drives duration, and most beats cluster in the same
// 2-3s range) and the same small layer count (2-4 layers is the normal
// case for almost every beat this engine produces) - meaning two
// unrelated real videos could (and, per this complaint, evidently did)
// hash to the EXACT SAME seed, and therefore the exact same background
// AND camera pan pattern. Fixed by hashing real content instead - every
// beat's own narration text plus each layer's own text/icon - which
// only repeats across two videos that are actually near-duplicates of
// each other, not just similarly-shaped. Still 100% deterministic per
// sceneJSON (same content -> same hash), which is the one property this
// function actually needs to preserve - see this function's own callers
// for why (chunk-to-chunk consistency within ONE video's render).
// Real, second bug found in THIS same hash (2026-09-05, tracing a live
// "icon renders one color, its own glow renders a totally different
// color" report): the layerSig above included each image layer's own
// "icon" field - which iconFetch.js's prefetchIcons DELETES once it
// rasterizes that icon to a local PNG (replaced with a "src" file
// path). ensureHarmoniousColors (below) needs to run BEFORE that
// deletion so it can actually harmonize iconColor before it's baked
// permanently into pixels - but this hash function is what seeds BOTH
// that pre-prefetch harmonization pass AND renderTimelineRange's own
// later pass, and computing it before vs after the icon field's own
// deletion produced two DIFFERENT seeds for the exact same video,
// silently picking a different background/palette each time. Dropping
// the layer signature entirely and keeping just duration+narration
// (verified sufficient on its own for the ORIGINAL collision bug this
// hash was written to fix - see this function's other doc comment)
// keeps the seed stable across every stage of the pipeline regardless
// of what icon/image prefetch mutates afterward.
function hashSceneJSONToSeed(sceneJSON) {
  const s = (sceneJSON.scenes || []).map((sc) => `${sc.params?.duration || 0}|${sc.params?.narration || ''}`).join(';');
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

// Real HSL round-trip and a real WCAG contrast-ratio formula - added
// specifically for ensureHarmoniousColors below, direct user request
// for "actual artist color concepts" (hue relationships, not
// independently-random picks) instead of the old approach of picking a
// background and an accent color from two totally unrelated palettes,
// patched only reactively (and only ever toward one flat charcoal) when
// they happened to collide badly. hexToHsl/hslToHex operate in real
// hue-degrees/0-1 saturation-lightness, not the perceptual-luma
// approximation relativeLuma below already uses for the OLD light/dark
// background check - contrastRatio here is the actual WCAG 2.x formula
// (linearized sRGB, 0.2126/0.7152/0.0722 weights, the (L1+0.05)/(L2+0.05)
// ratio), since the user specifically asked for "WCAG-level contrast
// ratios," not just a good-enough brightness comparison.
function hexToHsl(hex) {
  const [r, g, b] = hexToRgbLocal(hex).map((c) => c / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2; let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgbToHexLocal(rgb.map((v) => (v + m) * 255));
}
function srgbChannelToLinear(c) {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}
function wcagRelativeLuminance(rgb) {
  const [r, g, b] = rgb.map(srgbChannelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(hexA, hexB) {
  const La = wcagRelativeLuminance(hexToRgbLocal(hexA));
  const Lb = wcagRelativeLuminance(hexToRgbLocal(hexB));
  const [lighter, darker] = La >= Lb ? [La, Lb] : [Lb, La];
  return (lighter + 0.05) / (darker + 0.05);
}
// Real, directly-measured fix for a repeatedly-reported "background
// looks dull/muted/lifeless" complaint: the OLD palette here
// (#0A2435, #1A1035, etc) measured out to real HSL lightness of only
// 9-14% each - genuinely near-black regardless of their saturation
// (54-68%, not actually low). Very low LIGHTNESS reads as muddy/dull
// to the eye no matter how saturated the hue technically is - a
// direct side-by-side comparison against a real professional motion-
// graphics reference (a vivid saturated-orange title card, L~45%) made
// this obvious. Replaced with the same hue families at real jewel-tone
// lightness (L~28-38%, S~68-85%) - rich royal blue/violet/magenta/
// emerald/amber/teal instead of near-black navy/maroon/forest, still
// dark enough for white/light text to stay legible, but genuinely
// vivid instead of muddy.
//
// Second, real complaint (2026-09-03, with a reference video attached):
// "the bg color is supposed to be random, sometimes light eg cream
// sometimes dark, sometimes another gradient... I WANT UNIQUENESS."
// EVERY one of the 6 entries above is a medium-dark saturated jewel
// tone - a light/cream background (the reference video's own look) was
// mathematically impossible to land on, no matter how the seed rolled.
// Added a real LIGHT/CREAM category alongside the existing dark jewel
// tones and a couple of muted pastels, so the actual reachable range
// spans what was asked for. ensureTextContrastAgainstBackground (below)
// is the reason this is safe to do at all - light entries would
// otherwise make every white-text layer unreadable; that pass darkens
// text/icon colors at render time whenever the picked background turns
// out light, exactly the case these new entries introduce.
const BOARD_BACKGROUND_HUES = [
  // dark jewel tones (original palette)
  '#13529A', '#50198F', '#9C165E', '#158450', '#B35B0F', '#177875',
  // light / cream
  '#EDE4D3', '#F2ECE1', '#E8DCC8',
  // muted pastel
  '#D9C7B8', '#C9D6D3', '#D6C9E0',
];

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
  // Biased toward radial (was an even 50/50 coin flip) - real,
  // confirmed-live reference comparison showed radial's own bright-
  // center-fading-to-edges vignette is consistently what the reference
  // material uses and a real part of why it reads as "designed" rather
  // than flat; linear still gets picked sometimes for real variety
  // across a batch of videos, just less often now.
  const shape = rand() < 0.25 ? 'linear' : 'radial';

  return { positions, background: { startColor, endColor, shape } };
}

// Perceptual luma (ITU-R BT.601 weights) - standard "how bright does
// this actually look to a human eye" measure, not a flat RGB average
// (green reads far brighter than blue at the same channel value).
function relativeLuma([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
const LIGHT_BACKGROUND_LUMA_THRESHOLD = 150; // out of 255
const LIGHT_TEXT_COLOR_LUMA_THRESHOLD = 150; // out of 255

/**
 * Direct consequence of BOARD_BACKGROUND_HUES' own new light/cream
 * entries (see its doc comment): every text/icon color this engine
 * produces was authored - by the model, or by sceneSchema.js's own
 * mechanical passes - with an unconditional assumption baked in that
 * the background would always be dark (near-white fill colors,
 * confirmed via real production JSON - #ffffff, #FFD700, light accent
 * tones). That assumption was even true before this fix. It is no
 * longer true: background color is picked HERE, at render time, from a
 * seed - nothing upstream of this file (scene JSON generation) has any
 * way to know what background a given video will actually land on, so
 * light text authored blind would go invisible outright on a newly-
 * possible light/cream background. Only handles the LIGHT-background
 * case, and only body/headline TEXT ("fillStyle") - a flat, confident
 * dark neutral is the genuinely correct, deliberate choice there
 * (matching the user's own later color-theory guidance: "prefer
 * neutral... backgrounds should recede"), not something that needs
 * hue-harmonizing. Icon/shape ACCENT colors are a separate concern,
 * handled below by ensureHarmoniousColors - this only exists to keep
 * the readable-text safety net that predates it.
 */
function ensureTextContrastAgainstBackground(sceneJSON, boardBackgroundDef) {
  const startLuma = relativeLuma(hexToRgbLocal(boardBackgroundDef.startColor));
  const endLuma = relativeLuma(hexToRgbLocal(boardBackgroundDef.endColor));
  const isLightBackground = (startLuma + endLuma) / 2 > LIGHT_BACKGROUND_LUMA_THRESHOLD;
  if (!isLightBackground) return;

  // Real, direct follow-up complaint after this first shipped
  // (2026-09-03): "the text color is just disgusting and doesnt
  // match." adjustLightness(-0.65) took whatever ARBITRARY hue the
  // model/mechanical passes happened to pick for a dark background
  // (gold, teal, whatever) and mechanically darkened THAT hue - which
  // reliably produces a muddy, muted, accidental-looking color (an
  // olive-brown squashed out of a bright gold, for instance), not a
  // deliberate design choice. A flat, confident dark neutral reads as
  // intentional against any light background regardless of what hue it
  // started from - swapped the per-color darkening formula for one
  // fixed, genuinely good charcoal instead of algorithmically muddying
  // whatever arbitrary color was already there.
  const DARK_TEXT_COLOR = '#262220';
  const fixColor = (color) => {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    const luma = relativeLuma(hexToRgbLocal(color));
    if (luma < LIGHT_TEXT_COLOR_LUMA_THRESHOLD) return color; // already dark enough against a light bg - leave its own hue alone
    return DARK_TEXT_COLOR;
  };

  for (const scene of sceneJSON.scenes || []) {
    const layers = scene?.visual?.layers;
    if (!Array.isArray(layers)) continue;
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      if (typeof layer.fillStyle === 'string') layer.fillStyle = fixColor(layer.fillStyle);
    }
  }
}

// A color counts as a real, deliberate ACCENT (needing hue-coordination
// with the background) only if it's genuinely vivid - real HSL lightness
// in a mid-range band, not washed out toward white/tint or crushed
// toward black/shade. Confirmed with actual computed HSL values, not a
// guess: this codebase's own neutral colors (#FFFFFF, the near-white
// #E9E4FF/#F5F3FF icon tints, the #262220 dark-text charcoal) all land
// at L<=0.14 or L>=0.88 REGARDLESS of their own HSL saturation (a very
// light tint is mathematically "100% saturated" in HSL despite reading
// as a near-neutral to the eye) - while every real accent color this
// file's own ACCENT_PALETTE and mograph beats actually use lands at
// L 0.60-0.77. This is what lets the pass below tell "a deliberate
// neutral" from "a real accent that should match the background"
// apart, without needing to track which JSON field a color came from.
const VIVID_ACCENT_MIN_SATURATION = 0.5;
const VIVID_ACCENT_MIN_LIGHTNESS = 0.35;
const VIVID_ACCENT_MAX_LIGHTNESS = 0.80;
function isVividAccentColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
  const [, s, l] = hexToHsl(hex);
  return s >= VIVID_ACCENT_MIN_SATURATION && l >= VIVID_ACCENT_MIN_LIGHTNESS && l <= VIVID_ACCENT_MAX_LIGHTNESS;
}

const MIN_ACCENT_CONTRAST_RATIO = 3.2; // real WCAG large-UI-component minimum (3:1) plus a small safety margin

/**
 * Builds a small palette of accent colors all genuinely RELATED to the
 * background's own hue (monochromatic and analogous relationships -
 * complementary is deliberately NOT included here: the user's own
 * guidance was explicit that "two high-saturation complementary colors
 * directly against each other" should be used "sparingly," and this
 * palette is applied to EVERY accent-role color across a whole video,
 * not a single rare highlight, so skipping it here avoids exactly the
 * failure case that warning describes). Each candidate's lightness is
 * nudged - never its hue, that's what keeps it "in the family" - until
 * it clears a real measured WCAG contrast ratio against the background,
 * so every option in the returned palette is both harmonious AND
 * genuinely readable, not just one or the other.
 */
function buildHarmoniousAccentPalette(backgroundHex, rand) {
  const [bgH, , bgL] = hexToHsl(backgroundHex);
  const hueOffsets = [0, 30, -30, 18, -18];
  return hueOffsets.map((offset) => {
    const hue = bgH + offset;
    const sat = 0.62 + rand() * 0.22;
    let light = bgL > 0.5 ? 0.26 + rand() * 0.1 : 0.66 + rand() * 0.14;
    let hex = hslToHex(hue, sat, light);
    let guard = 0;
    while (contrastRatio(hex, backgroundHex) < MIN_ACCENT_CONTRAST_RATIO && guard < 14) {
      light = bgL > 0.5 ? Math.max(0.06, light - 0.05) : Math.min(0.96, light + 0.05);
      hex = hslToHex(hue, sat, light);
      guard += 1;
    }
    return hex;
  });
}

/**
 * Real, direct user request: "USE ACTUAL ARTIST COLOR CONCEPTS WHEN
 * PICKING COLORS FOR BOTH THE BG AND THE ICONS" - hierarchical
 * contrast + harmony (hue relationships, WCAG contrast), not
 * independently-random picks patched only reactively. Before this,
 * background color (buildBoardLayoutAndBackground, above) and every
 * icon/shape accent color (sceneSchema.js's ACCENT_PALETTE, picked at
 * scene-JSON-GENERATION time, before this render-time background is
 * even chosen) came from two totally unrelated sources - the only
 * existing safety net (ensureTextContrastAgainstBackground, above)
 * only ever fixed body TEXT on a light background, never touched icon/
 * shape colors at all, on either light or dark backgrounds.
 *
 * Runs unconditionally (unlike the text-only pass above, which only
 * fires on a light background) - a dark background can just as easily
 * clash with an unrelated accent hue as a light one; harmony isn't a
 * light-background-only problem the way raw readability was.
 *
 * Uses its OWN independently-seeded rand() stream (hashSceneJSONToSeed
 * XORed with a fixed salt), never sharing buildBoardLayoutAndBackground's
 * own stream - inserting extra draws into that SHARED sequence would
 * shift every later position/background draw it makes, breaking the
 * cross-chunk-worker determinism buildBoardLayoutAndBackground's own
 * doc comment depends on. A second, independently-seeded deterministic
 * stream stays exactly as reproducible without touching the first.
 *
 * Detects which colors actually need harmonizing via isVividAccentColor
 * (real HSL lightness, not which JSON field it came from) - lets this
 * one pass cover every accent-carrying field this file didn't
 * previously touch at all (shape fill/stroke - node circles, connector
 * lines, phone body/notch - none of which the old text-only pass ever
 * saw), not just iconColor and text fills. Maps each DISTINCT original
 * color to the SAME palette entry everywhere it appears (a Map, keyed
 * by the original hex) - if a beat originally used one accentColor
 * consistently across several fields (the normal mograph case), that
 * internal consistency survives the remap instead of scattering into
 * unrelated replacements.
 */
// Real, confirmed-live bug found via direct frame inspection (2026-09-05,
// mograph glow work): outerGlow's default 'screen' blend mode works by
// ADDING light - genuinely vivid on a dark background (the reference
// video this whole glow system is modeled on is dark in EVERY frame),
// but barely visible when the background itself already turns out
// light (BOARD_BACKGROUND_HUES can land on a light/cream/pastel entry -
// there's no light already there to brighten further). Confirmed
// directly: an icon's own outerGlow, unchanged, rendered as an almost
// imperceptible tint on a light lavender background. Switches to
// 'multiply' (darkens/saturates instead of adding light - genuinely
// visible against a light backdrop the same way a soft colored shadow
// would be) only when the ACTUAL picked background turns out light;
// completely inert on a dark background, the majority/originally-only
// case this glow system was built and tuned against.
function adaptGlowForBackground(effects, isLightBackground) {
  if (!isLightBackground || !Array.isArray(effects)) return;
  for (const e of effects) {
    if (e?.type === 'outerGlow' && e.params) e.params.blendMode = 'multiply';
  }
}

function ensureHarmoniousColors(sceneJSON, boardBackgroundDef) {
  const rand = mulberry32(hashSceneJSONToSeed(sceneJSON) ^ 0x9E3779B1);
  const bgRefColor = boardBackgroundDef.startColor;
  const palette = buildHarmoniousAccentPalette(bgRefColor, rand);
  const remap = new Map();
  let nextPaletteIndex = 0;
  const harmonize = (color) => {
    if (!isVividAccentColor(color)) return color;
    const key = color.toUpperCase();
    if (!remap.has(key)) {
      remap.set(key, palette[nextPaletteIndex % palette.length]);
      nextPaletteIndex += 1;
    }
    return remap.get(key);
  };
  const startLuma = relativeLuma(hexToRgbLocal(boardBackgroundDef.startColor));
  const endLuma = relativeLuma(hexToRgbLocal(boardBackgroundDef.endColor));
  const isLightBackground = (startLuma + endLuma) / 2 > LIGHT_BACKGROUND_LUMA_THRESHOLD;

  for (const scene of sceneJSON.scenes || []) {
    const layers = scene?.visual?.layers;
    if (!Array.isArray(layers)) continue;
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      if (typeof layer.iconColor === 'string') layer.iconColor = harmonize(layer.iconColor);
      if (typeof layer.fillStyle === 'string') layer.fillStyle = harmonize(layer.fillStyle);
      if (Array.isArray(layer.contents)) {
        for (const c of layer.contents) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'fill' && typeof c.color === 'string') c.color = harmonize(c.color);
          if (c.type === 'stroke' && typeof c.color === 'string') c.color = harmonize(c.color);
        }
      }
      if (Array.isArray(layer.animators)) {
        for (const a of layer.animators) {
          if (a?.properties && typeof a.properties.color === 'string') a.properties.color = harmonize(a.properties.color);
        }
      }
      if (Array.isArray(layer.effects)) {
        for (const e of layer.effects) {
          if (e?.params && typeof e.params.color === 'string') e.params.color = harmonize(e.params.color);
        }
        adaptGlowForBackground(layer.effects, isLightBackground);
      }
    }
  }
}

/**
 * Real production fix, not just a refactor: server.js used to let
 * renderTimelineRange be the ONLY place background color gets picked
 * and ensureHarmoniousColors run - fine in isolation, but by the time a
 * job actually reaches that call, iconFetch.js's own prefetch step has
 * ALREADY rasterized every icon layer's PNG using its ORIGINAL,
 * un-harmonized iconColor and deleted the field outright (see
 * hashSceneJSONToSeed's own doc comment for the full trace). That left
 * ensureHarmoniousColors' `if (typeof layer.iconColor === 'string')`
 * check permanently unable to reach image layers - it kept correctly
 * harmonizing that same layer's OWN outerGlow color (a separate, still-
 * live field), producing a confirmed-live, directly reproduced bug: a
 * mograph icon rendering in its ORIGINAL AI-picked color while its own
 * glow renders in a totally different, harmonized one.
 *
 * Exported so server.js can call this explicitly, once, BEFORE any
 * icon/image prefetch ever touches the scene - at that point iconColor
 * is still a live string, so it gets harmonized right alongside every
 * other color, and prefetch then bakes icons using the ALREADY-correct
 * value. Safe to still let renderTimelineRange run its own internal
 * copy of this same pass afterward (it does, unconditionally, for every
 * caller that does NOT pre-harmonize) - same stable seed (see
 * hashSceneJSONToSeed) plus the same first-color-encountered ->
 * palette-slot assignment order means re-running it against already-
 * harmonized values is a no-op fixed point, not a second, different
 * remap.
 */
function harmonizeSceneColors(sceneJSON) {
  const { beatRanges } = buildTimeline(sceneJSON);
  const { background } = buildBoardLayoutAndBackground(sceneJSON, beatRanges);
  ensureTextContrastAgainstBackground(sceneJSON, background);
  ensureHarmoniousColors(sceneJSON, background);
  return background;
}

/** Standard ease-in-out-cubic - explicitly requested ("MAKE SURE THE MOVEMENT IS CUBIC") for the camera pan, smooth acceleration then deceleration rather than a linear/robotic glide. */
/**
 * Soft, drifting glow "bokeh" particles scattered across the board's own
 * world-space bounding box - the direct answer to the real, frame-by-
 * frame reference comparison feedback ("THE TRANSITIONS... AINT
 * MAJECTIC... RUSHED... NOT CLICKING"): the reference keeps several
 * blurred, glowing circles visibly drifting at different depths through
 * every beat, not just during transitions, giving it an atmosphere the
 * previously-flat gradient board never had. Positions are fixed WORLD-
 * SPACE points, not animated independently - the camera's own existing
 * pan across the shared board (see buildBoardLayoutAndBackground's doc
 * comment) is what makes them drift past at all, exactly like real
 * parallax, for zero extra per-frame animation cost. Drawn directly onto
 * the SAME per-camera-position cached background canvas the plain
 * gradient already uses (see cachedBgCanvas in the frame loop below) -
 * so, like the gradient itself, this only ever gets (re)computed when
 * the camera position actually changes, not on every single frame.
 */
function generateAmbientOrbs(sceneJSON, boardPositions, backgroundDef) {
  // Independent stream from both the board-layout rand() (positions/
  // background hue, seeded plain) and ensureHarmoniousColors' own
  // ^0x9E3779B1 stream - this one must never perturb either of those
  // existing deterministic sequences, so it gets its own distinct XOR
  // constant (a standard MurmurHash3 fmix constant, unrelated to the
  // golden-ratio one already in use elsewhere in this file).
  const rand = mulberry32(hashSceneJSONToSeed(sceneJSON) ^ 0x85ebca6b);
  const [bgH] = hexToHsl(backgroundDef.startColor);
  const isLight = relativeLuma(hexToRgbLocal(backgroundDef.startColor)) > LIGHT_BACKGROUND_LUMA_THRESHOLD;
  const makeOrb = (x, y) => {
    const hue = bgH + (rand() * 50 - 25); // analogous - same harmony rule ensureHarmoniousColors already uses
    const sat = 0.35 + rand() * 0.25; // soft, not a vivid accent - this is atmosphere, not a focal element
    const light = isLight ? 0.5 + rand() * 0.18 : 0.62 + rand() * 0.2;
    return {
      x, y,
      radius: 50 + rand() * 130,
      color: hslToHex(hue, sat, light),
      opacity: 0.05 + rand() * 0.09, // deliberately subtle - this recedes into the background, unlike foreground content
    };
  };
  // Scattering uniformly across the board's full bounding-box AREA (the
  // first version of this function) badly undercounted in practice: a
  // multi-beat board is a long, thin zig-zag the camera actually walks,
  // not a rectangle it fills, so most of that area's bbox is empty space
  // the camera never visits - directly confirmed on a real 3-beat test
  // render, several consecutive parked frames showed zero orbs at all.
  // Clustering instead AROUND each beat's own parked camera position
  // (plus a couple more near each pan's midpoint) guarantees every beat
  // - parked or panning - actually has atmosphere nearby, using far
  // fewer total orbs for a denser-LOOKING result since none are wasted
  // in bbox regions the camera never crops into.
  const SPREAD = Math.max(WIDTH, HEIGHT) * 0.85;
  const orbs = [];
  for (const pos of boardPositions) {
    for (let i = 0; i < 6; i++) {
      orbs.push(makeOrb(pos.x + (rand() * 2 - 1) * SPREAD, pos.y + (rand() * 2 - 1) * SPREAD));
    }
  }
  for (let i = 1; i < boardPositions.length; i++) {
    const midX = (boardPositions[i - 1].x + boardPositions[i].x) / 2;
    const midY = (boardPositions[i - 1].y + boardPositions[i].y) / 2;
    orbs.push(makeOrb(midX + (rand() * 2 - 1) * SPREAD * 0.5, midY + (rand() * 2 - 1) * SPREAD * 0.5));
    orbs.push(makeOrb(midX + (rand() * 2 - 1) * SPREAD * 0.5, midY + (rand() * 2 - 1) * SPREAD * 0.5));
  }
  return orbs;
}

function drawAmbientOrbs(ctx, orbs, camX, camY, width, height) {
  for (const orb of orbs) {
    const cx = orb.x - camX;
    const cy = orb.y - camY;
    if (cx < -orb.radius || cx > width + orb.radius || cy < -orb.radius || cy > height + orb.radius) continue;
    const [r, g, b] = hexToRgbLocal(orb.color);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orb.radius);
    grad.addColorStop(0, `rgba(${r},${g},${b},${orb.opacity})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, orb.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// Default camera-pan duration - a beat can still override it via its
// existing "transitionIn.duration" field for pacing control (the
// TYPE field, e.g. "crossDissolve"/"linearWipe", is no longer used at
// all - every beat-to-beat change is now a pan, unconditionally, not
// just beats that happen to set a transitionIn).
// Raised from 0.6 - real, direct reference-comparison feedback called
// the transitions "rushed" and "not majestic." Paired with the new
// coupled zoom in the pan-compositing step below (drawZoomed) rather
// than relied on alone - a longer pan with no other change would just
// be the same flat slide taking longer, not a fix for "flat" itself.
const DEFAULT_PAN_DURATION_SECONDS = 0.75;

/**
 * Real, root-cause finding behind a persistent brutal vision-judge
 * complaint that survived EVERY other fix tried against it this whole
 * project (richer gradients, grain texture, decorative accents,
 * content-matched icons, dense content cards - each individually
 * verified correct, none of them moved the judge's score): "looks like
 * a PowerPoint slide" is not a vague insult, it's a LITERALLY accurate
 * technical description. Once a beat's own entrance keyframes finish
 * (textAnimationPresets' own 0.1-0.5s window) AND the camera finishes
 * its own beat-to-beat pan (panDuration, ~0.6s), there is NOTHING left
 * anywhere in this engine that moves for the remainder of the beat -
 * every layer sits at its own final, static value, and the camera is
 * PARKED at a fixed boardPositions[beatIndex] the entire time (see the
 * frame loop below). A judge (or a viewer) landing on ANY frame past
 * that entrance window sees a genuinely frozen image, indistinguishable
 * from a static slide - exactly PowerPoint's own "transition, then
 * nothing moves until the next slide" model. Every previous fix added
 * MORE THINGS to look at, but never addressed that the whole frame
 * still goes completely still for 80%+ of a typical beat's duration.
 *
 * Fixed here, not per-layer JSON, specifically because it needs zero
 * per-beat authoring and applies with 100% coverage to literally every
 * beat regardless of content - a slow, continuous "Ken Burns" style
 * zoom (a technique used in essentially all professional short-form/
 * documentary video for exactly this reason) driven purely by
 * beat-local time, applied as a transform wrapping the beat's own
 * render call. A subtle, SLOW zoom (over a beat's own FULL duration,
 * not a quick pulse) reads as "the camera is alive", not as motion
 * competing with the content - confirmed via direct real-render
 * inspection before shipping (see the render call sites below).
 *
 * 0.05 -> 0.15 (2026-09-03): direct, extremely emphatic user complaint
 * against a reference video ("they were FUCKING still moving around
 * while they were on screen... make it extremely dynamic") - 5% growth
 * spread across a whole 2-3s beat is real motion but reads as close to
 * imperceptible next to reference footage's own energy. This is one of
 * two fixes for the same complaint - see sceneSchema.js's
 * ensureSustainedAmbientMotion for the other (real per-LAYER wiggle, not
 * just the shared camera), since a uniform camera zoom alone still
 * reads as "the camera is moving," not "the elements themselves are
 * alive," which is closer to what was actually being asked for.
 */
const BEAT_ZOOM_AMOUNT = 0.15;
function withBeatZoom(drawFn, beatDuration, width, height) {
  return (ctx, t) => {
    const progress = beatDuration > 0 ? Math.min(1, Math.max(0, t / beatDuration)) : 0;
    const zoom = 1 + progress * BEAT_ZOOM_AMOUNT;
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-width / 2, -height / 2);
    drawFn(ctx, t);
    ctx.restore();
  };
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
  const { positions: boardPositions, background: boardBackgroundDef } = buildBoardLayoutAndBackground(sceneJSON, beatRanges);
  ensureTextContrastAgainstBackground(sceneJSON, boardBackgroundDef);
  ensureHarmoniousColors(sceneJSON, boardBackgroundDef);

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
  //
  // A radial gradient's own visible "vignette" - bright center fading
  // to darker edges - was investigated as a candidate fix for output
  // reading as flat/lifeless against reference footage. Direct numeric
  // probes of gradientRamp's own per-pixel RGB output (not just
  // eyeballing rendered PNGs) across a real board's actual beat
  // positions found a genuine tension baked into the "ONE shared
  // background, camera pans across regions of it" design (see this
  // function's own doc comment): a SMALL radius gives strong internal
  // variation within whichever one beat happens to sit near the
  // center, but every other beat saturates to a flat, undifferentiated
  // color (t>=1 across its whole viewport); a LARGE radius keeps every
  // beat non-flat, but the internal variation within any ONE beat's
  // own small 540x960 slice becomes too subtle (single-digit RGB
  // deltas) to read as a real vignette. Empirically, this radius (the
  // centroid-to-corner distance, coincidentally close to what the
  // original code already computed by extending the gradient axis to
  // the board's far corner) is the best available balance point - a
  // meaningfully large fraction of beats show real, visible internal
  // falloff, though not the dramatic center-to-edge contrast reference
  // material shows within a single frame. Getting genuinely reference-
  // grade vignette on every beat would need the gradient's own hot
  // center to track near wherever the camera currently is, which is a
  // materially different design than "one fixed background the camera
  // pans across" - a real product decision, not a bug, so left alone
  // here rather than silently overridden.
  const boardCenterX = boardMinX + boardW / 2;
  const boardCenterY = boardMinY + boardH / 2;
  const RADIAL_BG_RADIUS = Math.hypot(boardW / 2, boardH / 2);
  const boardBgStartPoint = boardBackgroundDef.shape === 'radial'
    ? [boardCenterX, boardCenterY] : [boardMinX, boardMinY];
  const boardBgEndPoint = boardBackgroundDef.shape === 'radial'
    ? [boardCenterX + RADIAL_BG_RADIUS, boardCenterY] : [boardMinX, boardMinY + boardH];

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

  // Real, directly measured finding: gradientRamp's per-pixel loop
  // (518,400 pixels, radial-distance + color-lerp math) costs ~60ms per
  // call - and the frame loop below was calling it UNCONDITIONALLY on
  // EVERY frame, even though its only frame-varying inputs are camX/
  // camY, which stay EXACTLY constant for every "parked" frame (the
  // large majority - a beat is only actually panning for
  // DEFAULT_PAN_DURATION_SECONDS, ~12 of a typical 40-70 frame beat).
  // Measured directly: ~60ms x 60 frames/chunk is a real ~3.6s slice of
  // a chunk's total render time, recomputing the IDENTICAL image over
  // and over. Cached here by (camX, camY) - not the "reuse a mutable
  // scratch canvas across renders" pattern that measured WORSE earlier
  // in this same investigation (composition.js's reverted attempt),
  // but the opposite: this canvas is fully computed and never mutated
  // again, so skipping the recompute entirely and reusing the exact
  // same finished bitmap via drawImage whenever camX/camY didn't
  // change since the last frame is a plain, safe memoization.
  let cachedBgCanvas = null;
  let cachedBgCamX = null;
  let cachedBgCamY = null;
  const ambientOrbs = generateAmbientOrbs(sceneJSON, boardPositions, boardBackgroundDef);

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
      let camX, camY, panProgress;
      if (inPan) {
        panProgress = easeInOutCubic(Math.min(1, Math.max(0, localT / panDuration)));
        const prevPos = boardPositions[beatIndex - 1];
        const currPos = boardPositions[beatIndex];
        camX = prevPos.x + (currPos.x - prevPos.x) * panProgress;
        camY = prevPos.y + (currPos.y - prevPos.y) * panProgress;
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
      let viewportBg;
      if (cachedBgCanvas && camX === cachedBgCamX && camY === cachedBgCamY) {
        viewportBg = cachedBgCanvas;
      } else {
        viewportBg = gradientRamp(WIDTH, HEIGHT, {
          startPoint: [boardBgStartPoint[0] - camX, boardBgStartPoint[1] - camY],
          endPoint: [boardBgEndPoint[0] - camX, boardBgEndPoint[1] - camY],
          startColor: boardBackgroundDef.startColor,
          endColor: boardBackgroundDef.endColor,
          shape: boardBackgroundDef.shape,
          dither: false,
        });
        drawAmbientOrbs(viewportBg.getContext('2d'), ambientOrbs, camX, camY, WIDTH, HEIGHT);
        cachedBgCanvas = viewportBg;
        cachedBgCamX = camX;
        cachedBgCamY = camY;
      }
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
        renderWithMotionBlur(transitionCurrCtx, WIDTH, HEIGHT, localT, FRAME_DURATION, withBeatZoom((c, st) => visualObj.render(c, st), range.duration, WIDTH, HEIGHT), MOTION_BLUR_CONFIG);

        // Drawing each beat's canvas at (itsBoardPos - camera) is what
        // actually produces the pan: at progress 0 the previous beat's
        // canvas lands exactly at (0,0) (camera still parked on it) and
        // the incoming beat is offset fully off-screen; at progress 1
        // it's the reverse.
        const prevPos = boardPositions[beatIndex - 1];
        const currPos = boardPositions[beatIndex];

        // A pure XY slide of two flat, unscaled canvases reads exactly
        // as the direct reference-video feedback described it: "rushed,"
        // "not majestic" - real motion-graphics transitions almost never
        // move on a single flat axis like that, they carry a coupled
        // scale "push" that reads as camera depth. Outgoing swells
        // slightly as if the camera is moving THROUGH it on the way
        // past; incoming swoops in from slightly smaller, landing at
        // exactly 1:1 right as it finishes arriving. Scaled around each
        // canvas's own on-screen CENTER (not top-left) so this reads as
        // a zoom, not an extra drift on top of the pan already happening.
        const drawZoomed = (image, x, y, scale) => {
          const w = WIDTH * scale;
          const h = HEIGHT * scale;
          const cx = x + WIDTH / 2;
          const cy = y + HEIGHT / 2;
          ctx.drawImage(image, cx - w / 2, cy - h / 2, w, h);
        };
        const outScale = 1 + panProgress * 0.16;
        const inScale = 0.86 + panProgress * 0.14;
        drawZoomed(prevCanvas, prevPos.x - camX, prevPos.y - camY, outScale);
        drawZoomed(transitionCurrCanvas, currPos.x - camX, currPos.y - camY, inScale);
      } else {
        renderWithMotionBlur(ctx, WIDTH, HEIGHT, localT, FRAME_DURATION, withBeatZoom((c, st) => visualObj.render(c, st), range.duration, WIDTH, HEIGHT), MOTION_BLUR_CONFIG);
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
      // sceneBuilder.js -> layerStack.js) allocates full-frame canvases
      // - each one a small JS wrapper object with several MB of NATIVE
      // Skia pixel memory attached via napi-rs. V8's own GC decides
      // when to collect based on JS HEAP size, which stays tiny here (a
      // canvas wrapper is small) regardless of how much native memory
      // is actually piling up - so V8 never feels "pressured" to
      // collect, and native RSS grows essentially unbounded without
      // help.
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
      // Cadence: this USED to be every-2nd-frame (looser cadences were
      // even worse) specifically because every-frame gc() measured ~4x
      // slower - back when layerStack.js/motionBlur.js/withEffects each
      // allocated a FRESH canvas per layer per motion-blur sample
      // (samples=4), so a single frame could momentarily hold dozens of
      // native buffers alive, making every gc() pass expensive. Those
      // three call sites now POOL their canvases (allocate once, clear
      // and reuse) instead of allocating fresh ones - see their own doc
      // comments - which shrank per-frame garbage enough that every-
      // frame gc() re-measured at essentially the SAME speed as every-
      // 2nd-frame (72.8s vs 71.6s on identical real content) while
      // keeping RSS consistently lower throughout the render, so this
      // now always runs, not conditionally. --max-old-space-size
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
  renderJobToFile, renderTimelineRange, buildTimeline, harmonizeSceneColors, WIDTH, HEIGHT, FPS,
};
