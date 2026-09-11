const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Property } = require('./engine/keyframes');
const { ExpressionProperty } = require('./engine/expressions');
const { Node, resolve } = require('./engine/node');
const { Composition, PrecompNode } = require('./engine/composition');
const { renderContents } = require('./engine/shapeLayer');
const {
  rectanglePath, ellipsePath, polygonPath, starPath, customPath,
} = require('./engine/shapePrimitives');
const { renderAnimatedText, layoutText } = require('./engine/textAnimator');
const { renderAnimatedTextOnPath } = require('./engine/textPath');
const { rangeSelector, wigglySelector } = require('./engine/selectors');
const { applyTextAnimationPresets } = require('./engine/textAnimationPresets');
const {
  gradientRamp, checkerboard, grid, lensFlare,
} = require('./engine/generateEffects');
const { fractalNoise } = require('./engine/noiseEffects');
const {
  applyCurves, applyHueSaturation, applyColorBalance, applyLevels,
} = require('./engine/colorGrading');
const { gaussianBlur, boxBlur, directionalBlur, radialBlur } = require('./engine/blurEffects');
const { addGrain, addNoise } = require('./engine/noiseEffects');
const {
  rgbShift, blockDisplace, scanLines, pixelSort,
} = require('./engine/glitchEffects');
const {
  findEdges, emboss, posterize, mosaic, autoGlow,
} = require('./engine/stylizeEffects');
const {
  applyDropShadow, applyOuterGlow, applyInnerGlow, applyInnerShadow, applyStroke,
} = require('./engine/layerStyles');
const {
  twirl, bulge, rippleWarp, waveWarp, displacementMap,
} = require('./engine/distortEffects');
// engine/transitions.js is NOT required here - real dead weight found
// during a full memory audit: renderEngine.js's own history already
// documents that every beat-to-beat change now pans unconditionally
// (the TYPE field a beat's old "transitionIn.type" would have selected
// one of these transitions with is "no longer used at all"), and a
// direct search confirmed zero references to this import anywhere in
// this file - it was pure unused weight, pulling in its own further
// dependency chain (noiseEffects.js, glitchEffects.js,
// shapePrimitives.js, path.js) into every chunk-worker process for
// zero benefit.

/**
 * The real interpreter: turns validated scene JSON (sceneSchema.js)
 * into actual calls against the engine - Nodes, Compositions,
 * ShapeLayers, real Property/ExpressionProperty animation, real effect
 * functions. This is the
 * piece that makes "the AI directs a real engine" true in practice,
 * not just in architecture - every construct in the schema maps to a
 * genuine, already-tested engine call, not a re-implementation.
 *
 * DESIGN BOUNDARY, stated honestly: a shape's own GEOMETRY (a
 * rectangle's width/height/roundness, a star's point count, etc) is
 * built ONCE per layer from static parameter values, not re-evaluated
 * every frame - this is a deliberate, reasonable scope limit, not an
 * oversight. It does not mean shapes can't animate: a shape's
 * TRANSFORM (position/rotation/scale/opacity, real Node fields) and
 * its Trim Paths / Repeater parameters (batch 6/7 - already resolved
 * fully per-frame inside shapeLayer.js's own real renderContents) are
 * both completely animatable, which covers the overwhelming majority
 * of real shape animation. Per-frame regeneration of the raw path
 * geometry itself would need extending shapeLayer.js's own contract,
 * which this file intentionally does not do.
 */

// ---------------------------------------------------------------------
// Animatable value resolution
// ---------------------------------------------------------------------

/** Turns a schema AnimatableValue into a real Property, ExpressionProperty, or plain value - usable anywhere the engine's own resolve() is called (every Node/ShapeLayer transform field). */
function buildAnimatable(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' || Array.isArray(value)) return value;
  if (Array.isArray(value.keyframes)) {
    return new Property(value.keyframes.map((kf) => ({
      time: kf.time,
      value: kf.value,
      interpolation: kf.interpolation,
      easing: kf.easing,
      easingParams: kf.easingParams,
      outTangent: kf.outTangent,
      inTangent: kf.inTangent,
      spatialOutTangent: kf.spatialOutTangent,
      spatialInTangent: kf.spatialInTangent,
    })), { spatial: !!value.spatial });
  }
  if (typeof value.expression === 'string') {
    let baseProperty = null;
    if (value.base !== undefined) {
      const built = buildAnimatable(value.base);
      baseProperty = typeof built?.valueAt === 'function' ? built : new Property([{ time: 0, value: built }]);
    }
    return new ExpressionProperty(value.expression, { baseProperty, seed: value.seed || 0 });
  }
  return value;
}

/** A shape-geometry parameter (or any effect param) is treated as a static value - if given an AnimatableValue shape, it's resolved ONCE at t=0 rather than crashing, a reasonable fallback for a field this file intentionally doesn't re-evaluate per frame (see the class-level design-boundary note above). */
function resolveStatic(value) {
  const built = buildAnimatable(value);
  return typeof built?.valueAt === 'function' ? built.valueAt(0) : built;
}

/** Resolves every top-level value of a params object AT TIME t via the real resolve() - lets effect parameters (blur radius, glitch intensity, etc) be keyframed/expression-driven exactly like a layer transform can. */
function resolveParamsAtTime(params, t) {
  if (!params) return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && (v.keyframes || v.expression)) ? resolve(buildAnimatable(v), t) : v;
  }
  return out;
}

// ---------------------------------------------------------------------
// Shape geometry + contents (batch 6/7's real shapePrimitives/shapeLayer)
// ---------------------------------------------------------------------

const SHAPE_BUILDERS = {
  rectangle: rectanglePath, ellipse: ellipsePath, polygon: polygonPath, star: starPath, customPath,
};

function buildShapePathDef(shapeDef) {
  const builder = SHAPE_BUILDERS[shapeDef.kind];
  if (!builder) throw new Error(`sceneBuilder: unknown shape kind "${shapeDef.kind}"`);
  const staticParams = {};
  for (const [k, v] of Object.entries(shapeDef.params || {})) staticParams[k] = resolveStatic(v);
  return builder(staticParams);
}

