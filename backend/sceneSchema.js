const { EASING_REGISTRY } = require('./engine/easingCurves');
const { BLEND_MODE_MAP } = require('./engine/layerStack');
const { Property } = require('./engine/keyframes');

/**
 * The scene JSON schema: what Mistral generates, what sceneBuilder.js
 * interprets into real calls against the batch 1-11 engine. This
 * REPLACES the deleted sceneTemplates.js's fixed ~21-template
 * vocabulary with a real, general scene-graph description - the whole
 * point of tearing the old system down was "the AI directs a real
 * engine," not "the AI directs a bigger table of fixed templates."
 *
 * Top level (unchanged from before the teardown, so narrationPrefetch.js
 * and imagePrefetch.js need no rework):
 *   { scenes: [Beat, ...] }
 *
 * Beat (a sequential segment - "beats" is the established name
 * throughout the surviving pipeline: narrationPrefetch.js/
 * imagePrefetch.js/renderEngine.js's buildTimeline all already sum
 * `scene.params.duration` across `sceneJSON.scenes`):
 *   {
 *     params: {
 *       duration: number (seconds, required - narration overrides this
 *         with the real measured speech duration when present),
 *       narration: string (optional, spoken text - consumed by
 *         narrationPrefetch.js, unchanged),
 *       imagePrompt: string (optional - consumed by imagePrefetch.js,
 *         unchanged; imagePath is filled in by that same prefetch
 *         step, never authored directly),
 *     },
 *     visual: BeatVisual   <- THE NEW PART, replacing the old `template` string
 *   }
 *
 * BeatVisual:
 *   {
 *     background: LayerDef | null - an optional full-frame layer
 *       drawn first, before `layers` (typically a "generate" layer -
 *       gradient/fractal-noise/checkerboard - or a solid fill).
 *     layers: [LayerDef, ...] - stacking order matches AE: LATER
 *       entries in this array are DRAWN LATER, i.e. they render on TOP.
 *     transitionIn: TransitionDef | null - how this beat transitions
 *       IN from whatever the previous beat ended on (real transitions.js
 *       reuse, batch 11) - omit for a hard cut.
 *   }
 *
 * NOTE: this engine is deliberately 2D-only - there is no true 3D
 * rendering path (no camera, no lighting, no perspective-projected
 * layers). A previous 3D system (Layer3D/Camera/Light, real per-pixel
 * perspective warping) was removed entirely: it was measured to be the
 * dominant driver of both a severe memory problem (~580MB peak RSS on
 * a single 3D beat against a 100MB target) and a severe speed problem
 * (per-frame render time roughly 10x'ing during 3D beats). Any
 * "depth"/"perspective" look now comes from honest 2D approximations -
 * ordinary scale/skew/rotation tricks (see transitions.js's card3DFlip
 * for the canonical example: a card "closing" to edge-on via scaleX ->
 * 0, not real projection) - never a genuine camera/lighting model.
 *
 * AnimatableValue<T>: every transform/effect-parameter number or
 * vector in this schema accepts THREE forms, matching how every real
 * animatable field in the engine already works:
 *   - a plain value: `5` or `[100, 200]`
 *   - real keyframes: `{ keyframes: [ { time, value, interpolation,
 *     easing, easingParams, spatialOutTangent, spatialInTangent }, ... ] }`
 *     (interpolation: 'hold'|'linear'|'easing'|'bezier', easing: any
 *     real name from easingCurves.js's registry - see EASING_NAMES below)
 *   - an expression: `{ expression: "wiggle(2,20)", base: AnimatableValue<T> }`
 *     (real JS, evaluated via expressions.js's sandboxed vm - `time`
 *     and `value` are in scope, `value` being whatever `base` resolves
 *     to; omit `base` for an expression with no underlying keyframes)
 *
 * LayerDef:
 *   {
 *     id: string (required if referenced by another layer's `parent`
 *       or a trackMatte's `source`),
 *     type: 'shape' | 'text' | 'image' | 'precomp' | 'null' | 'generate',
 *
 *     position, rotation, scale, anchor, opacity: AnimatableValue<...> -
 *       the common transform every layer has (matches node.js's real
 *       Node fields)
 *
 *     blendMode: one of BLEND_MODE_NAMES below (a real Composition-level
 *       concept, batch 3)
 *     trackMatte: { source: <layerId>, type: 'alpha'|'alphaInverted'|
 *       'luma'|'lumaInverted' }
 *     isAdjustmentLayer: boolean - this layer's `effects` post-process
 *       the ENTIRE accumulator below it (batch 3's real mechanism),
 *       rather than only itself
 *     effects: [EffectDef, ...] - applied to THIS layer's own rendered
 *       content, in order, regardless of isAdjustmentLayer (a real,
 *       general per-layer effects stack - see EFFECT_TYPES below)
 *     parent: <layerId> - real Node parenting (batch 2)
 *     width, height: number - this layer's own content bounding size
 *       (required for shape/generate layers; text uses maxWidth
 *       instead; image defaults to the fetched image's natural size)
 *
 *     --- type:'shape' ---
 *     contents: [ShapeContentItem, ...] - mirrors shapeLayer.js's real
 *       stacking model EXACTLY (batch 6/7): items append to or replace
 *       a running current-paths list, top to bottom
 *
 *     --- type:'text' ---
 *     text, fontFamily, fontWeight, fontSize, lineHeight, maxWidth,
 *       fillStyle: real renderAnimatedText params (batch 4)
 *     animators: [ { selector: SelectorDef, properties: { opacity,
 *       position:[dx,dy], scale, rotation, color:'#rrggbb' } }, ... ] -
 *       real per-character animator stack (batch 4/5). "color" blends
 *       the running per-character fill toward this hex color by the
 *       selector's own strength (0=base fillStyle, 1=fully this color)
 *       - use a selector scoped to one word (basedOn:'words') to accent
 *       a single word a different color from the rest of the line.
 *     highlights: [ { selector: SelectorDef, color:'#rrggbb' |
 *       gradient:{from,to}, paddingX, paddingY, cornerRadius }, ... ] -
 *       a rounded-rect "marker" chip drawn BEHIND a run of selected
 *       characters (grouped per line, never spanning a line break).
 *       Selector strength is used directly (no reveal inversion) and
 *       also drives the chip's own opacity, so an animated start/end
 *       can fade the chip in/out. Static coverage (no keyframes) draws
 *       it fully opaque for the layer's whole duration.
 *     onPath: { anchors: [{point:[x,y], outTangent?, inTangent?}, ...],
 *       firstMargin, lastMargin, reversePath, perpendicularToPath,
 *       forceAlignment } - omit for straight-baseline text; present ->
 *       uses renderAnimatedTextOnPath instead (batch 5). NOTE: "highlights"
 *       is NOT supported on path text - only on straight-baseline text.
 *
 *     --- type:'image' ---
 *     src: 'beatImage' (resolves to this beat's own params.imagePath,
 *       the common case) | a direct local file path
 *
 *     --- type:'precomp' ---
 *     layers: [LayerDef, ...] (nested/recursive - a real sub-Composition,
 *       batch 2)
 *     isolate: boolean (default true - see composition.js's real
 *       isolate-vs-collapsed distinction)
 *
 *     --- type:'generate' ---
 *     generate: { kind: 'gradientRamp'|'checkerboard'|'grid'|
 *       'lensFlare'|'fractalNoise', params: {...real per-kind params
 *       from generateEffects.js/noiseEffects.js} }
 *
 *     --- type:'null' ---
 *     (no extra fields - a pure transform/parent, batch 2's real Null
 *     Object concept: "a Node with no draw function")
 *   }
 *
 * ShapeContentItem (batch 6/7's real shapeLayer.js contents model):
 *   { type:'path', shape: { kind:'rectangle'|'ellipse'|'polygon'|'star',
 *       params: {...real per-kind params from shapePrimitives.js} } }
 *   | { type:'trim', start, end, offset, multiple:'individually'|'simultaneously' }
 *   | { type:'repeater', copies, transform:{position,rotation,scale,anchor},
 *       startOpacity, endOpacity, order:'below'|'above' }
 *   | { type:'pathOp', mode:'add'|'subtract'|'intersect'|'exclude'|'merge' }
 *   | { type:'fill', color, opacity, fillRule:'nonzero'|'evenodd' }
 *   | { type:'stroke', color, width, cap, join, dash, opacity }
 *   | { type:'group', contents:[...], transform:{position,rotation,scale,anchor,opacity} }
 *
 * SelectorDef (batch 4/5's real per-character selector system):
 *   { type:'range', start, end, offset, shape:'square'|'rampUp'|'rampDown'|
 *       'triangle'|'round'|'smooth', smoothness, basedOn:'characters'|'words',
 *       amount, randomizeOrder, randomSeed }
 *   | { type:'wiggly', frequency, seed, correlation, minAmount, maxAmount }
 *
 * EffectDef: { type: <name from EFFECT_TYPES below>, params: {...} } -
 * the dispatch table in sceneBuilder.js maps each name directly to the
 * real engine function (colorGrading.js/blurEffects.js/noiseEffects.js/
 * glitchEffects.js/stylizeEffects.js/layerStyles.js/distortEffects.js).
 *
 * TransitionDef (batch 11): { type: <name from TRANSITION_TYPES below>,
 *   duration, params:{...real per-type params from transitions.js} }
 */

const LAYER_TYPES = ['shape', 'text', 'image', 'precomp', 'null', 'generate'];
const SHAPE_KINDS = ['rectangle', 'ellipse', 'polygon', 'star', 'customPath'];
const SHAPE_CONTENT_TYPES = ['path', 'trim', 'repeater', 'pathOp', 'fill', 'stroke', 'group'];
const PATH_OP_MODES = ['add', 'subtract', 'intersect', 'exclude', 'merge'];
const SELECTOR_TYPES = ['range', 'wiggly'];
// Explicit product requirement: every eased keyframe uses one of these
// three - see the "easing" interpolation check in validateAnimatable.
const CUBIC_EASING_NAMES = ['easeInCubic', 'easeOutCubic', 'easeInOutCubic'];
const TEXT_ALIGN_VALUES = ['left', 'center', 'right'];
// The ONLY real, guaranteed-available font families - see renderEngine.js's
// own registration block for why an arbitrary font NAME (e.g. "Futura
// Condensed") was never actually safe to request: nothing bundles it,
// so it silently fell back to a generic host default that looked
// nothing like what was asked for, on EVERY prior generation.
const AVAILABLE_FONT_FAMILIES = ['Poppins Black', 'Poppins Bold', 'Poppins Medium', 'Poppins Italic'];
const RANGE_SELECTOR_SHAPES = ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'];
const TRACK_MATTE_TYPES = ['alpha', 'alphaInverted', 'luma', 'lumaInverted'];
const GENERATE_KINDS = ['gradientRamp', 'checkerboard', 'grid', 'lensFlare', 'fractalNoise'];
const BLEND_MODE_NAMES = Object.keys(BLEND_MODE_MAP);
const EASING_NAMES = Object.keys(EASING_REGISTRY);

const EFFECT_TYPES = [
  'gaussianBlur', 'boxBlur', 'directionalBlur', 'radialBlur',
  'curves', 'hueSaturation', 'colorBalance', 'levels',
  'addGrain', 'addNoise',
  'rgbShift', 'blockDisplace', 'scanLines', 'pixelSort',
  'findEdges', 'emboss', 'posterize', 'mosaic', 'autoGlow',
  'dropShadow', 'outerGlow', 'innerGlow', 'innerShadow', 'layerStroke',
  'twirl', 'bulge', 'rippleWarp', 'waveWarp', 'displacementMap',
];

const TRANSITION_TYPES = [
  'crossDissolve', 'linearWipe', 'radialWipe', 'irisWipe', 'venetianBlinds', 'gradientWipe', 'card3DFlip', 'glitchTransition',
];

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isNumberArray(v, len) { return Array.isArray(v) && v.length === len && v.every((n) => typeof n === 'number'); }

/** Loose, non-erroring shape check mirroring validateAnimatable's OWN acceptance rules (number / N-vector / {keyframes} / {expression}) - used by autoRepairBeat to silently drop a field that matches NONE of these shapes (falls back to the engine's own default) instead of forcing a retry over one malformed transform value. */
function isValidAnimatableShape(v, vectorLen) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return true;
  if (vectorLen && isNumberArray(v, vectorLen)) return true;
  if (!isPlainObject(v)) return false;
  if (Array.isArray(v.keyframes)) return true;
  if (typeof v.expression === 'string') return true;
  return false;
}

/**
 * Drops any keyframe missing a real "value" from an AnimatableValue's
 * "keyframes" array (real, confirmed-live mistake - a keyframe with a
 * genuine "time" but no "value" at all). If NO keyframes remain valid
 * afterward, returns undefined (deletes the property, falling back to
 * the engine's own default) rather than leave a broken empty array -
 * the same "safe fallback beats a full retry" tradeoff as every other
 * malformed-transform repair in this function. Passes through
 * anything that isn't a {keyframes:[...]} shape untouched (a plain
 * number, an {expression}, undefined) - isValidAnimatableShape still
 * catches anything genuinely unrecognizable afterward.
 */
function repairKeyframesMissingValue(value) {
  if (!isPlainObject(value) || !Array.isArray(value.keyframes)) return value;
  value.keyframes = value.keyframes.filter((kf) => isPlainObject(kf) && kf.value !== undefined);
  if (value.keyframes.length === 0) return undefined;
  return value;
}

/**
 * Remaps a keyframe's "easing" to the closest real cubic preset when
 * "interpolation" is "easing" but the name isn't one of the three this
 * engine actually bundles - a well-established, extremely recurring
 * mistake across this entire session, the model reaching for a real,
 * familiar easing name ("easeOutBack", "easeOutBounce", "linear",
 * "easeOutQuint") that simply isn't one of easeInCubic/easeOutCubic/
 * easeInOutCubic. A hard validation error alone was never enough to
 * stop this recurring even with prompt reinforcement, so - same
 * treatment as every other well-established recurring mistake this
 * session - converted to auto-repair. Inferred from the invalid name's
 * own "In"/"Out" pattern (the overwhelming majority of real easing
 * names follow this convention): contains "Out" but not "In" ->
 * easeOutCubic (a settling entrance, the single most common real
 * case); contains "In" but not "Out" -> easeInCubic (an accelerating
 * exit); contains both, or matches neither (e.g. "linear") ->
 * easeInOutCubic, a safe neutral default that both starts and ends at
 * rest.
 */
function repairEasingName(name) {
  if (CUBIC_EASING_NAMES.includes(name)) return name;
  const hasIn = /in/i.test(name);
  const hasOut = /out/i.test(name);
  if (hasOut && !hasIn) return 'easeOutCubic';
  if (hasIn && !hasOut) return 'easeInCubic';
  return 'easeInOutCubic';
}

/** Applies repairEasingName to every keyframe of an AnimatableValue that opted into eased interpolation (interpolation:"easing") - the exact same condition validateAnimatable itself checks, see that function's own matching branch. */
function repairKeyframeEasings(value) {
  if (!isPlainObject(value) || !Array.isArray(value.keyframes)) return value;
  for (const kf of value.keyframes) {
    if (isPlainObject(kf) && kf.interpolation === 'easing' && kf.easing && !CUBIC_EASING_NAMES.includes(kf.easing)) {
      kf.easing = repairEasingName(kf.easing);
    }
  }
  return value;
}

/**
 * Repairs a SelectorDef's "start"/"end"/"offset"/"amount" fields in
 * place - each must be a number or a real AnimatableValue ({keyframes}
 * or {expression}), never anything else (a bare string, boolean, or
 * other malformed shape - real, confirmed-live mistake). Falls back to
 * a sane literal default for that SPECIFIC field (0/100/0/1 - these
 * four mean very different things, not interchangeable) rather than
 * rejecting the whole selector outright.
 */
function repairSelectorFields(selector) {
  const defaults = { start: 0, end: 100, offset: 0, amount: 1 };
  for (const field of Object.keys(defaults)) {
    if (selector[field] !== undefined) selector[field] = repairKeyframeEasings(repairKeyframesMissingValue(selector[field]));
  }
  for (const [field, fallback] of Object.entries(defaults)) {
    const v = selector[field];
    if (v !== undefined && !isValidAnimatableShape(v)) selector[field] = fallback;
  }
}

/**
 * A "text" layer has no literal width/height field (unlike "shape"), but
 * follows the IDENTICAL local-origin-centered drawing convention -
 * buildTextDraw always renders with centerX/centerY at the layer's own
 * (0,0), wrapped to "maxWidth" (see sceneBuilder.js). So the same
 * "anchor set to roughly half the size, trying to center it" mistake
 * confirmed live on shape layers (anchor:[240,44] on a maxWidth:480
 * headline - 240 is exactly half of 480) applies here too. There's no
 * rendered line count available at validation time (no canvas), so the
 * effective height is an ESTIMATE: average glyph width ~0.55x fontSize
 * (typical for bold sans-serif) to guess how many wrapped lines the text
 * needs, then that many lineHeights. It only needs to be roughly right -
 * it feeds a loose tolerance check, not an exact one.
 */
// Matches sceneBuilder.js's own buildTextDraw fallback (comp width 540
// minus a 30px margin each side) - kept as a literal here since this
// module validates JSON structurally and has no beatContext/comp size
// of its own, and the engine only ever renders at this one fixed size.
const DEFAULT_TEXT_MAX_WIDTH = 480;
// Matches renderEngine.js's own fixed WIDTH/HEIGHT (a 9:16 short-form
// canvas, never anything else) - kept as literals here for the same
// reason as DEFAULT_TEXT_MAX_WIDTH above.
const CANVAS_WIDTH = 540;
const CANVAS_HEIGHT = 960;
// EDGE_SAFETY_PX: float-precision slop only, not a deliberate
// tolerance - the off-canvas self-heal fires on essentially any
// estimated overflow now that it's a free in-place clamp rather than a
// costly reject-and-retry (see its own call site's doc comment for the
// full story on why a real live gap between this file's char-width
// ESTIMATE and the renderer's actual measured glyph widths made the
// old, much looser 25%-of-box threshold let real clipping through).
// EDGE_MARGIN_PX: the clamp lands a box inset by this much from each
// canvas edge, not flush against it, to absorb exactly that estimate-
// vs-real-render gap instead of landing right back on the boundary.
const EDGE_SAFETY_PX = 2;
const EDGE_MARGIN_PX = 16;

function estimateTextEffectiveSize(layer) {
  const width = typeof layer.maxWidth === 'number' ? layer.maxWidth : DEFAULT_TEXT_MAX_WIDTH;
  const fontSize = typeof layer.fontSize === 'number' ? layer.fontSize : 48;
  const lineHeight = typeof layer.lineHeight === 'number' ? layer.lineHeight : fontSize * 1.15;
  const text = typeof layer.text === 'string' ? layer.text : '';
  // 0.55 -> 0.6: real, confirmed-live undercount. "THE OCEAN HAS
  // RIVERS." (21 chars) at fontSize 60/maxWidth 480, "Arial Black"
  // weight 900, actually wraps to 2 real Canvas-measured lines - the
  // 0.55 estimate put it at 1.44 (rounds to 1), silently telling every
  // caller of this function (both the anchor-backwards check and the
  // duplicate-position overlap check) the layer was half its real
  // height, which let a genuinely overlapping pair of these exact
  // layers slip through overlap detection entirely undetected. A
  // heavy/bold font (a common, encouraged choice for headline text)
  // runs measurably wider than a lighter one at the same size, so
  // erring conservative (slightly OVER-estimating typical text, never
  // under) is the safer direction for an estimate that only ever
  // feeds tolerance checks, not literal pixel placement.
  // 0.6 -> 0.62: re-measured directly against the now-bundled real
  // "Poppins Black" font (renderEngine.js's font registration) instead
  // of the old "Arial Black" this was originally calibrated against -
  // real ctx.measureText() on representative headline strings put
  // Poppins Black's average per-character width as high as 0.629x
  // fontSize on a long real sentence, above the old 0.6 constant, so
  // this stays the same "never undercount" side of the estimate for
  // the actual font now in use rather than the one this was tuned for.
  const estCharWidth = fontSize * 0.62;
  // Real, confirmed-live regression this exact averaging approach let
  // through: "3 FACTS" (fontSize:120, maxWidth:450) actually wraps to
  // 2 real Canvas-measured lines ("3" / "FACTS"), but the old flat
  // `text.length * estCharWidth / width` average (7 chars * 74.4 / 450
  // = 1.16, rounds to 1) told every caller it was ONE line - a short,
  // few-word headline at a large fontSize is exactly where a simple
  // average breaks down (wrapping is a per-WORD greedy decision, not a
  // smooth function of total character count), and this specific
  // under-estimate is what let a genuinely overlapping duplicate "3"
  // highlight layer slip past the overlap-detection check entirely
  // undetected (confirmed directly via a real generated beat). Fixed
  // by mirroring textAnimator.js's OWN real per-word greedy-wrap
  // algorithm here (word-by-word, wrap when the running line would
  // exceed "width"), just substituting this same estCharWidth-per-
  // character estimate for each word's width instead of an actual
  // ctx.measureText() call (unavailable at validation time, no canvas
  // to measure with) - a per-word simulation tracks real wrap
  // boundaries far more faithfully than any single whole-string
  // average ever can, especially for short multi-word strings.
  const { lines, maxLineWidth } = simulateWrap(text, width, estCharWidth);
  const estLines = Math.max(1, lines);
  // actualWidth is intentionally UNCAPPED (no `Math.min(width, ...)`
  // here) - real layout never force-breaks a single word to fit
  // "width", so a short word at a large fontSize can render WIDER
  // than its own declared maxWidth (confirmed live: "crazy" at
  // fontSize 200/maxWidth 480 simulates to ~744px wide on its own
  // line). Capping this at width silently hid that overflow from
  // every caller, including the off-canvas safety check, which let
  // the word clip both canvas edges with nothing ever flagging it.
  // Callers that want the OLD "never below maxWidth" conservative
  // floor (short text that never fills its box) should take
  // Math.max(width, actualWidth) themselves, not rely on this
  // function silently ceiling it.
  return {
    width, height: lineHeight * estLines, actualWidth: maxLineWidth,
  };
}

/** Shared per-word greedy-wrap simulation (mirrors textAnimator.js's real layoutText, substituting an estCharWidth-per-character estimate for an actual ctx.measureText call - see estimateTextEffectiveSize's own doc comment for why per-word beats a whole-string average). Returns both the line COUNT (used for the height estimate, deliberately capped at "maxWidth" itself elsewhere for a conservative overlap check) and the WIDEST actual simulated line (used by the off-canvas check below, where assuming every line is exactly "maxWidth" wide would false-positive on any short text that never fills its own box). */
function simulateWrap(text, maxWidth, estCharWidth) {
  const words = text.split(' ').filter((w) => w.length > 0);
  let lines = 0;
  let lineWidth = 0;
  let lineHasWord = false;
  let maxLineWidth = 0;
  for (const word of words) {
    const wordWidth = (word.length + 1) * estCharWidth; // +1 approximates the trailing space, same convention as the real layoutText's `ctx.measureText(word + ' ')`
    if (lineWidth + wordWidth > maxWidth && lineHasWord) {
      lines += 1;
      maxLineWidth = Math.max(maxLineWidth, lineWidth);
      lineWidth = 0;
      lineHasWord = false;
    }
    lineWidth += wordWidth;
    lineHasWord = true;
  }
  if (lineHasWord) { lines += 1; maxLineWidth = Math.max(maxLineWidth, lineWidth); }
  return { lines, maxLineWidth };
}

