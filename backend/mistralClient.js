const fetch = require('node-fetch');
const {
  validateSceneJSON, validateBeat, LAYER_TYPES, SHAPE_KINDS, SHAPE_CONTENT_TYPES, PATH_OP_MODES,
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

// Real, measured finding (not assumed): with response_format:json_object
// and no explicit instruction against it, mistral-large pretty-prints its
// JSON output with full 2-space indentation - for THIS schema's typical
// nesting depth (layer -> contents -> path -> shape -> params, or
// animators -> selector -> ...), that whitespace alone measured at
// ~49.6% of total output length on a real captured generation (26330
// chars pretty vs 13271 compact for the exact same parsed content) -
// i.e. close to HALF of every max_tokens budget was being spent on
// indentation, not content, pushing real generations (7204/8000 tokens
// on a modest 4-beat/10s video) dangerously close to truncation. Fixed
// two ways, together: (1) the system prompt now explicitly demands
// compact/minified JSON (see the OUTPUT FORMAT section below - verified
// live that the model actually complies, not just assumed), and (2)
// max_tokens/timeout below are raised as real safety margin on top of
// that fix, not a substitute for it.
// Raised again (120s -> 180s) after the two-pass creative-treatment
// architecture below made this a real, measured problem, not a
// hypothetical one: the JSON-encoding call now has to both READ a long
// director's treatment (large prompt) AND generate up to 18000 tokens
// of genuinely richer content, and a live run timed out at 120s doing
// exactly that. This is a different constraint from renderEngine.js's
// own render-time budget (which stayed fast on purpose) - generation
// quality, not generation speed, is the explicit priority here, so
// giving Mistral real room to finish a richer response is the correct
// tradeoff, not a regression.
const MISTRAL_TIMEOUT_MS = 180000;

/**
 * The shared transport - one real HTTP call, one real timeout/abort,
 * one real truncation check. `jsonMode` toggles response_format:
 * json_object (for schema generation) off for the free-text creative-
 * treatment pass below, which needs Mistral to actually write prose,
 * not force everything into a JSON string. Returns the raw text;
 * callers decide what to do with it (parse as JSON, or use as-is).
 */
async function callMistralRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 12000, temperature = 0.7 } = {}) {
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
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
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
    throw new Error(`Mistral response was truncated (hit max_tokens=${maxTokens}) before completing`);
  }

  return rawText;
}

/**
 * Shared by both the fresh-generation and edit paths - same API call
 * shape, same truncation detection. Only the system/user prompt
 * differ between the two callers below.
 */
async function callMistralForJSON(systemPrompt, userMessage, retriesLeft, onRetry) {
  // Raised from 12000: encoding a genuinely rich, director-planned
  // treatment (multiple background layers, real depth, more effects
  // per beat) is real additional content, not waste - the compact-JSON
  // fix already freed up the token budget this now spends on richer
  // scenes instead of indentation.
  const rawText = await callMistralRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 18000 });
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
// The real system prompt. Composition is WIDTH x HEIGHT = 540 x 960 (a
// 9:16 vertical short-form frame, matching renderEngine.js's own real
// constants) - stated explicitly below since every layer position in
// the schema is authored in these pixel units. Was 720x1280 - lowered
// together with renderEngine.js's own real render resolution after a
// production timeout incident (real per-frame rendering cost scales
// with pixel count across nearly the entire pipeline - see
// renderEngine.js's own doc comment for the full story). MUST stay in
// sync with renderEngine.js's WIDTH/HEIGHT - authored content is sized
// in these absolute pixel units, so a mismatch here would make Mistral
// author content proportioned for the wrong canvas size.
// ---------------------------------------------------------------------

const COMP_WIDTH = 540;
const COMP_HEIGHT = 960;

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