function buildShapeContents(contentsDef) {
  return contentsDef.map((item) => {
    if (item.type === 'path') {
      const { anchors, closed } = buildShapePathDef(item.shape);
      return { type: 'path', anchors, closed: item.closed !== undefined ? item.closed : closed };
    }
    if (item.type === 'group') {
      return {
        type: 'group',
        contents: buildShapeContents(item.contents),
        transform: item.transform ? {
          position: buildAnimatable(item.transform.position),
          rotation: buildAnimatable(item.transform.rotation),
          scale: buildAnimatable(item.transform.scale),
          anchor: buildAnimatable(item.transform.anchor),
          opacity: buildAnimatable(item.transform.opacity),
        } : undefined,
      };
    }
    if (item.type === 'repeater') {
      return {
        type: 'repeater',
        copies: buildAnimatable(item.copies),
        transform: item.transform ? {
          position: buildAnimatable(item.transform.position),
          rotation: buildAnimatable(item.transform.rotation),
          scale: buildAnimatable(item.transform.scale),
          anchor: buildAnimatable(item.transform.anchor),
        } : undefined,
        startOpacity: item.startOpacity,
        endOpacity: item.endOpacity,
        order: item.order,
      };
    }
    // trim / pathOp / fill / stroke pass through mostly as-is - their
    // own real per-frame resolve() calls already live inside
    // shapeLayer.js (batch 6/7), so animatable fields (trim start/end/
    // offset, fill/stroke opacity/width/color) work automatically.
    const out = { ...item };
    if (item.type === 'trim') {
      out.start = buildAnimatable(item.start);
      out.end = buildAnimatable(item.end);
      out.offset = buildAnimatable(item.offset);
    } else if (item.type === 'fill' || item.type === 'stroke') {
      if (item.opacity !== undefined) out.opacity = buildAnimatable(item.opacity);
      if (item.type === 'stroke' && item.width !== undefined) out.width = buildAnimatable(item.width);
    }
    return out;
  });
}

// ---------------------------------------------------------------------
// Text selectors + animators (batch 4/5)
// ---------------------------------------------------------------------

function buildSelectorFn(selectorDef) {
  if (selectorDef.type === 'wiggly') {
    return wigglySelector({
      frequency: selectorDef.frequency, seed: selectorDef.seed, correlation: selectorDef.correlation, minAmount: selectorDef.minAmount, maxAmount: selectorDef.maxAmount,
    });
  }
  // 'range' (default)
  return rangeSelector({
    start: buildAnimatable(selectorDef.start ?? 0),
    end: buildAnimatable(selectorDef.end ?? 100),
    offset: buildAnimatable(selectorDef.offset ?? 0),
    shape: selectorDef.shape,
    smoothness: selectorDef.smoothness,
    basedOn: selectorDef.basedOn,
    amount: buildAnimatable(selectorDef.amount ?? 1),
    randomizeOrder: selectorDef.randomizeOrder,
    randomSeed: selectorDef.randomSeed,
  });
}

/** Reveal animators reuse the SAME "1 - sweep" inversion convention every prior batch's own demos used (strength 1 = the property delta fully applied = hidden/offset; strength 0 = landed) - `invert:true` (default for a single range selector driving opacity/position, the overwhelmingly common "reveal" case) applies that inversion; set false for an effect that should ADD as the selector sweeps forward instead of reveal. */
function buildAnimator(animatorDef) {
  const selectorFn = buildSelectorFn(animatorDef.selector);
  const invert = animatorDef.invert !== undefined ? animatorDef.invert : true;
  return {
    selector: invert ? (unit) => 1 - selectorFn(unit) : selectorFn,
    properties: animatorDef.properties || {},
  };
}

// ---------------------------------------------------------------------
// Effects dispatch (batches 4/8/9) - two real families: functions that
// mutate an ImageData in place, and functions that take/return a whole
// canvas (distort warps, layer styles) - dispatched separately since
// their real signatures genuinely differ, not unified artificially.
// ---------------------------------------------------------------------

const IMAGE_DATA_EFFECTS = {
  gaussianBlur, boxBlur, directionalBlur, radialBlur,
  curves: applyCurves, hueSaturation: applyHueSaturation, colorBalance: applyColorBalance, levels: applyLevels,
  addGrain, addNoise,
  rgbShift, blockDisplace, scanLines, pixelSort,
  findEdges, emboss, posterize, mosaic, autoGlow,
};

const CANVAS_EFFECTS = {
  twirl, bulge, rippleWarp, waveWarp,
  dropShadow: applyDropShadow, outerGlow: applyOuterGlow, innerGlow: applyInnerGlow, innerShadow: applyInnerShadow, layerStroke: applyStroke,
};

function buildGenerateCanvas(generateDef, width, height) {
  const p = generateDef.params || {};
  switch (generateDef.kind) {
    case 'gradientRamp': return gradientRamp(width, height, p);
    case 'checkerboard': return checkerboard(width, height, p);
    case 'grid': return grid(width, height, p);
    case 'lensFlare': return lensFlare(width, height, p);
    case 'fractalNoise': return fractalNoise(width, height, p);
    default: throw new Error(`sceneBuilder: unknown generate kind "${generateDef.kind}"`);
  }
}

/** Applies one effect to `canvas` at time t, returning the (possibly new) resulting canvas. */
// blur/offsetX/offsetY are authored in LOGICAL content pixels, but when
// withEffects (below) rasterizes its buffer at a higher PHYSICAL
// resolution than that logical footprint (its own superSample factor),
// those params need to grow by the same factor or the glow/shadow reads
// as thinner and closer than authored, relative to the now-bigger
// buffer. Scoped to exactly the two types computeEffectsPadding already
// treats as "spreads past the content's own edges" - every other effect
// type's params were already correct at 1x and are left untouched.
function scaleEffectParamsForSuperSample(effectType, params, scaleFactor) {
  if (scaleFactor === 1 || (effectType !== 'outerGlow' && effectType !== 'dropShadow')) return params;
  const scaled = { ...params };
  if (typeof scaled.blur === 'number') scaled.blur *= scaleFactor;
  if (typeof scaled.offsetX === 'number') scaled.offsetX *= scaleFactor;
  if (typeof scaled.offsetY === 'number') scaled.offsetY *= scaleFactor;
  return scaled;
}