// ---------------------------------------------------------------------
// Explicit product rule (not a schema quirk): a beat's background may
// NEVER be a single flat color - always a real 2-stop gradient. Small,
// self-contained hex/RGB helpers rather than importing anything from
// engine/ - this module validates JSON structurally and has always
// stayed dependency-free from the rendering engine's own internals.
// ---------------------------------------------------------------------
function hexToRgbLocal(hex) {
  const clean = String(hex).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function rgbToHexLocal([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
/** Lightens (factor>0) or darkens (factor<0) a hex color toward white/black by a fraction of its remaining headroom - a plain RGB-space shift, not true HSL rotation, but that's all "light-to-normal"/"dim-to-normal" of the SAME hue actually needs. */
function adjustLightness(hex, factor) {
  const [r, g, b] = hexToRgbLocal(hex);
  const mix = (c) => (factor >= 0 ? c + (255 - c) * factor : c + c * factor);
  return rgbToHexLocal([mix(r), mix(g), mix(b)]);
}

const DEFAULT_BACKGROUND_HUES = ['#0A2435', '#1A1035', '#2A0A1F', '#0A2A1A', '#241A0A', '#1A2A24'];

/** Sum of per-channel absolute differences - cheap and good enough to distinguish "a real, visible gradient" from "technically two different hex strings that render as indistinguishable on screen". */
function colorDistance(hexA, hexB) {
  const [r1, g1, b1] = hexToRgbLocal(hexA);
  const [r2, g2, b2] = hexToRgbLocal(hexB);
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}
// Confirmed live: a real generated gradient used startColor "#0A0A12"
// and endColor "#06060b" - two DIFFERENT hex strings (passing a naive
// string-inequality check) that are still close enough in value to
// render as an essentially flat near-black backdrop. This threshold is
// picked to let a real, subtle-but-visible gradient through while
// rejecting a near-identical pair like that one (their distance is
// ~13, well under this).
const MIN_GRADIENT_COLOR_DISTANCE = 45;

function isValidGradientBackground(bg) {
  if (!isPlainObject(bg) || bg.type !== 'generate' || !isPlainObject(bg.generate)
      || bg.generate.kind !== 'gradientRamp' || !isPlainObject(bg.generate.params)) return false;
  const p = bg.generate.params;
  if (typeof p.startColor !== 'string' || typeof p.endColor !== 'string') return false;
  if (colorDistance(p.startColor, p.endColor) < MIN_GRADIENT_COLOR_DISTANCE) return false;
  // Degenerate geometry: startPoint===endPoint collapses ANY gradient
  // (linear or radial) into a near-flat single color, regardless of
  // how different startColor/endColor are - confirmed live: a real
  // generated radial gradient with startPoint===endPoint===[270,480]
  // rendered almost the ENTIRE frame as flat black (its own endColor).
  // A zero-length direction/radius leaves virtually every pixel beyond
  // the single center point clamped to t=1 (generateEffects.js's own
  // `radius = Math.hypot(dx,dy) || 1` - the "|| 1" fallback exists for
  // exactly this degenerate case, but a 1px radius on a 540x960 frame
  // is still visually indistinguishable from a hard cutoff).
  if (Array.isArray(p.startPoint) && Array.isArray(p.endPoint)
      && Math.abs(p.startPoint[0] - p.endPoint[0]) < 2 && Math.abs(p.startPoint[1] - p.endPoint[1]) < 2) {
    return false;
  }
  return true;
}

/** Best-effort salvage of "the one color this background was already using" from whatever shape it's currently in, so the repaired gradient stays roughly on-hue instead of picking something unrelated - only falls back to a fixed rotating palette when nothing usable is found at all. */
function extractBaseColor(bg) {
  if (isPlainObject(bg)) {
    if (bg.type === 'generate' && isPlainObject(bg.generate) && isPlainObject(bg.generate.params)) {
      const p = bg.generate.params;
      if (typeof p.startColor === 'string') return p.startColor;
      if (typeof p.colorA === 'string') return p.colorA;
      if (typeof p.color === 'string') return p.color;
    }
    if (bg.type === 'shape' && Array.isArray(bg.contents)) {
      const fillItem = bg.contents.find((c) => isPlainObject(c) && c.type === 'fill' && typeof c.color === 'string');
      if (fillItem) return fillItem.color;
    }
  }
  return DEFAULT_BACKGROUND_HUES[Math.floor(Math.random() * DEFAULT_BACKGROUND_HUES.length)];
}

/**
 * Rebuilds a background wholesale into a canonical gradientRamp.
 * Confirmed via real generated/rendered output: the AI regularly
 * authors either a flat-fill shape background, or a "generate" layer
 * whose colorA/colorB (or startColor/endColor) are IDENTICAL - both
 * render as one unbroken flat color despite superficially looking like
 * a gradient/noise layer in the JSON, and a real rendered video showed
 * exactly this: the same flat dark color for the entire runtime.
 * Keeps whatever base hue can be salvaged (extractBaseColor) and
 * derives a genuinely different second stop - lighter OR darker,
 * chosen at random each time this runs, so "not always the same
 * color" holds both within a beat (a real 2-stop gradient) and across
 * a video's several beats (each repair independently rerolls hue
 * variant/shape/direction).
 */
function enforceGradientBackground(background) {
  if (!isPlainObject(background) || isValidGradientBackground(background)) return background;
  const baseColor = extractBaseColor(background);
  const lighten = Math.random() < 0.5; // light-to-normal vs dim-to-normal
  const otherColor = adjustLightness(baseColor, (lighten ? 1 : -1) * (0.28 + Math.random() * 0.14));
  const [startColor, endColor] = lighten ? [otherColor, baseColor] : [baseColor, otherColor];
  const shape = Math.random() < 0.5 ? 'linear' : 'radial';
  return {
    ...(background.id ? { id: background.id } : {}),
    type: 'generate',
    generate: {
      kind: 'gradientRamp',
      params: {
        startColor,
        endColor,
        shape,
        ...(shape === 'linear' ? { endPoint: Math.random() < 0.5 ? [0, 960] : [540, 0] } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------
// Real, repeated finding across MULTIPLE live generations (not a
// one-off): the model consistently invents/misplaces type names across
// these FOUR separate closed vocabularies (a real layer type, a real
// shape-content type, a real effect type, a real generate kind) despite
// prose warnings already covering it - "trim" (a real shape-content
// type) used as an effects[].type, "adjustmentLayer" (not real at all -
// the real mechanism is isAdjustmentLayer:true) used as a layer type,
// "outerStroke" (not real - the real name is "layerStroke") used as an
// effect. A bare "expected one of: <40 names>" error clearly wasn't
// enough context for retries to reliably converge (confirmed directly:
// the SAME class of mistake recurred, with different specific names,
// across three separate live retries in one generation). This builds a
// far more targeted correction: if the invalid value IS a real name
// from a DIFFERENT vocabulary, say so explicitly (the exact, common
// case above); otherwise suggest the closest real name by edit
// distance (catches near-misses/typos like "outerStroke" ~ "layerStroke").
// ---------------------------------------------------------------------

const NAMED_VOCABULARIES = {
  'a layer type': LAYER_TYPES,
  'a shape-content type': SHAPE_CONTENT_TYPES,
  'an effect type': EFFECT_TYPES,
  'a generate kind': GENERATE_KINDS,
  'a transition type': TRANSITION_TYPES,
  'a selector type': SELECTOR_TYPES,
};

/** Classic dynamic-programming edit distance - small, fixed-size inputs (short identifier strings), no need for anything fancier. */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Builds a targeted "here's specifically what's wrong" suffix for a bad
 * type/kind value: names which OTHER real vocabulary it actually
 * belongs to if it's a real name used in the wrong place (the common,
 * confirmed case), otherwise the closest real name in the CORRECT list
 * by edit distance (typos/near-misses), otherwise nothing extra.
 */
function suggestFix(value, correctList, ownVocabName) {
  if (typeof value !== 'string') return '';
  for (const [vocabName, list] of Object.entries(NAMED_VOCABULARIES)) {
    if (vocabName === ownVocabName) continue;
    if (list.includes(value)) return ` "${value}" IS a real name, but it's ${vocabName}, not ${ownVocabName} - it belongs in a different field entirely, not here.`;
  }
  let best = null; let bestDist = Infinity;
  for (const candidate of correctList) {
    const d = editDistance(value, candidate);
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  if (best && bestDist <= 3) return ` Did you mean "${best}"?`;
  return '';
}

/**
 * Validates an AnimatableValue at `path` (for error messages). Accepts
 * a plain number, a plain number-array of `vectorLen` (if given), a
 * {keyframes:[...]} object, or an {expression:...} object. Real,
 * structural validation (not exhaustive per-easing-name checking of
 * every keyframe, which would be a lot of code for marginal benefit -
 * an unknown easing name fails loudly and immediately at render time
 * anyway via easingCurves.js's own lookup, which is an acceptable
 * place for that specific mistake to surface).
 */
function validateAnimatable(value, path, errors, vectorLen) {
  if (value === undefined || value === null) return;
  if (typeof value === 'number') return;
  if (vectorLen && isNumberArray(value, vectorLen)) return;
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected a number, a ${vectorLen ? `${vectorLen}-element array` : 'value'}, a {keyframes} object, or an {expression} object`);
    return;
  }
  if (Array.isArray(value.keyframes)) {
    if (value.keyframes.length === 0) errors.push(`${path}.keyframes: must have at least one keyframe`);
    value.keyframes.forEach((kf, i) => {
      if (typeof kf.time !== 'number') errors.push(`${path}.keyframes[${i}].time: must be a number`);
      if (kf.value === undefined) errors.push(`${path}.keyframes[${i}].value: is required`);
      if (kf.easing && !EASING_NAMES.includes(kf.easing) && kf.easing !== 'cubicBezier') {
        errors.push(`${path}.keyframes[${i}].easing: "${kf.easing}" is not a real easing name (expected one of ${EASING_NAMES.join(', ')}, or cubicBezier)`);
      } else if (kf.interpolation === 'easing' && !CUBIC_EASING_NAMES.includes(kf.easing)) {
        // Explicit hard product requirement, not a stylistic default:
        // every eased keyframe must use one of the three real cubic
        // presets. Enforced here (not just documented in the prompt)
        // for the same reason every other "advisory" rule in this file
        // graduated to a hard check - prompt instructions alone don't
        // reliably hold, a validation error is what actually guarantees
        // mistralClient.js's retry-with-errors-fed-back loop corrects it.
        errors.push(`${path}.keyframes[${i}].easing: "${kf.easing}" - "easing" interpolation must use one of ${CUBIC_EASING_NAMES.join(', ')} (a hard product requirement, not a suggestion). Use "easeOutCubic" for a settling entrance, "easeInCubic" for an accelerating exit, "easeInOutCubic" for motion that both starts and ends at rest.`);
      }
    });
    return;
  }
  if (typeof value.expression === 'string') {
    // Real, confirmed-live crash (not theorized): a per-character range
    // selector's "end" used {"expression":"(index===10||...)?0:100"} -
    // "index" is a genuine, real After Effects expression convention,
    // but this engine's own expression sandbox (expressions.js) only
    // ever injects "time"/"value"/Math/the wiggle-loopOut-loopIn-
    // linear-ease-random-clamp helpers, nothing per-character or per-
    // copy - so this threw a bare ReferenceError straight out of
    // vm.Script.runInContext with no handling anywhere above it,
    // crashing the entire render process mid-frame (now ALSO hardened
    // separately in expressions.js itself to never crash on this, but
    // catching it here means a retry can fix the actual mistake instead
    // of silently losing the intended per-character effect).
    if (/\bindex\b/.test(value.expression)) {
      errors.push(`${path}.expression: "${value.expression}" references "index", which is NOT a real variable anywhere in this engine's expression sandbox. "index" is a real After Effects convention, but this engine only ever provides "time" (current evaluation time) and "value" (this property's own base/keyframed value) inside an expression, plus Math and the wiggle/loopOut/loopIn/linear/ease/random/clamp helper functions - there is no per-character or per-copy index available. Build the effect from "time" instead - a per-character stagger already comes from the SELECTOR's own sweep (see SELECTORS), not from an index referenced inside the expression itself.`);
    }
    if (value.base !== undefined) validateAnimatable(value.base, `${path}.base`, errors, vectorLen);
    return;
  }
  errors.push(`${path}: object form must have either a "keyframes" array or an "expression" string`);
}

// Real bug found via a live-rendered, user-reported output (not
// theoretical): a per-character text reveal sweeps characters into
// place ONE AT A TIME, not all at once - a "properties.position" delta
// large relative to a single character's own width makes a still-
// transitioning character's CURRENT (partially-offset) position
// visually collide with already-landed neighboring characters, which
// reads as scrambled/overlapping garbage text for as long as the
// reveal is in progress (confirmed directly: "BUDGETING APPS" briefly
// rendered as overlapping fragments mid-reveal with a delta this rule
// would catch). Caught here, not just via prompt guidance, because
// prompt instructions are advisory - a hard validation error is what
// actually guarantees mistralClient.js's retry-with-errors-fed-back
// loop corrects it before the JSON ever reaches the renderer.
const MAX_TEXT_ANIMATOR_POSITION_DELTA = 150;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Salvages a flat animator-property delta from a value shaped like a
 * full keyframed AnimatableValue (real, extremely common AI mistake -
 * see the autoRepairBeat call site's own doc comment for the full
 * story and live-confirmed frequency). Picks whichever keyframe's
 * value deviates MOST from "neutral" (the settled/landed value each
 * of these properties has at selector strength 0 - [0,0] for position,
 * 1 for scale, 0 for rotation/opacity), matching the model's obvious
 * intent every time this has been seen live: it's using keyframes to
 * express an entrance from an offset extreme down to neutral, which a
 * flat delta already encodes automatically via the selector's own
 * strength sweep. Handles both the common {"keyframes":[...]} wrapper
 * AND a bare array of keyframe-shaped objects (a live-confirmed second
 * variant of the exact same underlying mistake - the model dropping
 * the wrapper but keeping the [{time,value},...] shape inside it).
 * Leaves any other shape untouched (already-flat, undefined, or
 * something genuinely unsalvageable, e.g. an {"expression":...}) - the
 * autoRepairBeat call site deletes the property outright if it's still
 * not a valid flat value after this, rather than let it reach
 * validateAnimator and cost a full retry over one decorative property.
 */
function salvageAnimatorDelta(value, neutral) {
  const keyframes = (isPlainObject(value) && Array.isArray(value.keyframes) && value.keyframes)
    || (Array.isArray(value) && value.every((kf) => isPlainObject(kf) && 'value' in kf) && value)
    || null;
  if (!keyframes || keyframes.length === 0) return value;
  const isVec = Array.isArray(neutral);
  const magnitude = (v) => {
    if (isVec) return isNumberArray(v, 2) ? Math.abs(v[0] - neutral[0]) + Math.abs(v[1] - neutral[1]) : -Infinity;
    return typeof v === 'number' ? Math.abs(v - neutral) : -Infinity;
  };
  let best = null; let bestMag = -Infinity;
  for (const kf of keyframes) {
    if (!isPlainObject(kf)) continue;
    const mag = magnitude(kf.value);
    if (mag > bestMag) { bestMag = mag; best = kf.value; }
  }
  return best !== null ? best : value;
}

function validateAnimator(a, path, errors) {
  if (!a.selector) { errors.push(`${path}.selector: is required`); return; }
  validateSelector(a.selector, `${path}.selector`, errors);
  const props = a.properties;
  if (isPlainObject(props) && props.color !== undefined && !HEX_COLOR_RE.test(props.color)) {
    errors.push(`${path}.properties.color: "${props.color}" must be a 6-digit hex string like "#ff3366" (no shorthand 3-digit form, no rgb()/named colors).`);
  }
  // Real, render-silent-failure bug found live across MULTIPLE beats of
  // the same generated video: the model submitted a full keyframed
  // {"keyframes":[...]} AnimatableValue for "properties.position" - the
  // SAME shape a layer's own top-level "position" transform correctly
  // takes - instead of the flat [dx,dy] NUMBER delta this per-character
  // engine actually reads (see textAnimator.js's renderAnimatedText:
  // `dx += p.position[0] * strength`). Because the old check here only
  // fired `if (Array.isArray(props.position))`, an object value skipped
  // it ENTIRELY - no error, straight through to the renderer, where
  // `p.position[0]` on an object is undefined, the delta silently
  // becomes NaN/0, and the character never moves from its raw base
  // layout position for the whole beat. Confirmed directly: multiple
  // real generated beats rendered with headline text frozen at a
  // strongly off-canvas base position (e.g. x=-222 or x=533 on a 540px
  // canvas, deliberately off-screen so the reveal could fly it in),
  // permanently clipped/unreadable because the "flying in" animator
  // never actually applied. opacity/scale/rotation share the exact same
  // exposure (textAnimator.js does `dRotation += p.rotation * strength`
  // etc, same plain-number contract), so all four are checked here.
  if (isPlainObject(props)) {
    if (props.position !== undefined) {
      if (!isNumberArray(props.position, 2)) {
        errors.push(`${path}.properties.position: must be a flat [dx,dy] NUMBER array - a fixed per-character offset magnitude applied at full selector strength (e.g. [0,40] moves a selected character 40px down as it lands) - NOT a keyframed {"keyframes":[...]} object like a layer's own top-level "position" transform. Got ${JSON.stringify(props.position)}.`);
      } else {
        const [dx = 0, dy = 0] = props.position;
        if (Math.abs(dx) > MAX_TEXT_ANIMATOR_POSITION_DELTA || Math.abs(dy) > MAX_TEXT_ANIMATOR_POSITION_DELTA) {
          errors.push(`${path}.properties.position: [${dx},${dy}] is too large (keep each axis under ${MAX_TEXT_ANIMATOR_POSITION_DELTA}px, and typically 15-40px) - a per-character reveal sweeps characters into place individually, so a large delta makes still-transitioning characters visually overlap already-landed neighbors, rendering as garbled/scrambled text during the reveal.`);
        }
        // A "wiggly" selector never settles - every character is
        // perpetually offset by some amount, forever - so pairing it with
        // a position delta makes text look permanently scrambled for its
        // WHOLE time on screen, not just during an entrance (confirmed
        // directly: a badge's text stayed garbled across the entire beat,
        // never resolving to a readable state, unlike a one-time "range"
        // sweep which lands and stays).
        if (a.selector.type === 'wiggly') {
          errors.push(`${path}: a "wiggly" selector combined with a "position" property never settles - text using this will look permanently scrambled for its entire time on screen. Use "wiggly" only with "opacity"/"scale" (small ranges), or use a one-time "range" selector for any position-based text reveal.`);
        }
      }
    }
    if (props.opacity !== undefined && typeof props.opacity !== 'number') {
      errors.push(`${path}.properties.opacity: must be a plain NUMBER delta (e.g. -1 to fade in from fully hidden), not a keyframed {"keyframes":[...]} object - this is a per-character strength-scaled delta, not a layer-level animated transform.`);
    }
    if (props.scale !== undefined && typeof props.scale !== 'number') {
      errors.push(`${path}.properties.scale: must be a plain NUMBER multiplier (e.g. 0.5 to grow from half-size), not a keyframed {"keyframes":[...]} object.`);
    }
    if (props.rotation !== undefined && typeof props.rotation !== 'number') {
      errors.push(`${path}.properties.rotation: must be a plain NUMBER of degrees, not a keyframed {"keyframes":[...]} object.`);
    }
  }
}

function validateSelector(sel, path, errors) {
  if (!isPlainObject(sel)) { errors.push(`${path}: must be an object`); return; }
  if (!SELECTOR_TYPES.includes(sel.type)) {
    errors.push(`${path}.type: "${sel.type}" is not a real selector type (expected one of ${SELECTOR_TYPES.join(', ')})`);
    return;
  }
  if (sel.type === 'range') {
    if (sel.shape && !RANGE_SELECTOR_SHAPES.includes(sel.shape)) {
      errors.push(`${path}.shape: "${sel.shape}" is not a real range-selector shape (expected one of ${RANGE_SELECTOR_SHAPES.join(', ')})`);
    }
    // Real gap found live: start/end/offset/amount are documented as
    // AnimatableValue but were never actually routed through
    // validateAnimatable - so a malformed one (most dangerously, an
    // {"expression":...} referencing a variable that doesn't exist,
    // e.g. "index") passed validation entirely and only failed at
    // RENDER time, crashing the whole process (see validateAnimatable's
    // own "index" check for the exact confirmed incident).
    validateAnimatable(sel.start, `${path}.start`, errors);
    validateAnimatable(sel.end, `${path}.end`, errors);
    validateAnimatable(sel.offset, `${path}.offset`, errors);
    validateAnimatable(sel.amount, `${path}.amount`, errors);
  }
}

function validateHighlight(h, path, errors) {
  if (!isPlainObject(h)) { errors.push(`${path}: must be an object`); return; }
  if (!h.selector) { errors.push(`${path}.selector: is required (same SelectorDef shape as an animator's selector - e.g. a "range" selector with basedOn:"words" to box one specific word)`); }
  else validateSelector(h.selector, `${path}.selector`, errors);
  const hasColor = h.color !== undefined;
  const hasGradient = h.gradient !== undefined;
  if (!hasColor && !hasGradient) {
    errors.push(`${path}: requires either "color" (solid hex fill) or "gradient" ({from,to} hex pair) - a highlight chip with neither has nothing to draw itself with.`);
  }
  if (hasColor && !HEX_COLOR_RE.test(h.color)) {
    errors.push(`${path}.color: "${h.color}" must be a 6-digit hex string like "#ffe066".`);
  }
  if (hasGradient) {
    if (!isPlainObject(h.gradient) || !HEX_COLOR_RE.test(h.gradient.from) || !HEX_COLOR_RE.test(h.gradient.to)) {
      errors.push(`${path}.gradient: must be {"from":"#hex","to":"#hex"} - both 6-digit hex strings.`);
    }
  }
}

function validateShapeContentItem(item, path, errors) {
  if (!isPlainObject(item) || !SHAPE_CONTENT_TYPES.includes(item.type)) {
    const val = item && item.type;
    errors.push(`${path}.type: "${val}" is not a real shape content type (expected one of ${SHAPE_CONTENT_TYPES.join(', ')}).${suggestFix(val, SHAPE_CONTENT_TYPES, 'a shape-content type')}`);
    return;
  }
  if (item.type === 'path') {
    if (!item.shape || !SHAPE_KINDS.includes(item.shape.kind)) {
      errors.push(`${path}.shape.kind: "${item.shape && item.shape.kind}" is not a real shape kind (expected one of ${SHAPE_KINDS.join(', ')})`);
    } else if (item.shape.kind === 'customPath') {
      const anchors = item.shape.params && item.shape.params.anchors;
      if (!Array.isArray(anchors) || anchors.length < 2) {
        errors.push(`${path}.shape.params.anchors: a "customPath" shape requires an array of at least 2 anchor points ({"point":[x,y],"outTangent":[dx,dy]?,"inTangent":[dx,dy]?} - tangents optional, omit both for a straight-line segment into/out of that anchor).`);
      } else {
        anchors.forEach((a, i) => {
          if (!isPlainObject(a) || !isNumberArray(a.point, 2)) {
            errors.push(`${path}.shape.params.anchors[${i}].point: must be a real [x,y] pixel coordinate. Got ${JSON.stringify(a)}. Each anchor is an OBJECT with a "point" field holding a plain [x,y] array - e.g. {"point":[10,20]}, NOT a bare [x,y] array as the anchor itself, and NOT {"x":10,"y":20} for "point".`);
          }
        });
      }
    } else if (item.shape.kind === 'polygon' || item.shape.kind === 'star') {
      // Real, confirmed-live crash this prevents: "points" here is the
      // NUMBER OF SIDES (a regular polygon/star is generated from it,
      // not hand-specified vertices) - confused with customPath's own
      // "anchors" concept, a real generation instead sent an ARRAY of
      // explicit {"point":[x,y]} vertex objects for "points". Nothing
      // validated that shape, so it silently reached the polygon
      // primitive builder, which produced a near-empty/degenerate path
      // with no error anywhere - and THAT crashed the entire render
      // process outright once a "trim" operator tried to sample it
      // (now defensively handled in trimPaths.js too, but this is the
      // actual root cause worth catching before it ever gets that far).
      const p = item.shape.params;
      if (!isPlainObject(p) || typeof p.points !== 'number' || p.points < 3) {
        errors.push(`${path}.shape.params.points: must be a plain NUMBER >= 3 (the number of sides/points), not an array of vertex coordinates - "${item.shape.kind}" generates a REGULAR ${item.shape.kind} from a side count + radius, it does not take hand-specified vertices (that's what "customPath" is for). Got ${JSON.stringify(p && p.points)}.`);
      }
      if (item.shape.kind === 'polygon' && (!isPlainObject(p) || typeof p.radius !== 'number')) {
        errors.push(`${path}.shape.params.radius: a "polygon" requires a real number "radius".`);
      }
      if (item.shape.kind === 'star' && (!isPlainObject(p) || typeof p.outerRadius !== 'number' || typeof p.innerRadius !== 'number')) {
        errors.push(`${path}.shape.params: a "star" requires real number "outerRadius" and "innerRadius" values.`);
      }
    }
  } else if (item.type === 'pathOp') {
    if (!PATH_OP_MODES.includes(item.mode)) errors.push(`${path}.mode: "${item.mode}" is not a real path operation mode (expected one of ${PATH_OP_MODES.join(', ')})`);
  } else if (item.type === 'trim') {
    // Real, confirmed-live gap: this branch didn't exist at all, so
    // start/end/offset were NEVER structurally checked - a live
    // generation sent "end" wrapped in a stray single-element array
    // ("end":[{"keyframes":[...]}]) and it passed straight through
    // with zero error, leaving a line-reveal effect silently broken.
    // sanitizeShapeContents (autoRepairBeat) already unwraps that exact
    // mistake before this ever runs; this is the backstop for whatever
    // it couldn't fix.
    for (const field of ['start', 'end', 'offset']) {
      if (item[field] !== undefined && !isValidAnimatableShape(item[field])) {
        errors.push(`${path}.${field}: must be a plain number (0-100), or {"keyframes":[...]} for an animated sweep - got ${JSON.stringify(item[field])}.`);
      }
    }
  } else if (item.type === 'group') {
    if (!Array.isArray(item.contents)) errors.push(`${path}.contents: a group requires a contents array`);
    else item.contents.forEach((sub, i) => validateShapeContentItem(sub, `${path}.contents[${i}]`, errors));
  } else if (item.type === 'repeater' && isPlainObject(item.transform)) {
    // Real, previously-completely-silent bug found via direct frame
    // isolation: a live-generated repeater used per-copy
    // {"expression":"Math.cos(index*45)*200","base":0} objects for
    // transform.position, clearly assuming (reasonably, given real AE
    // repeaters DO support this) that each copy gets its own
    // expression-evaluated offset with an "index" variable. This
    // engine's actual repeater (engine/repeater.js) has NO such
    // feature - it reads transform.position/rotation/scale/anchor as
    // PLAIN STATIC NUMBERS exactly once, then COMPOUNDS that one fixed
    // per-copy delta across copies (matrix power, matching AE's real
    // "Transform: compounds per copy" behavior - a genuinely powerful,
    // correct way to build fans/circles/spirals on its own, just not
    // via expressions). Feeding it an {expression,...} object where a
    // number is expected doesn't error - it silently corrupts the
    // per-copy matrix into NaN, which then compounds, so every copy
    // except the very first (which starts from an untouched identity
    // matrix) vanishes with no error anywhere. Confirmed directly: a
    // repeater meant to show 8 shapes rendered exactly 1.
    const isNumericPlain = (v) => typeof v === 'number' || (Array.isArray(v) && v.every((x) => typeof x === 'number'));
    for (const field of ['position', 'rotation', 'scale', 'anchor']) {
      const val = item.transform[field];
      if (val !== undefined && !isNumericPlain(val)) {
        errors.push(`${path}.transform.${field}: must be a plain static number (or [x,y] of plain numbers) - repeater "transform" fields do NOT support AnimatableValue keyframes or {"expression":...} objects, and there is no "index" variable available to them. Got ${JSON.stringify(val)}. This is NOT a limitation to work around - the SAME per-copy transform is automatically COMPOUNDED across every copy (copy 2 gets the transform applied twice, copy 3 three times, etc, matching real After Effects), which is how a repeater naturally fans out into a circle/spiral/ring using nothing but one fixed rotation and/or position value.`);
      }
    }
  }
}

/**
 * Repairs a shape layer's "contents" array in place-ish (returns a new
 * array; call sites reassign) - see the autoRepairBeat call site's own
 * doc comment for the full story on why each of these specific fixups
 * exists. After attempting them, re-validates every item with the REAL
 * validateShapeContentItem and drops anything still invalid, so this
 * never has to enumerate every possible malformed shape by hand - only
 * the recognized, mechanically-safe patterns get actively fixed, and
 * everything else just gets dropped rather than failing the beat.
 */
function sanitizeShapeContents(contents) {
  if (!Array.isArray(contents)) return contents;
  const cleaned = [];
  for (const item of contents) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'path' && isPlainObject(item.shape)) {
      // "circle" is a real, intuitive name that just isn't one of this
      // schema's five SHAPE_KINDS - "ellipse" (equal width/height) is
      // the exact equivalent. A circle is naturally described by a
      // radius; ellipse takes width/height, so radius->diameter here.
      if (item.shape.kind === 'circle') {
        const p = isPlainObject(item.shape.params) ? item.shape.params : {};
        const width = typeof p.width === 'number' ? p.width : (typeof p.radius === 'number' ? p.radius * 2 : 100);
        const height = typeof p.height === 'number' ? p.height : (typeof p.radius === 'number' ? p.radius * 2 : width);
        item.shape = { kind: 'ellipse', params: { ...p, width, height } };
        delete item.shape.params.radius;
      }
      if (item.shape.kind === 'polygon' && isPlainObject(item.shape.params) && typeof item.shape.params.radius !== 'number') {
        item.shape.params.radius = 50;
      }
      if (item.shape.kind === 'star' && isPlainObject(item.shape.params)) {
        if (typeof item.shape.params.outerRadius !== 'number') item.shape.params.outerRadius = 50;
        if (typeof item.shape.params.innerRadius !== 'number') item.shape.params.innerRadius = 25;
      }
    }
    if (item.type === 'trim') {
      // Real, confirmed-live bug found via a live generation:
      // "end" sent as a single-element ARRAY wrapping the real
      // AnimatableValue object - "end":[{"keyframes":[...]}] instead of
      // "end":{"keyframes":[...]} directly. validateShapeContentItem
      // had NO branch for "trim" at all until now - start/end/offset
      // were never structurally checked here - so this passed
      // validation completely silently, leaving the line-reveal this
      // was meant to drive either frozen at whatever default the
      // renderer falls back to, or misbehaving with zero error
      // anywhere to explain why. Unwraps the common single-element-
      // array mistake; anything still malformed after that falls back
      // to a safe neutral default per field (0 for start/offset, 100
      // for end - "fully drawn," the least broken-looking failure mode
      // for a reveal effect) rather than being silently accepted by a
      // check that was never actually looking at it.
      for (const field of ['start', 'end', 'offset']) {
        let val = item[field];
        if (Array.isArray(val) && val.length === 1) val = val[0];
        if (val !== undefined && !isValidAnimatableShape(val)) val = field === 'end' ? 100 : 0;
        if (val !== undefined) item[field] = val;
      }
    }
    if (item.type === 'group' && Array.isArray(item.contents)) {
      item.contents = sanitizeShapeContents(item.contents);
    }
    const throwaway = [];
    validateShapeContentItem(item, 'x', throwaway);
    if (throwaway.length === 0) cleaned.push(item);
  }
  // Real, confirmed-live bug found via direct isolated render test (not
  // a live generation yet, but a genuinely dormant landmine): AE's real
  // stacking rule is that Trim Paths operates on whatever path data is
  // ABOVE it in the SAME contents list, and Fill/Stroke consume
  // whatever's currently accumulated WITHOUT modifying it - so a
  // "path, stroke, trim" order (stroke drawn BEFORE trim ever runs)
  // draws the FULL, untrimmed shape, and the trim item after it has
  // nothing left to affect. The result isn't an error or a crash - it's
  // a "self-drawing line" that's simply fully drawn from frame one,
  // with zero indication anything is wrong; confirmed directly by
  // swapping the two items in an otherwise-identical test and watching
  // the exact same reveal that should have taken 1.5s instead appear
  // instantly. This is a one-way, purely mechanical AE convention (no
  // legitimate reason to ever want trim evaluated AFTER the paint that
  // should be limited by it), so it's auto-repaired here rather than
  // left to force a retry: any "trim" item found after the first
  // "fill"/"stroke" is moved to sit immediately before that first
  // fill/stroke, preserving every other item's relative order.
  const firstPaintIndex = cleaned.findIndex((item) => item.type === 'fill' || item.type === 'stroke');
  if (firstPaintIndex !== -1) {
    const misplacedTrims = [];
    const rest = [];
    cleaned.forEach((item, i) => {
      if (item.type === 'trim' && i > firstPaintIndex) misplacedTrims.push(item);
      else rest.push(item);
    });
    if (misplacedTrims.length > 0) {
      const newFirstPaintIndex = rest.findIndex((item) => item.type === 'fill' || item.type === 'stroke');
      rest.splice(newFirstPaintIndex, 0, ...misplacedTrims);
      return rest;
    }
  }
  return cleaned;
}

function validateEffect(effect, path, errors) {
  if (!isPlainObject(effect) || !EFFECT_TYPES.includes(effect.type)) {
    const val = effect && effect.type;
    errors.push(`${path}.type: "${val}" is not a real effect type (expected one of ${EFFECT_TYPES.join(', ')}).${suggestFix(val, EFFECT_TYPES, 'an effect type')}`);
  }
}

function validateLayer(layer, path, errors, knownIds) {
  if (!isPlainObject(layer)) { errors.push(`${path}: must be an object`); return; }
  if (!LAYER_TYPES.includes(layer.type)) {
    if (layer.isAdjustmentLayer !== undefined || /adjust/i.test(String(layer.type))) {
      errors.push(`${path}.type: "${layer.type}" is not a real layer type. THERE IS NO "adjustment"/"adjustmentLayer" TYPE - an adjustment layer is a NORMAL layer (e.g. "type":"shape" or "type":"null") with "isAdjustmentLayer":true and a real "effects" array. Use one of ${LAYER_TYPES.join(', ')} for "type", and set isAdjustmentLayer:true separately.`);
    } else {
      errors.push(`${path}.type: "${layer.type}" is not a real layer type (expected one of ${LAYER_TYPES.join(', ')}).${suggestFix(layer.type, LAYER_TYPES, 'a layer type')}`);
    }
  }
  if (layer.id) knownIds.add(layer.id);

  if (layer.blendMode && !BLEND_MODE_NAMES.includes(layer.blendMode)) {
    errors.push(`${path}.blendMode: "${layer.blendMode}" is not a real blend mode (expected one of ${BLEND_MODE_NAMES.join(', ')})`);
  }

  // Real gap found the same way validateSelector's own start/end/
  // offset/amount gap was found earlier: these five common transform
  // fields are documented as AnimatableValue (JSDoc block up top) but
  // were never actually routed through validateAnimatable at all - so
  // a malformed one (most importantly for the cubic-easing product
  // requirement: an "easing" keyframe using a non-cubic name) passed
  // validation silently instead of being caught and retried. Position/
  // scale/anchor are 2-vectors; rotation/opacity are scalars.
  validateAnimatable(layer.position, `${path}.position`, errors, 2);
  validateAnimatable(layer.rotation, `${path}.rotation`, errors);
  validateAnimatable(layer.scale, `${path}.scale`, errors, 2);
  validateAnimatable(layer.anchor, `${path}.anchor`, errors, 2);
  validateAnimatable(layer.opacity, `${path}.opacity`, errors);

  // Real, confirmed-live bug: a layer's own top-level "opacity" and a
  // per-character animator's "opacity" DELTA are two entirely separate
  // mechanisms - the animator only ever modulates per-CHARACTER alpha
  // inside the text draw call, it has no way to reach back and affect
  // the LAYER's own opacity, which gates the whole composited result
  // multiplicatively (Node.getWorldOpacity -> ctx.globalAlpha) no
  // matter what the animator does internally. A static "opacity":0 at
  // the layer level is a hard, permanent 0% for the layer's entire
  // duration. Confirmed directly: a real generated "FACT #2" headline
  // with "opacity":0 plus a per-character reveal animator (clearly
  // intended to fade the text in) rendered as nothing - fully
  // invisible - for the ENTIRE beat, even though the animator itself
  // was correctly configured and would have worked fine had layer
  // opacity been left at its default. Only flagged for a plain STATIC
  // 0 (not an AnimatableValue/keyframes object that legitimately
  // starts at 0 and animates up on its own) alongside a non-empty
  // "animators" array - a keyframed layer opacity with no animators is
  // a completely different, valid use case, untouched here.
  if (layer.opacity === 0 && Array.isArray(layer.animators) && layer.animators.length > 0) {
    errors.push(`${path}.opacity: is a static 0 - combined with a per-character "animators" reveal, this makes the ENTIRE layer permanently invisible for its whole duration, since the animator only controls per-character alpha and can never override the layer's own opacity. Omit "opacity" entirely (default 1) and let the animator's own per-character "opacity" delta handle the reveal instead.`);
  }
  if (layer.trackMatte) {
    if (!layer.trackMatte.source) errors.push(`${path}.trackMatte.source: is required (the id of the matte layer)`);
    if (!TRACK_MATTE_TYPES.includes(layer.trackMatte.type)) errors.push(`${path}.trackMatte.type: "${layer.trackMatte.type}" is not real (expected one of ${TRACK_MATTE_TYPES.join(', ')})`);
  }
  if (Array.isArray(layer.effects)) layer.effects.forEach((e, i) => validateEffect(e, `${path}.effects[${i}]`, errors));

  // Real, confirmed-live bug: unlike "image"/"generate" layers (whose
  // content draws top-left-anchored, so anchor:[width/2,height/2] IS
  // the correct way to center them), a "shape" layer's own content is
  // ALREADY drawn centered on its own local (0,0) - so giving it
  // anchor:[width/2,height/2] (the natural-seeming "half the size"
  // choice, and what the prompt used to recommend uniformly for every
  // layer type) shifts it OFF-center by half its own width/height, the
  // opposite of the intent. Confirmed directly: a 420x60 badge given
  // anchor:[210,30] rendered clipped off the frame edge; the same
  // layer with anchor omitted (or [0,0]) rendered correctly centered.
  // Flagged only when anchor closely matches exactly half the layer's
  // own declared width/height - a real, deliberately off-center pivot
  // (a page-flip rotating around an edge) would use a different value,
  // not this specific "trying to center it and getting it backwards"
  // pattern.
  if (layer.type === 'shape' && Array.isArray(layer.anchor)
      && typeof layer.width === 'number' && typeof layer.height === 'number') {
    const [ax, ay] = layer.anchor;
    // Loose (30%) tolerance, not an exact match - real generated
    // anchors aiming for "half the size" are often APPROXIMATIONS
    // (e.g. derived from a related text layer's maxWidth/lineHeight
    // instead of this shape's own exact width/height), confirmed
    // directly: a real badge sized 420x60 used anchor:[200,26] - off
    // from the true half [210,30] by 10px/4px, close enough that
    // it's unmistakably the same "trying to center it, backwards"
    // mistake, but too far off for a tight pixel tolerance to catch.
    const halfW = layer.width / 2, halfH = layer.height / 2;
    if (typeof ax === 'number' && typeof ay === 'number' && ax > 0 && ay > 0
        && Math.abs(ax - halfW) < halfW * 0.3 && Math.abs(ay - halfH) < halfH * 0.3) {
      errors.push(`${path}.anchor: [${ax},${ay}] is approximately half this shape's own width/height (${layer.width}x${layer.height}) - for a "shape" layer this is BACKWARDS. Shape content is already centered on its own local (0,0), so this anchor value shifts it OFF-center by roughly half its size instead of centering it. To center this layer on "position", either omit "anchor" entirely or set it to [0,0] explicitly.`);
    }
  }

  // Identical mistake, identical convention, "text" layer version - see
  // estimateTextEffectiveSize's doc comment for why height is estimated
  // rather than read from a literal field. Confirmed directly on real
  // generated output: a "WAIT... THIS IS REAL?" headline with
  // maxWidth:480 used anchor:[240,44] (240 = exactly half of 480),
  // rendering almost entirely off-frame; the same layer with anchor
  // omitted (or [0,0]) rendered correctly centered.
  if (layer.type === 'text' && Array.isArray(layer.anchor)) {
    const [ax, ay] = layer.anchor;
    const { width: effW, height: effH } = estimateTextEffectiveSize(layer);
    const halfW = effW / 2, halfH = effH / 2;
    if (typeof ax === 'number' && typeof ay === 'number' && ax > 0 && ay > 0
        && Math.abs(ax - halfW) < halfW * 0.3 && Math.abs(ay - halfH) < halfH * 0.6) {
      errors.push(`${path}.anchor: [${ax},${ay}] looks like roughly half this text layer's own maxWidth/rendered-height (~${Math.round(effW)}x${Math.round(effH)}) - for a "text" layer this is BACKWARDS, the exact same mistake as on shape layers. Text is already drawn centered on its own local (0,0) (both "position" and any wrapped multi-line layout are built around that origin), so this anchor shifts it OFF-center by roughly half its size - often enough to push it partly or entirely off-frame. To center this layer on "position", either omit "anchor" entirely or set it to [0,0] explicitly.`);
    }
  }

  if (layer.type === 'shape') {
    if (!Array.isArray(layer.contents)) errors.push(`${path}.contents: a shape layer requires a contents array`);
    else layer.contents.forEach((item, i) => validateShapeContentItem(item, `${path}.contents[${i}]`, errors));
    // The prompt has always documented width/height as REQUIRED for
    // shape layers, but nothing actually enforced that until now - a
    // real generation omitted them entirely (they only appeared nested
    // inside the shape's own path geometry params, a DIFFERENT field),
    // which silently falls back to the full frame size for effect-
    // buffer sizing (build2DLayer's own `layerDef.width || beatContext.width`)
    // and, worse, meant the anchor-centering check above had no
    // dimensions to check against at all, letting the very anchor bug
    // that check exists to catch slip through unflagged.
    if (typeof layer.width !== 'number' || typeof layer.height !== 'number') {
      errors.push(`${path}: a "shape" layer requires its own top-level "width" and "height" (a sibling of "position"/"contents", not nested inside a content item's shape.params) - this is the layer's own bounding size, separate from any individual path's geometry, and other logic (anchor centering, effect-buffer sizing) depends on it being present and accurate.`);
    }
  } else if (layer.type === 'text') {
    if (typeof layer.text !== 'string' || layer.text.length === 0) errors.push(`${path}.text: is required and must be a non-empty string`);
    if (layer.fontFamily !== undefined && !AVAILABLE_FONT_FAMILIES.includes(layer.fontFamily)) {
      errors.push(`${path}.fontFamily: "${layer.fontFamily}" is not a real, bundled font - only these are actually registered and guaranteed to render correctly on every host: ${AVAILABLE_FONT_FAMILIES.join(', ')}. Any other name silently falls back to a generic, unstyled default (confirmed directly - this is not a style preference, it's the difference between real bold geometric type and an unstyled fallback).${suggestFix(layer.fontFamily, AVAILABLE_FONT_FAMILIES, 'a font family')}`);
    }
    if (layer.textAlign !== undefined && !TEXT_ALIGN_VALUES.includes(layer.textAlign)) {
      errors.push(`${path}.textAlign: "${layer.textAlign}" is not real (expected one of ${TEXT_ALIGN_VALUES.join(', ')})`);
    }
    if (Array.isArray(layer.animators)) {
      layer.animators.forEach((a, i) => validateAnimator(a, `${path}.animators[${i}]`, errors));
    }
    if (Array.isArray(layer.highlights)) {
      if (layer.onPath) {
        errors.push(`${path}.highlights: not supported together with "onPath" - highlight chips only work on straight-baseline text. Remove one or the other.`);
      }
      layer.highlights.forEach((h, i) => validateHighlight(h, `${path}.highlights[${i}]`, errors));
    }
  } else if (layer.type === 'generate') {
    if (!layer.generate || !GENERATE_KINDS.includes(layer.generate.kind)) {
      const val = layer.generate && layer.generate.kind;
      errors.push(`${path}.generate.kind: "${val}" is not real (expected one of ${GENERATE_KINDS.join(', ')}).${suggestFix(val, GENERATE_KINDS, 'a generate kind')}`);
    }
  } else if (layer.type === 'image') {
    // "icon" is the real, intended way to put a specific icon/logo on
    // screen - a semantic Iconify name ("prefix:name", e.g.
    // "mdi:rocket-launch" or "simple-icons:youtube" for a real brand
    // logo), resolved to a real local PNG by iconFetch.js's own
    // prefetch step (mirrors "beatImage"/imagePrompt->imagePath
    // exactly) BEFORE the layer ever reaches the renderer - never a
    // literal "src" path for an icon. An image layer needs one or the
    // other; neither means nothing will ever be drawn.
    if (layer.icon !== undefined) {
      if (typeof layer.icon !== 'string' || !/^[\w-]+:[\w-]+$/.test(layer.icon)) {
        errors.push(`${path}.icon: "${layer.icon}" must be a real Iconify name in "prefix:name" form (e.g. "mdi:rocket-launch", "simple-icons:youtube") - see ICONS below for how to pick a real one.`);
      }
      // Real, confirmed-live bug: an icon layer with no "width"/
      // "height" left the actual render size entirely up to
      // buildImageDraw's own fallback (the rasterized icon's NATURAL
      // pixel size, which iconFetch.js deliberately over-rasterizes at
      // 2x for crisp downscaling - a "256px" default request becomes a
      // 512px-wide rendered icon with no explicit size to shrink it
      // back down). Confirmed directly: a real generated icon with no
      // width/height rendered nearly as large as the frame itself,
      // overlapping the text next to it - and having no width/height
      // ALSO made it invisible to the overlap-detection/auto-spread
      // system entirely (sizeForSpreadCheck has nothing to measure
      // without one), so the collision was never caught or repaired
      // either. width/height are required on every OTHER layer type
      // with real bounding geometry (shape already requires them) -
      // an icon is no different.
      if (typeof layer.width !== 'number' || typeof layer.height !== 'number') {
        errors.push(`${path}: an icon image layer requires its own top-level "width" and "height" (the actual rendered size) - omitting them lets the icon render at its raw rasterized size (can be much larger than intended) and makes it invisible to overlap detection, both confirmed as real live bugs.`);
      }
      if (layer.iconColor !== undefined && !HEX_COLOR_RE.test(layer.iconColor)) {
        errors.push(`${path}.iconColor: "${layer.iconColor}" must be a 6-digit hex string.`);
      }
    } else if (typeof layer.src !== 'string' || layer.src.trim().length === 0) {
      errors.push(`${path}: an "image" layer needs either "icon" (a real Iconify icon name) or "src":"beatImage" - without one of these, nothing will ever be drawn for this layer.`);
    }
    // Real, measured performance bug: an "image" layer with effects
    // but no explicit width/height silently sizes its effects buffer
    // at the FULL FRAME (build2DLayer's own width/height fallback),
    // regardless of the image's real size - and if the image's own
    // fetch happens to fail (a real, routine occurrence - the free
    // Pollinations backend is genuinely rate-limited), there's no
    // loaded image to fall back to a smaller natural size from either,
    // so the buffer stays full-frame-sized with nothing useful even
    // drawn into it. Confirmed via direct profiling of a real
    // generated beat: exactly this layer (image + outerGlow +
    // gaussianBlur + rgbShift, no explicit size) cost 1768ms/frame -
    // by far the single most expensive layer in that beat, the next
    // slowest was 393ms/frame. Only flagged when effects are present,
    // since an effect-free image layer has no expensive per-pixel work
    // to needlessly oversize a buffer for.
    if (Array.isArray(layer.effects) && layer.effects.length > 0
        && (typeof layer.width !== 'number' || typeof layer.height !== 'number')) {
      errors.push(`${path}: an "image" layer with effects should set explicit "width"/"height" matching its intended display size. Omitting them sizes the effects-processing buffer at the FULL FRAME regardless of the image's real size (and stays that size even if the image fetch fails), making every effect on this layer far more expensive than necessary for no visual benefit.`);
    }
  } else if (layer.type === 'precomp') {
    if (!Array.isArray(layer.layers)) errors.push(`${path}.layers: a precomp requires a nested layers array`);
    else {
      layer.layers.forEach((l, i) => validateLayer(l, `${path}.layers[${i}]`, errors, knownIds));
      // Real, confirmed-live bug: a precomp's own declared width/height
      // is the FULL EXTENT of its children's local coordinate space
      // (see mistralClient.js's precomp doc for the full story) - a
      // child positioned using coordinates sized for the OUTER frame
      // (typically much bigger than a small precomp) renders outside
      // the precomp's own private buffer and is silently clipped.
      // Confirmed directly: a 400x300 chart precomp whose own bars
      // were positioned at y:400-600 (coordinates that only make sense
      // in the ~960px-tall outer frame) rendered mostly clipped off.
      // Only checked for a PLAIN [x,y] position (not keyframed) against
      // a generous 50%-beyond-bounds tolerance - loose enough to allow
      // legitimate off-canvas entrance/exit motion, tight enough to
      // catch "used outer-frame-sized coordinates by mistake".
      if (typeof layer.width === 'number' && typeof layer.height === 'number') {
        const marginX = layer.width * 0.5;
        const marginY = layer.height * 0.5;
        layer.layers.forEach((l, i) => {
          if (!isPlainObject(l) || !isNumberArray(l.position, 2)) return;
          const [px, py] = l.position;
          if (px < -marginX || px > layer.width + marginX || py < -marginY || py > layer.height + marginY) {
            errors.push(`${path}.layers[${i}].position: [${px},${py}] is far outside this precomp's own declared bounds (0,0)-(${layer.width},${layer.height}) - a precomp's children are positioned relative to ITS OWN width/height, not the outer frame's, so this renders clipped outside the precomp's private buffer. Reposition it to make sense within this precomp's own ${layer.width}x${layer.height} space (e.g. centered around [${layer.width / 2},${layer.height / 2}]).`);
          }
        });
      }
    }
  }
}

function validateTransition(transition, path, errors) {
  if (!isPlainObject(transition) || !TRANSITION_TYPES.includes(transition.type)) {
    errors.push(`${path}.type: "${transition && transition.type}" is not a real transition type (expected one of ${TRANSITION_TYPES.join(', ')})`);
  }
}

function validateBeatVisual(visual, path, errors, knownIds) {
  if (!isPlainObject(visual)) { errors.push(`${path}: is required and must be an object`); return; }
  if (visual.background) validateLayer(visual.background, `${path}.background`, errors, knownIds);
  if (!Array.isArray(visual.layers)) { errors.push(`${path}.layers: is required and must be an array`); return; }
  // Real bug found via a live-rendered, user-reported output: a beat
  // with zero layers (just a background, or nothing at all) renders as
  // several seconds of a static/empty frame with no foreground content
  // whatsoever - confirmed directly as a multi-second dead zone in an
  // actual generated video. A beat needs at least one real foreground
  // layer; "just a background for a few seconds" is never an
  // intentional design choice worth having, it's a generation gap.
  if (visual.layers.length === 0) {
    errors.push(`${path}.layers: must contain at least one layer - a beat with zero foreground layers renders as an empty/dead frame with nothing happening for its entire duration.`);
  }
  // Same reasoning as the zero-layer check above, one level more
  // specific: real, confirmed-live gap where a beat cleared THAT check
  // (it had shape/image layers) but had ZERO text layers - a full 3s
  // beat (a third of the whole video) with nothing but a decorative
  // squiggle line on a plain gradient, no headline/stat/label
  // whatsoever. This app's whole purpose is short-form INFORMATIONAL
  // content - a beat conveying no actual words is never a deliberate
  // "visual breather" here, it's a generation gap same as the zero-
  // layer case, just one this narrower check didn't catch.
  if (visual.layers.length > 0 && !visual.layers.some((l) => isPlainObject(l) && l.type === 'text')) {
    errors.push(`${path}.layers: must contain at least one text layer - a beat with only shapes/icons and no text conveys no actual information for its entire duration.`);
  }
  visual.layers.forEach((layer, i) => validateLayer(layer, `${path}.layers[${i}]`, errors, knownIds));

  // Real, systematic bug found across MULTIPLE beats of the SAME
  // generated video, not a one-off: a supporting-text layer got
  // duplicated verbatim into two separate, otherwise-independent
  // layers with the IDENTICAL "text" string (e.g. two entire layers
  // both reading "20 MILLION TONS dissolved in seawater") - almost
  // certainly the model reaching for a "one plain copy + one
  // accented copy" pattern (a real technique in other tools, e.g. a
  // duplicated-layer drop-shadow trick), which this schema has no use
  // for since "highlights"/an animator "color" already let ONE layer
  // carry both a plain base look AND an accent. Two text layers
  // sharing the exact same string in the same beat is never a
  // legitimate design choice here - it always renders as visibly
  // doubled/overlapping text. Exact string match (case/whitespace
  // normalized), not fuzzy - a deliberately conservative check with
  // effectively no legitimate false-positive case to guard against.
  const textLayersByContent = new Map();
  visual.layers.forEach((layer, i) => {
    if (!isPlainObject(layer) || layer.type !== 'text' || typeof layer.text !== 'string') return;
    const key = layer.text.trim().toLowerCase();
    if (!key) return;
    if (!textLayersByContent.has(key)) textLayersByContent.set(key, []);
    textLayersByContent.get(key).push(i);
  });
  for (const [text, indices] of textLayersByContent.entries()) {
    if (indices.length > 1) {
      errors.push(`${path}.layers: layers at indices [${indices.join(', ')}] all have the IDENTICAL text "${text}" - two separate text layers must never share the same literal content, it always renders as visibly doubled/overlapping text. If the intent was a plain version plus an accented/highlighted version of the same words, that's ONE layer with a "highlights" entry and/or an animator "color" property targeting the specific word(s) to accent - not two layers. Merge these into one layer.`);
    }
  }

  // Real bug found via direct JSON inspection of a live-generated beat:
  // two "cell" precomps meant to sit side-by-side both independently
  // left "position" at the schema's default [0,0] - they don't share a
  // "parent", they're just both un-set. Confirmed directly via a
  // rendered frame: instead of a spread-out grid, they stack fully on
  // top of each other at the frame's top-left corner. Shown up
  // independently across more than one real generation, so it's
  // detected structurally rather than left to prompt guidance alone.
  //
  // False-positive risk this had to be guarded against (found while
  // testing this exact check against real captured beats): full-frame
  // overlay/matte layers LEGITIMATELY share the same frame-filling
  // position with each other - that's normal, correct compositing, not
  // a "forgot to spread these out" mistake. So only layers that are
  // SMALLER than the beat's own largest layer are eligible to be
  // flagged; anything tied for the largest in the beat is treated as a
  // background/overlay-style layer and exempted.
  //
  // Text layers get an ESTIMATED size here (sizeForSpreadCheck), not
  // exempted outright the way this used to treat "no explicit width/
  // height". Detection is a real AABB overlap test (via
  // representativePosition, resolving a keyframed position to its own
  // settled/final value) rather than exact-position matching - a real,
  // confirmed-live failure slipped through the OLD exact-match version
  // twice over: once for 4 separate text layers left at the IDENTICAL
  // static position, and again for layers whose positions were merely
  // CLOSE (12px apart) or ANIMATED (keyframed, invisible to a plain
  // `Array.isArray` check entirely) but still fully overlapped once
  // rendered. autoRepairBeat's own matching spread logic
  // (autoSpreadDuplicatePositions) already fixes this mechanically
  // before validation ever runs, so this check mostly exists as an
  // independent confirmation/backstop now. The "tied for largest"
  // exemption itself is tracked using ONLY explicitly-sized (shape/
  // image) layers, same reasoning as autoSpreadDuplicatePositions -
  // text has no legitimate "meant to overlap" case, so two same-size
  // headline words tying for "largest" must never exempt each other.
  const explicitSized = visual.layers.filter((l) => isPlainObject(l) && typeof l.width === 'number' && typeof l.height === 'number');
  const maxW = explicitSized.length ? Math.max(...explicitSized.map((l) => l.width)) : 0;
  const maxH = explicitSized.length ? Math.max(...explicitSized.map((l) => l.height)) : 0;
  const overlapEntries = visual.layers.map((layer, i) => {
    if (!isPlainObject(layer) || layer.parent) return null;
    const pos = representativePosition(layer.position);
    if (!pos) return null;
    const size = sizeForSpreadCheck(layer);
    if (!size) return null;
    const hasExplicitSize = typeof layer.width === 'number' && typeof layer.height === 'number';
    // Real, confirmed-live gap: "tied for largest" trivially exempts a
    // SMALL decorative shape whenever it's the ONLY explicitly-sized
    // layer in the beat (it's automatically its own max, tied with
    // itself) - a 90x90 accent ring next to a headline was never
    // eligible for overlap detection at all because of this, even
    // though 90x90 is nowhere near a real background/overlay size on a
    // ${CANVAS_WIDTH}x${CANVAS_HEIGHT} canvas. Now ALSO requires the
    // layer to be absolutely large (spans most of the canvas in at
    // least one dimension), not just relatively largest among however
    // many explicitly-sized siblings happen to exist - a genuine
    // full-frame overlay/lower-third band still qualifies either way.
    const isBackgroundScale = size.width >= CANVAS_WIDTH * 0.6 || size.height >= CANVAS_HEIGHT * 0.6;
    if (hasExplicitSize && isBackgroundScale && size.width >= maxW && size.height >= maxH) return null;
    return {
      index: i, x: pos[0], y: pos[1], width: size.width, height: size.height, isText: layer.type === 'text',
    };
  }).filter(Boolean);
  const parent = overlapEntries.map((_, i) => i);
  function findRoot(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  for (let a = 0; a < overlapEntries.length; a++) {
    for (let b = a + 1; b < overlapEntries.length; b++) {
      const A = overlapEntries[a]; const B = overlapEntries[b];
      const overlapsX = Math.abs(A.x - B.x) < ((A.width + B.width) / 2) * 0.9;
      const overlapsY = Math.abs(A.y - B.y) < ((A.height + B.height) / 2) * 0.9;
      if (overlapsX && overlapsY) { const ra = findRoot(a); const rb = findRoot(b); if (ra !== rb) parent[ra] = rb; }
    }
  }
  const positionGroups = new Map();
  overlapEntries.forEach((e, i) => {
    const root = findRoot(i);
    if (!positionGroups.has(root)) positionGroups.set(root, []);
    positionGroups.get(root).push(e.index);
  });
  for (const indices of positionGroups.values()) {
    if (indices.length <= 1) continue;
    // Real, confirmed-live false positive: a text layer plus its own
    // backdrop card (a shape sized to contain it, sitting at the text's
    // EXACT same position - the common, encouraged "card behind text"
    // pattern) reported an overlap error on its own, with nothing
    // actually wrong on screen. The repair pass above (runOverlapSpreadPass,
    // called via autoRepairBeat before this function ever runs) already
    // recognizes this exact pattern as legitimate and deliberately
    // leaves it untouched - but this independent backstop check had no
    // matching exemption, so it kept hard-failing beats the repair pass
    // had already correctly accepted, forcing a wasted retry with
    // nothing for the model to actually fix (retrying just produces
    // ANOTHER card wide enough to describe its text, which still isn't
    // "background-scale" by this check's own >=60%-of-canvas threshold).
    // Mirrors that same "co-located non-text member(s) are a legitimate
    // backdrop, not a collision" reasoning: a group is only a REAL
    // error if it has 2+ text members (never a legitimate reason for
    // text to sit on text), or if any non-text member sits somewhere
    // OTHER than essentially the exact same spot as the text (a
    // genuinely separate decorative element that happens to collide,
    // not a deliberate pairing).
    const members = indices.map((idx) => overlapEntries.find((e) => e.index === idx));
    const textMembers = members.filter((m) => m.isText);
    const otherMembers = members.filter((m) => !m.isText);
    if (textMembers.length === 1) {
      const t = textMembers[0];
      const genuineOthers = otherMembers.filter((o) => !(
        Math.abs(o.x - t.x) < 5 && Math.abs(o.y - t.y) < 5
      ));
      if (genuineOthers.length === 0) continue;
    }
    errors.push(`${path}.layers: layers at indices [${indices.join(', ')}] render visually overlapped (identical, near-identical, or merely close-enough positions given their own size) - sibling elements need distinct "position" values or they'll render stacked/overlapping instead of spread out (e.g. as a row, grid, or scattered composition). Give each one its own real position.`);
  }

  // Real, confirmed-live bug found across MULTIPLE beats of the same
  // generated video: a text layer's bounding box - centered on its own
  // "position", symmetric +/- maxWidth/2 regardless of "textAlign" (see
  // layoutText's own doc comment in textAnimator.js for exactly why
  // that symmetry holds even for "left"/"right") - placed so far off
  // one edge of the ${CANVAS_WIDTH}x${CANVAS_HEIGHT} canvas that most
  // of the text renders permanently clipped/unreadable for the beat's
  // whole duration. Real example: "position":[71,...] with
  // "maxWidth":459 and "textAlign":"center" - that box spans roughly
  // -158 to 300, nearly a third of a 540px-wide canvas' worth of it off
  // the left edge. This is independent of the animator position-delta
  // bug validateAnimator catches above - even a text layer with NO
  // "animators" at all can still have a base "position" placed this
  // badly. Reuses the exact same representativePosition (resolves a
  // keyframed position to its settled/final value) machinery as the
  // overlap check above for a consistent notion of a layer's own box.
  // Threshold: over a quarter of the box's own size must be off-frame
  // before this fires, so a small, deliberate edge-bleed never trips
  // it - calibrated against the real failing beat that motivated this
  // check (a 459px box on position.x:71, ~34.5% of it off the left
  // edge, which rendered as multiple whole words missing from the
  // start of every line) rather than an arbitrary round number.
  visual.layers.forEach((layer, i) => {
    if (!isPlainObject(layer) || layer.type !== 'text' || layer.parent) return;
    const pos = representativePosition(layer.position);
    if (!pos) return;
    const size = estimateTextEffectiveSize(layer);
    // Real, confirmed-live gap: this used to prefer the WIDEST-
    // simulated-line width (size.actualWidth) over the full "maxWidth"
    // box, specifically to avoid false-flagging short text that never
    // fills its own box. But a live case ("Check this out", maxWidth
    // 200) proved that narrower per-word simulation can UNDERESTIMATE
    // the real wrap - it predicted a 3-line wrap ("Check"/"this"/
    // "out", widest line ~156px) while the real ctx.measureText-based
    // renderer produced a 2-line wrap ("Check"/"this out", the real
    // "this out" together measuring wider than this estimate's
    // per-word sum) - so the "smarter" narrower estimate reported ZERO
    // overflow for a box that, in the real render, was visibly clipped
    // on the left edge. Reverted to "maxWidth" (size.width) - the same
    // "never undercount" conservative ceiling this file already uses
    // for the overlap check, and for the identical reasoning: now that
    // this is a free in-place clamp rather than a costly reject-and-
    // retry, a false positive costs an imperceptible nudge, while a
    // false negative is confirmed-real visible clipping.
    // Math.max with actualWidth (not size.width alone): actualWidth is
    // now uncapped (see estimateTextEffectiveSize) and can legitimately
    // exceed "width" when a single word is wider than its own maxWidth
    // at a large fontSize - taking the max keeps BOTH known-live
    // failure directions covered (maxWidth alone undercounts a real
    // multi-word wrap that merges onto fewer/wider lines than
    // predicted; actualWidth alone undercounts a single oversized word
    // that was being silently capped at maxWidth until now).
    const effWidth = Math.max(1, size.width, size.actualWidth || 0);
    const left = pos[0] - effWidth / 2;
    const right = pos[0] + effWidth / 2;
    const offLeft = Math.max(0, -left);
    const offRight = Math.max(0, right - CANVAS_WIDTH);
    // Self-healing, not just error-reporting: clamps the SETTLED x
    // directly on the layer object AT THE POINT OF DETECTION, rather
    // than relying on a separate earlier autoRepairBeat pass having
    // already fixed it (that two-pass split was found live to have a
    // real synchronization gap - some beats' clamp never actually
    // landed before this check ran, for reasons that traced back to
    // beat-processing order rather than the clamp math itself, which
    // tested correct in isolation every time). Doing the fix HERE,
    // inside the exact same function that detects the problem,
    // eliminates any possibility of that gap recurring: there is only
    // ever one place this can go wrong now, not two that both have to
    // agree. Mutates layer.position in place (or the last keyframe's
    // value, for an animated position - an earlier keyframe, a
    // legitimate off-screen fly-in START point, is left untouched)
    // and does NOT push an error, since the beat is now valid.
    //
    // Threshold/margin, both tightened live after the original 25%-of-
    // box threshold (calibrated back when this only produced an ERROR,
    // where a false-positive genuinely cost a wasted retry) let real
    // clipping through: several confirmed-live cases sat at 0-17% by
    // this file's own char-width ESTIMATE - clean by that threshold -
    // yet the real renderer's actual ctx.measureText glyph widths ran
    // measurably wider, clipping a character or two in the rendered
    // frame anyway. Once this became a free, in-place clamp instead of
    // a costly reject-and-retry, that tradeoff flipped entirely: a
    // false-positive clamp on genuinely fine text is an imperceptible
    // few-pixel nudge, while a false negative is visible clipping - so
    // this now fires on ANY estimated overflow at all (EDGE_SAFETY_PX
    // is just float-precision slop, not a deliberate tolerance), and
    // clamps to a box inset by EDGE_MARGIN_PX from each edge rather
    // than flush against it, to absorb exactly this kind of estimate-
    // vs-real-render gap instead of landing back on the edge itself.
    if (offLeft > EDGE_SAFETY_PX || offRight > EDGE_SAFETY_PX) {
      const halfW = Math.min(effWidth / 2, (CANVAS_WIDTH - EDGE_MARGIN_PX * 2) / 2);
      const clampedX = effWidth + EDGE_MARGIN_PX * 2 >= CANVAS_WIDTH
        ? CANVAS_WIDTH / 2
        : Math.max(EDGE_MARGIN_PX + halfW, Math.min(CANVAS_WIDTH - EDGE_MARGIN_PX - halfW, pos[0]));
      if (isNumberArray(layer.position, 2)) {
        layer.position = [clampedX, layer.position[1]];
      } else if (isPlainObject(layer.position) && Array.isArray(layer.position.keyframes) && layer.position.keyframes.length > 0) {
        const last = layer.position.keyframes[layer.position.keyframes.length - 1];
        if (isPlainObject(last) && isNumberArray(last.value, 2)) last.value = [clampedX, last.value[1]];
      }
    }
    // Re-reads pos[1] fresh in case the horizontal branch above already
    // mutated layer.position (it never touches [1], but pos itself was
    // captured before that mutation) - same self-healing treatment as
    // the horizontal check, same reasoning (see that one's own doc
    // comment for the full synchronization-gap story this replaced).
    const currentPos = representativePosition(layer.position) || pos;
    const top = currentPos[1] - size.height / 2;
    const bottom = currentPos[1] + size.height / 2;
    const offTop = Math.max(0, -top);
    const offBottom = Math.max(0, bottom - CANVAS_HEIGHT);
    if (offTop > EDGE_SAFETY_PX || offBottom > EDGE_SAFETY_PX) {
      const halfH = Math.min(size.height / 2, (CANVAS_HEIGHT - EDGE_MARGIN_PX * 2) / 2);
      const clampedY = size.height + EDGE_MARGIN_PX * 2 >= CANVAS_HEIGHT
        ? CANVAS_HEIGHT / 2
        : Math.max(EDGE_MARGIN_PX + halfH, Math.min(CANVAS_HEIGHT - EDGE_MARGIN_PX - halfH, currentPos[1]));
      if (isNumberArray(layer.position, 2)) {
        layer.position = [layer.position[0], clampedY];
      } else if (isPlainObject(layer.position) && Array.isArray(layer.position.keyframes) && layer.position.keyframes.length > 0) {
        const last = layer.position.keyframes[layer.position.keyframes.length - 1];
        if (isPlainObject(last) && isNumberArray(last.value, 2)) last.value = [last.value[0], clampedY];
      }
    }
  });

  // Same self-healing off-canvas clamp as the text check above, for
  // shape/image layers - a real generation showed a decorative shape
  // clipping up to 173px off the right edge, the identical failure
  // mode text was fixed for earlier this session but never extended to
  // non-text layers. Uses the layer's own literal width/height
  // directly (no wrapping/char-width estimation needed, unlike text),
  // via the shared clampSettledPositionToCanvas helper.
  visual.layers.forEach((layer) => {
    if (!isPlainObject(layer) || layer.parent) return;
    if (layer.type !== 'shape' && layer.type !== 'image') return;
    if (typeof layer.width !== 'number' || typeof layer.height !== 'number') return;
    clampSettledPositionToCanvas(layer, layer.width, layer.height);
  });

  if (visual.transitionIn) validateTransition(visual.transitionIn, `${path}.transitionIn`, errors);

  // Cross-reference parent/trackMatte ids against ids actually declared
  // in this beat - a real, common AI-generation mistake (referencing a
  // typo'd or nonexistent layer id) that's much better caught here,
  // with a clear message, than as a confusing crash deep in sceneBuilder.js.
  const checkRefs = (layer, layerPath) => {
    if (layer.parent && !knownIds.has(layer.parent)) errors.push(`${layerPath}.parent: references unknown layer id "${layer.parent}"`);
    if (layer.trackMatte && layer.trackMatte.source && !knownIds.has(layer.trackMatte.source)) errors.push(`${layerPath}.trackMatte.source: references unknown layer id "${layer.trackMatte.source}"`);
    if (layer.type === 'precomp' && Array.isArray(layer.layers)) layer.layers.forEach((l, i) => checkRefs(l, `${layerPath}.layers[${i}]`));
  };
  visual.layers.forEach((layer, i) => checkRefs(layer, `${path}.layers[${i}]`));
}

/**
 * Mutates `beat` IN PLACE, silently fixing the small set of real,
 * recurring generation mistakes that are SAFE and MECHANICAL to
 * correct - no ambiguity about author intent, no risk of changing what
 * the beat actually looks like beyond fixing the mistake itself. Exists
 * because live testing showed the reject-and-retry loop, while it DOES
 * eventually converge, is too slow for these specific categories:
 * every one of them recurred across MANY separate real generations,
 * each occurrence costing a full extra retry round-trip (a real
 * Mistral call, adaptive-queue spacing, and re-validation) for a
 * mistake this function can fix in microseconds with zero ambiguity.
 * Cutting these out of the retry loop entirely is a direct, measured
 * lever on the actual reported problem (generation taking long enough
 * to hit its own 6-minute hard timeout).
 *
 * Deliberately does NOT attempt to fix anything with NO safe
 * mechanical answer at all (missing shape contents, unresolvable
 * layer/effect types) - those still go through the normal validate-
 * and-retry path. Duplicate positions and content-types-in-"effects"
 * WERE originally left out of this function for the same reason, but
 * live data changed that call: a real production run showed these two
 * were BY FAR the most frequently recurring blockers (duplicate
 * positions alone appeared in nearly every single retry across a
 * whole run that still hit its 6-minute timeout) - "not perfectly
 * ideal" beats a beat's whole generation timing out, so both now get
 * a deterministic, always-reasonable (if not always author-optimal)
 * mechanical fix instead of forcing a full retry every time.
 *
 * Called BEFORE validateBeat, so anything this successfully repairs
 * never even reaches validation as an error, let alone a retry.
 */
/** Absolute cubic bezier control points for one anchor segment - EXACT same convention as engine/path.js's segmentControlPoints (P1 = anchor.point + outTangent if present else anchor.point, P2 = next.point + next.inTangent if present else next.point), duplicated here rather than imported since that lives one level into rendering internals this file otherwise stays clear of - this is pure, tiny, side-effect-free geometry, safe to keep in sync by hand. */
function bezierSegmentControlPoints(a, b) {
  const p0 = a.point;
  const p1 = a.outTangent ? [a.point[0] + a.outTangent[0], a.point[1] + a.outTangent[1]] : a.point;
  const p2 = b.inTangent ? [b.point[0] + b.inTangent[0], b.point[1] + b.inTangent[1]] : b.point;
  const p3 = b.point;
  return [p0, p1, p2, p3];
}
function cubicBezierPointAt(p0, p1, p2, p3, u) {
  const mt = 1 - u;
  const a = mt * mt * mt; const b = 3 * mt * mt * u; const c = 3 * mt * u * u; const d = u * u * u;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}
/** Dense-samples a full open customPath (anchors, 2+) into a cumulative arc-length lookup table, for mapping a "% of the path drawn" fraction to the REAL (x,y) point there - not the naive straight-line distance between anchors, which a curved bezier segment can deviate from substantially. */
function buildBezierArcLengthTable(anchors) {
  const SAMPLES_PER_SEGMENT = 40;
  const segCount = anchors.length - 1;
  const table = [];
  let cum = 0;
  let prev = null;
  for (let seg = 0; seg < segCount; seg++) {
    const [p0, p1, p2, p3] = bezierSegmentControlPoints(anchors[seg], anchors[seg + 1]);
    for (let i = 0; i <= SAMPLES_PER_SEGMENT; i++) {
      if (seg > 0 && i === 0) continue;
      const u = i / SAMPLES_PER_SEGMENT;
      const pt = cubicBezierPointAt(p0, p1, p2, p3, u);
      if (prev) cum += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
      table.push({ point: pt, cumLength: cum });
      prev = pt;
    }
  }
  return { table, totalLength: cum };
}
function pointAtArcFraction(table, totalLength, frac) {
  const target = Math.max(0, Math.min(1, frac)) * totalLength;
  let lo = 0; let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid].cumLength < target) lo = mid + 1; else hi = mid;
  }
  return table[lo].point;
}

/**
 * Auto-attaches a precisely curve-tracking "leading spark" companion
 * layer to any hand-drawn line-reveal shape (a stroke-only, unfilled
 * customPath with a genuinely ANIMATED Trim Paths "end" sweep) that
 * doesn't already have one. Real, confirmed-live gap: hand-authoring a
 * handful of waypoint keyframes to approximate "a dot chasing the
 * line's tip" was tested directly and visibly DRIFTS off the real
 * curve - a straight-line "connect the dots" approximation between a
 * few points never actually traces a bezier's true curved path, and
 * this is real bezier arc-length math (needs dense sampling and a
 * cumulative-length lookup) the model generating this JSON has no way
 * to compute itself. Doing it here, deterministically, in code -
 * reusing the SAME Property/valueAt evaluation the real renderer uses
 * for the trim's own "end", so the spark's pacing exactly matches
 * whatever easing the trim actually uses, not an assumed one -
 * guarantees the spark always sits exactly on the line's own current
 * tip, every time this technique is used, regardless of how well the
 * model itself could ever approximate that by hand.
 */
function attachLineRevealSparks(beat) {
  if (!isPlainObject(beat.visual) || !Array.isArray(beat.visual.layers)) return;
  const layers = beat.visual.layers;
  const additions = [];
  layers.forEach((layer, i) => {
    if (!isPlainObject(layer) || layer.type !== 'shape' || !Array.isArray(layer.contents)) return;
    const nextLayer = layers[i + 1];
    if (isPlainObject(nextLayer) && typeof nextLayer.id === 'string' && typeof layer.id === 'string' && nextLayer.id === `${layer.id}__spark`) return;

    const pathItem = layer.contents.find((c) => isPlainObject(c) && c.type === 'path' && isPlainObject(c.shape) && c.shape.kind === 'customPath');
    const trimItem = layer.contents.find((c) => isPlainObject(c) && c.type === 'trim');
    const strokeItem = layer.contents.find((c) => isPlainObject(c) && c.type === 'stroke');
    const hasFill = layer.contents.some((c) => isPlainObject(c) && c.type === 'fill');
    if (!pathItem || !trimItem || !strokeItem || hasFill) return;

    const anchors = pathItem.shape.params && Array.isArray(pathItem.shape.params.anchors) ? pathItem.shape.params.anchors : null;
    if (!anchors || anchors.length < 2 || anchors.some((a) => !isPlainObject(a) || !isNumberArray(a.point, 2))) return;

    const endVal = trimItem.end;
    if (!isPlainObject(endVal) || !Array.isArray(endVal.keyframes)) return;
    const validKfs = endVal.keyframes.filter((kf) => isPlainObject(kf) && typeof kf.time === 'number' && typeof kf.value === 'number');
    if (validKfs.length < 2) return;

    const pos = representativePosition(layer.position);
    if (!pos) return;

    let endProp;
    try { endProp = new Property(validKfs); } catch (e) { return; }
    const startTime = validKfs[0].time;
    const endTime = validKfs[validKfs.length - 1].time;
    if (endTime <= startTime) return;

    const { table, totalLength } = buildBezierArcLengthTable(anchors);
    if (!(totalLength > 0)) return;

    const N = 20;
    const sparkKeyframes = [];
    for (let k = 0; k <= N; k++) {
      const time = startTime + (k / N) * (endTime - startTime);
      const pctValue = endProp.valueAt(time);
      const frac = typeof pctValue === 'number' ? pctValue / 100 : 0;
      const [lx, ly] = pointAtArcFraction(table, totalLength, frac);
      sparkKeyframes.push({ time: +time.toFixed(4), value: [+(lx + pos[0]).toFixed(2), +(ly + pos[1]).toFixed(2)], interpolation: 'linear' });
    }

    const dotSize = Math.max(10, Math.min(28, (typeof strokeItem.width === 'number' ? strokeItem.width : 6) * 3.2));
    const glowColor = typeof strokeItem.color === 'string' ? strokeItem.color : '#7DF9FF';
    const fadeStart = endTime - (endTime - startTime) * 0.08;

    const sparkLayer = {
      type: 'shape',
      width: dotSize,
      height: dotSize,
      position: { keyframes: sparkKeyframes },
      opacity: {
        keyframes: [
          { time: startTime, value: 1 },
          { time: fadeStart, value: 1 },
          { time: endTime, value: 0, interpolation: 'easing', easing: 'easeInCubic' },
        ],
      },
      contents: [
        { type: 'path', shape: { kind: 'ellipse', params: { width: dotSize, height: dotSize } } },
        { type: 'fill', color: '#FFFFFF' },
      ],
      effects: [
        { type: 'outerGlow', params: { color: glowColor, opacity: 1, blur: dotSize * 1.3, blendMode: 'screen' } },
      ],
    };
    if (typeof layer.id === 'string') sparkLayer.id = `${layer.id}__spark`;
    additions.push({ afterIndex: i, layer: sparkLayer });
  });

  for (let k = additions.length - 1; k >= 0; k--) {
    layers.splice(additions[k].afterIndex + 1, 0, additions[k].layer);
  }
}

function autoRepairBeat(beat) {
  if (!isPlainObject(beat)) return;

  // Real, confirmed-live mistake: "params.duration" missing or
  // malformed entirely (not present, not a number, zero/negative) -
  // rather than force a full retry over one field, defaults to a
  // typical beat length (1.5s, the middle of the 1-2.5s range real
  // beats in this schema actually use) so a real beat with genuinely
  // good content isn't discarded over a single missing number.
  if (!isPlainObject(beat.params)) beat.params = {};
  if (typeof beat.params.duration !== 'number' || beat.params.duration <= 0) beat.params.duration = 1.5;
  // Real, confirmed-live pacing complaint traced to a genuine root
  // cause, not a style preference: the prompt's own "each new piece of
  // TEXT lands roughly every 0.3-1s" stagger-timing guidance (about
  // when successive WORDS/LINES appear within a longer beat) was
  // getting read by the model as "make the WHOLE BEAT 0.3-1s long" for
  // a short, single-phrase beat - confirmed directly: a real video's
  // opening beat was 0.5s, barely enough time for its own entrance
  // animation to finish settling, let alone be read. Floors any beat
  // under MIN_BEAT_DURATION up to it - the prompt's own stagger-timing
  // wording is being reworded separately, this is the mechanical
  // backstop so a too-fast beat can't ship even if that doesn't fully
  // land on its own.
  const MIN_BEAT_DURATION = 1.0;
  if (beat.params.duration < MIN_BEAT_DURATION) beat.params.duration = MIN_BEAT_DURATION;

  if (!isPlainObject(beat.visual)) return;

  const walkLayers = (layers) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      if (!isPlainObject(layer)) continue;

      // Real, confirmed-live bug: the model padded a headline with
      // multiple literal spaces ("3    mind-blowing facts", 4 spaces)
      // presumably trying to visually separate a leading number from
      // the rest of the phrase - renders as an ugly, unintended gap
      // instead. There's no legitimate reason for 2+ consecutive spaces
      // in short-form text content, so this is collapsed unconditionally
      // rather than forcing a retry over whitespace.
      if (layer.type === 'text' && typeof layer.text === 'string' && /\s{2,}/.test(layer.text)) {
        layer.text = layer.text.replace(/\s{2,}/g, ' ');
      }

      // Real, repeatedly-recurring mistake (multiple separate live
      // generations, same shape every time) - converted to auto-repair
      // rather than left as a pure retry-forcing validation error, same
      // reasoning as the font/animator-delta repairs above: this is
      // mechanically safe and unambiguous to fix, so there's no reason
      // to spend a full retry round-trip on it. Clamps the SETTLED x
      // (the plain "position", or the LAST keyframe's value if animated
      // - the actual on-screen landing spot) so the text's own box fits
      // within the canvas, using the same effective-width estimate and
      // 25%-off threshold as validateBeatVisual's own matching check
      // (see its doc comment for the full detection story). Only
      // touches x when the box is genuinely mostly off-frame - a small,
      // deliberate edge position is left completely alone. An earlier
      // keyframe (a legitimate off-screen fly-in START point) is never
      // touched - only a bad LANDING spot gets fixed.
      if (layer.type === 'text' && typeof layer.text === 'string') {
        const size = estimateTextEffectiveSize(layer);
        // Math.max(width, actualWidth) - see validateBeatVisual's own
        // matching check for the full live-confirmed reason this takes
        // the larger of the two rather than either alone.
        const effWidth = Math.max(1, size.width, size.actualWidth || 0);
        const clampX = (x) => {
          // Same tightened threshold/margin as validateBeatVisual's own
          // matching check (this is defense-in-depth for the same
          // problem, see that one's doc comment for the full story).
          if (effWidth + EDGE_MARGIN_PX * 2 >= CANVAS_WIDTH) return CANVAS_WIDTH / 2;
          const left = x - effWidth / 2;
          const right = x + effWidth / 2;
          const offLeft = Math.max(0, -left);
          const offRight = Math.max(0, right - CANVAS_WIDTH);
          if (offLeft <= EDGE_SAFETY_PX && offRight <= EDGE_SAFETY_PX) return x;
          const halfW = Math.min(effWidth / 2, (CANVAS_WIDTH - EDGE_MARGIN_PX * 2) / 2);
          return Math.max(EDGE_MARGIN_PX + halfW, Math.min(CANVAS_WIDTH - EDGE_MARGIN_PX - halfW, x));
        };
        if (isNumberArray(layer.position, 2)) {
          layer.position = [clampX(layer.position[0]), layer.position[1]];
        } else if (isPlainObject(layer.position) && Array.isArray(layer.position.keyframes) && layer.position.keyframes.length > 0) {
          const last = layer.position.keyframes[layer.position.keyframes.length - 1];
          if (isPlainObject(last) && isNumberArray(last.value, 2)) last.value = [clampX(last.value[0]), last.value[1]];
        }
      }

      // Real, repeatedly-recurring mistake across MULTIPLE separate live
      // generations - not just wrong Poppins weights ("Poppins
      // SemiBold") but reaching for a totally different real commercial
      // typeface by name ("Frutiger LT 65 Bold", "Frutiger LT 55 Roman")
      // because it felt right for the content's tone. A full retry over
      // one font name is wasteful given how consistently this recurs
      // and how mechanically safe the fix is: map the INVALID name's own
      // weight-ish keywords onto the closest bundled equivalent (the
      // same instinct - "this needs to look heavy/bold/light" - just
      // pointed at a name that actually exists here), falling back to
      // "Poppins Medium" as the safest default when no weight hint is
      // present at all.
      if (layer.type === 'text' && typeof layer.fontFamily === 'string' && !AVAILABLE_FONT_FAMILIES.includes(layer.fontFamily)) {
        const f = layer.fontFamily.toLowerCase();
        if (/italic|oblique/.test(f)) layer.fontFamily = 'Poppins Italic';
        else if (/black|heavy|900|ultra|extra.?bold/.test(f)) layer.fontFamily = 'Poppins Black';
        else if (/bold|semi.?bold|600|65|70|75|80/.test(f)) layer.fontFamily = 'Poppins Bold';
        else layer.fontFamily = 'Poppins Medium';
      }

      // Real, confirmed-live bug: an icon layer with no width/height
      // renders at its raw rasterized pixel size (can be far larger
      // than intended) and is invisible to overlap detection - see
      // validateLayer's matching check for the full incident. Defaults
      // to a sensible icon size rather than forcing a retry over a
      // single missing pair of numbers.
      if (layer.type === 'image' && typeof layer.icon === 'string'
          && (typeof layer.width !== 'number' || typeof layer.height !== 'number')) {
        if (typeof layer.width !== 'number') layer.width = 100;
        if (typeof layer.height !== 'number') layer.height = 100;
      }

      // Real, repeatedly-recurring family of shape-contents mistakes,
      // all converted to auto-repair rather than left to force a
      // retry: "circle" used as a shape.kind (a real, intuitive name
      // that just isn't one of this schema's five - "ellipse" is the
      // equivalent, remapped here with radius->width/height converted
      // automatically); a "polygon"/"star" missing its required
      // radius/outerRadius/innerRadius (same shape as the existing
      // "points" validation, just given a sane default instead of
      // rejected); and, as a general backstop for anything else this
      // doesn't specifically recognize (an unsalvageable customPath
      // with too few real anchors, an unknown content "type", garbled
      // JSON-corruption artifacts) - sanitizeShapeContents re-runs the
      // REAL validator on each item after attempting the fixups above
      // and drops any item still invalid, rather than trying to
      // enumerate every possible malformed shape by hand. Losing one
      // decorative content item (or, in the worst case, ending up with
      // an empty shape that the layer-list filter below then drops
      // entirely) is a far better outcome than failing the whole beat's
      // generation over it.
      if (layer.type === 'shape' && Array.isArray(layer.contents)) {
        layer.contents = sanitizeShapeContents(layer.contents);
      }

      // Static layer-level opacity:0 alongside a reveal animator -
      // see validateLayer's matching check for the full story. Not
      // scoped to any one layer type since any layer (shape/text/
      // image/generate) can carry "animators" and this same
      // self-defeating mistake.
      if (layer.opacity === 0 && Array.isArray(layer.animators) && layer.animators.length > 0) {
        delete layer.opacity;
      }

      // Real, confirmed-live bug: "stroke" in a layer's "effects" array
      // - the shape-content stroke fix a few lines up (relocating a
      // SHAPE_CONTENT_TYPES item from "effects" into "contents") only
      // ever applies to shape layers, which HAVE a "contents" array to
      // move it into. A text or image layer wanting an outline/stroke
      // around it has no such array - there's nothing to relocate it
      // TO - so this recurred unfixed specifically for those layer
      // types. But "stroke" IS a real, legitimate INTENT here (an
      // AE-style Stroke layer style, outlining the whole layer) - it's
      // just the wrong NAME for it; the real effect is "layerStroke",
      // which takes the same "color"/"width" params a shape-content
      // stroke item already provides (an extra "cap"/"join"/"dash" from
      // that shape-content shape is simply unused by it, not harmful).
      // Renamed in place rather than dropped, on any layer type that
      // doesn't have "contents" to relocate it into instead. EffectDef
      // params live NESTED under "params" (unlike a shape-content
      // item's own flat shape) - confirmed live this matters, not just
      // a style nit: applyEffectToCanvas reads ONLY effectDef.params,
      // so leaving color/width flat on the effect object (matching the
      // shape-content stroke's own shape) would still PASS validation
      // (only "type" is checked) but silently render with every
      // layerStroke param defaulted, discarding whatever color/width
      // was actually specified.
      if (!Array.isArray(layer.contents) && Array.isArray(layer.effects)) {
        layer.effects = layer.effects.map((e) => {
          if (!isPlainObject(e) || e.type !== 'stroke') return e;
          const params = isPlainObject(e.params) ? { ...e.params } : {};
          if (params.color === undefined && e.color !== undefined) params.color = e.color;
          if (params.width === undefined && e.width !== undefined) params.width = e.width;
          return { type: 'layerStroke', params };
        });
      }

      // Real, confirmed-live mistake: a keyframe with a real "time" but
      // no "value" at all (e.g. "rotation.keyframes[2].value" simply
      // absent). Rather than reject the WHOLE property over one
      // incomplete keyframe, drop just that keyframe and keep the rest
      // - only if NONE remain does the property fall through to the
      // "drop the whole field" repair immediately below.
      layer.position = repairKeyframeEasings(repairKeyframesMissingValue(layer.position));
      layer.scale = repairKeyframeEasings(repairKeyframesMissingValue(layer.scale));
      layer.anchor = repairKeyframeEasings(repairKeyframesMissingValue(layer.anchor));
      layer.opacity = repairKeyframeEasings(repairKeyframesMissingValue(layer.opacity));
      layer.rotation = repairKeyframeEasings(repairKeyframesMissingValue(layer.rotation));

      // Real, repeatedly-recurring mistake: "position"/"scale"/"anchor"/
      // "opacity"/"rotation" sent as something matching NONE of the
      // real AnimatableValue shapes (not a number, not the right-size
      // vector, not {keyframes}, not {expression} - e.g. `null`, a
      // bare string, a malformed nested object). Rejecting outright
      // forces a full retry over one field that has a perfectly safe
      // fallback: the engine's own documented default for each
      // (position/anchor [0,0], scale [1,1], opacity 1, rotation 0) -
      // so the field is simply dropped rather than failing the beat.
      if (!isValidAnimatableShape(layer.position, 2)) delete layer.position;
      if (!isValidAnimatableShape(layer.scale, 2)) delete layer.scale;
      if (!isValidAnimatableShape(layer.anchor, 2)) delete layer.anchor;
      if (!isValidAnimatableShape(layer.opacity)) delete layer.opacity;
      if (!isValidAnimatableShape(layer.rotation)) delete layer.rotation;

      // Real, confirmed-live bug found via direct frame inspection of a
      // live generated video: a text layer's STATIC (non-keyframed)
      // "scale" was [3,3] - a permanent 300% zoom applied for the
      // layer's whole time on screen, no animation, from the very
      // first frame. At fontSize 64 that renders at an effective ~192,
      // guaranteed to overflow badly regardless of position - and
      // undetectable by the off-canvas checks above, which estimate
      // effective size from raw fontSize alone with no notion of a
      // scale multiplier on top of it. A KEYFRAMED scale (an
      // intentional pop-in/out animation, e.g. 0.7->1) is completely
      // legitimate and left alone here - only a STATIC value far from
      // neutral is nonsensical, since there's no animation reason for
      // text to sit permanently 3x its own declared size. Reset to
      // neutral [1,1] rather than guessing at what magnitude was
      // actually intended.
      const staticScaleOutOfRange = (v) => (typeof v === 'number' && (v < 0.5 || v > 1.5))
        || (isNumberArray(v, 2) && (v[0] < 0.5 || v[0] > 1.5 || v[1] < 0.5 || v[1] > 1.5));
      if (staticScaleOutOfRange(layer.scale)) delete layer.scale;

      // Real, confirmed-live bug found via direct frame inspection of a
      // live generated video: "crazy" at fontSize 200/maxWidth 480
      // rendered with BOTH edges clipped off the 540px canvas. Real
      // text layout never force-breaks a single word to fit maxWidth,
      // so a short word at a large enough fontSize can end up wider
      // than the canvas itself - and no amount of REPOSITIONING (the
      // off-canvas checks elsewhere in this file) can fix that; even
      // dead-centering a too-wide box still clips both edges equally.
      // Only a real fontSize reduction fixes this at the root, so it's
      // done here, before those checks run, using the same per-word
      // wrap simulation they rely on for detection.
      if (layer.type === 'text' && typeof layer.fontSize === 'number' && layer.fontSize > 0) {
        const maxSafeWidth = CANVAS_WIDTH - EDGE_MARGIN_PX * 2;
        const size = estimateTextEffectiveSize(layer);
        if (size.actualWidth > maxSafeWidth) {
          const shrinkScale = maxSafeWidth / size.actualWidth;
          const oldFontSize = layer.fontSize;
          layer.fontSize = Math.max(12, Math.floor(layer.fontSize * shrinkScale));
          if (typeof layer.lineHeight === 'number') {
            layer.lineHeight = Math.round(layer.lineHeight * (layer.fontSize / oldFontSize));
          }
        }
      }

      // Real, confirmed-live bug found via direct JSON audit of a live
      // generated video (not a style guess): a text layer with NO
      // animated property whatsoever - no "animators" (per-character
      // reveal), no keyframed "opacity"/"scale"/"position"/"rotation" -
      // appears with a hard, instant cut and never moves again for its
      // whole time on screen. The prompt already says "NOTHING IS
      // STATIC" in as many words, but that alone didn't hold - two
      // layers in the same real video ("VOLUME 1", "1 in 5 ocean
      // species") had zero animated properties, confirmed directly in
      // their own JSON. Rather than argue with the model harder about
      // it, inject a real default entrance mechanically: a scale
      // pop-in (0.7->1, easeOutCubic) plus an opacity fade (0->1) over
      // the first ~0.3s of the layer's own life - matches the already-
      // documented SCALE POP-IN pattern, so this is the same motion the
      // model is told to reach for anyway, just guaranteed instead of
      // hoped for. Only fires when truly nothing animated exists at
      // all; any real entrance the model DID author (any one of these
      // four fields, or a real animators array) is left completely
      // alone.
      if (layer.type === 'text') {
        const hasAnimators = Array.isArray(layer.animators) && layer.animators.length > 0;
        const hasKeyframedTransform = ['position', 'scale', 'opacity', 'rotation']
          .some((f) => isPlainObject(layer[f]) && Array.isArray(layer[f].keyframes) && layer[f].keyframes.length > 0);
        if (!hasAnimators && !hasKeyframedTransform) {
          layer.scale = {
            keyframes: [
              { time: 0, value: [0.7, 0.7] },
              { time: 0.3, value: [1, 1], interpolation: 'easing', easing: 'easeOutCubic' },
            ],
          };
          layer.opacity = {
            keyframes: [
              { time: 0, value: 0 },
              { time: 0.2, value: 1, interpolation: 'easing', easing: 'easeOutCubic' },
            ],
          };
        }
      }

      // Real, confirmed-live mistake: a selector's "start"/"end"/
      // "offset"/"amount" sent as something matching none of the real
      // AnimatableValue shapes (a bare string, a malformed object,
      // etc) - same "safe fallback beats a retry" treatment, with each
      // field's own sane literal default (0/100/0/1) rather than a
      // shared one, since these four mean very different things.
      if (Array.isArray(layer.animators)) {
        for (const a of layer.animators) {
          if (isPlainObject(a) && isPlainObject(a.selector)) repairSelectorFields(a.selector);
        }
      }
      if (Array.isArray(layer.highlights)) {
        for (const h of layer.highlights) {
          if (isPlainObject(h) && isPlainObject(h.selector)) repairSelectorFields(h.selector);
        }
      }

      // Real, confirmed-live complaint traced to a concrete cause: a
      // per-character reveal's "end" sweep took a roughly-constant
      // ~0.4-0.5s regardless of how much text it was revealing - a
      // 57-character sentence swept in the same half-second as a
      // 12-character one (9ms/character vs 33ms/character), finishing
      // almost instantly relative to how long a real typewriter effect
      // actually takes. It reads as an imperceptible "pop", not a
      // visible animation - directly what "I'm not seeing a single
      // animation" traced back to. Stretches the sweep's own keyframe
      // TIMES (never which characters get selected) so its total
      // duration scales with the text's real character count at a real
      // typewriter pace, preserving when the reveal STARTS and only
      // extending how long it takes to finish. Also pushes the beat's
      // own duration out far enough to cover the now-longer reveal PLUS
      // real reading time afterward - animating text in slowly is
      // pointless if the beat cuts away before a viewer could actually
      // finish reading it, which is the same root cause behind the
      // separate "scenes moving too fast" complaint.
      // Real, confirmed-live bug found via direct pixel-level testing (a
      // real generated beat rendered to ZERO visible text pixels across
      // its entire duration, not just a slow reveal): a text layer with
      // MULTIPLE opacity-reveal animators (a staggered per-word cascade
      // - three separate range-selector animators, each meant to reveal
      // one word) where animators after the first ALSO animated their
      // own "start" (not just "end"). Once BOTH start and end finish
      // sweeping to their own final values, that animator's own
      // [start,end] window collapses to a single degenerate point
      // (e.g. both settling at 100) - and at that point EVERY character
      // reads as "outside the selected range" for THIS animator (raw
      // selector value 0), which the engine's default invert flips into
      // "fully hidden" (strength 1) for literally every character, not
      // just the one word this animator was meant to target. That
      // negative opacityDelta then permanently overrides whatever the
      // FIRST (correctly-behaving) animator did, re-hiding text that had
      // already finished revealing. Confirmed directly: a word measured
      // opacity 1.0 (fully visible) for one instant mid-sweep, then
      // opacity 0.0 for the entire rest of the beat. The one animator
      // that behaves correctly throughout (start:0, static, never
      // sweeps) never hits this - its own settled [0,100] range covers
      // every character permanently, contributing zero forever after.
      // Rather than try to preserve the FANCIER (broken) moving-window
      // stagger, every opacity-reveal animator's own selector.start is
      // forced back to static 0 here - each animator still keeps its
      // OWN independent "end" sweep timing (already staggered per word/
      // character elsewhere in the treatment), just without the
      // degenerate-collapse failure mode a moving start introduces.
      if (Array.isArray(layer.animators)) {
        for (const a of layer.animators) {
          if (!isPlainObject(a) || !isPlainObject(a.properties) || typeof a.properties.opacity !== 'number') continue;
          if (!isPlainObject(a.selector)) continue;
          if (typeof a.selector.start !== 'number') a.selector.start = 0;
        }
      }

      const MIN_SEC_PER_CHAR = 0.035;
      const MIN_SEC_PER_WORD = 0.18;
      const POST_REVEAL_READ_BUFFER = 1.0;
      if (Array.isArray(layer.animators) && typeof layer.text === 'string' && layer.text.length > 0) {
        const wordCount = Math.max(1, layer.text.split(/\s+/).filter(Boolean).length);
        const requiredSpan = layer.text.length * MIN_SEC_PER_CHAR;
        const requiredSpanByBasis = { characters: requiredSpan, words: wordCount * MIN_SEC_PER_WORD };
        for (const a of layer.animators) {
          if (!isPlainObject(a) || !isPlainObject(a.selector)) continue;
          const basis = a.selector.basedOn;
          if (basis !== 'characters' && basis !== 'words') continue;
          const need = requiredSpanByBasis[basis];
          const end = a.selector.end;
          // Real, confirmed-live bug distinct from "too fast": a
          // selector's own "start"/"end" were BOTH plain static
          // numbers (e.g. start:0, end:100), never animated over time
          // at all - with this engine's own strength math (a character
          // is "selected" whenever it falls within [start,end], and
          // the default invert flips that into strength = 1 - selected
          // for a reveal), a CONSTANT [0,100] range means every
          // character is ALWAYS fully selected, so the inverted
          // strength is a permanent 0 - the whole animator becomes
          // completely inert dead code, contributing zero motion ever,
          // confirmed directly in a real generated layer (its only
          // visible entrance came from the LAYER's own opacity/scale/
          // position keyframes, not this animator at all). Converts a
          // static "end" into a real 0->100 sweep at the same real
          // per-unit pace used below, rather than leaving a per-
          // character/word reveal that silently never happens.
          if (typeof end === 'number') {
            a.selector.end = {
              keyframes: [
                { time: 0, value: 0 },
                { time: need, value: 100, interpolation: 'easing', easing: 'easeOutCubic' },
              ],
            };
            const neededDuration = need + POST_REVEAL_READ_BUFFER;
            if (beat.params.duration < neededDuration) beat.params.duration = neededDuration;
            continue;
          }
          if (!isPlainObject(end) || !Array.isArray(end.keyframes) || end.keyframes.length < 2) continue;
          const kfs = end.keyframes;
          const first = kfs[0];
          const last = kfs[kfs.length - 1];
          if (!isPlainObject(first) || !isPlainObject(last) || typeof first.time !== 'number' || typeof last.time !== 'number') continue;
          if (typeof last.value !== 'number' || last.value < 90) continue;
          const currentSpan = last.time - first.time;
          if (currentSpan <= 0) continue;
          if (currentSpan >= need) continue;
          const scale = need / currentSpan;
          for (const kf of kfs) {
            if (isPlainObject(kf) && typeof kf.time === 'number') kf.time = first.time + (kf.time - first.time) * scale;
          }
          const neededDuration = first.time + need + POST_REVEAL_READ_BUFFER;
          if (beat.params.duration < neededDuration) beat.params.duration = neededDuration;
        }
      }

      // Real, repeatedly-recurring mistake: an animator's "color" sent
      // as an object instead of a hex string (e.g. a stray gradient-
      // shaped {from,to}, or some other nested value) - salvages a real
      // hex from a couple of plausible common shapes before giving up
      // and dropping the property entirely (falls back to the layer's
      // own fillStyle, same as never setting a color accent at all).
      if (Array.isArray(layer.animators)) {
        for (const a of layer.animators) {
          if (!isPlainObject(a) || !isPlainObject(a.properties)) continue;
          const c = a.properties.color;
          if (c !== undefined && typeof c !== 'string') {
            const salvaged = (isPlainObject(c) && HEX_COLOR_RE.test(c.from) && c.from)
              || (isPlainObject(c) && HEX_COLOR_RE.test(c.color) && c.color)
              || (isPlainObject(c) && HEX_COLOR_RE.test(c.hex) && c.hex)
              || null;
            if (salvaged) a.properties.color = salvaged;
            else delete a.properties.color;
          }
        }
      }

      // Real, EXTREMELY common mistake (confirmed across near-every
      // retry of a live run, on position AND scale AND opacity alike):
      // "properties.position/scale/rotation/opacity" sent as a full
      // keyframed {"keyframes":[...]} AnimatableValue - the shape
      // that's correct for a LAYER's own top-level transform, but wrong
      // here (see validateAnimator's own doc comment for the exact
      // render-breaking result: the delta silently becomes 0/undefined
      // and the character never moves). The model's intent is
      // unambiguous every time this has been seen live: it's using
      // keyframes to express "starts offset by X, settles at neutral" -
      // exactly what a flat delta plus the selector's own strength
      // sweep already does automatically. Rejecting outright forces a
      // full retry over a mistake this consistent and this mechanically
      // cheap to fix, and a live run confirmed the model does NOT
      // reliably self-correct even after seeing the validation error
      // message repeatedly - so this salvages the KEYFRAME FARTHEST
      // FROM NEUTRAL (the "still hidden/offset" extreme, which is
      // always the non-settled one) as the flat delta instead.
      if (Array.isArray(layer.animators)) {
        for (const a of layer.animators) {
          if (!isPlainObject(a) || !isPlainObject(a.properties)) continue;
          if (a.properties.position !== undefined) {
            a.properties.position = salvageAnimatorDelta(a.properties.position, [0, 0]);
            // A live run confirmed the model invents OTHER malformed
            // shapes beyond the two salvageAnimatorDelta recognizes
            // (e.g. {"expression":...}, or something too garbled to be
            // either) - rather than try to enumerate every variant,
            // anything still not a valid flat value after the salvage
            // attempt is simply dropped (loses one decorative
            // per-character effect on one layer), matching this same
            // function's own established philosophy for a malformed
            // layer-level transform just above. Guarantees this whole
            // category of mistake can never cost a retry again.
            if (!isNumberArray(a.properties.position, 2)) delete a.properties.position;
          }
          // Real, recurring mistake, distinct from the malformed-shape
          // one above: a genuinely flat [dx,dy] delta whose MAGNITUDE
          // is just too large (e.g. [-180,0] against the 150px cap -
          // see MAX_TEXT_ANIMATOR_POSITION_DELTA's own doc comment for
          // why that ceiling exists). Clamping each axis to the cap
          // preserves the model's own intended DIRECTION of travel
          // (still the same "reveal sweeps in from this side" effect,
          // just at a magnitude that won't garble still-transitioning
          // characters) rather than rejecting a value that's correct
          // in every way except size.
          if (Array.isArray(a.properties.position)) {
            a.properties.position = a.properties.position.map(
              (v) => Math.max(-MAX_TEXT_ANIMATOR_POSITION_DELTA, Math.min(MAX_TEXT_ANIMATOR_POSITION_DELTA, v)),
            );
          }
          if (a.properties.scale !== undefined) {
            a.properties.scale = salvageAnimatorDelta(a.properties.scale, 1);
            if (typeof a.properties.scale !== 'number') delete a.properties.scale;
          }
          if (a.properties.rotation !== undefined) {
            a.properties.rotation = salvageAnimatorDelta(a.properties.rotation, 0);
            if (typeof a.properties.rotation !== 'number') delete a.properties.rotation;
          }
          if (a.properties.opacity !== undefined) {
            a.properties.opacity = salvageAnimatorDelta(a.properties.opacity, 0);
            if (typeof a.properties.opacity !== 'number') delete a.properties.opacity;
          }
        }
      }

      // Real, repeatedly-recurring mistake: an "animators"/"highlights"
      // entry missing its "selector" entirely - there is no safe way
      // to guess what selector was intended, so the whole malformed
      // entry is dropped (loses one decorative effect on this layer,
      // not the whole beat) rather than rejected outright.
      if (Array.isArray(layer.animators)) {
        layer.animators = layer.animators.filter((a) => isPlainObject(a) && isPlainObject(a.selector));
      }
      if (Array.isArray(layer.highlights)) {
        layer.highlights = layer.highlights.filter((h) => isPlainObject(h) && isPlainObject(h.selector));
      }

      if (layer.type === 'shape') {
        // Missing top-level width/height, derivable from the shape's
        // own first sized path content - the exact real pattern found
        // live: the AI puts width/height on the rectangle/ellipse's
        // own shape.params but forgets the separate layer-level
        // requirement, even though the numbers are RIGHT THERE one
        // level down.
        if ((typeof layer.width !== 'number' || typeof layer.height !== 'number') && Array.isArray(layer.contents)) {
          const firstPath = layer.contents.find((item) => isPlainObject(item) && item.type === 'path'
            && isPlainObject(item.shape) && isPlainObject(item.shape.params));
          const p = firstPath && firstPath.shape.params;
          let derivedW; let derivedH;
          if (p && typeof p.width === 'number' && typeof p.height === 'number') {
            // rectangle/ellipse: width/height are already right there.
            derivedW = p.width; derivedH = p.height;
          } else if (firstPath && firstPath.shape.kind === 'polygon' && p && typeof p.radius === 'number') {
            // A regular polygon's bounding box is its own circumscribed
            // circle - 2x radius in both dimensions is a safe upper
            // bound, exactly matching what sanitizeShapeContents's own
            // default radius (50) would also produce if that ran first.
            derivedW = p.radius * 2; derivedH = p.radius * 2;
          } else if (firstPath && firstPath.shape.kind === 'star' && p && typeof p.outerRadius === 'number') {
            derivedW = p.outerRadius * 2; derivedH = p.outerRadius * 2;
          } else if (firstPath && firstPath.shape.kind === 'customPath' && Array.isArray(p && p.anchors)) {
            // A hand-drawn path has no declared width/height anywhere -
            // derive a real bounding box from its own anchor points,
            // the only geometry actually available.
            const xs = p.anchors.filter((a) => isPlainObject(a) && isNumberArray(a.point, 2)).map((a) => a.point[0]);
            const ys = p.anchors.filter((a) => isPlainObject(a) && isNumberArray(a.point, 2)).map((a) => a.point[1]);
            if (xs.length >= 2) {
              derivedW = Math.max(1, Math.max(...xs) - Math.min(...xs));
              derivedH = Math.max(1, Math.max(...ys) - Math.min(...ys));
            }
          }
          // Nothing informative to derive from at all (e.g. every
          // content item was already stripped by sanitizeShapeContents,
          // or a shape kind this doesn't specifically handle) - a
          // generic default beats forcing a retry over two numbers.
          if (derivedW === undefined || derivedH === undefined) { derivedW = 100; derivedH = 100; }
          if (typeof layer.width !== 'number') layer.width = derivedW;
          if (typeof layer.height !== 'number') layer.height = derivedH;
        }

        // Backwards anchor (~half the shape's own width/height) -
        // the confirmed-live "trying to center it, got it backwards"
        // mistake. [0,0] is the genuinely correct centering anchor for
        // a shape layer (see the identical check in validateLayer's
        // own doc comment for the full story).
        if (Array.isArray(layer.anchor) && typeof layer.width === 'number' && typeof layer.height === 'number') {
          const [ax, ay] = layer.anchor;
          const halfW = layer.width / 2, halfH = layer.height / 2;
          if (typeof ax === 'number' && typeof ay === 'number' && ax > 0 && ay > 0
              && Math.abs(ax - halfW) < halfW * 0.3 && Math.abs(ay - halfH) < halfH * 0.3) {
            layer.anchor = [0, 0];
          }
        }

        // Malformed customPath anchor points - confirmed live to recur
        // across multiple retries (different beats, different anchor
        // indices) without converging, because the old error message
        // gave the model no signal about what it actually sent. Two
        // mechanical mistakes are safe to silently fix: (a) a bare
        // [x,y] array used AS the anchor entry itself, instead of the
        // required {"point":[x,y]} object wrapper - an easy confusion
        // given polygon/star's OWN params use plain coordinate-shaped
        // values elsewhere in this same shape vocabulary; (b) "point"
        // given as {"x":..,"y":..} instead of a [x,y] array - the
        // single most common coordinate-shape mistake throughout this
        // whole schema. Anything else (missing point entirely, a
        // keyframed/expression value, etc.) is left alone - validation
        // still catches and clearly messages it, this only handles the
        // two shapes worth guessing at automatically.
        if (Array.isArray(layer.contents)) {
          for (const item of layer.contents) {
            if (isPlainObject(item) && item.type === 'path' && isPlainObject(item.shape) && item.shape.kind === 'customPath'
                && isPlainObject(item.shape.params) && Array.isArray(item.shape.params.anchors)) {
              item.shape.params.anchors = item.shape.params.anchors.map((a) => {
                if (isNumberArray(a, 2)) return { point: a };
                if (isPlainObject(a) && isPlainObject(a.point)
                    && typeof a.point.x === 'number' && typeof a.point.y === 'number') {
                  return { ...a, point: [a.point.x, a.point.y] };
                }
                return a;
              });
            }
          }
        }

        // Effect-type items misplaced inside "contents" (e.g.
        // "outerGlow"/"dropShadow" appearing as a contents entry) -
        // relocated to the layer's own "effects" array, where the
        // object's own {type,params} shape already matches exactly
        // what an EffectDef looks like, no reshaping needed.
        if (Array.isArray(layer.contents)) {
          const misplacedEffects = layer.contents.filter((item) => isPlainObject(item) && EFFECT_TYPES.includes(item.type));
          if (misplacedEffects.length > 0) {
            layer.contents = layer.contents.filter((item) => !(isPlainObject(item) && EFFECT_TYPES.includes(item.type)));
            layer.effects = [...(Array.isArray(layer.effects) ? layer.effects : []), ...misplacedEffects];
          }
        }

        // The mirror image - content-type items (by far most often
        // "trim"/"repeater") misplaced inside the layer's "effects"
        // array. Relocated to the END of "contents" rather than left
        // for a retry: contents ORDER genuinely matters for path/trim/
        // fill/stroke sequencing, so appending isn't guaranteed to be
        // exactly the position the author intended - but a trim/
        // repeater applied to "whatever paths already exist above it"
        // is a coherent, non-crashing, generally-sensible placement in
        // the overwhelmingly common case, and confirmed live to be by
        // far the single most frequently recurring blocker of all - a
        // less-than-perfect but valid contents order beats forcing a
        // full beat retry over it every time.
        if (Array.isArray(layer.effects)) {
          const misplacedContent = layer.effects.filter((item) => isPlainObject(item) && SHAPE_CONTENT_TYPES.includes(item.type));
          if (misplacedContent.length > 0) {
            layer.effects = layer.effects.filter((item) => !(isPlainObject(item) && SHAPE_CONTENT_TYPES.includes(item.type)));
            layer.contents = [...(Array.isArray(layer.contents) ? layer.contents : []), ...misplacedContent];
          }
        }
      }

      if (layer.type === 'text') {
        // Missing/oversized "maxWidth" - the renderer's own fallback is
        // now comp-width-safe (see sceneBuilder.js's buildTextDraw), but
        // an EXPLICIT value the AI sets itself (e.g. copying a stray
        // 900) isn't covered by that fallback at all, so clamp it here
        // too rather than trusting every generation to pick a sane one.
        if (typeof layer.maxWidth !== 'number' || layer.maxWidth > DEFAULT_TEXT_MAX_WIDTH) {
          layer.maxWidth = DEFAULT_TEXT_MAX_WIDTH;
        }
        // Real, confirmed-live bug: "lineHeight" is documented and
        // consumed EVERYWHERE (sceneBuilder.js, textAnimator.js) as an
        // ABSOLUTE PIXEL value, but the AI sometimes writes a CSS-style
        // unitless multiplier instead (e.g. "lineHeight":1.2, clearly
        // meaning "1.2x the font size"). Since a truthy lineHeight is
        // always used AS-IS (never multiplied by fontSize), this makes
        // every wrapped line render almost exactly on top of the next,
        // AND (found via direct investigation of a real duplicate-text
        // bug this was silently causing) makes estimateTextEffectiveSize
        // think a whole line is ~1px tall instead of ~70px - shrinking
        // the overlap-detection threshold to nearly zero and letting a
        // genuinely overlapping pair of text layers slip through
        // undetected entirely. A real per-line pixel height is
        // essentially always >= the font size itself (typically
        // 1.0-1.6x it); anything under half the font size is
        // unambiguously a stray multiplier, not pixels, so it's
        // rescaled by fontSize here rather than just discarded -
        // preserving the AI's actual intended spacing ratio.
        if (typeof layer.lineHeight === 'number' && typeof layer.fontSize === 'number'
            && layer.lineHeight > 0 && layer.lineHeight < layer.fontSize * 0.5) {
          layer.lineHeight *= layer.fontSize;
        }
      }

      if (layer.type === 'text' && Array.isArray(layer.anchor)) {
        // Backwards anchor, text-layer version of the shape fix above -
        // see estimateTextEffectiveSize's doc comment and the matching
        // validateLayer check for the full story.
        const [ax, ay] = layer.anchor;
        const { width: effW, height: effH } = estimateTextEffectiveSize(layer);
        const halfW = effW / 2, halfH = effH / 2;
        if (typeof ax === 'number' && typeof ay === 'number' && ax > 0 && ay > 0
            && Math.abs(ax - halfW) < halfW * 0.3 && Math.abs(ay - halfH) < halfH * 0.6) {
          layer.anchor = [0, 0];
        }
      }

      if (Array.isArray(layer.effects)) {
        // Effect entries with a "type" that isn't a real effect AND
        // has no other real, single, unambiguous destination anywhere
        // in the schema (a hallucinated name like "wiggle"/
        // "expression"/"blendMode" - none of these are ever correct
        // ANYWHERE, unlike "trim"/"gradientRamp" which at least belong
        // somewhere) are dropped outright - losing one stylistic
        // effect on one layer is a far smaller change than failing the
        // whole beat and forcing a full regeneration over it.
        const NEVER_VALID_ANYWHERE = new Set(['wiggle', 'expression', 'blendMode', 'transform', 'adjustment', 'adjustmentLayer']);
        layer.effects = layer.effects.filter((e) => {
          if (!isPlainObject(e)) return false;
          if (GENERATE_KINDS.includes(e.type)) return false; // e.g. "gradientRamp" used as an effect - no safe move target, drop it
          if (NEVER_VALID_ANYWHERE.has(e.type)) return false;
          return true;
        });
      }

      // Real, repeatedly-recurring mistake across many live runs: a
      // "wiggly" selector paired with a "position" property delta never
      // settles (every character stays perpetually jittered), which
      // validateAnimator already hard-rejects - but rejecting it forces
      // a full retry for something mechanically fixable in place: strip
      // just the "position" delta (keep any opacity/scale delta on the
      // same animator untouched), converting an invalid animator into a
      // valid, still-decorative one instead of failing the whole beat.
      if (Array.isArray(layer.animators)) {
        for (const a of layer.animators) {
          if (isPlainObject(a) && isPlainObject(a.selector) && a.selector.type === 'wiggly'
              && isPlainObject(a.properties) && a.properties.position !== undefined) {
            delete a.properties.position;
          }
        }
      }

      // Real, repeatedly-recurring mistake: a "highlights" entry's
      // "gradient" missing "from"/"to" or using a non-hex value -
      // rejecting outright forces a full retry over one cosmetic field.
      // Falls back to a flat solid color instead (the gradient's own
      // "from" if it's a real hex, else the layer's own fillStyle, else
      // a safe default) - loses only the gradient effect, not the
      // whole highlight or the whole beat.
      if (Array.isArray(layer.highlights)) {
        for (const h of layer.highlights) {
          if (!isPlainObject(h)) continue;
          const gradOk = isPlainObject(h.gradient) && HEX_COLOR_RE.test(h.gradient.from) && HEX_COLOR_RE.test(h.gradient.to);
          if (h.gradient !== undefined && !gradOk && !HEX_COLOR_RE.test(h.color)) {
            const salvaged = (isPlainObject(h.gradient) && HEX_COLOR_RE.test(h.gradient.from) && h.gradient.from)
              || (typeof layer.fillStyle === 'string' && HEX_COLOR_RE.test(layer.fillStyle) && layer.fillStyle)
              || '#ffe066';
            delete h.gradient;
            h.color = salvaged;
          }
        }
      }

      if (layer.type === 'precomp') walkLayers(layer.layers);
    }
  };

  if (isPlainObject(beat.visual.background)) {
    beat.visual.background = enforceGradientBackground(beat.visual.background);
    walkLayers([beat.visual.background]);
  }
  walkLayers(beat.visual.layers);

  // Real, repeatedly-recurring mistake needing array-level (not per-
  // layer) surgery, so handled here rather than inside walkLayers:
  //
  // 1. A layer entry that isn't even a real object, or has no real
  //    "type" - confirmed live as `null`/`{}`-shaped stray entries,
  //    almost certainly a truncated or malformed generation artifact.
  //    Nothing about a single uninterpretable layer is worth failing
  //    the WHOLE beat's retry over - dropped outright, same tradeoff
  //    philosophy as every other auto-repair here (a beat with one
  //    fewer decorative element beats a full regeneration).
  // 2. Two or more text layers sharing the EXACT SAME "text" string -
  //    confirmed live, repeatedly, as a "plain copy + accented copy"
  //    pattern (see the matching hard-validation check's own doc
  //    comment for the real incident) with no legitimate use in this
  //    schema. Rather than reject-and-retry, merged automatically: the
  //    first occurrence is kept and absorbs every later duplicate's
  //    own "animators"/"highlights" entries (so an intended accent
  //    isn't silently lost, just correctly consolidated onto the one
  //    real layer), the duplicates are removed entirely.
  // 3. A "type":"text" layer with a missing/empty "text" - confirmed
  //    live, repeatedly, as its own separate failure from #2 (not a
  //    duplicate of anything, just genuinely empty). There is no safe
  //    way to fabricate real words the model never wrote, so - same
  //    tradeoff as #1 - the layer itself is dropped rather than
  //    failing the whole beat over one missing piece of text.
  if (Array.isArray(beat.visual.layers)) {
    beat.visual.layers = beat.visual.layers.filter((l) => isPlainObject(l) && LAYER_TYPES.includes(l.type)
      && !(l.type === 'text' && (typeof l.text !== 'string' || l.text.trim().length === 0))
      // A shape layer whose contents sanitizeShapeContents just
      // reduced to nothing (every item was unsalvageable), OR that
      // never had a real "contents" array at all (a genuinely
      // different mistake, confirmed live - "contents" simply missing/
      // not-an-array, nothing to sanitize) - either way there's no
      // real content left to draw, so the layer is dropped outright
      // rather than left as a dead one that draws nothing for its
      // whole time on screen.
      && !(l.type === 'shape' && (!Array.isArray(l.contents) || l.contents.length === 0)));

    const firstByText = new Map();
    const toRemove = new Set();
    beat.visual.layers.forEach((layer, i) => {
      if (layer.type !== 'text' || typeof layer.text !== 'string') return;
      const key = layer.text.trim().toLowerCase();
      if (!key) return;
      if (!firstByText.has(key)) { firstByText.set(key, layer); return; }
      const original = firstByText.get(key);
      if (Array.isArray(layer.animators) && layer.animators.length > 0) {
        original.animators = [...(Array.isArray(original.animators) ? original.animators : []), ...layer.animators];
      }
      if (Array.isArray(layer.highlights) && layer.highlights.length > 0) {
        original.highlights = [...(Array.isArray(original.highlights) ? original.highlights : []), ...layer.highlights];
      }
      toRemove.add(i);
    });
    if (toRemove.size > 0) {
      beat.visual.layers = beat.visual.layers.filter((_, i) => !toRemove.has(i));
    }

    // Real, confirmed-live gap: the prompt documents a drop shadow on
    // every beat's dominant headline as effectively required (a large
    // part of what makes text read as "designed" rather than "pasted-
    // on" per direct reference comparison), but a live generation
    // audit found it landing on only 1 of 8 beats - prompt instruction
    // alone isn't reliable here, the same story as every other rule
    // this session that ended up needing a mechanical backstop. Rather
    // than just document it harder again, inject it directly: find
    // each beat's own DOMINANT text layer(s) - every top-level text
    // layer whose "fontSize" is at least 95% of the beat's own largest
    // (not just a single strict-max pick) - and give each a real
    // dropShadow if it doesn't already have one. The 95% tie-tolerance
    // matters: a real generation split one headline across two same-
    // size lines as separate layers ("facts about" / "the", both
    // fontSize 42, likely for staggered per-line reveal timing) and a
    // strict single-max pick left the second line completely flat
    // while its own sibling line right above it had real depth -
    // visibly inconsistent within what reads as ONE headline. Nested
    // precomp text isn't "the beat's own" headline in the same sense,
    // so this only looks at beat.visual.layers directly. Skips a beat
    // with no text at all (a pure icon/shape moment) and never touches
    // a layer that already has its own dropShadow (an explicit small/
    // secondary opacity or blur choice from the model is left alone).
    const beatTextLayers = beat.visual.layers.filter((l) => isPlainObject(l) && l.type === 'text' && typeof l.fontSize === 'number');
    if (beatTextLayers.length > 0) {
      const maxFontSize = Math.max(...beatTextLayers.map((l) => l.fontSize));
      const dominantLayers = beatTextLayers.filter((l) => l.fontSize >= maxFontSize * 0.95);
      dominantLayers.forEach((dominant) => {
      const hasShadow = Array.isArray(dominant.effects) && dominant.effects.some((e) => isPlainObject(e) && e.type === 'dropShadow');
      if (!hasShadow) {
        if (!Array.isArray(dominant.effects)) dominant.effects = [];
        dominant.effects.push({
          type: 'dropShadow', params: {
            color: '#000000', blur: 8, offsetX: 0, offsetY: 6, opacity: 0.4,
          },
        });
      }
      });
    }
  }

  autoSpreadDuplicatePositions(beat.visual);
  attachLineRevealSparks(beat);
}

