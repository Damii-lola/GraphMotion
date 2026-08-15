const fetch = require('node-fetch');
const {
  validateSceneJSON, LAYER_TYPES, SHAPE_KINDS, PATH_OP_MODES,
  RANGE_SELECTOR_SHAPES, TRACK_MATTE_TYPES, GENERATE_KINDS, LIGHT_TYPES,
  FALLOFF_TYPES, BLEND_MODE_NAMES, EASING_NAMES, EFFECT_TYPES, TRANSITION_TYPES,
} = require('./sceneSchema');

/**
 * The real "Mistral" piece: key rotation, the HTTP call with its
 * timeout, truncation detection, JSON extraction - AND now a real
 * system prompt teaching the full scene schema (sceneSchema.js) so the
 * model can actually direct the batch 1-11 engine (via sceneBuilder.js)
 * to produce genuine After-Effects-style motion graphics, not just
 * emit syntactically-valid-but-empty JSON. Every enum list below is
 * pulled directly from sceneSchema.js's own real exported constants
 * (not hand-copied) so this prompt can never silently drift out of
 * sync with what the validator/interpreter actually accept.
 *
 * generateSceneJSON/generateEditedSceneJSON keep their exported names/
 * signatures so renderWorker.js needed no edits. Both now also run the
 * real validateSceneJSON on the result and retry (within the existing
 * retriesLeft budget) with the validation errors fed back as context on
 * failure - exactly the design sceneSchema.js's own doc comment already
 * described ("mistralClient.js retries generation with the errors fed
 * back as context").
 */