function applyEffectToCanvas(canvas, effectDef, t, scaleFactor = 1) {
  const params = scaleEffectParamsForSuperSample(effectDef.type, resolveParamsAtTime(effectDef.params, t), scaleFactor);
  if (effectDef.type in IMAGE_DATA_EFFECTS) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    IMAGE_DATA_EFFECTS[effectDef.type](imgData, params);
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }
  if (effectDef.type === 'displacementMap') {
    const mapCanvas = params.map ? buildGenerateCanvas(params.map, canvas.width, canvas.height) : fractalNoise(canvas.width, canvas.height, { seed: 1 });
    return displacementMap(canvas, mapCanvas, params);
  }
  if (effectDef.type in CANVAS_EFFECTS) {
    return CANVAS_EFFECTS[effectDef.type](canvas, params);
  }
  throw new Error(`sceneBuilder: unknown effect type "${effectDef.type}"`);
}

function applyEffectsToCanvas(canvas, effectsDef, t, scaleFactor = 1) {
  let current = canvas;
  for (const effectDef of effectsDef || []) current = applyEffectToCanvas(current, effectDef, t, scaleFactor);
  return current;
}

// ---------------------------------------------------------------------
// Layer content builders - one per schema layer `type`, each returning
// a (ctx, t) => void draw function operating in the layer's own LOCAL
// space (its own transform is applied by the Node wrapper).
// ---------------------------------------------------------------------

function buildShapeDraw(layerDef) {
  const contents = buildShapeContents(layerDef.contents);
  return (ctx, t) => renderContents(ctx, contents, t);
}

/**
 * Real bug found via live frame inspection: the old hardcoded
 * `maxWidth: layerDef.maxWidth || 900` fallback is WIDER than the
 * entire 540px-wide comp, so any text layer that omits "maxWidth"
 * (common - the prompt lists it as optional with no stated default)
 * never wraps and gets centered as one long unbroken line, overflowing
 * off BOTH edges of the frame. Confirmed directly: a real generated
 * "THE OCEAN IS LYING TO YOU." headline with no "maxWidth" rendered
 * with only "LYING TO YOU" visible, the rest pushed off-frame. The
 * fallback now derives from the actual comp width instead of a
 * disconnected constant, leaving a 30px margin each side (540-60=480,
 * matching what real generations that DO set it explicitly tend to
 * use) so omitting "maxWidth" is always safe by construction.
 */
/** A highlight chip's selector is used AS-IS (no reveal "1-strength" inversion, unlike buildAnimator) - a chip is a static call-out, not a per-character entrance sweep, so strength 1 = "shown" is already the intuitive default a JSON author would expect from a plain start/end range. */
function buildHighlight(highlightDef) {
  return {
    selector: buildSelectorFn(highlightDef.selector),
    color: highlightDef.color,
    gradient: highlightDef.gradient,
    paddingX: highlightDef.paddingX,
    paddingY: highlightDef.paddingY,
    cornerRadius: highlightDef.cornerRadius,
    // Real, confirmed bug found via a production render (2026-09-03):
    // this whitelist silently dropped appearAt/fadeInDuration (the
    // real-audio-synced reveal-timing fields sceneSchema.js's
    // ensureHighlightChip and narrationPrefetch.js's
    // applyRealWordTimingToText set on every highlight) - the chip
    // rendered fully opaque for the WHOLE beat regardless, showing as a
    // floating colored box with no text under it whenever its word
    // landed late in the sentence. drawHighlights (textAnimator.js)
    // defaults both to safe values when absent, so passing them through
    // here is the only change needed.
    appearAt: highlightDef.appearAt,
    fadeInDuration: highlightDef.fadeInDuration,
  };
}

function buildTextDraw(layerDef, beatContext) {
  const animators = (layerDef.animators || []).map(buildAnimator);
  const highlights = (layerDef.highlights || []).map(buildHighlight);
  const textOpts = {
    fontFamily: layerDef.fontFamily || 'sans-serif',
    fontWeight: layerDef.fontWeight || '700',
    fontSize: layerDef.fontSize || 48,
    lineHeight: layerDef.lineHeight || (layerDef.fontSize || 48) * 1.15,
    fillStyle: layerDef.fillStyle || '#ffffff',
    textAlign: layerDef.textAlign || 'center',
    animators,
    highlights,
  };
  if (layerDef.onPath) {
    return (ctx, t) => renderAnimatedTextOnPath(ctx, layerDef.text, layerDef.onPath.anchors, t, {
      ...textOpts,
      firstMargin: layerDef.onPath.firstMargin,
      lastMargin: layerDef.onPath.lastMargin,
      reversePath: layerDef.onPath.reversePath,
      perpendicularToPath: layerDef.onPath.perpendicularToPath,
      forceAlignment: layerDef.onPath.forceAlignment,
    });
  }
  // Scoped to THIS closure (one beat, one text layer) so the cache
  // naturally starts fresh for every new beat - see renderAnimatedText's
  // own doc comment for why this is safe and what it skips.
  const layoutCache = { key: null, result: null };
  return (ctx, t) => renderAnimatedText(ctx, layerDef.text, t, {
    ...textOpts,
    maxWidth: layerDef.maxWidth || Math.max(100, beatContext.width - 60),
    centerX: layerDef.centerX || 0,
    layoutCache,
    centerY: layerDef.centerY || 0,
  });
}

/** `w`/`h` are the CALLER's already-resolved size (layerDef.width/height falling back to beatContext's, exactly like every other builder here) - NOT re-derived from layerDef alone, which would silently pass `undefined` into buildGenerateCanvas -> createCanvas for any generate layer that omits explicit width/height (the common case for a full-frame background). Real bug found via direct smoke-test crash, not assumed. */
function buildGenerateDraw(layerDef, w, h) {
  let cached = null;
  return (ctx) => {
    if (!cached) cached = buildGenerateCanvas(layerDef.generate, w, h);
    ctx.drawImage(cached, 0, 0);
  };
}