/**
 * Auto-fixes the "sibling layers left at an identical position" case
 * (confirmed live to be the single most frequently recurring blocker
 * of all - it showed up in nearly every retry across a whole real
 * production run that still hit its own 6-minute timeout). Mirrors
 * validateBeatVisual's OWN detection heuristic exactly (same "exempt
 * anything tied for the beat's largest explicit size, or with no
 * explicit size at all" logic - see that function's doc comment for
 * why: full-frame overlay/matte layers legitimately share a position,
 * that's normal compositing, not this bug), so this only ever touches
 * layers the validator would ALSO have flagged.
 *
 * The fix itself is a plain, deterministic horizontal row centered on
 * the group's original shared position - not necessarily the exact
 * layout the AI would have chosen on a real retry, but a real,
 * non-overlapping spread beats forcing a full beat regeneration over
 * something this mechanical every single time.
 */
/** A layer's own size for duplicate-position detection - explicit width/height for shape/image layers, ESTIMATED for text (which never carries a literal width/height field at all). Returns null when neither is available. */
function sizeForSpreadCheck(layer) {
  if (typeof layer.width === 'number' && typeof layer.height === 'number') return { width: layer.width, height: layer.height };
  if (layer.type === 'text') return estimateTextEffectiveSize(layer);
  return null;
}