OUTPUT FORMAT - CRITICAL: output COMPACT, MINIFIED JSON - no indentation,
no line breaks, no spaces after ":" or ",". You have a limited output
token budget shared between formatting and actual content: pretty-
printed JSON with indentation can nearly DOUBLE the token cost of the
exact same content for a schema this deeply nested, risking your
response getting cut off mid-generation before the JSON is even
complete. Every character you spend on whitespace is a character you
can't spend on the scene itself. Write it as ONE continuous line, e.g.
{"scenes":[{"params":{"duration":2.5},"visual":{"is3D":false,"layers":[...]}}]}
- not spread across multiple indented lines.

The canvas is ${COMP_WIDTH} x ${COMP_HEIGHT} pixels (9:16 vertical). Every
position/size you author is in these pixel units, origin (0,0) at the
top-left for 2D content. Keep primary content within a safe zone
roughly 45px in from every edge so nothing critical is clipped.

EVERY object in a "layers" array and EVERY object in a shape's
"contents" array MUST include an explicit "type" field - this is
REQUIRED, never optional, never implied by other fields present. A fill
entry is {"type":"fill","color":"#rrggbb"} - NOT just {"color":"#rrggbb"}
with "type" left out because it seems obvious from "color" alone. A
layer is {"type":"shape",...} - NOT an object with contents/text/etc
but no "type" key. This is the single most common structural mistake:
double-check every object in every array has its own "type" before
finishing.