/**
 * Real, severe bug found via direct user report + local reproduction
 * (2026-09-03): "the icons are not appearing... the watermark is so
 * faint that it's barely noticeable." Root cause: this drew from local
 * (0,0) extending only right/down - the layer's own TOP-LEFT corner
 * lands at "position", not its center. EVERY other layer type in this
 * engine (text, shape) draws its content CENTERED on local (0,0), and
 * the prompt/schema's entire documented contract - "position is ALWAYS
 * the layer's own center" (scenePrompts.js's TextLayer docs; every
 * collision/bounding-box helper in sceneSchema.js computes
 * left/right/top/bottom as position +/- width/2,height/2) - assumes
 * this universally. "image" was the one silent exception, and every
 * piece of code that ever placed an icon (transformIconIntoWatermark's
 * whole anchor system included) was computing a CENTER position that
 * this function then treated as a TOP-LEFT corner - for a 240px
 * watermark, a real 120px silent offset, enough to push the "visible"
 * remainder down/right until only a tiny corner sliver survived
 * on-canvas. Confirmed directly: a local repro render with this exact
 * bug showed nothing but a sliver at the frame edge; adding an explicit
 * center anchor (or, as fixed here, drawing centered by default the
 * same way text/shape already do) made the SAME icon render correctly
 * sized and positioned. Fixed at the source instead of patching every
 * icon-placement call site - draws from (-w/2,-h/2) so "position" means
 * the same thing for an image layer as it already does for everything
 * else in this engine.
 */
function buildImageDraw(layerDef, beatContext) {
  const srcPath = layerDef.src === 'beatImage' ? beatContext.imagePath : layerDef.src;
  return (ctx) => {
    if (!srcPath || !beatContext.loadedImages.has(srcPath)) return;
    const img = beatContext.loadedImages.get(srcPath);
    const w = layerDef.width || img.width;
    const h = layerDef.height || img.height;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  };
}

/** Recursively collects every `type:'image'` layer def reachable from a beat's visual - background, top-level layers, and any precomp nesting. */
function collectImageLayerDefs(visual) {
  const out = [];
  function walk(layerDef) {
    if (!layerDef) return;
    if (layerDef.type === 'image') out.push(layerDef);
    if (layerDef.type === 'precomp' && Array.isArray(layerDef.layers)) layerDef.layers.forEach(walk);
  }
  if (visual.background) walk(visual.background);
  (visual.layers || []).forEach(walk);
  return out;
}

/**
 * Pre-loads every image layer's source file for one beat, BEFORE
 * buildBeatVisual runs. buildImageDraw's own draw closure is
 * synchronous (called once per rendered frame), so the actual file I/O
 * has to happen up front, once per beat - matching this file's own
 * "build once per beat, not per frame" design boundary already stated
 * at the top of this file, not a new one invented just for images.
 *
 * Load failures are treated as routine (a beat with no imagePath yet,
 * or a bad path) and silently skipped, exactly mirroring
 * imagePrefetch.js's own "fetch failure just means no image, renderer
 * falls back" philosophy - buildImageDraw already no-ops for any src
 * missing from the returned map, so a failed load here simply results
 * in that layer drawing nothing rather than crashing the render.
 */
async function loadBeatImages(visual, beatContext) {
  const loadedImages = new Map();
  const srcs = new Set();
  for (const layerDef of collectImageLayerDefs(visual)) {
    const srcPath = layerDef.src === 'beatImage' ? beatContext.imagePath : layerDef.src;
    if (srcPath) srcs.add(srcPath);
  }
  await Promise.all([...srcs].map(async (srcPath) => {
    try {
      loadedImages.set(srcPath, await loadImage(srcPath));
    } catch (e) {
      // routine - see doc comment above
    }
  }));
  return loadedImages;
}

/** Wraps any raw draw function with this layer's own effects stack (if any) - renders to an offscreen buffer sized to the layer's own content bounds, applies effects in order, draws the result. A layer with no effects skips the extra buffer entirely (drawn directly), so this costs nothing for the common case. */
/**
 * `centered` must be true for "shape"/"text"/"image" layers and
 * false/omitted only for "generate" - it's NOT a style choice, it has
 * to match where each layer type actually draws its content. Real,
 * severe bug found via live frame inspection: the buffer this function
 * creates for effects processing is a PLAIN canvas whose own origin is
 * its top-left corner, but "shape"/"text" content is drawn CENTERED on
 * local (0,0) (the whole engine's established convention - see
 * matrix2d.js/sceneSchema.js's anchor docs), spanning NEGATIVE as well
 * as positive local coordinates. Canvas pixels don't exist at negative
 * indices, so without `centered`, anything drawn left-of/above local
 * origin was silently clipped - confirmed directly: a real generated
 * "Giant isopods grow up to 2.5 feet long" caption with a "dropShadow"
 * effect rendered with ONLY "t long" visible, the rest clipped off by
 * exactly this. `centered` recenters the buffer's own origin to its
 * middle (and draws it back offset by the same amount) so
 * negative-coordinate content has somewhere real to land - exactly
 * matching how the SAME layer already rendered correctly whenever it
 * had no effects at all (and therefore no buffer indirection to get
 * this wrong).
 *
 * "image" used to be top-left-anchored too (grouped with "generate"
 * here) - a SEPARATE, much worse bug fixed the same day this comment
 * was updated: buildImageDraw's own top-left `drawImage(img,0,0,w,h)`
 * meant "position" never actually meant this layer's CENTER for an
 * image the way it does for literally everything else in this engine
 * (every collision/bounding-box helper in sceneSchema.js, every real
 * icon-placement function) - real, live-confirmed user report ("the
 * icons are not appearing... barely noticeable") traced to a 240px
 * watermark icon rendering with only a tiny corner sliver on-canvas,
 * the rest silently shifted off-frame by its own half-size. Fixed at
 * buildImageDraw itself (now draws from (-w/2,-h/2), matching
 * shape/text's own convention) - this file's own `centered:true` now
 * has to move in lockstep for "image" too, for the exact same clipping
 * reason described above, or a shadowed/blurred icon would clip in half
 * even though a plain one renders correctly. "generate" is the one
 * remaining real exception - its own content still fills [0,w]x[0,h]
 * exactly as before, untouched by this fix.
 */