/**
 * A REPRESENTATIVE resolved [x,y] for overlap purposes - the plain
 * value directly for a static position, or the LAST keyframe's value
 * for an animated one (its settled/resting spot, what it shows for
 * most of its actual on-screen time once any entrance finishes - the
 * same "final frame" convention already used elsewhere in this file/
 * renderEngine.js for a frozen reference point). Real, confirmed-live
 * gap this exists to close: overlap detection used to require an
 * EXACT `isNumberArray` match, which only ever looked at plain [x,y]
 * arrays - any keyframed position (an entrance animation, extremely
 * common) was invisible to it entirely, regardless of where it
 * actually settled. Returns null for anything unusable (an expression,
 * a keyframe with a non-numeric value, no keyframes at all).
 */
function representativePosition(position) {
  if (isNumberArray(position, 2)) return position;
  if (isPlainObject(position) && Array.isArray(position.keyframes) && position.keyframes.length > 0) {
    const last = position.keyframes[position.keyframes.length - 1];
    if (isPlainObject(last) && isNumberArray(last.value, 2)) return last.value;
  }
  return null;
}

/**
 * Self-healing off-canvas clamp, shared by the text AND shape/image
 * off-canvas checks in validateBeatVisual (originally written once for
 * text, then found to apply equally to shape/image layers once a live
 * generation showed decorative shapes clipping off the right edge just
 * as badly as text ever did - factored out here rather than copied a
 * third time). Mutates layer.position in place - the plain value, or
 * the LAST keyframe's value for an animated position (an earlier
 * keyframe, a legitimate off-screen fly-in START point, is left
 * untouched) - clamping the SETTLED [x,y] so a box of `effWidth` x
 * `effHeight` centered on it stays inset by EDGE_MARGIN_PX from every
 * canvas edge. Fires on essentially any overflow (EDGE_SAFETY_PX is
 * pure float-precision slop, not a deliberate tolerance) since this is
 * a free in-place nudge, not a costly reject-and-retry - see the
 * original text-only version's own doc comment (still on the text
 * check below) for the full story on why that threshold is this tight.
 */
