/**
 * A named library of whole-layer and per-character text ENTRANCE/EXIT
 * animations - the real distinct motion families used across CapCut,
 * Canva, and After Effects text presets (their much longer named lists
 * are overwhelmingly cosmetic re-namings of the same handful of real
 * primitives: a fade, a slide, a scale pop, a rotate, a flip, a blur, a
 * bounce/elastic overshoot, a per-character typewriter/cascade reveal -
 * covered here as genuinely distinct, tunable behaviors rather than
 * duplicated under many redundant names).
 *
 * This is an ENGINE feature, not a prompt-only convention: sceneBuilder.js
 * calls applyTextAnimationPresets(visual, duration) once per beat, at
 * RENDER time (see this file's own call-site doc comment below for why
 * that specific timing matters, not just generation time), and
 * MECHANICALLY expands a compact `layer.textAnimation` spec into real
 * position/scale/opacity/rotation/effects keyframes (or a real per-
 * character `animators` entry, for the character/word/line-based
 * presets) - and, critically, auto-assigns a sensible default preset to
 * any text layer that specifies NONE and has no other motion of its own,
 * so no text layer can ever silently render as a static, un-animated
 * pop-in regardless of whether the model remembered to ask for one.
 */

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isNumberArray(v, len) { return Array.isArray(v) && v.length === len && v.every((n) => typeof n === 'number'); }
function round(n) { return Math.round(n * 1000) / 1000; }

// Whole-layer presets: expand to position/scale/opacity/rotation/effects
// keyframe fragments applied to the ENTIRE text block as one rigid unit.
const LAYER_IN_PRESETS = [
  'fadeIn', 'fadeUp', 'fadeDown', 'slideIn', 'popIn', 'zoomIn', 'bounceIn',
  'rotateIn', 'flipIn', 'blurIn', 'swingIn', 'elasticIn', 'dropIn', 'punchIn', 'glitchIn',
];
const LAYER_OUT_PRESETS = [
  'fadeOut', 'slideOut', 'zoomOut', 'shrinkOut', 'popOut', 'blurOut', 'rotateOut', 'dropOut', 'bounceOut',
];
// Character/word/line presets: expand into a real `animators` entry
// instead (the existing per-character reveal mechanism), since these are
// inherently about how the TEXT CONTENT itself reveals, not the block.
const CHAR_IN_PRESETS = ['typewriter', 'wordCascade', 'lineCascade', 'splitIn'];
const CHAR_OUT_PRESETS = ['dissolveOut'];

const TEXT_IN_PRESETS = [...LAYER_IN_PRESETS, ...CHAR_IN_PRESETS];
const TEXT_OUT_PRESETS = [...LAYER_OUT_PRESETS, ...CHAR_OUT_PRESETS];
const TEXT_ANIMATION_DIRECTIONS = ['left', 'right', 'up', 'down'];

const DIRECTION_VECTOR = {
  left: [-70, 0], right: [70, 0], up: [0, -70], down: [0, 70],
};

/** Reads a layer's own authored value for a property (plain, or the settled/last keyframe of an animated one) - the "landing spot" every generated preset animates TOWARD, so it never fights whatever base placement the layer already has. */
function baseValueOf(value, fallback) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value.keyframes) && value.keyframes.length > 0) {
    const last = value.keyframes[value.keyframes.length - 1];
    if (isPlainObject(last) && (typeof last.value === 'number' || Array.isArray(last.value))) return last.value;
  }
  return fallback;
}