// Memory note: this closure runs once per motion-blur SAMPLE (4, by
// default) for every single output frame that layer appears in - with
// dropShadow now attached to essentially every dominant headline
// (autoRepairBeat's own dropShadow-on-dominant-text rule), a fresh
// `createCanvas` here on every call was another real multiplier
// against the same <75MB target layerStack.js's own pooling fix
// targets. The buffer is instead created ONCE when withEffects itself
// is called (build time, once per layer - see buildOneBeat's own "once
// per beat, not per frame" note) and reused across every later call to
// this same closure; safe because rendering is single-threaded and
// strictly sequential (never two overlapping calls to the same
// closure), and `resetTransform` before each use means a leftover
// translate from a PRIOR call can never bleed into the next one.
// Real, confirmed-live bug found via direct frame inspection (2026-09-05,
// mograph glow work): outerGlow/dropShadow are BOTH meant to extend
// visibly beyond the raw content's own edges (that's the entire point -
// a halo or an offset shadow), but the buffer canvas below used to be
// sized to EXACTLY contentWidth x contentHeight, giving the blur no
// room to spread into. Confirmed directly: a small icon (a few dozen
// px) with a 22px-blur outerGlow rendered with a hard, visibly
// RECTANGULAR cutoff exactly at the icon's own bounding box, instead of
// a soft halo - the blur kernel had nowhere to expand, so it just got
// clipped at the canvas edge. innerGlow/innerShadow are NOT affected
// (they mask the blurred result back inside the ORIGINAL shape by
// design - see layerStyles.js's own doc comment - so they never needed
// to extend past the raw bounds in the first place).
//
// Real, direct performance finding (2026-09-10, CPU-profiled a real
// chunk render after a user report of slow renders): this padding
// drives the buffer size for EVERY effect-bearing layer, and a v8
// --prof profile of a real render showed drawImage (63% of samples) and
// silhouette's own per-pixel recolor loop (a further 8%+) as the
// dominant frame cost - both scale directly with this buffer's AREA,
// and outerGlow's blur routinely reaches 40-75px in this app's own
// heaviest templates, so the padding multiplier below is a direct,
// compounding cost driver. `ctx.filter = blur(Npx)` is a real CSS-spec
// Gaussian blur (stdDeviation = radius/2, per the Filter Effects spec -
// this engine's own choice, see blurCanvas above) - at 2.5x the blur
// radius (5 standard deviations), well over 99.9999% of the
// distribution's mass is already contained; the padding was multiplying
// well past the point of any visible difference. Tightened to 1.8x
// (3.6 sigma, ~99.97% contained - still a real safety margin beyond the
// point everything is visually imperceptible, not a bare-minimum cut)
// - verified directly with a before/after frame render of the heaviest
// case in the app (nodeCluster's hero, blur:75): a pixel-diff of the two
// PNGs showed max per-pixel channel difference of 39/765 and an average
// of 1.78/765 - antialiasing-level noise, not visible clipping. Shrinks
// the padded buffer's area by roughly 40% for that case (a
// proportionally smaller win for lighter blurs), which directly reduces
// both the drawImage and silhouette costs measured above, and the
// buffer's own memory footprint alongside it.
function computeEffectsPadding(effects) {
  let pad = 0;
  for (const e of effects || []) {
    if (!e || (e.type !== 'outerGlow' && e.type !== 'dropShadow')) continue;
    const params = e.params || {};
    const blur = typeof params.blur === 'number' ? params.blur : 0;
    const offset = Math.max(Math.abs(params.offsetX) || 0, Math.abs(params.offsetY) || 0);
    pad = Math.max(pad, blur * 1.8 + offset);
  }
  return Math.ceil(pad);
}

// A layer's own "scale" track (raw JSON at this point, not yet an
// animatable) can grow it well past 1x by the time it's on screen - up
// to ~4x for a mograph "hero" (nodeCluster/mergeCluster's chosen icon).
// Mirrors iconFetch.js's own getMaxScaleFactor (same reasoning, same
// shape of track to walk) rather than importing it - this file is kept
// deliberately dependency-free from the icon-prefetch step, and the two
// already-duplicated helpers only need to agree on behavior, not share code.
function getLayerMaxScaleFactor(layerDef) {
  const track = layerDef && layerDef.scale;
  if (!track) return 1;
  if (Array.isArray(track)) return Math.max(1, ...track.filter((v) => typeof v === 'number'));
  if (typeof track !== 'object') return 1;
  if (Array.isArray(track.keyframes)) {
    let max = 1;
    for (const kf of track.keyframes) {
      if (!kf) continue;
      if (Array.isArray(kf.value)) max = Math.max(max, ...kf.value.filter((v) => typeof v === 'number'));
      else if (typeof kf.value === 'number') max = Math.max(max, kf.value);
    }
    return max;
  }
  if (typeof track.expression === 'string') return getLayerMaxScaleFactor({ scale: track.base }) * 1.15;
  return 1;
}