SIX COMPLETELY SEPARATE "type" VOCABULARIES - THEY NEVER CROSS OVER.
This schema has six different closed lists of names that all sound
adjacent but belong to six unrelated fields. Using a name from the
wrong list is the single most common mistake in real generated output -
memorize which list each name lives in:

  1. LAYER "type" (what KIND of layer this is, inside "layers"/
     "background"/a precomp's "layers"):
     ${LAYER_TYPES.join(', ')}
  2. SHAPE CONTENT "type" (entries inside a shape layer's "contents"
     array - building/filling/stroking/trimming/repeating a path):
     ${SHAPE_CONTENT_TYPES.join(', ')}
  3. EFFECT "type" (entries inside ANY layer's "effects" array - post-
     processing already-rendered pixels: blur/color/glow/grain/glitch/
     distort):
     ${EFFECT_TYPES.join(', ')}
  4. GENERATE "kind" (inside a "generate" layer's generate.kind field -
     procedurally drawing brand new pixels from nothing):
     ${GENERATE_KINDS.join(', ')}
  5. TRANSITION "type" (inside "transitionIn.type" only):
     ${TRANSITION_TYPES.join(', ')}
  6. LIGHT "type" (inside an entry of the beat-level "lights" array
     ONLY - lights are NEVER layers, they never appear in "layers"):
     ${LIGHT_TYPES.join(', ')}

Concretely, real mistakes seen in actual generated output that WILL
fail validation - never do these:
  WRONG: {"type":"trim",...} inside an "effects" array (trim is a SHAPE
    CONTENT type - it belongs inside "contents", not "effects")
  WRONG: {"type":"repeater",...} or {"type":"linearWipe",...} inside an
    "effects" array (repeater is a shape content type; linearWipe is a
    TRANSITION type - neither is a real effect)
  WRONG: {"type":"transform",...} anywhere - THERE IS NO "transform"
    EFFECT. A layer's position/rotation/scale/anchor ARE its transform,
    set directly as normal fields on the layer itself - never wrap a
    transform in an effects-array entry.
  WRONG: {"type":"spot",...} or {"type":"ambient",...} inside "layers" -
    those are LIGHT types, they belong in the beat's own "lights" array,
    never mixed into "layers".
  WRONG: "generate":{"kind":"addGrain",...} (addGrain/addNoise are
    EFFECTS - grain/noise texture is added to something that already
    exists via a layer's "effects" array, never generated from nothing
    via generate.kind)
  WRONG: {"type":"adjustment",...} as a layer type (adjustment layers
    are a normal layer with isAdjustmentLayer:true, not a distinct type)
  RIGHT: want grain on a background? {"type":"generate","generate":
    {"kind":"fractalNoise",...},"effects":[{"type":"addGrain",
    "params":{...}}]} - generate the base texture, THEN add the grain
    effect on top, as two separate real mechanisms, not one field
    doing both jobs.
  RIGHT: want a spotlight? Add {"type":"spot",...} to the beat's
    "lights" array (a sibling of "layers", not inside it) - never as a
    "layers" entry.

Before finishing, mentally check every single "type"/"kind" value you
wrote against the list it's actually supposed to come from.

JSON STRING ESCAPING - a real, repeated failure: any quote character
("), backslash (\\), or literal newline INSIDE a text value (e.g.
"text":"...") MUST be escaped (\\", \\\\, \\n) or the JSON becomes
invalid and your entire response is unusable. If a piece of copy would
naturally use a quote mark, either escape it properly or rephrase to
avoid it - a broken response is worse than a slightly reworded line.

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
  "layers": [ LayerDef, ... ],  // REQUIRED, must be NON-EMPTY - every beat
                                  // needs real foreground content (text,
                                  // shapes, an image...). "background" alone
                                  // with an empty "layers" array renders as
                                  // a dead, empty frame with nothing
                                  // happening for that beat's WHOLE duration
                                  // - confirmed directly as a multi-second
                                  // static void in real generated output.
                                  // Never leave a beat with nothing in it.
                                  // Stacking order: LATER entries draw ON
                                  // TOP of earlier ones.
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
  "anchor": AnimatableValue<[x,y]> or [x,y,z] - the pivot point for
            rotation/scale, ALSO the point of the layer that lands
            exactly at "position". Default [0,0,0] is the layer's own
            TOP-LEFT corner (matching AE), NOT its center.
  "opacity": AnimatableValue<number> (0-1, default 1),

  CRITICAL for any 3D layer ("is3D":true) that has an explicit
  width/height (a shape/text/generate layer, not the default full-frame
  size): "position" places the ANCHOR point, and anchor defaults to the
  layer's own TOP-LEFT corner - so setting position to the frame's
  center ([${COMP_WIDTH / 2},${COMP_HEIGHT / 2}]) WITHOUT also setting
  anchor puts the layer's TOP-LEFT corner at the frame center, pushing
  most of a sizeable layer off-screen (confirmed directly: a 486x576
  card at position:[270,480] with no anchor rendered almost entirely
  off-frame, invisible, despite having a correct size, position-looking-
  right, and a bright fill color - the anchor was the actual problem).
  To center a sized 3D layer on its own "position", ALWAYS also set
  "anchor":[width/2,height/2,0] explicitly. This does NOT apply to 2D
  layers (which have no such buffer-clipping concern) or to 3D layers
  deliberately pivoting off-center (e.g. a page-flip rotating around an
  edge, where the top-left default is exactly correct).

  "blendMode": ${BLEND_MODE_NAMES.join(' | ')}  // 2D only, default "normal"
  "trackMatte": { "source": <layerId>, "type": ${TRACK_MATTE_TYPES.map((t) => `"${t}"`).join(' | ')} },
                 // 2D only - clips THIS layer to another layer's shape/luma.
                 // The source layer is automatically hidden from the normal
                 // stack once used as a matte (don't also try to hide it
                 // yourself, but DO give it full opacity - an invisible/
                 // zero-opacity matte source produces a fully-clipped result).
  "isAdjustmentLayer": boolean,  // this layer's "effects" post-process
                                   // EVERYTHING below it instead of itself.
                                   // THERE IS NO "adjustment" LAYER TYPE -
                                   // an adjustment layer is a NORMAL layer
                                   // (type:"shape" with a full-frame rect
                                   // and no visible fill, or type:"null")
                                   // with isAdjustmentLayer:true and a real
                                   // "effects" array. WRONG:
                                   // {"type":"adjustment","effects":[...]}.
                                   // RIGHT: {"type":"shape","width":540,
                                   // "height":960,"isAdjustmentLayer":true,
                                   // "effects":[{"type":"curves","params":{...}}],
                                   // "contents":[{"type":"path","shape":
                                   // {"kind":"rectangle","params":{"width":540,
                                   // "height":960}}},{"type":"fill","color":
                                   // "#000000","opacity":0}]}
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
engine exactly, not a simplification). ONLY these 7 types are valid
here - grain/noise/blur/glow and every other EFFECTS-list name belongs
on the LAYER's own "effects" array instead (see EFFECTS below), never
inside "contents":
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
    // ONLY valid INSIDE a shape layer's own "contents" array - stamps N
    // copies of the raw PATH GEOMETRY built so far in that same
    // contents list. There is NO layer-level "repeater" field (a
    // precomp/shape/etc layer object itself can never have "repeater"
    // as a sibling of "type"/"layers"/"effects" - the engine silently
    // ignores it there instead of erroring, so this fails invisibly,
    // not loudly). To repeat a whole complex composed element (not just
    // one shape's geometry), build ONE real precomp layer, then wrap
    // copies of THAT precomp inside multiple shape layers each with
    // their own position/rotation, or accept repeating just the raw
    // geometry within one shape as this feature actually supports.
    // stamps N copies, each offset by one more increment of "transform"
{ "type": "pathOp", "mode": ${PATH_OP_MODES.map((m) => `"${m}"`).join(' | ')} }
    // boolean-combines all paths built so far
{ "type": "fill", "color": "#rrggbb", "opacity": AnimatableValue<0-1>, "fillRule": "nonzero" | "evenodd" }
{ "type": "stroke", "color": "#rrggbb", "width": AnimatableValue<number>,
    "cap": "butt"|"round"|"square", "join": "miter"|"round"|"bevel", "dash": [number,...], "opacity" }
{ "type": "group", "contents": [ ShapeContentItem, ... ],
    "transform": { "position","rotation","scale","anchor","opacity" } }
    // "transform" is a FIELD on the group item, sitting next to
    // "contents" - it is NOT its own ShapeContentItem type. WRONG:
    // {"contents":[...,{"type":"transform","position":[...]}]}. RIGHT:
    // {"type":"group","contents":[...],"transform":{"position":[...]}}.
    // nests a sub-stack under its own extra transform - a group's own
    // "contents" is STILL only ever these same 7 ShapeContentItem types,
    // even nested several groups deep. There is NO {"type":"effect",...}
    // ShapeContentItem at any nesting depth - effects ALWAYS belong on
    // the enclosing LAYER's own "effects" array (see EFFECTS below),
    // never anywhere inside any "contents" array, group or not.

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

CRITICAL - keep "position" deltas SMALL, or text renders as garbled,
overlapping nonsense: each character sweeps into place INDIVIDUALLY, in
sequence, not all at once - while one character is still mid-transition
(offset by some fraction of your delta) the NEXT characters over may
have already landed. If your delta is large relative to a single
character's own width (roughly fontSize * 0.6), the still-moving
character's current position visually collides with already-landed
neighboring characters, and for a few frames the word reads as scrambled
garbage (e.g. "BUDGETING" briefly rendering as overlapping fragments
mid-reveal). This is not a hypothetical edge case - it is the single
most common way generated text looks broken. Concrete rule: keep
"position" deltas to roughly 15-40px for body/headline text at typical
sizes (40-80px fontSize) - large enough to read as motion, far too
small to overlap a neighboring character. Never use triple-digit
position deltas on a per-character text animator.

Selector choice for legibility-critical text (headlines, labels, short
badges the viewer needs to actually READ): use "range" with a ONE-TIME
sweep (start fixed, end animating 0->100, or vice versa) so the text
reaches a fully-landed, stable, readable state and STAYS there. NEVER
use "wiggly" as the ONLY animator on text meant to be read, especially
combined with a "position" property - wiggly is a continuous, NEVER-
SETTLING oscillation (every character is perpetually offset by some
amount, forever), so any text using it will look permanently glitched/
scrambled for its entire time on screen, not just during an entrance -
this is exactly the "text renders as unreadable garbage the whole time
it's visible" failure mode. Reserve "wiggly" (with modest amounts,
never combined with large position deltas) for decorative/ambient
motion on text that isn't the primary thing being read, or use it only
on "opacity"/"scale" with a small range, never on "position" for short
critical labels.