const KEYS = (process.env.MISTRAL_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

const MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';

if (KEYS.length === 0) {
  console.warn('[mistralClient] No MISTRAL_API_KEYS configured');
}

function pickKey() {
  return KEYS[Math.floor(Math.random() * KEYS.length)];
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in Mistral response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const MISTRAL_TIMEOUT_MS = 75000;

/**
 * Shared by both the fresh-generation and edit paths - same API call
 * shape, same truncation detection. Only the system/user prompt
 * differ between the two callers below.
 */
async function callMistralForJSON(systemPrompt, userMessage, retriesLeft, onRetry) {
  const maxTokens = 8000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pickKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Mistral request timed out after ${MISTRAL_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content;
  if (!rawText) throw new Error('Mistral returned no content');

  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error(`Mistral response was truncated (hit max_tokens=${maxTokens}) before completing the JSON`);
  }

  try {
    return extractJson(rawText);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] JSON parse failed (${err.message}), retrying...`);
      return onRetry(err, retriesLeft - 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// The real system prompt. Composition is WIDTH x HEIGHT = 720 x 1280
// (a 9:16 vertical short-form frame, matching renderEngine.js's own
// real constants) - stated explicitly below since every layer position
// in the schema is authored in these pixel units.
// ---------------------------------------------------------------------

const COMP_WIDTH = 720;
const COMP_HEIGHT = 1280;

const SCHEMA_REFERENCE = `
You are directing a REAL motion graphics rendering engine - not writing
a description of a video, not choosing from a fixed template library.
Every field you output maps to an actual, already-built function call
against a real 2D/3D compositing engine (comparable in capability to
After Effects: real bezier shapes, real per-character text animation,
real 3D layers with perspective and lighting, real blend modes and
track mattes, real blur/color-grading/glitch/distort effects, real
transitions). Your job is to compose these real primitives into
genuinely well-designed, dynamic motion graphics - not a static image
with a caption. Nothing here is decorative flavor text: every option
below is real and will actually render.

The output is ALWAYS a single JSON object, no markdown fences, no
prose outside the JSON: { "scenes": [ Beat, ... ] }

The canvas is ${COMP_WIDTH} x ${COMP_HEIGHT} pixels (9:16 vertical). Every
position/size you author is in these pixel units, origin (0,0) at the
top-left for 2D content. Keep primary content within a safe zone
roughly 60px in from every edge so nothing critical is clipped.

=====================================================================
BEAT
=====================================================================
{
  "params": {
    "duration": number,       // seconds, REQUIRED. Overridden automatically
                               // if "narration" is set (real measured speech
                               // duration + 0.4s), so treat it as an ESTIMATE
                               // when narration is present, exact otherwise.
    "narration": string,      // optional spoken line for this beat (real TTS)
    "imagePrompt": string     // optional - fetches a REAL photo for this beat;
                               // reference it from a layer via {"type":"image",
                               // "src":"beatImage"}. Omit if this beat doesn't
                               // need a photo.
  },
  "visual": BeatVisual
}

Whole-video duration is capped at 30 seconds of narration. Pace beats
accordingly: for short-form content, 2-5 seconds per beat is typical;
a beat with narration should roughly match how long that line takes to
speak (~2.5-3 words/second is a reasonable estimate).

=====================================================================
ANIMATABLE VALUES - every transform/effect number or vector accepts:
=====================================================================
1. A plain value:              5   or   [100, 200]
2. Real keyframes:
   { "keyframes": [
       { "time": 0,   "value": 0,   "interpolation": "easing", "easing": "easeOutCubic" },
       { "time": 0.5, "value": 100, "interpolation": "easing", "easing": "easeInOutQuad" }
     ] }
   interpolation: "hold" | "linear" | "easing" | "bezier"
   easing (when interpolation is "easing"): one of
     ${EASING_NAMES.join(', ')}
3. An expression (real JS, sandboxed):
   { "expression": "wiggle(2, 20)", "base": <AnimatableValue> }
   "time" and "value" (= base's resolved value) are in scope. wiggle(freq,amp)
   is available for organic drift. Omit "base" for a pure function of time.

USE REAL MOTION. A layer that never moves/scales/fades is a static
image, not motion graphics - animate position, opacity, and scale on
nearly every layer's entrance (and often its whole duration).

=====================================================================
BEATVISUAL
=====================================================================
{
  "is3D": boolean,            // false (default) = 2D composition. true = every
                               // layer becomes a flat plane in real 3D space
                               // with a camera and lights - use this for
                               // genuine depth, perspective, rotating cards,
                               // parallax. Layer AUTHORING (contents, text,
                               // effects) is IDENTICAL in both modes.
  "background": LayerDef | null,  // optional full-frame layer drawn first
                                    // (typically a "generate" gradient/noise,
                                    // or a solid-fill shape sized to the frame)
  "layers": [ LayerDef, ... ],  // REQUIRED. Stacking order: LATER entries
                                  // draw ON TOP of earlier ones.
  "camera": CameraDef,          // only used if is3D
  "lights": [ LightDef, ... ],  // only used if is3D
  "transitionIn": TransitionDef | null  // how this beat enters from whatever
                                          // the PREVIOUS beat ended on. Omit
                                          // for a hard cut (fine for beat 1,
                                          // and fine often - don't force a
                                          // transition on every single beat).
}

=====================================================================
LAYERDEF - one entry in "layers" (or "background")
=====================================================================
{
  "id": string,          // required only if another layer's "parent" or a
                          // trackMatte's "source" needs to reference this one
  "type": ${LAYER_TYPES.map((t) => `"${t}"`).join(' | ')},

  "position": AnimatableValue<[x,y]> (2D) or [x,y,z] (3D, default [0,0,0]),
  "rotation": AnimatableValue<number> (2D only, degrees),
  "rotationX"/"rotationY"/"rotationZ": AnimatableValue<number> (3D only, degrees),
  "scale": AnimatableValue<[sx,sy]> (2D) or [sx,sy,sz] (3D),
  "anchor": AnimatableValue<[x,y]> or [x,y,z> - the pivot point for rotation/scale,
  "opacity": AnimatableValue<number> (0-1, default 1),

  "blendMode": ${BLEND_MODE_NAMES.join(' | ')}  // 2D only, default "normal"
  "trackMatte": { "source": <layerId>, "type": ${TRACK_MATTE_TYPES.map((t) => `"${t}"`).join(' | ')} },
                 // 2D only - clips THIS layer to another layer's shape/luma.
                 // The source layer is automatically hidden from the normal
                 // stack once used as a matte (don't also try to hide it
                 // yourself, but DO give it full opacity - an invisible/
                 // zero-opacity matte source produces a fully-clipped result).
  "isAdjustmentLayer": boolean,  // this layer's "effects" post-process
                                   // EVERYTHING below it instead of itself
  "effects": [ EffectDef, ... ],  // this layer's own effects stack, see below
  "parent": <layerId>,            // real parenting - this layer's transform
                                    // is relative to the parent's
  "material": { "ambient": 0-1, "diffuse": 0-1, "specularStrength": 0-1, "shininess": number },
              // 3D only - opts this layer INTO real scene lighting (lit by
              // "lights"). Omit for a flat, self-illuminated (unlit) layer -
              // most UI/text/icon content should stay unlit; use material on
              // things meant to look like real physical objects (cards,
              // product shapes) in a 3D beat.
  "width", "height": number  // REQUIRED for "shape"/"generate" layers, and for
                              // any layer used inside an "is3D":true beat
                              // (defaults to the full frame size if omitted,
                              // which is correct for a full-frame background
                              // but wrong for a smaller 3D object)

  // --- type:"shape" ---
  "contents": [ ShapeContentItem, ... ],   // see below

  // --- type:"text" ---
  "text": string, "fontFamily": string, "fontWeight": string, "fontSize": number,
  "lineHeight": number, "maxWidth": number, "fillStyle": color,
  "animators": [ { "selector": SelectorDef, "properties": { "opacity": number,
      "position": [dx,dy], "scale": number, "rotation": number } }, ... ],
      // real per-character animation - see SELECTORS below. properties are
      // DELTAS applied at full selector strength (e.g. position:[0,40] moves
      // a character 40px down when "selected").
  "onPath": { "anchors": [{"point":[x,y]}, ...], "firstMargin", "lastMargin",
      "reversePath", "perpendicularToPath", "forceAlignment" },  // omit for
      // straight baseline text; present -> text flows along this bezier path

  // --- type:"image" ---
  "src": "beatImage" | "<absolute local file path>",  // "beatImage" is the
      // common case: uses this beat's own params.imagePrompt-fetched photo

  // --- type:"precomp" ---
  "layers": [ LayerDef, ... ],   // nested, recursive - a real sub-composition
  "isolate": boolean,             // default true (pre-composited as one flat
                                    // unit - needed for whole-group opacity/
                                    // blend to work correctly)

  // --- type:"generate" ---
  "generate": { "kind": ${GENERATE_KINDS.map((k) => `"${k}"`).join(' | ')}, "params": {...} }
      // see GENERATE KINDS below for real per-kind params

  // --- type:"null" ---
  // no extra fields - a pure transform/parent, invisible itself
}

=====================================================================
SHAPECONTENTITEM - entries in a shape layer's "contents" array, applied
TOP TO BOTTOM building up a running path list (this mirrors the real
engine exactly, not a simplification):
=====================================================================
{ "type": "path", "shape": { "kind": ${SHAPE_KINDS.map((k) => `"${k}"`).join(' | ')}, "params": {...} } }
    rectangle: { width, height, position:[x,y] (default [0,0], CENTERED on
      position), roundness (px corner radius) }
    ellipse:   { width, height, position:[x,y] (default [0,0], centered) }
    polygon:   { points (side count), radius, position, rotation (deg), roundness }
    star:      { points, innerRadius, outerRadius, position, rotation (deg),
                 innerRoundness, outerRoundness }
    NOTE: shape geometry is centered on its own local (0,0) by default,
    matching real vector-tool authoring - the LAYER's own position/anchor is
    what actually places it on screen, not the shape's own "position" param
    (that param only re-centers the path within the layer's local space).
{ "type": "trim", "start": AnimatableValue<0-100>, "end": AnimatableValue<0-100>,
    "offset": AnimatableValue<0-100>, "multiple": "individually" | "simultaneously" }
    // real Trim Paths - animate start/end for a genuine "drawing on" reveal
{ "type": "repeater", "copies": AnimatableValue<number>,
    "transform": { "position":[dx,dy], "rotation", "scale":[sx,sy], "anchor" },
    "startOpacity", "endOpacity", "order": "below" | "above" }
    // stamps N copies, each offset by one more increment of "transform"
{ "type": "pathOp", "mode": ${PATH_OP_MODES.map((m) => `"${m}"`).join(' | ')} }
    // boolean-combines all paths built so far
{ "type": "fill", "color": "#rrggbb", "opacity": AnimatableValue<0-1>, "fillRule": "nonzero" | "evenodd" }
{ "type": "stroke", "color": "#rrggbb", "width": AnimatableValue<number>,
    "cap": "butt"|"round"|"square", "join": "miter"|"round"|"bevel", "dash": [number,...], "opacity" }
{ "type": "group", "contents": [ ShapeContentItem, ... ],
    "transform": { "position","rotation","scale","anchor","opacity" } }
    // nests a sub-stack under its own extra transform

Colors are always full 6-digit hex ("#rrggbb" or "#rrggbbaa") - 3-digit
shorthand ("#333") is NOT supported and will render wrong.

=====================================================================
SELECTORS (per-character text animator drivers)
=====================================================================
{ "type": "range", "start": AnimatableValue<0-100>, "end": AnimatableValue<0-100>,
  "offset": AnimatableValue<0-100>, "shape": ${RANGE_SELECTOR_SHAPES.map((s) => `"${s}"`).join(' | ')},
  "smoothness": 0-100, "basedOn": "characters" | "words", "amount": AnimatableValue<number>,
  "randomizeOrder": boolean, "randomSeed": number }
  // THE standard reveal driver. For a classic left-to-right character
  // reveal: keep "start" fixed at 0 and animate "end" from 0 to 100 over
  // your reveal duration (shape:"square" is a clean per-character cutoff).
{ "type": "wiggly", "frequency": number, "seed": number, "correlation": 0-100,
  "minAmount": number, "maxAmount": number }
  // continuous organic per-character jitter, not a one-time reveal

An animator's "properties" are applied as DELTAS at full ("selected")
strength, inverted automatically for a natural reveal (unselected =
full delta applied = hidden/offset; selected = delta removed = landed).
So { "position":[0,40], "opacity":-1 } with a range selector sweeping
0->100 makes each character rise 40px and fade in as the sweep reaches it.

=====================================================================
EFFECTS - EffectDef: { "type": <name>, "params": {...} }, real per-type params:
=====================================================================
Applied to a layer via its own "effects" array (see LAYERDEF above).
Valid types: ${EFFECT_TYPES.join(', ')}

  gaussianBlur: { radius=8 }
  boxBlur: { radius=8, iterations=1 }
  directionalBlur: { length=20, angle=0 (deg) }
  radialBlur: { amount=10, center=[x,y] (default layer center), mode="zoom"|"spin", samples=12 }
  curves: { master, r, g, b: [[x,y], ...] control points (0-255 each) }
  hueSaturation: { hueShift=0 (deg), saturationScale=1, lightnessShift=0 }
  colorBalance: { shadows=[r,g,b], midtones=[r,g,b], highlights=[r,g,b] (each -100..100) }
  levels: { inBlack=0, inWhite=255, gamma=1, outBlack=0, outWhite=255, channel="master" }
  addGrain: { intensity=0.15, size=1, seed=0 }
  addNoise: { amount=20, monochrome=false, seed=0 }
  rgbShift: { redOffset=[8,0], greenOffset=[0,0], blueOffset=[-8,0] }
  blockDisplace: { bandHeight=8, maxShift=30, seed=0, probability=0.3 }
  scanLines: { spacing=3, darkenAmount=0.4, lineWidth=1 }
  pixelSort: { direction="horizontal"|"vertical", threshold=[0.25,0.75] }
  findEdges: { invert=false }
  emboss: { strength=1, angle=135 (deg) }
  posterize: { levels=4 }
  mosaic: { blockSize=10 }
  autoGlow: { threshold=0.7, blurRadius=15, intensity=1 }
  dropShadow: { color="#000000", opacity=0.75, blur=10, offsetX=8, offsetY=8 }
  outerGlow: { color="#FFD966", opacity=0.9, blur=16, blendMode="screen" }
  innerGlow: { color="#FFD966", opacity=0.85, blur=12 }
  innerShadow: { color="#000000", opacity=0.85, blur=12 }
  layerStroke: { color="#FFFFFF", width=6, align="center"|"inside"|"outside" }
  twirl: { center=[x,y], radius=200, angle=90 (deg) }
  bulge: { center=[x,y], radius=200, power=1.6 }
  rippleWarp: { center=[x,y], amplitude=10, wavelength=40, phase=0, decay=0 }
  waveWarp: { amplitude=10, wavelength=60, phase=0, direction="horizontal"|"vertical" }
  displacementMap: { maxDisplacement=20, xChannel="r", yChannel="g",
    map: {kind, params} (a GENERATE def used as the displacement source; omit for fractal noise) }

Use effects with intent (a subtle dropShadow/outerGlow for depth, a
tasteful gaussianBlur for a defocused background layer, grain for
texture) - don't stack many strong effects on everything.

=====================================================================
GENERATE KINDS - for "generate" layers and the "background" field:
=====================================================================
  gradientRamp: { startPoint=[0,0], endPoint=[w,0], startColor="#000000",
    endColor="#ffffff", shape="linear"|"radial", dither=true }
    // for a vertical top-to-bottom gradient use endPoint:[0,height]
  checkerboard: { tileSize=20, colorA="#ffffff", colorB="#000000" }
  grid: { cellWidth=40, cellHeight=40, lineColor="#ffffff", lineWidth=2, backgroundColor }
  lensFlare: { sourcePoint=[x,y], intensity=1, color="#fff2d0" }
  fractalNoise: { seed=0, octaves=5, persistence=0.5, lacunarity=2, scale=0.02, colorA, colorB }

A "generate" layer used as "background" should normally omit width/height
(defaults to the full frame) and position (defaults to filling from the
top-left corner).

=====================================================================
3D: CAMERA / LIGHTS (only when "is3D": true)
=====================================================================
CameraDef: { "position": AnimatableValue<[x,y,z]> (default [0,0,-1000]),
  "pointOfInterest": AnimatableValue<[x,y,z]> (default [0,0,0], what the
  camera looks at - world (0,0,z) projects to the CENTER of the frame under
  the default/any origin-facing camera), "zoom": AnimatableValue<number>
  (default 1000, larger = more telephoto) }. Omitting "camera" entirely uses
  a sensible default. Animate position/pointOfInterest for real camera moves
  (push-in, orbit, reveal).

LightDef: { "type": ${LIGHT_TYPES.join(' | ')},
  "position", "pointOfInterest" (spot/directional only, defines direction),
  "color"="#ffffff", "intensity"=1,
  "falloff": ${FALLOFF_TYPES.join(' | ')}, "falloffRadius"=500,
  "coneAngle"=90, "coneFeather"=50 (spot only) }
  // Only layers with a "material" set are actually lit - always include at
  // least one "ambient" light in a lit 3D beat, or unlit-facing layers will
  // render solid black.

3D layers are flat planes with real perspective - great for rotating cards,
parallax stacks (several layers at different z), and depth reveals. A
layer's own content (shape/text/generate/image/effects) is authored
EXACTLY like a 2D layer; only its position/rotation are 3D.

=====================================================================
TRANSITIONS - TransitionDef: { "type": <name>, "duration": seconds, "params": {...} }
=====================================================================
Valid types: ${TRANSITION_TYPES.join(', ')}
  crossDissolve: {}  (no params - simple alpha blend)
  linearWipe: { angle=0 (deg), softness=0.05 }
  radialWipe: { center=[x,y], startAngle=-90 }
  irisWipe: { shape="ellipse"|"polygon"|"star", center=[x,y], points=5 }
  venetianBlinds: { stripes=10, direction="horizontal"|"vertical" }
  gradientWipe: { seed=0, scale=0.02, softness=0.15 }
  card3DFlip: { axis="x"|"y" }
  glitchTransition: {}  (no params)

duration is typically 0.4-0.8s. Vary transition choice across a video -
don't use the same one on every beat.

=====================================================================
DESIGN QUALITY - this is the whole point, not an afterthought
=====================================================================
- Every beat should feel like a deliberately DESIGNED motion graphics
  shot, not a slide: a background, an entrance animation, and (for
  text) a real per-character reveal, at minimum.
- Vary composition across beats: don't repeat the same layout/shape/
  color every time. Use is3D for at least some beats in a longer video
  to get real depth and camera movement.
- Use color with intent (a coherent palette across the whole video, not
  random hex values per beat) and real hierarchy (one clear focal
  element per beat, not several competing ones).
- Prefer real keyframed motion with eased interpolation over static
  layers or expression-only wiggle for primary content; save
  expressions for secondary/ambient motion (background drift, idle
  bob).
- A trackMatte, an adjustment layer with a subtle color grade, or a
  light layer-stroke/glow are the kind of real detail that reads as
  "professionally designed" - use them where they fit, not everywhere.
`.trim();

function buildGenerationSystemPrompt(targetDurationSeconds) {
  return `${SCHEMA_REFERENCE}

=====================================================================
YOUR TASK
=====================================================================
Generate a complete, valid scene JSON for a short-form vertical video
matching the user's request below. Target roughly ${targetDurationSeconds}
seconds total across all beats (sum of params.duration). Output ONLY the
JSON object - no markdown fences, no commentary before or after it.`;
}

function buildEditSystemPrompt(targetDurationSeconds) {
  return `${SCHEMA_REFERENCE}

=====================================================================
YOUR TASK
=====================================================================
You will be given the CURRENT complete scene JSON and an edit
instruction. Output the COMPLETE, updated scene JSON with that
instruction applied - not a diff, not just the changed beat. Preserve
every beat/field the instruction doesn't ask you to change. Keep the
total duration close to the original (~${targetDurationSeconds}s) unless
the instruction explicitly asks to add/remove/lengthen beats. Output
ONLY the JSON object - no markdown fences, no commentary.`;
}

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12, { retriesLeft = 1, priorErrors = null } = {}) {
  const systemPrompt = buildGenerationSystemPrompt(targetDurationSeconds);
  const userMessage = priorErrors
    ? `${userPrompt}\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`
    : userPrompt;

  const result = await callMistralForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateSceneJSON(userPrompt, targetDurationSeconds, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] generated scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateSceneJSON(userPrompt, targetDurationSeconds, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Mistral-generated scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
}

async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 1, priorErrors = null } = {}) {
  const systemPrompt = buildEditSystemPrompt(targetDurationSeconds);
  let userMessage = `Current JSON:\n${JSON.stringify(previousSceneJSON)}\n\nInstruction: ${editInstruction}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`;

  const result = await callMistralForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] edited scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Mistral-generated edited scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
}

module.exports = { generateSceneJSON, generateEditedSceneJSON };
