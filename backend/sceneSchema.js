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
 *     is3D: boolean (default false) - chooses the render path:
 *       false -> a real Composition/Node tree (batches 1-6: blend
 *         modes, track mattes, adjustment layers, shape layers, text)
 *       true  -> a real Layer3D+Camera+Lights scene (batch 7-8) -
 *         EVERY layer becomes a flat plane in a shared 3D space; each
 *         plane's own CONTENT is still built by the exact same 2D
 *         layer-building code (a 3D layer is fundamentally "a flat 2D
 *         layer with a 3D transform," matching how AE itself works -
 *         see layer3d.js's own class doc comment), so nothing about
 *         layer content authoring differs between 2D and 3D beats,
 *         only how the finished planes get positioned/lit/projected.
 *     background: LayerDef | null - an optional full-frame layer
 *       drawn first, before `layers` (typically a "generate" layer -
 *       gradient/fractal-noise/checkerboard - or a solid fill).
 *     layers: [LayerDef, ...] - stacking order matches AE: LATER
 *       entries in this array are DRAWN LATER, i.e. they render on TOP.
 *     camera: CameraDef (only consulted if is3D)
 *     lights: [LightDef, ...] (only consulted if is3D)
 *     transitionIn: TransitionDef | null - how this beat transitions
 *       IN from whatever the previous beat ended on (real transitions.js
 *       reuse, batch 11) - omit for a hard cut.
 *   }
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
 *     position, rotation (2D) or rotationX/rotationY/rotationZ (3D),
 *     scale, anchor, opacity: AnimatableValue<...> - the common
 *       transform every layer has (matches node.js's real Node fields
 *       for 2D, layer3d.js's real Layer3D fields for 3D)
 *
 *     blendMode: one of BLEND_MODE_NAMES below (2D only - a real
 *       Composition-level concept, batch 3)
 *     trackMatte: { source: <layerId>, type: 'alpha'|'alphaInverted'|
 *       'luma'|'lumaInverted' } (2D only)
 *     isAdjustmentLayer: boolean - this layer's `effects` post-process
 *       the ENTIRE accumulator below it (batch 3's real mechanism),
 *       rather than only itself
 *     effects: [EffectDef, ...] - applied to THIS layer's own rendered
 *       content, in order, regardless of isAdjustmentLayer (a real,
 *       general per-layer effects stack - see EFFECT_TYPES below)
 *     parent: <layerId> - real Node/Layer3D parenting (batch 2/7)
 *     material: { ambient, diffuse, specularStrength, shininess } (3D
 *       only - opts this layer INTO real scene lighting, batch 8;
 *       omit for an unlit/self-illuminated layer)
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
 * CameraDef (batch 7): { position: AnimatableValue<[x,y,z]>,
 *   pointOfInterest: AnimatableValue<[x,y,z]>, zoom: AnimatableValue<number> }
 *
 * LightDef (batch 8): { type:'point'|'spot'|'directional'|'ambient',
 *   position, pointOfInterest, color, intensity, falloff:'none'|'smooth'|
 *   'inverseSquareClamped', falloffRadius, coneAngle, coneFeather }
 *
 * TransitionDef (batch 11): { type: <name from TRANSITION_TYPES below>,
 *   duration, params:{...real per-type params from transitions.js} }
 */

const LAYER_TYPES = ['shape', 'text', 'image', 'precomp', 'null', 'generate'];
const SHAPE_KINDS = ['rectangle', 'ellipse', 'polygon', 'star'];
const SHAPE_CONTENT_TYPES = ['path', 'trim', 'repeater', 'pathOp', 'fill', 'stroke', 'group'];
const PATH_OP_MODES = ['add', 'subtract', 'intersect', 'exclude', 'merge'];
const SELECTOR_TYPES = ['range', 'wiggly'];
const RANGE_SELECTOR_SHAPES = ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'];
const TRACK_MATTE_TYPES = ['alpha', 'alphaInverted', 'luma', 'lumaInverted'];
const GENERATE_KINDS = ['gradientRamp', 'checkerboard', 'grid', 'lensFlare', 'fractalNoise'];
const LIGHT_TYPES = ['point', 'spot', 'directional', 'ambient'];
const FALLOFF_TYPES = ['none', 'smooth', 'inverseSquareClamped'];
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
    }
  } else if (item.type === 'pathOp') {
    if (!PATH_OP_MODES.includes(item.mode)) errors.push(`${path}.mode: "${item.mode}" is not a real path operation mode (expected one of ${PATH_OP_MODES.join(', ')})`);
  } else if (item.type === 'group') {
    if (!Array.isArray(item.contents)) errors.push(`${path}.contents: a group requires a contents array`);
    else item.contents.forEach((sub, i) => validateShapeContentItem(sub, `${path}.contents[${i}]`, errors));
  }
}