function clampSettledPositionToCanvas(layer, effWidth, effHeight) {
  const pos = representativePosition(layer.position);
  if (!pos) return;
  const left = pos[0] - effWidth / 2;
  const right = pos[0] + effWidth / 2;
  const offLeft = Math.max(0, -left);
  const offRight = Math.max(0, right - CANVAS_WIDTH);
  let x = pos[0];
  if (offLeft > EDGE_SAFETY_PX || offRight > EDGE_SAFETY_PX) {
    const halfW = Math.min(effWidth / 2, (CANVAS_WIDTH - EDGE_MARGIN_PX * 2) / 2);
    x = effWidth + EDGE_MARGIN_PX * 2 >= CANVAS_WIDTH
      ? CANVAS_WIDTH / 2
      : Math.max(EDGE_MARGIN_PX + halfW, Math.min(CANVAS_WIDTH - EDGE_MARGIN_PX - halfW, pos[0]));
  }
  const top = pos[1] - effHeight / 2;
  const bottom = pos[1] + effHeight / 2;
  const offTop = Math.max(0, -top);
  const offBottom = Math.max(0, bottom - CANVAS_HEIGHT);
  let y = pos[1];
  if (offTop > EDGE_SAFETY_PX || offBottom > EDGE_SAFETY_PX) {
    const halfH = Math.min(effHeight / 2, (CANVAS_HEIGHT - EDGE_MARGIN_PX * 2) / 2);
    y = effHeight + EDGE_MARGIN_PX * 2 >= CANVAS_HEIGHT
      ? CANVAS_HEIGHT / 2
      : Math.max(EDGE_MARGIN_PX + halfH, Math.min(CANVAS_HEIGHT - EDGE_MARGIN_PX - halfH, pos[1]));
  }
  if (x === pos[0] && y === pos[1]) return;
  if (isNumberArray(layer.position, 2)) {
    layer.position = [x, y];
  } else if (isPlainObject(layer.position) && Array.isArray(layer.position.keyframes) && layer.position.keyframes.length > 0) {
    const last = layer.position.keyframes[layer.position.keyframes.length - 1];
    if (isPlainObject(last) && isNumberArray(last.value, 2)) last.value = [x, y];
  }
}