function withEffects(rawDraw, layerDef, contentWidth, contentHeight, centered = false) {
  if (!layerDef.effects || layerDef.effects.length === 0) return rawDraw;
  const pad = computeEffectsPadding(layerDef.effects);
  const bufferW = contentWidth + pad * 2;
  const bufferH = contentHeight + pad * 2;
  // Real, confirmed-live bug (2026-09-09, direct user report the whole
  // video looked "trash", traced via a lossless-PNG frame extraction of
  // nodeCluster's own hero icon - ruled out ffmpeg's own JPEG compression
  // as the cause FIRST, before concluding this was a real engine bug).
  // node.js's Node.render() applies this layer's full world transform
  // (including its own "scale" track) via ctx.setTransform BEFORE calling
  // this draw closure - so a hero icon growing to ~4x was being drawn
  // into this buffer at its small BASE (1x) physical resolution, then
  // that already-low-res buffer got stretched ~4x by the OUTER transform,
  // producing visibly blocky/aliased edges no matter how high-res the
  // source icon bitmap was (iconFetch.js's own getMaxScaleFactor fix
  // already fetches a high-res source PNG for exactly this case - all of
  // that extra detail was being thrown away right here, at this buffer,
  // before the outer scale-up ever got a chance to use it). Fixed by
  // rasterizing this buffer at a higher PHYSICAL resolution when the
  // layer's own scale track grows large, then letting the final
  // drawImage's explicit destination size (still the original LOGICAL
  // bufferW/bufferH) downsample it back before the outer transform
  // scales it back up - the same "supersample before a big scale-up"
  // idea iconFetch.js already applies to the source PNG, carried through
  // this buffer too. Capped at 2x (a 4x buffer-AREA/frame-cost increase,
  // not the 16x a full 4x cap would cost) and only triggered above 1.5x
  // scale, since most layers never grow large enough for this to matter
  // and this buffer's own per-frame blur/composite cost scales directly
  // with its area (see computeEffectsPadding's own cost comment above).
  const maxScale = getLayerMaxScaleFactor(layerDef);
  const superSample = maxScale > 1.5 ? Math.min(2, maxScale) : 1;
  const physicalW = Math.round(bufferW * superSample);
  const physicalH = Math.round(bufferH * superSample);
  if (!centered) {
    const buffer = createCanvas(physicalW, physicalH);
    const bufferCtx = buffer.getContext('2d');
    return (ctx, t) => {
      bufferCtx.resetTransform();
      bufferCtx.clearRect(0, 0, physicalW, physicalH);
      bufferCtx.scale(superSample, superSample);
      bufferCtx.translate(pad, pad);
      rawDraw(bufferCtx, t);
      // Real, confirmed-live engine bug (2026-09-11, found building the
      // tripleStack template, backend/sceneSchema.js): @napi-rs/canvas's
      // getImageData/putImageData do NOT ignore the context's current
      // transform the way the Canvas 2D spec requires (both are meant to
      // operate purely in device-pixel space regardless of any active
      // scale/translate) - with the translate(pad, pad) above still
      // active, IMAGE_DATA_EFFECTS (blurEffects.js's gaussianBlur/
      // boxBlur, called via applyEffectsToCanvas just below) read and/or
      // write pixels at a transform-shifted offset, producing a second,
      // fainter, blurred GHOST DUPLICATE of the layer's own content
      // elsewhere in the buffer. Root-caused via direct before/after-
      // effect buffer dumps (a clean single copy right after rawDraw,
      // the duplicate only appears once applyEffectsToCanvas has run),
      // then confirmed the SAME duplicate is completely ABSENT when
      // blurEffects.js's own convolution math is exercised on a
      // synthetic ImageData with no real canvas/transform involved at
      // all - isolating the bug to this transform-vs-pixel-readback
      // interaction specifically, not this project's own blur math (both
      // gaussianBlur and boxBlur reproduced it identically, ruling out
      // buildGaussianKernel too). Resetting the transform right here,
      // AFTER drawing but BEFORE any IMAGE_DATA_EFFECT touches the
      // buffer, sidesteps the library bug entirely - the drawImage below
      // doesn't depend on this buffer's own leftover transform state
      // anyway. Also fixes the sibling `centered` branch just below,
      // same bug, same reasoning.
      bufferCtx.resetTransform();
      const finalCanvas = applyEffectsToCanvas(buffer, layerDef.effects, t, superSample);
      ctx.drawImage(finalCanvas, -pad, -pad, bufferW, bufferH);
    };
  }
  const offsetX = contentWidth / 2 + pad;
  const offsetY = contentHeight / 2 + pad;
  const buffer = createCanvas(physicalW, physicalH);
  const bufferCtx = buffer.getContext('2d');
  return (ctx, t) => {
    bufferCtx.resetTransform();
    bufferCtx.clearRect(0, 0, physicalW, physicalH);
    bufferCtx.scale(superSample, superSample);
    bufferCtx.translate(offsetX, offsetY);
    rawDraw(bufferCtx, t);
    // See the sibling !centered branch above for the full writeup - same
    // real @napi-rs/canvas getImageData/putImageData-vs-transform bug,
    // same fix (reset before any effect ever touches this buffer).
    bufferCtx.resetTransform();
    const finalCanvas = applyEffectsToCanvas(buffer, layerDef.effects, t, superSample);
    ctx.drawImage(finalCanvas, -offsetX, -offsetY, bufferW, bufferH);
  };
}

// ---------------------------------------------------------------------
// Node construction - the common transform + dispatch layer
// ---------------------------------------------------------------------

function commonNodeOpts(layerDef) {
  return {
    position: buildAnimatable(layerDef.position ?? [0, 0]),
    rotation: buildAnimatable(layerDef.rotation ?? 0),
    scale: buildAnimatable(layerDef.scale ?? [1, 1]),
    anchor: buildAnimatable(layerDef.anchor ?? [0, 0]),
    opacity: buildAnimatable(layerDef.opacity ?? 1),
    blendMode: layerDef.blendMode,
    isAdjustmentLayer: !!layerDef.isAdjustmentLayer,
    effects: layerDef.isAdjustmentLayer ? (layerDef.effects || []).map((e) => (imgData, t) => {
      IMAGE_DATA_EFFECTS[e.type]?.(imgData, resolveParamsAtTime(e.params, t));
    }) : [],
    name: layerDef.id,
  };
}

/**
 * `w`/`h` fall back to the loaded image's own natural size for an
 * "image" layer that omits explicit width/height, instead of the full
 * frame - a real, measured performance fix, not a style choice.
 * Confirmed via direct profiling of a real generated beat: an "image"
 * layer with 3 effects (outerGlow/gaussianBlur/rgbShift) and no
 * explicit width/height cost 1768ms/frame - by far the single most
 * expensive layer in that beat (the next slowest was 393ms/frame) -
 * because withEffects' buffer was silently sized at the FULL 540x960
 * frame (518,400px) via the old `layerDef.width || beatContext.width`
 * fallback, regardless of the actual image's real size, and every one
 * of those effects (each doing real per-pixel work, blur passes
 * especially) paid for processing that entire oversized buffer. The
 * loaded image's own dimensions are already known at this point
 * (loadBeatImages already resolved and cached them) and are almost
 * always meaningfully smaller than the full frame, so this is a real,
 * broadly-applicable win, not a narrow special case.
 */