=====================================================================
EFFECTS - EffectDef: { "type": <name>, "params": {...} }, real per-type params:
=====================================================================
Applied to a layer via its own "effects" array (see LAYERDEF above) -
NEVER inside a shape's "contents" array (that array only ever takes the
SHAPECONTENTITEM types listed above - path/trim/repeater/pathOp/fill/
stroke/group - a shape content item can NEVER have type:"addNoise" or
any other effect name). Effects and generate kinds are also two
DIFFERENT lists - "gradientRamp"/"checkerboard"/etc (GENERATE KINDS,
below) only ever appear inside a "generate" layer's generate.kind, NEVER
inside an effects[].type, and vice versa: nothing in this EFFECTS list
is ever a valid generate.kind.
Valid effect types: ${EFFECT_TYPES.join(', ')}

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

THERE IS NO "vignette" EFFECT - it is not in the list above and never
will validate. For a real vignette (darkened frame edges, a very common
professional technique), build it as its own separate, extra layer, NOT
an effect: a "generate" layer using gradientRamp with shape:"radial",
startColor:"#ffffff" (center, white = unchanged), endColor:"#000000"
(edges, black = fully darkened), sized to fill the frame, positioned
last (on top) in "layers" with "blendMode":"multiply" and a modest
"opacity" (0.4-0.7). White-to-black under multiply is exact and doesn't
depend on alpha-channel hex support - don't use a transparent center via
alpha hex for this, use the multiply blend mode instead.

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
- FILL THE FRAME. A tiny graphic confined to one corner while most of
  the ${COMP_WIDTH}x${COMP_HEIGHT} frame sits empty reads as unfinished,
  not minimalist - scale primary elements (shapes, images, text) to
  genuinely occupy meaningful screen area. An image beat especially
  should let the photo be a dominant, prominent element, not a small
  thumbnail pushed into a corner.