function validateEffect(effect, path, errors) {
  if (!isPlainObject(effect) || !EFFECT_TYPES.includes(effect.type)) {
    const val = effect && effect.type;
    errors.push(`${path}.type: "${val}" is not a real effect type (expected one of ${EFFECT_TYPES.join(', ')}).${suggestFix(val, EFFECT_TYPES, 'an effect type')}`);
  }
}

function validateLayer(layer, path, errors, knownIds, is3D = false) {
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

  // Real bug found via direct inspection of a live-generated 3D beat: a
  // "shards" precomp layer set an explicit anchor:[60,60,0] (sized for
  // its real, intended ~120x120 footprint) but omitted width/height
  // entirely. buildLayer3D's own width/height fallback (`layerDef.width
  // || beatContext.width`) then silently expanded it to the FULL FRAME
  // size (540x960) while the anchor stayed pinned near its old, now-
  // wrong corner - the layer's actual center moved to (270,480) but its
  // pivot stayed at (60,60), so "position" no longer places the layer
  // where it visually appears to, throwing it badly off from its
  // intended frame-center placement. This is exactly the kind of silent
  // fallback-vs-explicit-value mismatch prompting alone won't reliably
  // prevent, so it's enforced structurally: a 3D layer that sets an
  // explicit anchor MUST also set explicit width/height (so the anchor
  // is guaranteed to describe the layer's REAL footprint), or omit
  // anchor entirely and get the correct auto-centered default.
  if (is3D && layer.anchor !== undefined && layer.type !== 'null'
      && (layer.width === undefined || layer.height === undefined)) {
    errors.push(`${path}: sets an explicit "anchor" but omits "width"/"height". For a 3D layer, omitting width/height falls back to the FULL FRAME size, which will not match an anchor chosen for the layer's real (usually smaller) intended size, throwing its actual position off badly. Either set explicit "width" and "height" alongside "anchor", or omit "anchor" entirely to get the correct auto-centered default.`);
  }

  if (layer.type === 'shape') {
    if (!Array.isArray(layer.contents)) errors.push(`${path}.contents: a shape layer requires a contents array`);
    else layer.contents.forEach((item, i) => validateShapeContentItem(item, `${path}.contents[${i}]`, errors));
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
  } else if (layer.type === 'precomp') {
    if (!Array.isArray(layer.layers)) errors.push(`${path}.layers: a precomp requires a nested layers array`);
    else layer.layers.forEach((l, i) => validateLayer(l, `${path}.layers[${i}]`, errors, knownIds));
  }
}

function validateLight(light, path, errors) {
  if (!isPlainObject(light) || !LIGHT_TYPES.includes(light.type)) {
    errors.push(`${path}.type: "${light && light.type}" is not a real light type (expected one of ${LIGHT_TYPES.join(', ')})`);
    return;
  }
  if (light.falloff && !FALLOFF_TYPES.includes(light.falloff)) {
    errors.push(`${path}.falloff: "${light.falloff}" is not real (expected one of ${FALLOFF_TYPES.join(', ')})`);
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
  visual.layers.forEach((layer, i) => validateLayer(layer, `${path}.layers[${i}]`, errors, knownIds, !!visual.is3D));

  if (visual.is3D) {
    if (Array.isArray(visual.lights)) visual.lights.forEach((l, i) => validateLight(l, `${path}.lights[${i}]`, errors));
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
 * Validates ONE beat ({params, visual}) in isolation - the same check
 * validateSceneJSON runs per-beat inside its own loop, pulled out as
 * its own function so mistralClient.js's per-beat generation (each beat
 * generated and validated/retried independently, rather than the whole
 * multi-beat scene in one call - see the architecture note above
 * generateBeatJSON there for why) can validate a single beat without
 * needing a full {scenes:[...]} wrapper around it.
 */
function validateBeat(beat, path = 'beat') {
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
  LIGHT_TYPES,
  FALLOFF_TYPES,
  BLEND_MODE_NAMES,
  EASING_NAMES,
  EFFECT_TYPES,
  TRANSITION_TYPES,
};