/** Shifts a layer's own position by [dx,dy] - every keyframe's value for an animated position (preserving the animation's own shape/timing, just moving the whole path to a new resting spot), or the value directly for a static one. */
function shiftLayerPosition(layer, dx, dy) {
  if (isNumberArray(layer.position, 2)) {
    layer.position = [layer.position[0] + dx, layer.position[1] + dy];
  } else if (isPlainObject(layer.position) && Array.isArray(layer.position.keyframes)) {
    layer.position.keyframes.forEach((kf) => {
      if (isPlainObject(kf) && isNumberArray(kf.value, 2)) kf.value = [kf.value[0] + dx, kf.value[1] + dy];
    });
  }
}

/**
 * Detects and mechanically fixes layers that render visually
 * overlapped - a real, confirmed-live, extremely common mistake:
 * several text layers meant to read as separate lines/words of one
 * headline, left at identical OR merely close-enough positions that
 * their estimated bounding boxes overlap anyway (e.g. two 60px-font
 * lines only 12px apart in y - nowhere near identical, but still
 * fully overlapping on screen). Detection is a real AABB overlap
 * test (not exact-position matching, which misses exactly this kind
 * of near-miss and misses every keyframed/animated position outright
 * - see representativePosition's own doc comment), grouped via
 * union-find since overlap isn't naturally transitive-by-equality the
 * way identical positions were.
 *
 * Run in a bounded loop (see autoSpreadDuplicatePositions below), not
 * just once - confirmed necessary live: repositioning one overlapping
 * GROUP can land it newly overlapping a layer that was never part of
 * that group in the first place (its original, pre-repair position
 * didn't overlap anything, only its NEW one does), which a single
 * pass has no way to notice or correct.
 */