- NEVER let a beat go visually static/empty for more than a fraction of
  a second. Something (a reveal, a move, an effect, a transition)
  should always be happening on screen - a beat that's just a single
  motionless element sitting in front of a background for its whole
  duration, or a background-only beat with sparse/no foreground
  content, reads as dead air and is the single fastest way to lose a
  short-form viewer. Match each beat's duration to how much is actually
  happening in it - don't stretch a simple idea across several empty
  seconds.
- DON'T STACK MULTIPLE DARK OVERLAYS ON YOUR OWN BACKGROUND - opacity
  compounds MULTIPLICATIVELY, not additively: two separate 30%-opacity
  black fills over the same background don't add to 60%, they combine
  to ~51% (1-0.7*0.7), and three or four "subtle vignette" layers
  stacked the same way can silently crush an intended vivid color down
  to something that reads as flat black on screen even though it's
  technically not RGB (0,0,0). If you want a vignette/grain/darkening
  treatment, apply it in ONE deliberate layer at a real, considered
  opacity - not several small "just in case" overlays that combine into
  an accidentally near-black result, wasting the palette you picked.
- WHEN A BEAT HAS SEVERAL SIMILAR SIBLING ELEMENTS (a row of category
  cards, a grid of icons, several bars/tiles) each one MUST get its own
  DIFFERENT explicit "position" - confirmed directly as a real bug: two
  precomp "cell" layers both left at the same default position:[0,0]
  rendered stacked exactly on top of each other in one corner instead
  of spreading across the frame as a grid, since nothing here infers a
  layout FOR you. If you want 3 cards in a row, compute and set 3
  actually-different x positions yourself (e.g. spaced across the safe
  width) - never leave multiple sibling layers all at the same
  position/default and expect them to arrange themselves.
