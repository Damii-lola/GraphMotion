const { EASING_REGISTRY } = require('./engine/easingCurves');
const { BLEND_MODE_MAP } = require('./engine/layerStack');

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
 *       position:[dx,dy], scale, rotation } }, ... ] - real per-
 *       character animator stack (batch 4/5)
 *     onPath: { anchors: [{point:[x,y], outTangent?, inTangent?}, ...],
 *       firstMargin, lastMargin, reversePath, perpendicularToPath,
 *       forceAlignment } - omit for straight-baseline text; present ->
 *       uses renderAnimatedTextOnPath instead (batch 5)
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
      }
    });
    return;
  }
  if (typeof value.expression === 'string') {
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

function validateAnimator(a, path, errors) {
  if (!a.selector) { errors.push(`${path}.selector: is required`); return; }
  validateSelector(a.selector, `${path}.selector`, errors);
  const props = a.properties;
  if (isPlainObject(props) && Array.isArray(props.position)) {
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

function validateSelector(sel, path, errors) {
  if (!isPlainObject(sel)) { errors.push(`${path}: must be an object`); return; }
  if (!SELECTOR_TYPES.includes(sel.type)) {
    errors.push(`${path}.type: "${sel.type}" is not a real selector type (expected one of ${SELECTOR_TYPES.join(', ')})`);
    return;
  }
  if (sel.type === 'range' && sel.shape && !RANGE_SELECTOR_SHAPES.includes(sel.shape)) {
    errors.push(`${path}.shape: "${sel.shape}" is not a real range-selector shape (expected one of ${RANGE_SELECTOR_SHAPES.join(', ')})`);
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
            errors.push(`${path}.shape.params.anchors[${i}].point: must be a real [x,y] pixel coordinate.`);
          }
        });
      }
    }
  } else if (item.type === 'pathOp') {
    if (!PATH_OP_MODES.includes(item.mode)) errors.push(`${path}.mode: "${item.mode}" is not a real path operation mode (expected one of ${PATH_OP_MODES.join(', ')})`);
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
    if (Array.isArray(layer.animators)) {
      layer.animators.forEach((a, i) => validateAnimator(a, `${path}.animators[${i}]`, errors));
    }
  } else if (layer.type === 'generate') {
    if (!layer.generate || !GENERATE_KINDS.includes(layer.generate.kind)) {
      const val = layer.generate && layer.generate.kind;
      errors.push(`${path}.generate.kind: "${val}" is not real (expected one of ${GENERATE_KINDS.join(', ')}).${suggestFix(val, GENERATE_KINDS, 'a generate kind')}`);
    }
  } else if (layer.type === 'image' && Array.isArray(layer.effects) && layer.effects.length > 0
      && (typeof layer.width !== 'number' || typeof layer.height !== 'number')) {
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
    errors.push(`${path}: an "image" layer with effects should set explicit "width"/"height" matching its intended display size. Omitting them sizes the effects-processing buffer at the FULL FRAME regardless of the image's real size (and stays that size even if the image fetch fails), making every effect on this layer far more expensive than necessary for no visual benefit.`);
  } else if (layer.type === 'precomp') {
    if (!Array.isArray(layer.layers)) errors.push(`${path}.layers: a precomp requires a nested layers array`);
    else layer.layers.forEach((l, i) => validateLayer(l, `${path}.layers[${i}]`, errors, knownIds));
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
  visual.layers.forEach((layer, i) => validateLayer(layer, `${path}.layers[${i}]`, errors, knownIds));
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
  // overlay/matte/background layers (a wipe matte, a paper texture, a
  // full-frame color layer) LEGITIMATELY share the same frame-filling
  // position with each other - that's normal, correct compositing, not
  // a "forgot to spread these out" mistake. So only layers that are
  // SMALLER than the beat's own largest explicit layer are eligible to
  // be flagged; anything tied for the largest explicit width/height in
  // the beat is treated as a background/overlay-style layer and
  // exempted, and layers with no explicit width/height at all (text
  // layers, generate/image layers meant to fill their container - both
  // extremely common and NOT a sign of this bug) are exempted too
  // rather than guessed at.
  const layersWithSize = visual.layers.filter((l) => typeof l.width === 'number' && typeof l.height === 'number');
  const maxW = layersWithSize.length ? Math.max(...layersWithSize.map((l) => l.width)) : 0;
  const maxH = layersWithSize.length ? Math.max(...layersWithSize.map((l) => l.height)) : 0;
  const positionGroups = new Map();
  visual.layers.forEach((layer, i) => {
    if (layer.parent || !Array.isArray(layer.position)) return;
    if (typeof layer.width !== 'number' || typeof layer.height !== 'number') return;
    if (layer.width >= maxW && layer.height >= maxH) return;
    const key = JSON.stringify(layer.position);
    if (!positionGroups.has(key)) positionGroups.set(key, []);
    positionGroups.get(key).push(i);
  });
  for (const [key, indices] of positionGroups) {
    if (indices.length > 1) {
      errors.push(`${path}.layers: layers at indices [${indices.join(', ')}] all share the identical un-animated position ${key} - sibling elements need distinct "position" values or they'll render stacked/overlapping instead of spread out (e.g. as a row, grid, or scattered composition). Give each one its own real position.`);
    }
  }

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
 * Deliberately does NOT attempt to fix anything requiring judgment
 * (missing shape contents, duplicate positions - auto-picking a new
 * position risks a worse layout than the AI would choose on a real
 * retry) - those still go through the normal validate-and-retry path.
 *
 * Called BEFORE validateBeat, so anything this successfully repairs
 * never even reaches validation as an error, let alone a retry.
 */
function autoRepairBeat(beat) {
  if (!isPlainObject(beat) || !isPlainObject(beat.visual)) return;

  const walkLayers = (layers) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      if (!isPlainObject(layer)) continue;

      if (layer.type === 'shape') {
        // Missing top-level width/height, derivable from the shape's
        // own first sized path content - the exact real pattern found
        // live: the AI puts width/height on the rectangle/ellipse's
        // own shape.params but forgets the separate layer-level
        // requirement, even though the numbers are RIGHT THERE one
        // level down.
        if ((typeof layer.width !== 'number' || typeof layer.height !== 'number') && Array.isArray(layer.contents)) {
          const sized = layer.contents.find((item) => isPlainObject(item) && item.type === 'path'
            && isPlainObject(item.shape) && isPlainObject(item.shape.params)
            && typeof item.shape.params.width === 'number' && typeof item.shape.params.height === 'number');
          if (sized) {
            if (typeof layer.width !== 'number') layer.width = sized.shape.params.width;
            if (typeof layer.height !== 'number') layer.height = sized.shape.params.height;
          }
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

        // Effect-type items misplaced inside "contents" (the "trim
        // sitting in effects" mistake's mirror image, e.g. "outerGlow"/
        // "dropShadow" appearing as a contents entry) - relocated to
        // the layer's own "effects" array, where the object's own
        // {type,params} shape already matches exactly what an
        // EffectDef looks like, no reshaping needed. Content-type
        // items found in "effects" are NOT auto-moved the other
        // direction - contents order matters for path/trim/fill/stroke
        // sequencing, and guessing the right insertion point is a real
        // judgment call this function deliberately leaves to a retry.
        if (Array.isArray(layer.contents)) {
          const misplaced = layer.contents.filter((item) => isPlainObject(item) && EFFECT_TYPES.includes(item.type));
          if (misplaced.length > 0) {
            layer.contents = layer.contents.filter((item) => !(isPlainObject(item) && EFFECT_TYPES.includes(item.type)));
            layer.effects = [...(Array.isArray(layer.effects) ? layer.effects : []), ...misplaced];
          }
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

      if (layer.type === 'precomp') walkLayers(layer.layers);
    }
  };

  if (isPlainObject(beat.visual.background)) walkLayers([beat.visual.background]);
  walkLayers(beat.visual.layers);
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
  const strayRootKeys = Object.keys(sceneJSON).filter((k) => !ROOT_KEYS.has(k));
  if (strayRootKeys.length > 0) {
    errors.push(`root: unexpected top-level key(s) [${strayRootKeys.join(', ')}] - "scenes" is the ONLY valid root key. This usually means a beat's content (params/visual/etc) was accidentally placed as a SIBLING of "scenes" instead of nested INSIDE the "scenes" array as its next element - move it into "scenes" as its own {params,visual} object.`);
  }

  sceneJSON.scenes.forEach((beat, i) => {
    const { errors: beatErrors } = validateBeat(beat, `scenes[${i}]`);
    errors.push(...beatErrors);
  });

  return { valid: errors.length === 0, errors };
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
  BLEND_MODE_NAMES,
  EASING_NAMES,
  EFFECT_TYPES,
  TRANSITION_TYPES,
};