function runOverlapSpreadPass(visual) {
  if (!Array.isArray(visual.layers)) return false;
  // The "exempt the largest" background-protection rule only makes
  // sense for a layer with an EXPLICIT width/height (a real,
  // deliberate full-frame background/overlay choosing to share space
  // with another full-frame layer) - text has no legitimate "meant to
  // overlap" case, so its max is tracked SEPARATELY and text is never
  // exempted by it, no matter how large its own estimated size is
  // relative to other text in the beat. Confirmed necessary live:
  // without this split, two same-fontSize headline words tied for
  // "largest" both got wrongly treated as an intentional shared-
  // position pair and were left fully overlapping.
  const explicitSized = visual.layers.filter((l) => isPlainObject(l) && typeof l.width === 'number' && typeof l.height === 'number');
  const maxW = explicitSized.length ? Math.max(...explicitSized.map((l) => l.width)) : 0;
  const maxH = explicitSized.length ? Math.max(...explicitSized.map((l) => l.height)) : 0;

  const entries = visual.layers.map((layer, i) => {
    if (!isPlainObject(layer) || layer.parent) return null;
    const pos = representativePosition(layer.position);
    if (!pos) return null;
    const size = sizeForSpreadCheck(layer);
    if (!size) return null;
    const hasExplicitSize = typeof layer.width === 'number' && typeof layer.height === 'number';
    // Same absolute-scale requirement as the matching check in
    // validateBeatVisual above - see that one's doc comment for the
    // full story (a small decorative shape trivially exempting itself
    // when it's the only explicitly-sized layer in the beat).
    const isBackgroundScale = size.width >= CANVAS_WIDTH * 0.6 || size.height >= CANVAS_HEIGHT * 0.6;
    if (hasExplicitSize && isBackgroundScale && size.width >= maxW && size.height >= maxH) return null;
    return {
      index: i, x: pos[0], y: pos[1], width: size.width, height: size.height, isText: layer.type === 'text',
    };
  }).filter(Boolean);

  // Union-find over pairwise AABB overlap. Each box is shrunk to 90%
  // before testing - loose enough that a real, borderline near-miss
  // (found live: a 2-line-wrapped headline whose true footprint a
  // rough single-line height ESTIMATE understates) still gets pulled
  // into the same group and repositioned together, while still
  // leaving room for two boxes that are clearly, deliberately spaced
  // apart to be left alone.
  const parent = entries.map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const A = entries[a]; const B = entries[b];
      const overlapsX = Math.abs(A.x - B.x) < ((A.width + B.width) / 2) * 0.9;
      const overlapsY = Math.abs(A.y - B.y) < ((A.height + B.height) / 2) * 0.9;
      if (overlapsX && overlapsY) union(a, b);
    }
  }
  const groups = new Map();
  entries.forEach((e, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  });

  // Real, confirmed-live gap (reported directly via a live run's own
  // validation output): a beat with TWO SEPARATE overlap clusters
  // (e.g. layers [0,1] overlapping each other, and UNRELATEDLY layers
  // [3,4,5] overlapping each other) used to have each cluster spread
  // out independently around its OWN pre-existing centroid - which
  // fixes the overlap WITHIN each cluster but does nothing to check
  // whether the two now-tidied clusters still collide with EACH OTHER,
  // since their centroids were often already close together to begin
  // with (a common cause of multiple originally-overlapping clusters
  // in the same beat: several elements all defaulting toward the
  // frame's center). The independent "backstop" validation check
  // AFTER repair then correctly still flags this as unresolved,
  // forcing a full retry for something repair should have handled.
  // Fixed by treating ALL qualifying text-only clusters in the SAME
  // beat as ONE combined stack when there's more than one of them,
  // rather than repairing each in isolation - guarantees no two
  // clusters can still collide post-repair, since there's only ever
  // one resulting stack for all of a beat's colliding text.
  // Real, confirmed-live bug found via direct frame inspection of a
  // real generated video: two text lines sat at the LITERAL identical
  // position, fully overlapping and unreadable, despite this whole
  // pass existing specifically to catch exactly that. Root cause: the
  // OLD `groupEntries.every((e) => e.isText)` check required the
  // WHOLE connected component to be text-only before the vertical-
  // stack treatment applied at all - a single decorative shape (a
  // thin accent line) happened to spatially overlap both text layers
  // by this file's own size ESTIMATE, pulling all three into ONE
  // union-find cluster. Because that mixed cluster wasn't "every
  // member isText", it fell through to the horizontal ROW-spread
  // logic instead, which only varies X and shares one common Y
  // centroid - so the two text lines, which both already sat at the
  // same Y, were left at that same shared Y forever, still fully
  // overlapping. Now splits EACH cluster into its own text subset and
  // non-text subset: 2+ text members get the vertical stack among
  // THEMSELVES regardless of what else got pulled into the same
  // cluster, and 2+ non-text members separately get the row-spread. A
  // lone non-text member alongside a resolved text stack is left
  // alone - nothing else in its own subset to spread against, and a
  // single decorative element sharing rough space with a headline is
  // a common, legitimate pattern this file already treats as fine
  // elsewhere; the text-on-text overlap this exists to prevent is the
  // one case with no legitimate excuse, and is what this guarantees
  // gets fixed regardless of whatever else is nearby.
  const textGroups = [];
  const otherGroups = [];
  const strandedSingles = [];
  for (const groupEntries of groups.values()) {
    if (groupEntries.length < 2) continue;
    const textMembers = groupEntries.filter((e) => e.isText);
    const otherMembers = groupEntries.filter((e) => !e.isText);
    if (textMembers.length >= 2) {
      // 2+ text members always get their own vertical stack, regardless
      // of whatever non-text members got pulled into the same cluster -
      // this is the actual fix for the text-on-text overlap bug.
      textGroups.push(textMembers);
      // A lone non-text member is left in place for now (a decorative
      // element sharing rough space with a headline is often fine
      // as-is), tracked here to be re-checked once the text stack has
      // its real final position and nudged only if it would still
      // genuinely overlap. 2+ non-text members get their own row-spread
      // exactly like a pure non-text cluster would.
      if (otherMembers.length === 1) strandedSingles.push(otherMembers[0]);
      else if (otherMembers.length >= 2) otherGroups.push(otherMembers);
    } else if (textMembers.length === 1) {
      // Real, confirmed-live bug found via direct frame inspection: a
      // thin decorative divider line, positioned to visually extend
      // outward from a text card, sat at the card's exact vertical
      // CENTER - which is fine for a single short line of text, but
      // this card's text wrapped to 3 lines, so that centerline landed
      // squarely on the MIDDLE line of real text ("average depth is"),
      // reading as an accidental strikethrough. This one-text-member
      // case used to fall straight into the generic mixed row-spread
      // fallback below with everything else in the cluster, which
      // never separately re-checks a shape against the ACTUAL text
      // content it's crossing - only clusters with 2+ text members got
      // that finer-grained treatment. Splits this cluster's non-text
      // members the same way: a shape sitting at essentially the exact
      // SAME position as the text (within a few px) is a deliberate
      // backdrop/card sized to contain it - the same common, legitimate
      // pattern already left alone elsewhere in this file - and is
      // never touched. Anything else is a genuinely separate decorative
      // element that only collides with the text by coincidence, and
      // gets the same stranded-single re-check (pushed clear only if it
      // would still truly overlap real text) already proven for the
      // 2+-text-member case above.
      const textMember = textMembers[0];
      const genuineOthers = otherMembers.filter((other) => !(
        Math.abs(other.x - textMember.x) < 5 && Math.abs(other.y - textMember.y) < 5
      ));
      if (genuineOthers.length === 1) strandedSingles.push(genuineOthers[0]);
      else if (genuineOthers.length >= 2) {
        // Real, confirmed-live bug found via direct reproduction: 2+
        // genuinely-separate decorative shapes alongside a text+backdrop
        // pair used to go ONLY into otherGroups, which spreads them
        // apart from EACH OTHER but never re-checks whether the result
        // still overlaps the text/backdrop they started clustered with
        // - confirmed directly, a small accent dot and a decorative
        // line both got separated from each other but left sitting
        // squarely on top of the text's own backdrop circle, still
        // failing validation after "repair." Also pushing each into
        // strandedSingles (which runs its OWN real-text-overlap recheck
        // BEFORE the otherGroups spread below) fixes this in two
        // coherent steps: first clear them from the text/backdrop
        // (using their still-original, still-overlapping positions),
        // THEN spread them apart from each other at that new, already-
        // clear position - so neither step can undo the other.
        otherGroups.push(genuineOthers);
        genuineOthers.forEach((o) => strandedSingles.push(o));
      }
    } else {
      // Zero text members - real, confirmed-live regression from an
      // earlier version of this split: routing a 1-text+1-shape (or any
      // other combination that isn't "2+ of the same kind") group
      // through neither bucket left it completely unhandled, silently
      // reverting a previously-working case (a single ring shape left
      // directly overlapping a single text label, both at their
      // original untouched positions). This exactly restores the
      // ORIGINAL "treat the whole mixed cluster as one row-spread"
      // behavior for every case that doesn't have 2+ of one kind (or,
      // per the branch above, exactly 1 text member) to stack/spread
      // against - it's not "the fix", it's the proven-working fallback
      // for a group shape neither fix specifically targets.
      otherGroups.push(groupEntries);
    }
  }

  let changed = false;

  if (textGroups.length > 0) {
    changed = true;
    const combined = textGroups.length === 1 ? textGroups[0] : textGroups.flat();
    const cx = combined.reduce((sum, e) => sum + e.x, 0) / combined.length;
    const cy = combined.reduce((sum, e) => sum + e.y, 0) / combined.length;
    // A text-only group is stacked VERTICALLY (one per line) instead
    // of spread into a horizontal row - confirmed necessary live: 3-4
    // separate text layers meant to read as sequential words of one
    // headline routinely need MORE total width than a row has to work
    // with (a real 4-word case needed ~1650px of row width against a
    // 540px-wide frame), so a horizontal spread just pushes outer
    // words off-frame instead of actually fixing legibility. Vertical
    // stacking uses the frame's much deeper height budget instead and
    // reads naturally as a multi-line headline, which is what these
    // almost always actually are.
    //
    // Laid out as a genuine CUMULATIVE top-to-bottom stack (each
    // entry's own actual height, not a flat group-average spacing) -
    // confirmed necessary live: averaging spacing across a group whose
    // members vary a lot in size (a big wrapped 2-line headline next
    // to a short single-line label) left some pairs still overlapping,
    // since the average understated what the LARGER member actually
    // needed. A cumulative stack can't make that mistake - it adds
    // each member's own real height (plus a small gap) as it goes, so
    // total spacing is exactly what THAT group needs, not an estimate.
    // Original top-to-bottom order (by pre-repair y, not array index)
    // is preserved so a genuine reading sequence isn't scrambled.
    const ordered = [...combined].sort((a, b) => a.y - b.y);
    const gap = 12;
    const totalHeight = ordered.reduce((sum, e) => sum + (e.height || 60), 0) + gap * (ordered.length - 1);
    let cursorY = cy - totalHeight / 2;
    ordered.forEach((e) => {
      const h = e.height || 60;
      const targetY = cursorY + h / 2;
      shiftLayerPosition(visual.layers[e.index], cx - e.x, targetY - e.y);
      cursorY += h + gap;
    });
  }

  // Re-checks each lone non-text member tracked above against the text
  // stack's REAL final position (not its pre-move one) and nudges it
  // clear only if it would still genuinely overlap - most of the time
  // the text stack has already moved well away and this is a no-op,
  // but it closes the gap left by deliberately not row-spreading a
  // single decorative element earlier.
  for (const single of strandedSingles) {
    const layer = visual.layers[single.index];
    const pos = representativePosition(layer.position);
    if (!pos) continue;
    let stillOverlapping = false;
    let stackBottom = -Infinity;
    for (const textLayer of visual.layers) {
      if (!isPlainObject(textLayer) || textLayer.type !== 'text' || textLayer.parent) continue;
      const tPos = representativePosition(textLayer.position);
      if (!tPos) continue;
      const tSize = estimateTextEffectiveSize(textLayer);
      // A co-located backdrop (a shape/image sitting at essentially the
      // exact same position as this text - e.g. a card explicitly
      // sized to contain it) is the REAL visual boundary a stranded
      // single needs to clear, not just the text's own tighter
      // ESTIMATED box. Confirmed live: a divider line pushed clear of
      // only the text's estimate (114px tall) still landed inside a
      // taller 180px explicit backdrop card behind that same text,
      // since the card's real height was never factored in here.
      let effHeight = tSize.height;
      for (const sib of visual.layers) {
        if (!isPlainObject(sib) || sib === textLayer || sib.parent) continue;
        if (sib.type !== 'shape' && sib.type !== 'image') continue;
        if (typeof sib.width !== 'number' || typeof sib.height !== 'number') continue;
        const sPos = representativePosition(sib.position);
        if (!sPos) continue;
        if (Math.abs(sPos[0] - tPos[0]) < 5 && Math.abs(sPos[1] - tPos[1]) < 5) {
          effHeight = Math.max(effHeight, sib.height);
        }
      }
      const overlapsX = Math.abs(pos[0] - tPos[0]) < ((single.width + tSize.width) / 2) * 0.9;
      const overlapsY = Math.abs(pos[1] - tPos[1]) < ((single.height + effHeight) / 2) * 0.9;
      if (overlapsX && overlapsY) stillOverlapping = true;
      // Tracks the LOWEST bottom edge across every text layer roughly
      // sharing this single's own horizontal space, not just the one
      // it happens to overlap - a fixed "own height + margin" push
      // (tried first) landed it on top of a DIFFERENT line in the same
      // stack instead of clearing all of them; pushing below the
      // stack's real full extent is what actually guarantees it lands
      // clear of every line at once, not just the one it started
      // overlapping.
      if (Math.abs(pos[0] - tPos[0]) < ((single.width + tSize.width) / 2) * 1.5) {
        stackBottom = Math.max(stackBottom, tPos[1] + effHeight / 2);
      }
    }
    if (stillOverlapping && stackBottom > -Infinity) {
      changed = true;
      const targetY = stackBottom + single.height / 2 + 20;
      shiftLayerPosition(layer, 0, targetY - pos[1]);
    }
  }

  // Shape/image groups keep the original horizontal-row behavior (a
  // row of icons/badges/cards, the case it was built for, has no such
  // width problem) - handled per-cluster still, since two SEPARATE
  // rows of icons legitimately can sit in different parts of the frame
  // without needing to merge into one row the way text always does.
  for (const groupEntries of otherGroups) {
    changed = true;
    const cx = groupEntries.reduce((sum, e) => sum + e.x, 0) / groupEntries.length;
    const cy = groupEntries.reduce((sum, e) => sum + e.y, 0) / groupEntries.length;
    const avgSpan = groupEntries.reduce((sum, e) => sum + (e.width || 120), 0) / groupEntries.length;
    const spacing = Math.max(80, avgSpan * 1.15);
    const totalSpan = spacing * (groupEntries.length - 1);
    groupEntries.forEach((e, k) => {
      const offset = -totalSpan / 2 + spacing * k;
      const [targetX, targetY] = [cx + offset, cy];
      shiftLayerPosition(visual.layers[e.index], targetX - e.x, targetY - e.y);
    });
  }
  return changed;
}