`.trim();

// ---------------------------------------------------------------------
// The creative-treatment pass. Real architectural change, not more
// prompt wording: a single call that has to simultaneously invent a
// professional-grade design AND obey strict JSON syntax measurably
// produces thinner, more generic output than letting the model think
// through the design in free text first, unconstrained by structure,
// then translate an already-good plan into the schema as a second,
// separate step. This mirrors how a real studio actually works (a
// director's treatment exists before an animator opens After Effects)
// and is the direct, structural answer to "tell it to be an expert" vs
// "make it think like one" - the treatment pass has no JSON to produce
// at all, so nothing competes with the model actually reasoning about
// composition, hierarchy, and motion.
// ---------------------------------------------------------------------

function buildTreatmentSystemPrompt(targetDurationSeconds) {
  return `You are a world-class motion graphics director and animator -
20+ years of real hands-on After Effects experience at top-tier
studios, the kind of person clients pay a premium for because every
single frame is intentional, layered, and alive. You are planning (NOT
building yet) a ${targetDurationSeconds}-second short-form vertical
video (${COMP_WIDTH}x${COMP_HEIGHT}px, 9:16) for the request below.

You are briefing a REAL, capable engine - not a limited template tool.
It genuinely supports: real bezier shapes (rectangles/ellipses/polygons/
stars, with trim-path "draw on" reveals, repeaters, boolean path
operations), real per-character text animation (staggered reveals,
organic wiggle, text on a bezier path), real 3D layers with an
animatable camera and real point/spot/directional/ambient lighting
(rotating cards, parallax depth, dramatic camera moves), real blend
modes and track mattes (one layer's shape or luma masking another),
adjustment layers (a color grade or effect applied to everything
below), and a real effects library: blur (gaussian/directional/radial),
color grading (curves/hue-sat/color-balance/levels), glow/drop-shadow/
inner-shadow/stroke, film grain/noise, glitch (RGB-shift/scan-lines/
block-displace), stylize (posterize/emboss/edge-detect), and distort
warps (twirl/bulge/ripple/wave). Generated photos can be fetched for
any beat. Real transitions (cross-dissolve, wipes, 3D card flip, glitch)
connect beats. Plan USING these real capabilities, specifically and by
name where they fit - don't describe something vague this engine can't
build, and don't undersell it with something generic when a specific
technique would sell the shot better.

Write a concrete, opinionated, beat-by-beat treatment - not mood words,
actual visual decisions a senior director would hand an animator to
build frame-for-frame:

1. THE HOOK: what's on screen in the first half-second and exactly why
   it earns attention immediately (specific, not "an engaging visual").
2. PALETTE & MOOD: 2-4 specific colors (describe them precisely enough
   to pick real hex values from) and the visual mood they create
   together, held consistent across the whole video.
3. BEAT BY BEAT (beats are typically 2-4s each): this section gets
   parsed PROGRAMMATICALLY by a script, so its structure is not
   optional - start each beat with its own line reading EXACTLY
   "===BEAT n=== duration:X.Xs" (n starting at 0, X.X the beat's own
   length in seconds, all beats summing to approximately
   ${targetDurationSeconds}s) on its own line, with nothing else on
   that line. Everything between one "===BEAT n===" line and the next
   is that beat's own full description. For EVERY beat, cover ALL of:
   - What's happening, moment to moment
   - The FULL background treatment - never just "a gradient": what's
     layered underneath/around the main content (a subtle noise/grain
     texture, a soft vignette, a secondary slow-drifting shape or
     pattern, a color-graded adjustment layer)
   - EVERY foreground element, specifically: what it is, roughly where
     it sits, how it enters/moves/exits, and its role in the hierarchy
     (name the ONE dominant focal element and what's clearly secondary/
     supporting - never several same-weight elements competing)
   - Real depth: is this beat flat 2D, or does it use real 3D (camera
     move, a rotating/tilted object, layers at different depths for
     parallax)? Prefer 3D for at least some beats in a longer video.
   - Specific effects that sell the shot and why (a soft outer glow on
     the focal text, a drop shadow separating layers, film grain for
     texture, a track-matte reveal, a subtle color-graded adjustment
     layer tying the beat to the palette) - not decoration for its own
     sake, each choice should earn its place
   - How this beat transitions into the next
4. Fill the frame with intent every beat - avoid large dead margins;
   every region of the frame should feel considered, not empty by
   default.

Example of the required beat-header format (exact syntax, not just the
idea - the parser looks for this literal pattern):
===BEAT 0=== duration:2.5s
<full description of beat 0 here>
===BEAT 1=== duration:3.0s
<full description of beat 1 here>

Be decisive and specific throughout, the way a real director committing
to real choices would - no hedging, no "could be" or "maybe", no
generic filler description. This treatment will be built EXACTLY as
written, so anything vague or missing here will be vague or missing in
the final video. Write the HOOK and PALETTE & MOOD sections as plain
prose before the first "===BEAT 0===" line; everything from there on
must follow the beat-header format above exactly, as long and detailed
as each beat needs to leave nothing for the next step to guess at.`;
}

async function generateCreativeTreatment(userPrompt, targetDurationSeconds) {
  const systemPrompt = buildTreatmentSystemPrompt(targetDurationSeconds);
  // Raised from 4000 after a live run hit that cap and got cut off mid-
  // treatment - real evidence the model wanted to be MORE thorough than
  // the cap allowed, not less (an earlier successful treatment already
  // ran ~11.8k chars, close to the old ceiling). A truncated treatment
  // feeds incomplete instructions into the JSON pass, so this needs
  // real headroom, not a tight budget - plain text is cheap regardless.
  return callMistralRaw(systemPrompt, userPrompt, { jsonMode: false, maxTokens: 8000, temperature: 0.85 });
}

function buildGenerationSystemPrompt(targetDurationSeconds) {
  return `${SCHEMA_REFERENCE}

=====================================================================
YOUR TASK
=====================================================================
Generate a complete, valid scene JSON for a short-form vertical video
matching the user's request below. Target roughly ${targetDurationSeconds}
seconds total across all beats (sum of params.duration). Output ONLY the
JSON object - no markdown fences, no commentary before or after it.
Remember: COMPACT/MINIFIED JSON, one line, no indentation - this is not
optional, it directly determines whether your response fits before
being cut off.`;
}

// ---------------------------------------------------------------------
// Per-beat generation. Real architectural change, not another prompt
// patch: asking one API call to correctly produce an ENTIRE multi-beat,
// deeply-nested JSON document in one shot gives a genuinely rich
// generation dozens of independent chances to go wrong (a stray root
// key, a type/kind confusion, a truncated string, a missing field -
// ANY of which fails the WHOLE document) - confirmed directly across
// several live runs: the SAME class of mistake recurred with different
// specifics attempt after attempt, and a single retry regenerating the
// ENTIRE scene could fix one problem while introducing an unrelated new
// one elsewhere, never fully converging within the retry budget.
//
// This parses the treatment's own required "===BEAT n===" structure
// (see buildTreatmentSystemPrompt) and encodes EACH beat as its own
// small, independent JSON generation+validation+retry - a much smaller
// document per call, with far less surface area to go wrong, and a
// failure in one beat costs one small retry rather than risking the
// whole video. Beats are encoded CONCURRENTLY (they only read the
// shared preamble, never each other's output), so total wall-clock
// time stays close to one beat's own generation time rather than
// summing every beat sequentially. Falls back to the previous single-
// call whole-scene generation if the treatment's beat structure can't
// be parsed (a real, if now rare, possibility - keeps this robust
// rather than hard-failing on a parse gap).
// ---------------------------------------------------------------------

const BEAT_HEADER_RE = /===\s*BEAT\s+(\d+)\s*===\s*duration:\s*([\d.]+)\s*s?/gi;

/**
 * Splits a treatment into { preamble, beats: [{index,duration,text}] }
 * using the required "===BEAT n=== duration:X.Xs" headers. Returns null
 * if no headers are found at all (signals the caller to fall back to
 * whole-scene generation instead of encoding zero beats).
 */
function parseBeatsFromTreatment(treatment) {
  const matches = [...treatment.matchAll(BEAT_HEADER_RE)];
  if (matches.length === 0) return null;
  const preamble = treatment.slice(0, matches[0].index).trim();
  const beats = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : treatment.length;
    return { index: Number(m[1]), duration: Number(m[2]) || 0, text: treatment.slice(start, end).trim() };
  });
  return { preamble, beats };
}

function buildBeatEncodingSystemPrompt() {
  return `${SCHEMA_REFERENCE}

=====================================================================
YOUR TASK
=====================================================================
You are encoding ONE SINGLE BEAT of a larger video - not the whole
video, not a "scenes" array. Output ONLY a single JSON object shaped
exactly like ONE beat: {"params":{...},"visual":{...}} - do NOT wrap it
in {"scenes":[...]}, output that one object directly as the root.
Remember: COMPACT/MINIFIED JSON, one line, no indentation - this is not
optional, it directly determines whether your response fits before
being cut off.`;
}

async function generateOneBeat(preamble, beatChunk, beatIndex, totalBeats, { retriesLeft = 3, priorErrors = null } = {}) {
  const systemPrompt = buildBeatEncodingSystemPrompt();
  let userMessage = `OVERALL VIDEO CONTEXT (hook + palette/mood, shared across every beat for visual consistency):\n${preamble}\n\nTHIS BEAT (beat ${beatIndex + 1} of ${totalBeats}, target duration ${beatChunk.duration}s) - encode this EXACTLY and FAITHFULLY, missing nothing; every VISUAL decision below must become real layers/effects/animators from the schema above, never simplified or dropped to something generic. Sound cues (a "clink", a "whoosh") have no schema field - translate them into a visual beat instead (a hard hit, a flash, a snap into place). Only use real fields from the schema above - never invent new ones.\n\n${beatChunk.text}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt for THIS beat produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected beat JSON.`;

  const result = await callMistralForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateOneBeat(preamble, beatChunk, beatIndex, totalBeats, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateBeat(result, `beat[${beatIndex}]`);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] beat ${beatIndex} failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateOneBeat(preamble, beatChunk, beatIndex, totalBeats, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Beat ${beatIndex} failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
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
ONLY the JSON object - no markdown fences, no commentary.
Remember: COMPACT/MINIFIED JSON, one line, no indentation - this is not
optional, it directly determines whether your response fits before
being cut off.`;
}