function addVec(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function scaleVec(v, s) { return [v[0] * s, v[1] * s]; }

/**
 * Builds the keyframe fragment for ONE whole-layer preset - always a
 * segment that LANDS exactly on `base` (in-presets) or DEPARTS exactly
 * FROM `base` (out-presets) at the specified time, so preset segments
 * chain cleanly with whatever the layer's own natural resting value is.
 * Returns `{ position?, scale?, opacity?, rotation?, effects? }` -
 * only the properties this specific preset actually touches.
 */
function buildLayerPresetFragment(preset, { base, startAt, duration, direction, isOut }) {
  const endAt = round(startAt + duration);
  const pos = Array.isArray(base.position) ? base.position : [0, 0];
  const scale = Array.isArray(base.scale) ? base.scale : [1, 1];
  const opacity = typeof base.opacity === 'number' ? base.opacity : 1;
  const rotation = typeof base.rotation === 'number' ? base.rotation : 0;
  const dirVec = DIRECTION_VECTOR[direction] || DIRECTION_VECTOR.up;

  const out = {};
  const seg = (a, b, easing) => (isOut
    ? [{ time: startAt, value: a, interpolation: 'easing', easing }, { time: endAt, value: b, interpolation: 'easing', easing }]
    : [{ time: startAt, value: a, interpolation: 'easing', easing }, { time: endAt, value: b, interpolation: 'easing', easing }]);

  switch (preset) {
    case 'fadeIn':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      break;
    case 'fadeUp':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      out.position = seg(addVec(pos, [0, 36]), pos, 'easeOutCubic');
      break;
    case 'fadeDown':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      out.position = seg(addVec(pos, [0, -36]), pos, 'easeOutCubic');
      break;
    case 'slideIn':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      out.position = seg(addVec(pos, dirVec), pos, 'easeOutCubic');
      break;
    case 'popIn':
      out.opacity = [{ time: startAt, value: 0, interpolation: 'easing', easing: 'easeOutQuad' }, { time: round(startAt + duration * 0.5), value: opacity, interpolation: 'easing', easing: 'easeOutQuad' }];
      out.scale = seg(scaleVec(scale, 0.55), scale, 'easeOutBack');
      break;
    case 'zoomIn':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      out.scale = seg(scaleVec(scale, 1.6), scale, 'easeOutQuart');
      break;
    case 'bounceIn':
      out.opacity = [{ time: startAt, value: 0, interpolation: 'easing', easing: 'easeOutQuad' }, { time: round(startAt + duration * 0.4), value: opacity, interpolation: 'easing', easing: 'easeOutQuad' }];
      out.scale = seg(scaleVec(scale, 0.3), scale, 'easeOutBounce');
      break;
    case 'rotateIn':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      out.rotation = seg(rotation - 18, rotation, 'easeOutBack');
      break;
    case 'flipIn': {
      const axis = direction === 'left' || direction === 'right' ? 1 : 0; // vertical directions flip the OTHER axis
      const flipped = [...scale];
      flipped[axis] = -scale[axis];
      out.scale = seg(flipped, scale, 'easeInOutCubic');
      break;
    }
    case 'blurIn':
      out.opacity = seg(0, opacity, 'easeOutQuad');
      out.effects = { type: 'gaussianBlur', params: { radius: seg(22, 0, 'easeOutCubic') } };
      break;
    case 'swingIn': {
      const t0 = startAt; const t1 = round(startAt + duration * 0.35); const t2 = round(startAt + duration * 0.65); const t3 = endAt;
      out.rotation = [
        { time: t0, value: rotation - 16, interpolation: 'easing', easing: 'easeOutSine' },
        { time: t1, value: rotation + 8, interpolation: 'easing', easing: 'easeInOutSine' },
        { time: t2, value: rotation - 4, interpolation: 'easing', easing: 'easeInOutSine' },
        { time: t3, value: rotation, interpolation: 'easing', easing: 'easeInOutSine' },
      ];
      out.opacity = [{ time: t0, value: 0, interpolation: 'easing', easing: 'easeOutQuad' }, { time: round(startAt + duration * 0.3), value: opacity, interpolation: 'easing', easing: 'easeOutQuad' }];
      break;
    }
    case 'elasticIn':
      out.opacity = [{ time: startAt, value: 0, interpolation: 'easing', easing: 'easeOutQuad' }, { time: round(startAt + duration * 0.3), value: opacity, interpolation: 'easing', easing: 'easeOutQuad' }];
      out.scale = seg(scaleVec(scale, 0.4), scale, 'easeOutElastic');
      break;
    case 'dropIn': {
      const mid = round(startAt + duration * 0.7);
      out.position = [
        { time: startAt, value: addVec(pos, [0, -50]), interpolation: 'easing', easing: 'easeInQuad' },
        { time: mid, value: addVec(pos, [0, 6]), interpolation: 'easing', easing: 'easeOutCubic' },
        { time: endAt, value: pos, interpolation: 'easing', easing: 'easeOutCubic' },
      ];
      out.opacity = [{ time: startAt, value: 0, interpolation: 'easing', easing: 'easeOutQuad' }, { time: round(startAt + duration * 0.3), value: opacity, interpolation: 'easing', easing: 'easeOutQuad' }];
      break;
    }
    case 'punchIn': {
      const mid = round(startAt + duration * 0.55);
      out.scale = [
        { time: startAt, value: scale, interpolation: 'easing', easing: 'easeOutQuad' },
        { time: mid, value: scaleVec(scale, 1.22), interpolation: 'easing', easing: 'easeOutQuad' },
        { time: endAt, value: scale, interpolation: 'easing', easing: 'easeOutBack' },
      ];
      out.opacity = [{ time: startAt, value: 0, interpolation: 'hold' }, { time: startAt, value: opacity, interpolation: 'easing', easing: 'linear' }];
      break;
    }
    case 'glitchIn': {
      const n = 4; const kfs = [];
      for (let i = 0; i <= n; i++) {
        const t = round(startAt + (i / n) * duration);
        const jitter = i === n ? pos : addVec(pos, [(i % 2 === 0 ? 1 : -1) * (8 - i), (i % 2 === 0 ? -1 : 1) * (6 - i)]);
        kfs.push({ time: t, value: jitter, interpolation: i === n ? 'easing' : 'hold', easing: 'linear' });
      }
      out.position = kfs;
      out.opacity = [
        { time: startAt, value: 0, interpolation: 'hold' },
        { time: round(startAt + duration * 0.15), value: opacity, interpolation: 'hold' },
        { time: round(startAt + duration * 0.35), value: opacity * 0.3, interpolation: 'hold' },
        { time: round(startAt + duration * 0.5), value: opacity, interpolation: 'hold' },
        { time: endAt, value: opacity, interpolation: 'linear' },
      ];
      break;
    }
    // OUT presets - mirror structure, DEPART from base.
    case 'fadeOut':
      out.opacity = seg(opacity, 0, 'easeInCubic');
      break;
    case 'slideOut':
      out.opacity = seg(opacity, 0, 'easeInCubic');
      out.position = seg(pos, addVec(pos, dirVec), 'easeInCubic');
      break;
    case 'zoomOut':
      out.opacity = seg(opacity, 0, 'easeInQuart');
      out.scale = seg(scale, scaleVec(scale, 1.4), 'easeInQuart');
      break;
    case 'shrinkOut':
      out.opacity = seg(opacity, 0, 'easeInCubic');
      out.scale = seg(scale, scaleVec(scale, 0.5), 'easeInCubic');
      break;
    case 'popOut': {
      const mid = round(startAt + duration * 0.35);
      out.scale = [
        { time: startAt, value: scale, interpolation: 'easing', easing: 'easeInQuad' },
        { time: mid, value: scaleVec(scale, 1.15), interpolation: 'easing', easing: 'easeInBack' },
        { time: endAt, value: scaleVec(scale, 0.3), interpolation: 'easing', easing: 'easeInBack' },
      ];
      out.opacity = seg(opacity, 0, 'easeInCubic');
      break;
    }
    case 'blurOut':
      out.opacity = seg(opacity, 0, 'easeInCubic');
      out.effects = { type: 'gaussianBlur', params: { radius: seg(0, 20, 'easeInCubic') } };
      break;
    case 'rotateOut':
      out.opacity = seg(opacity, 0, 'easeInCubic');
      out.rotation = seg(rotation, rotation + 18, 'easeInBack');
      break;
    case 'dropOut':
      out.opacity = seg(opacity, 0, 'easeInCubic');
      out.position = seg(pos, addVec(pos, [0, 60]), 'easeInCubic');
      break;
    case 'bounceOut': {
      const mid = round(startAt + duration * 0.3);
      out.scale = [
        { time: startAt, value: scale, interpolation: 'easing', easing: 'easeInQuad' },
        { time: mid, value: scaleVec(scale, 1.2), interpolation: 'easing', easing: 'easeInBack' },
        { time: endAt, value: scaleVec(scale, 0.05), interpolation: 'easing', easing: 'easeInBack' },
      ];
      out.opacity = seg(opacity, 0, 'easeInQuad');
      break;
    }
    default:
      return null;
  }
  return out;
}

/** Character/word/line presets populate a real `animators` entry (schema-shape: selector + properties) instead of layer-level keyframes - the existing per-character reveal mechanism, exercised here as a formal named preset rather than requiring hand-authored selector math every time. */
function buildCharAnimatorFragment(preset, { startAt, duration, isOut }) {
  const endAt = round(startAt + duration);
  const basedOn = preset === 'lineCascade' ? 'lines' : (preset === 'typewriter' ? 'characters' : (preset === 'splitIn' || preset === 'dissolveOut' ? 'characters' : 'words'));
  const selector = {
    type: 'range',
    start: 0,
    end: isOut
      ? { keyframes: [{ time: startAt, value: 100, interpolation: 'easing', easing: 'easeInCubic' }, { time: endAt, value: 0, interpolation: 'easing', easing: 'easeInCubic' }] }
      : { keyframes: [{ time: startAt, value: 0, interpolation: 'easing', easing: 'easeOutCubic' }, { time: endAt, value: 100, interpolation: 'easing', easing: 'easeOutCubic' }] },
    basedOn,
  };
  const properties = { opacity: -1 };
  if (preset === 'wordCascade' || preset === 'lineCascade') properties.scale = 1.15;
  if (preset === 'splitIn') { properties.scale = 1.3; properties.position = [0, 26]; }
  if (preset === 'dissolveOut') { properties.scale = 0.6; properties.position = [0, -18]; }
  return { selector, properties };
}

/**
 * Merges multiple keyframe-array fragments for the SAME property
 * (an in-segment and/or an out-segment) into one sorted array - Property
 * itself sorts by time too, but pre-sorting here keeps the emitted JSON
 * readable/debuggable.
 */
function mergeKeyframeSegments(segments) {
  const all = segments.filter(Boolean).flat();
  return all.sort((a, b) => a.time - b.time);
}

/**
 * THE entry point: expands `layer.textAnimation` (if present) into real
 * position/scale/opacity/rotation/effects/animators fields, or - if
 * ABSENT and the layer has no motion of its own already (no animators,
 * no keyframed position/scale/opacity/rotation) - auto-assigns a
 * default preset so no text layer can ever ship as a static instant
 * pop-in. Always deletes `layer.textAnimation` when done - the render
 * pipeline (sceneBuilder.js) never needs to know this field existed, it
 * only ever sees ordinary keyframed layers.
 */
const DEFAULT_PRESET_ROTATION = ['fadeUp', 'slideIn', 'popIn', 'fadeIn'];

function hasOwnMotion(layer) {
  const animated = (v) => isPlainObject(v) && Array.isArray(v.keyframes) && v.keyframes.length > 0;
  if (animated(layer.position) || animated(layer.scale) || animated(layer.opacity) || animated(layer.rotation)) return true;
  if (Array.isArray(layer.animators) && layer.animators.length > 0) return true;
  return false;
}

function applyTextAnimationPreset(layer, beatDuration, layerIndex) {
  if (!isPlainObject(layer) || layer.type !== 'text') return;

  let spec = layer.textAnimation;
  const specIsValid = isPlainObject(spec) && (spec.in || spec.out);
  if (!specIsValid) {
    delete layer.textAnimation;
    if (hasOwnMotion(layer)) return; // already animated some other way (e.g. a hand-authored per-character reveal) - don't fight it
    // MANDATORY fallback: guarantees every static text layer still gets
    // a real, tasteful entrance rather than appearing instantly.
    spec = { in: { preset: DEFAULT_PRESET_ROTATION[layerIndex % DEFAULT_PRESET_ROTATION.length] } };
  } else {
    delete layer.textAnimation;
  }

  const base = {
    position: baseValueOf(layer.position, [0, 0]),
    scale: baseValueOf(layer.scale, [1, 1]),
    opacity: baseValueOf(layer.opacity, 1),
    rotation: baseValueOf(layer.rotation, 0),
  };

  const positionSegs = []; const scaleSegs = []; const opacitySegs = []; const rotationSegs = [];
  let blurEffect = null;
  const charAnimators = [];

  const inSpec = isPlainObject(spec.in) ? spec.in : (typeof spec.in === 'string' ? { preset: spec.in } : null);
  const outSpec = isPlainObject(spec.out) ? spec.out : (typeof spec.out === 'string' ? { preset: spec.out } : null);

  if (inSpec && typeof inSpec.preset === 'string') {
    const startAt = typeof inSpec.startAt === 'number' ? Math.max(0, inSpec.startAt) : 0;
    const duration = typeof inSpec.duration === 'number' && inSpec.duration > 0 ? inSpec.duration : 0.45;
    const direction = TEXT_ANIMATION_DIRECTIONS.includes(inSpec.direction) ? inSpec.direction : 'up';
    if (CHAR_IN_PRESETS.includes(inSpec.preset)) {
      charAnimators.push(buildCharAnimatorFragment(inSpec.preset, { startAt, duration: Math.max(duration, layer.text && layer.text.length ? layer.text.length * 0.035 : duration), isOut: false }));
    } else if (LAYER_IN_PRESETS.includes(inSpec.preset)) {
      const frag = buildLayerPresetFragment(inSpec.preset, { base, startAt, duration, direction, isOut: false });
      if (frag) {
        if (frag.position) positionSegs.push(frag.position);
        if (frag.scale) scaleSegs.push(frag.scale);
        if (frag.opacity) opacitySegs.push(frag.opacity);
        if (frag.rotation) rotationSegs.push(frag.rotation);
        if (frag.effects) blurEffect = frag.effects;
      }
    }
  }

  if (outSpec && typeof outSpec.preset === 'string') {
    const duration = typeof outSpec.duration === 'number' && outSpec.duration > 0 ? outSpec.duration : 0.4;
    const startAt = typeof outSpec.startAt === 'number' ? Math.max(0, outSpec.startAt) : Math.max(0, beatDuration - duration);
    const direction = TEXT_ANIMATION_DIRECTIONS.includes(outSpec.direction) ? outSpec.direction : 'up';
    if (CHAR_OUT_PRESETS.includes(outSpec.preset)) {
      charAnimators.push(buildCharAnimatorFragment(outSpec.preset, { startAt, duration, isOut: true }));
    } else if (LAYER_OUT_PRESETS.includes(outSpec.preset)) {
      const frag = buildLayerPresetFragment(outSpec.preset, { base, startAt, duration, direction, isOut: true });
      if (frag) {
        if (frag.position) positionSegs.push(frag.position);
        if (frag.scale) scaleSegs.push(frag.scale);
        if (frag.opacity) opacitySegs.push(frag.opacity);
        if (frag.rotation) rotationSegs.push(frag.rotation);
        if (frag.effects) blurEffect = frag.effects;
      }
    }
  }

  if (positionSegs.length) layer.position = { keyframes: mergeKeyframeSegments(positionSegs) };
  if (scaleSegs.length) layer.scale = { keyframes: mergeKeyframeSegments(scaleSegs) };
  if (opacitySegs.length) layer.opacity = { keyframes: mergeKeyframeSegments(opacitySegs) };
  if (rotationSegs.length) layer.rotation = { keyframes: mergeKeyframeSegments(rotationSegs) };
  if (blurEffect) {
    if (!Array.isArray(layer.effects)) layer.effects = [];
    layer.effects.push(blurEffect);
  }
  if (charAnimators.length) {
    if (!Array.isArray(layer.animators)) layer.animators = [];
    layer.animators.push(...charAnimators);
  }
}

/**
 * Called once per beat from sceneBuilder.js's buildBeatVisual - RENDER
 * time, not generation-validation time. Deliberately placed after the
 * AI-generation validation pipeline (validateSceneJSON/autoRepairBeat)
 * has already run and passed, not inside it: the validator enforces a
 * hard cubic-only easing rule on whatever the AI itself hand-authors
 * (see validateAnimatable's own doc comment - a real product requirement
 * because prompt instructions alone don't reliably hold for an LLM
 * picking from 30 named easings), but that constraint has no reason to
 * apply to this trusted, deterministic, unit-tested preset library,
 * which uses the FULL richer easing registry (back/elastic/bounce/quad/
 * sine/quart) deliberately for real bounce/overshoot personality -
 * running here means it never passes back through that AI-facing check.
 * Also means this applies uniformly to every beat that gets rendered
 * (a harvester test, a live user generation, an edit-flow re-render, or
 * hand-authored test JSON) regardless of how it was produced.
 */
function applyTextAnimationPresets(visual, duration) {
  if (!isPlainObject(visual) || !Array.isArray(visual.layers)) return;
  const beatDuration = typeof duration === 'number' && duration > 0 ? duration : 1.5;
  visual.layers.forEach((layer, i) => applyTextAnimationPreset(layer, beatDuration, i));
}

module.exports = {
  TEXT_IN_PRESETS, TEXT_OUT_PRESETS, TEXT_ANIMATION_DIRECTIONS,
  applyTextAnimationPresets, applyTextAnimationPreset,
};