// TWO passes, deliberately not more: a single pass can leave a
// repositioned group newly overlapping a layer it never touched
// (confirmed live, a common 2-group case - a 4-word headline stack
// plus a separate subtitle line ended up only ~5px apart after the
// first pass alone), so a second pass catches exactly that. Measured
// directly that a THIRD+ pass does NOT keep improving things on a
// genuinely messy many-element cluster - it oscillates instead (the
// group's own center recomputes from already-shifted positions each
// time, so a new overlap can appear while the original one still
// hasn't fully resolved). Two passes is the sweet spot: enough to
// catch the common "fixing A exposed a new conflict with B" case,
// bounded enough to never reach the oscillation zone.
// Was a fixed 2 passes ("a third pass measured to OSCILLATE on a messy
// many-element cluster"), raised to a bounded loop after a real live
// case still reported overlap AFTER 2 passes (the validation backstop
// correctly still caught it, forcing an otherwise-avoidable retry).
// The original oscillation risk came from MULTIPLE independent
// clusters re-grouping differently pass to pass; runOverlapSpreadPass
// itself now merges every text-only cluster into ONE combined stack
// per pass (see its own doc comment), which removes that specific
// membership-churn mechanism - a further pass on an already-single-
// group state can only refine spacing, not reshuffle who's grouped
// with whom, so continuing is safe. Stops the moment a pass reports
// nothing left to fix (the common case, after 1-2 passes); the cap
// exists only as a distant safety net against a genuinely pathological
// beat, not an expected ceiling.
function autoSpreadDuplicatePositions(visual) {
  for (let i = 0; i < 4; i++) {
    const changed = runOverlapSpreadPass(visual);
    if (!changed) break;
  }
}

/**
 * Validates ONE beat ({params, visual}) in isolation - the same check
 * validateSceneJSON runs per-beat inside its own loop, pulled out as
 * its own function so mistralClient.js's per-beat generation (each beat
 * generated and validated/retried independently, rather than the whole
 * multi-beat scene in one call - see the architecture note above
 * generateBeatJSON there for why) can validate a single beat without
 * needing a full {scenes:[...]} wrapper around it.
 */
function validateBeat(beat, path = 'beat') {
  autoRepairBeat(beat);
  const errors = [];
  if (!isPlainObject(beat)) return { valid: false, errors: [`${path}: must be an object`] };
  if (!isPlainObject(beat.params) || typeof beat.params.duration !== 'number' || beat.params.duration <= 0) {
    errors.push(`${path}.params.duration: is required and must be a positive number`);
  }
  const knownIds = new Set();
  validateBeatVisual(beat.visual, `${path}.visual`, errors, knownIds);
  return { valid: errors.length === 0, errors };
}

/**
 * The real, top-level validator - checks the whole sceneJSON structure
 * and returns { valid, errors }. Never throws; callers decide what to
 * do with a non-empty errors list (mistralClient.js retries generation
 * with the errors fed back as context; a test fixture just asserts on it).
 */
function validateSceneJSON(sceneJSON) {
  const errors = [];
  if (!isPlainObject(sceneJSON) || !Array.isArray(sceneJSON.scenes)) {
    return { valid: false, errors: ['root: sceneJSON must be an object with a "scenes" array'] };
  }
  if (sceneJSON.scenes.length === 0) errors.push('scenes: must contain at least one beat');

  // Real bug found via a live-rendered, user-reported output (not
  // theoretical): on a long, deeply-nested, COMPACT (whitespace-free)
  // generation, the model lost track of its own bracket nesting and
  // left an entire beat's worth of content (params/visual/transitionIn)
  // sitting as SIBLING keys on the root object instead of nested as the
  // next element INSIDE the "scenes" array - valid JSON syntax, so it
  // parsed fine, but the render pipeline only ever reads sceneJSON.scenes,
  // so that whole beat was silently dropped with no error anywhere.
  // "scenes" is the only real root key; anything else here is almost
  // certainly exactly this failure, so it's flagged explicitly rather
  // than silently ignored.
  const ROOT_KEYS = new Set(['scenes']);
  // Auto-repaired here (array-level surgery, so it belongs at the
  // whole-document level rather than autoRepairBeat's per-beat scope),
  // not just flagged - two distinct real live patterns behind the
  // SAME underlying mistake (the model losing track of its own bracket
  // nesting near the end of a long response):
  // 1. A WHOLE beat's own content ("params" AND "visual" both present)
  //    sitting as stray root siblings instead of nested inside "scenes"
  //    - reconstructed into a real {params,visual,transitionIn} beat
  //    object and appended to "scenes" (its content is fully real and
  //    recoverable, just misplaced one level up).
  // 2. A smaller ORPHANED fragment (e.g. just "highlights" alone, no
  //    accompanying params/visual) that isn't beat-shaped at all and
  //    has no safe destination to reconstruct - these are dropped
  //    outright rather than guessed at, same tradeoff as every other
  //    unrecoverable-fragment repair in this file.
  if (isPlainObject(sceneJSON.params) && isPlainObject(sceneJSON.visual)) {
    const recovered = { params: sceneJSON.params, visual: sceneJSON.visual };
    if (sceneJSON.transitionIn !== undefined) recovered.transitionIn = sceneJSON.transitionIn;
    sceneJSON.scenes.push(recovered);
    delete sceneJSON.params;
    delete sceneJSON.visual;
    delete sceneJSON.transitionIn;
  }
  for (const k of Object.keys(sceneJSON)) {
    if (!ROOT_KEYS.has(k)) delete sceneJSON[k];
  }

  // Real, repeatedly-recurring pattern: a truncated/malformed response
  // leaves one or more `null` or clearly-incomplete stub entries INSIDE
  // "scenes" (not missing entirely - the array slot exists, e.g. from
  // JSON.parse salvage on a cut-off response) - these used to surface
  // as a confusing cascade of per-field errors (".params.duration is
  // required", ".visual is required") on something that was never a
  // real beat to begin with. Dropped here instead, so the ONE real,
  // actionable signal (mistralClient.js's own "too short" completeness
  // check, comparing actual vs the treatment's planned beat count)
  // fires cleanly instead of being buried under noise about a beat
  // that was already known to be missing.
  sceneJSON.scenes = sceneJSON.scenes.filter((beat) => isPlainObject(beat) && isPlainObject(beat.visual));

  sceneJSON.scenes.forEach((beat, i) => {
    const { errors: beatErrors } = validateBeat(beat, `scenes[${i}]`);
    errors.push(...beatErrors);
  });

  varyHeadlinePositions(sceneJSON);

  return { valid: errors.length === 0, errors };
}

/**
 * Real, confirmed-live composition complaint, distinct from anything
 * autoRepairBeat can fix on its own: it only ever sees ONE beat at a
 * time, with no notion of "beat index within the whole video", so it
 * has no way to alternate composition across beats even though that's
 * exactly what's needed here. A direct audit of a real generated video
 * (after prompt guidance alone was added encouraging off-center
 * placement) found every single headline still landing within ~40px
 * of dead-center - technically not identical, but visually
 * indistinguishable from "always centered," the same repetitive/boring
 * failure the guidance was meant to fix. Prompt wording alone didn't
 * move this, the same story as nearly every other rule this session -
 * so this runs as its own whole-scene pass AFTER all per-beat repair,
 * shifting a beat's headline group off-center when it's still
 * suspiciously close to it, alternating left/right by beat index for a
 * real, deterministic (not random/jittery) spread across the video.
 *
 * Shifts EVERY top-level text layer in the beat by the SAME delta,
 * not just the single dominant one - a real live regression from the
 * first version of this pass, confirmed via direct user feedback: only
 * moving the dominant layer left its own sibling lines behind at their
 * original position, breaking what should read as one coherent
 * headline group into visually disconnected fragments ("scattered",
 * "goblin"-made). Moving the whole group together is what actually
 * reads as a deliberate compositional choice instead of misalignment.
 *
 * Skips the FIRST and LAST beat (a genuine title-card bookend is a
 * legitimate reason to stay centered) and only ever nudges WITHIN the
 * same safe on-canvas bounds the off-canvas clamp already established
 * for EACH layer individually after the shared shift - it can widen
 * how far off-center a layer sits, never reintroduce an overflow, and
 * naturally does less for a headline too wide to have real margin to
 * begin with (its own safe zone collapses toward center).
 */
function varyHeadlinePositions(sceneJSON) {
  const scenes = sceneJSON.scenes;
  if (!Array.isArray(scenes) || scenes.length < 3) return;
  const CENTER_THRESHOLD = CANVAS_WIDTH * 0.05;
  scenes.forEach((beat, i) => {
    if (i === 0 || i === scenes.length - 1) return;
    if (!isPlainObject(beat) || !isPlainObject(beat.visual) || !Array.isArray(beat.visual.layers)) return;
    const textLayers = beat.visual.layers.filter((l) => isPlainObject(l) && l.type === 'text' && !l.parent && typeof l.fontSize === 'number');
    if (textLayers.length === 0) return;
    const dominant = textLayers.reduce((a, b) => (b.fontSize > a.fontSize ? b : a));
    const pos = representativePosition(dominant.position);
    if (!pos) return;
    if (Math.abs(pos[0] - CANVAS_WIDTH / 2) > CENTER_THRESHOLD) return;
    // Uses a padded ACTUAL-width estimate here, not the conservative
    // "maxWidth" ceiling the off-canvas clamp itself relies on - real,
    // confirmed-live gap: size.width falls back to the full
    // DEFAULT_TEXT_MAX_WIDTH (480, most of this canvas) whenever no
    // explicit "maxWidth" is set, REGARDLESS of how short the actual
    // text is. A first attempt still capped this estimate at
    // `Math.min(size.width, actualWidth*1.3)` as an extra guard - but
    // direct testing found that ALSO self-defeating: for anything past
    // roughly 10-12 characters at a normal fontSize, actualWidth*1.3
    // already exceeds 480 on its own, so the min just fell back to the
    // full conservative ceiling anyway ("3 mind-blowing" - a completely
    // ordinary short headline - didn't move at all). The off-canvas
    // clamp needs that conservative ceiling because a false negative
    // there is visible clipping; this pass carries a much smaller
    // downside if slightly imprecise (worst case, a beat lands a bit
    // closer to an edge than ideal, not broken), and the separate
    // safety-net re-clamp below already provides real protection - so
    // this uses the padded actual-width estimate directly, uncapped.
    const size = estimateTextEffectiveSize(dominant);
    const effWidth = Math.max(1, (size.actualWidth || size.width) * 1.3);
    const halfW = Math.min(effWidth / 2, (CANVAS_WIDTH - EDGE_MARGIN_PX * 2) / 2);
    const safeLeftX = EDGE_MARGIN_PX + halfW;
    const safeRightX = CANVAS_WIDTH - EDGE_MARGIN_PX - halfW;
    const center = CANVAS_WIDTH / 2;
    const leaningLeft = i % 2 === 0;
    const target = leaningLeft ? center - (center - safeLeftX) * 0.6 : center + (safeRightX - center) * 0.6;
    const dx = target - pos[0];
    if (Math.abs(dx) < 1) return;
    textLayers.forEach((layer) => {
      const layerPos = representativePosition(layer.position);
      if (!layerPos) return;
      const newX = layerPos[0] + dx;
      if (isNumberArray(layer.position, 2)) {
        layer.position = [newX, layer.position[1]];
      } else if (isPlainObject(layer.position) && Array.isArray(layer.position.keyframes) && layer.position.keyframes.length > 0) {
        const last = layer.position.keyframes[layer.position.keyframes.length - 1];
        if (isPlainObject(last) && isNumberArray(last.value, 2)) last.value = [newX, last.value[1]];
      }
      // Safety net, but NOT the off-canvas check's own full "maxWidth"
      // ceiling - re-clamping with that (confirmed by direct testing)
      // fell all the way back to treating a 4-character word as though
      // it might need 480px, erasing the nudge above almost entirely.
      // A second, more generous safety multiplier over the real
      // per-line estimate (1.6x, vs this pass's own 1.3x above) still
      // catches a genuine underestimate without reintroducing that
      // problem - the off-canvas check's stricter ceiling exists
      // because a false negative THERE is uncaught visible clipping; a
      // slightly-too-generous nudge here just means a beat sits a
      // little closer to an edge than ideal, a real but much smaller
      // downside. Applied per-layer (not just the dominant one) since
      // a shorter sibling line shifted by the same dx as a wider
      // headline could still individually run out of real margin.
      const layerSize = estimateTextEffectiveSize(layer);
      const safetyWidth = Math.max(1, (layerSize.actualWidth || layerSize.width) * 1.6);
      clampSettledPositionToCanvas(layer, safetyWidth, layerSize.height);
    });
  });
}

module.exports = {
  validateSceneJSON,
  validateBeat,
  LAYER_TYPES,
  SHAPE_KINDS,
  SHAPE_CONTENT_TYPES,
  PATH_OP_MODES,
  SELECTOR_TYPES,
  RANGE_SELECTOR_SHAPES,
  TRACK_MATTE_TYPES,
  GENERATE_KINDS,
  CUBIC_EASING_NAMES,
  TEXT_ALIGN_VALUES,
  AVAILABLE_FONT_FAMILIES,
  BLEND_MODE_NAMES,
  EASING_NAMES,
  EFFECT_TYPES,
  TRANSITION_TYPES,
};