/**
 * The fallback path - the previous whole-scene-in-one-call generation,
 * kept for when a treatment's beat structure can't be parsed (see
 * parseBeatsFromTreatment). Same retry-with-errors-fed-back design as
 * generateOneBeat, just for the entire {scenes:[...]} document at once.
 */
async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 4, priorErrors = null } = {}) {
  const systemPrompt = buildGenerationSystemPrompt(targetDurationSeconds);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every VISUAL decision below must become real layers/effects/animators from the schema above, never simplified or dropped to something generic. The treatment may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead (a hard hit, a flash, a snap into place) rather than inventing a nonexistent field. Only use real fields from the schema above - never invent new ones.):\n${treatment}\n\nOriginal request: ${userPrompt}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;

  const result = await callMistralForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] generated scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Mistral-generated scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
}

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[mistralClient] planning creative treatment...');
  const treatment = await generateCreativeTreatment(userPrompt, targetDurationSeconds);

  const parsed = parseBeatsFromTreatment(treatment);
  if (parsed && parsed.beats.length > 0) {
    console.log(`[mistralClient] encoding ${parsed.beats.length} beat(s) independently...`);
    const scenes = await Promise.all(
      parsed.beats.map((beatChunk, i) => generateOneBeat(parsed.preamble, beatChunk, i, parsed.beats.length, { retriesLeft: 3 })),
    );
    return { scenes };
  }

  console.warn('[mistralClient] could not parse "===BEAT n===" structure from the treatment, falling back to whole-scene generation');
  return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment);
}

async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 4, priorErrors = null } = {}) {
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