function resolveImageNaturalSize(layerDef, beatContext) {
  const srcPath = layerDef.src === 'beatImage' ? beatContext.imagePath : layerDef.src;
  const img = srcPath && beatContext.loadedImages && beatContext.loadedImages.get(srcPath);
  return img ? { width: img.width, height: img.height } : null;
}

/** Builds a 2D layer (Node or ShapeLayer). */
function build2DLayer(layerDef, beatContext, idMap) {
  let node;
  const imageNaturalSize = layerDef.type === 'image' && (!layerDef.width || !layerDef.height)
    ? resolveImageNaturalSize(layerDef, beatContext) : null;
  const w = layerDef.width || (imageNaturalSize && imageNaturalSize.width) || beatContext.width;
  const h = layerDef.height || (imageNaturalSize && imageNaturalSize.height) || beatContext.height;

  if (layerDef.type === 'shape') {
    const rawContents = buildShapeContents(layerDef.contents);
    node = new Node({
      ...commonNodeOpts(layerDef),
      draw: withEffects((ctx, t) => renderContents(ctx, rawContents, t), layerDef, w, h, true),
    });
  } else if (layerDef.type === 'text') {
    node = new Node({ ...commonNodeOpts(layerDef), draw: withEffects(buildTextDraw(layerDef, beatContext), layerDef, w, h, true) });
  } else if (layerDef.type === 'generate') {
    node = new Node({ ...commonNodeOpts(layerDef), draw: withEffects(buildGenerateDraw(layerDef, w, h), layerDef, w, h) });
  } else if (layerDef.type === 'image') {
    // centered:true (was omitted/false) - buildImageDraw now draws
    // centered on local (0,0) too (see its own doc comment for the real
    // bug this fixes), so its effects buffer needs the SAME recentering
    // offset text/shape already get - otherwise an image layer that
    // also has "effects" would have its now-centered content clipped by
    // a buffer still sized for the OLD top-left-anchored assumption.
    node = new Node({ ...commonNodeOpts(layerDef), draw: withEffects(buildImageDraw(layerDef, beatContext), layerDef, w, h, true) });
  } else if (layerDef.type === 'precomp') {
    const childNodes = layerDef.layers.map((l) => build2DLayer(l, beatContext, idMap));
    const inner = new Composition({
      width: w, height: h, duration: beatContext.duration, children: childNodes,
    });
    node = new PrecompNode({ ...commonNodeOpts(layerDef), composition: inner, isolate: layerDef.isolate !== false });
  } else {
    // 'null' - a pure transform, no content
    node = new Node(commonNodeOpts(layerDef));
  }

  if (layerDef.id) idMap.set(layerDef.id, node);
  return node;
}

function wireTrackMattesAndParents(layerDefs, idMap) {
  for (const layerDef of layerDefs) {
    const node = idMap.get(layerDef.id);
    if (!node) continue;
    if (layerDef.parent && idMap.has(layerDef.parent)) idMap.get(layerDef.parent).addChild(node);
    if (layerDef.trackMatte && idMap.has(layerDef.trackMatte.source)) {
      node.trackMatte = { source: idMap.get(layerDef.trackMatte.source), type: layerDef.trackMatte.type };
    }
    if (layerDef.type === 'precomp') wireTrackMattesAndParents(layerDef.layers, idMap);
  }
}

// Real, confirmed bug found via local render (2026-09-04): the
// typewriter cursor's position track is built by sceneSchema.js's
// buildCharacterCursorTrack, which has to ESTIMATE where line breaks
// land (fontSize * 0.62 per character) because sceneSchema.js
// deliberately has no real canvas/font access - it validates JSON
// structurally, long before rendering. That estimate can genuinely
// disagree with the real wrap decision (confirmed directly: "Your
// phone bill is a scam." was estimated to need 2 lines, the real
// renderer fits it on 1), which visibly misplaces the cursor - it hangs
// at the wrong line entirely, not just a few pixels off.
//
// This file DOES have real canvas/font access (that's the whole reason
// buildTextDraw calls the real layoutText, not an estimate) - so
// rather than trying to make the estimate more accurate (a losing
// game: any fixed per-character width is wrong for SOME font/string,
// and sceneSchema.js has no way to verify against real glyphs), this
// throws the estimated track away entirely and rebuilds it from
// layoutText's own real per-character positions, once per beat, right
// before the layers it depends on get built.
function recomputeTypewriterCursorTrack(layers, beatContext) {
  if (!Array.isArray(layers)) return;
  const textLayer = layers.find((l) => l && l.id === '__typewriter_text__');
  const cursor = layers.find((l) => l && l.id === '__typewriter_cursor__');
  if (!textLayer || !cursor || typeof textLayer.text !== 'string') return;
  if (!cursor.position || !Array.isArray(cursor.position.keyframes) || cursor.position.keyframes.length === 0) return;
  const reveal = Array.isArray(textLayer.animators)
    ? textLayer.animators.find((a) => a && a.selector && a.selector.basedOn === 'characters' && a.selector.end && Array.isArray(a.selector.end.keyframes))
    : null;
  if (!reveal) return;

  const textPos = Array.isArray(textLayer.position) ? textLayer.position
    : (textLayer.position && Array.isArray(textLayer.position.keyframes) && textLayer.position.keyframes.length > 0
      ? textLayer.position.keyframes[textLayer.position.keyframes.length - 1].value
      : null);
  if (!Array.isArray(textPos)) return;

  const rawText = textLayer.text.trim();
  if (rawText.length === 0) return;
  const fontSize = textLayer.fontSize || 48;
  const canvas = createCanvas(8, 8);
  const ctx = canvas.getContext('2d');
  ctx.font = `${textLayer.fontWeight || '700'} ${fontSize}px ${textLayer.fontFamily || 'sans-serif'}`;
  const { chars } = layoutText(ctx, rawText, {
    fontFamily: textLayer.fontFamily || 'sans-serif',
    fontWeight: textLayer.fontWeight || '700',
    fontSize,
    lineHeight: textLayer.lineHeight || fontSize * 1.15,
    maxWidth: textLayer.maxWidth || Math.max(100, beatContext.width - 60),
    centerX: 0,
    centerY: 0,
    textAlign: textLayer.textAlign || 'center',
  });
  if (chars.length === 0) return;

  // Real, confirmed SECOND bug found verifying the position fix above:
  // the cursor's own keyframe TIMES (not just positions) were already
  // wrong before this function ever ran - ensureTypewriterReveal builds
  // them as `(i+1)/chars_RAW * totalTypeDuration` where chars_RAW
  // COUNTS SPACES, but `i` only ever iterates the non-space track (a
  // space advances the estimated cursorX but gets no entry of its own)
  // - so the cursor's last keyframe lands at
  // `nonSpaceCount/chars_RAW * totalTypeDuration`, well BEFORE
  // totalTypeDuration itself whenever the line has any spaces (every
  // real sentence). Confirmed directly: the cursor visibly finished
  // moving - and sat AHEAD of the actually-revealed text - before
  // typing was really done. The reveal's own keyframes (read off
  // `reveal` above) are the correct, authoritative time grid - one
  // entry per RAW character including spaces - so this rebuilds the
  // cursor's keyframes to match that grid exactly, one keyframe per
  // raw character, reusing the last real (non-space) position on any
  // keyframe that lands on a space (nothing new to point at yet).
  const revealKfs = reveal.selector.end.keyframes;
  const newKfs = [{ time: 0, value: [textPos[0] + chars[0].x - chars[0].w / 2, textPos[1] + chars[0].y], interpolation: 'hold' }];
  let nonSpaceIdx = -1;
  let lastValue = newKfs[0].value;
  for (let i = 0; i < rawText.length; i++) {
    if (!/\s/.test(rawText[i])) {
      nonSpaceIdx += 1;
      const c = chars[Math.min(nonSpaceIdx, chars.length - 1)];
      // Right edge of the character just typed - matches the ORIGINAL
      // estimate's own convention (cursorX accumulated to sit AFTER
      // each typed character, not centered on it).
      lastValue = [textPos[0] + c.x + c.w / 2, textPos[1] + c.y];
    }
    const kfTime = i + 1 < revealKfs.length ? revealKfs[i + 1].time : revealKfs[revealKfs.length - 1].time;
    newKfs.push({ time: kfTime, value: lastValue, interpolation: 'hold' });
  }
  cursor.position.keyframes = newKfs;
}

