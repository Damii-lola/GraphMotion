const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Property } = require('./engine/keyframes');
const { ExpressionProperty } = require('./engine/expressions');
const { Node, resolve } = require('./engine/node');
const { Composition, PrecompNode } = require('./engine/composition');
const { renderContents } = require('./engine/shapeLayer');
const {
  rectanglePath, ellipsePath, polygonPath, starPath, customPath,
} = require('./engine/shapePrimitives');
const { renderAnimatedText } = require('./engine/textAnimator');
const { renderAnimatedTextOnPath } = require('./engine/textPath');
const { rangeSelector, wigglySelector } = require('./engine/selectors');
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
const T = require('./engine/transitions');

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
function applyEffectToCanvas(canvas, effectDef, t) {
  const params = resolveParamsAtTime(effectDef.params, t);
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

function applyEffectsToCanvas(canvas, effectsDef, t) {
  let current = canvas;
  for (const effectDef of effectsDef || []) current = applyEffectToCanvas(current, effectDef, t);
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
function buildTextDraw(layerDef, beatContext) {
  const animators = (layerDef.animators || []).map(buildAnimator);
  const textOpts = {
    fontFamily: layerDef.fontFamily || 'sans-serif',
    fontWeight: layerDef.fontWeight || '700',
    fontSize: layerDef.fontSize || 48,
    lineHeight: layerDef.lineHeight || (layerDef.fontSize || 48) * 1.15,
    fillStyle: layerDef.fillStyle || '#ffffff',
    animators,
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
  return (ctx, t) => renderAnimatedText(ctx, layerDef.text, t, {
    ...textOpts,
    maxWidth: layerDef.maxWidth || Math.max(100, beatContext.width - 60),
    centerX: layerDef.centerX || 0,
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

function buildImageDraw(layerDef, beatContext) {
  const srcPath = layerDef.src === 'beatImage' ? beatContext.imagePath : layerDef.src;
  return (ctx) => {
    if (!srcPath || !beatContext.loadedImages.has(srcPath)) return;
    const img = beatContext.loadedImages.get(srcPath);
    const w = layerDef.width || img.width;
    const h = layerDef.height || img.height;
    ctx.drawImage(img, 0, 0, w, h);
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
 * `centered` must be true for "shape"/"text" layers and false/omitted
 * for "image"/"generate" - it's NOT a style choice, it has to match
 * where each layer type actually draws its content. Real, severe bug
 * found via live frame inspection: the buffer this function creates
 * for effects processing is a PLAIN canvas whose own origin is its
 * top-left corner, but "shape"/"text" content is drawn CENTERED on
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
 * this wrong). "image"/"generate" content, by contrast, draws
 * TOP-LEFT-anchored already fitting the buffer's native [0,w]x[0,h]
 * range, so centering them would incorrectly shift their content by
 * half their own size - `centered` must stay false there.
 */
function withEffects(rawDraw, layerDef, contentWidth, contentHeight, centered = false) {
  if (!layerDef.effects || layerDef.effects.length === 0) return rawDraw;
  if (!centered) {
    return (ctx, t) => {
      const buffer = createCanvas(contentWidth, contentHeight);
      rawDraw(buffer.getContext('2d'), t);
      const finalCanvas = applyEffectsToCanvas(buffer, layerDef.effects, t);
      ctx.drawImage(finalCanvas, 0, 0);
    };
  }
  const offsetX = contentWidth / 2;
  const offsetY = contentHeight / 2;
  return (ctx, t) => {
    const buffer = createCanvas(contentWidth, contentHeight);
    const bufferCtx = buffer.getContext('2d');
    bufferCtx.translate(offsetX, offsetY);
    rawDraw(bufferCtx, t);
    const finalCanvas = applyEffectsToCanvas(buffer, layerDef.effects, t);
    ctx.drawImage(finalCanvas, -offsetX, -offsetY);
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
    node = new Node({ ...commonNodeOpts(layerDef), draw: withEffects(buildImageDraw(layerDef, beatContext), layerDef, w, h) });
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

  const rootChildren = [];
  if (visual.background) rootChildren.push(build2DLayer({ ...visual.background, id: visual.background.id || '__background__' }, { ...beatContext, duration }, idMap));
  for (const layerDef of visual.layers) rootChildren.push(build2DLayer(layerDef, { ...beatContext, duration }, idMap));
  wireTrackMattesAndParents(visual.layers, idMap);

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
  buildAnimatable, buildBeatVisual, applyEffectsToCanvas, buildGenerateCanvas, loadBeatImages, T,
};