// ---------------------------------------------------------------------
// Top-level: one beat's whole visual
// ---------------------------------------------------------------------

/**
 * Builds ONE beat's renderable scene: { render(ctx, localT) }. Chosen
 * once per beat (not per frame - the whole point of building objects
 * up front is that rendering a frame is just evaluating already-built
 * Properties/Nodes at a new t, not reconstructing anything).
 */
function buildBeatVisual(visual, beatContext) {
  const { width, height, duration } = beatContext;
  const idMap = new Map();
  recomputeTypewriterCursorTrack(visual.layers, beatContext);

  // Mutates visual.layers in place, expanding any layer.textAnimation
  // preset spec into real keyframes/animators (and auto-assigning a
  // default entrance to any text layer with no motion of its own at
  // all) BEFORE layers are built into Nodes/Properties below - see
  // textAnimationPresets.js's own doc comment for why this runs here,
  // at render time, rather than during generation-validation.
  applyTextAnimationPresets(visual, duration);

  // Real, confirmed-live bug found while building this engine's first
  // real use of layer parenting (a null/group object multiple children
  // attach to - textPopOut's own word-reveal-then-zoom-out template,
  // backend/sceneSchema.js): EVERY built node used to be pushed into
  // rootChildren here, including ones a LATER layerDef declares as a
  // child via "parent" - and Composition's own constructor
  // (composition.js) unconditionally calls root.addChild(c) on every one
  // of its own "children" argument, which (per Node.addChild's own
  // logic: "if (child.parent) child.parent.removeChild(child)") FORCIBLY
  // detaches a node from whatever parent it has and reattaches it to
  // root. So wireTrackMattesAndParents's own correct re-parenting, run
  // just before this, was immediately undone the moment `new
  // Composition` ran one line later - any child rendered as if it were
  // a top-level layer (only its own LOCAL position, no parent transform
  // composed in at all). Confirmed directly: a text layer authored with
  // local position [x, 0] under a parent positioned at [x, 520] rendered
  // at y=0 (the canvas's own top edge), not y=520 - Node.render() DOES
  // correctly climb the real parent chain via getWorldMatrix(), but only
  // for nodes that are ACTUALLY still attached to that parent by the
  // time rendering happens, which none of them were.
  //
  // Fixed by building every node and wiring parents FIRST, then
  // filtering to only the genuinely top-level ones (no resolvable
  // "parent") for Composition's own children list - a parented node
  // still exists and still renders, just via its real parent's own
  // recursive render(), never as a second, independent root-level copy.
  // Collected as {layerDef, node} pairs rather than re-looked-up via
  // idMap, because "id" is optional on a layer (only needed when
  // something else references it) - an id-less layer would silently
  // vanish from rootChildren if collection depended on idMap.get(id).
  const rootChildren = [];
  if (visual.background) rootChildren.push(build2DLayer({ ...visual.background, id: visual.background.id || '__background__' }, { ...beatContext, duration }, idMap));
  const builtLayers = visual.layers.map((layerDef) => ({ layerDef, node: build2DLayer(layerDef, { ...beatContext, duration }, idMap) }));
  wireTrackMattesAndParents(visual.layers, idMap);
  for (const { layerDef, node } of builtLayers) {
    if (layerDef.parent && idMap.has(layerDef.parent)) continue;
    rootChildren.push(node);
  }

  const composition = new Composition({
    width, height, duration, children: rootChildren,
  });
  return {
    render(ctx, t) {
      composition.render(ctx, t);
    },
  };
}

module.exports = {
  buildAnimatable, buildBeatVisual, applyEffectsToCanvas, buildGenerateCanvas, loadBeatImages,
};
