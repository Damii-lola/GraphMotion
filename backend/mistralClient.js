const fetch = require('node-fetch');
const {
  validateSceneJSON, validateBeat, LAYER_TYPES, SHAPE_KINDS, SHAPE_CONTENT_TYPES, PATH_OP_MODES,
  RANGE_SELECTOR_SHAPES, TRACK_MATTE_TYPES, GENERATE_KINDS,
  BLEND_MODE_NAMES, EASING_NAMES, EFFECT_TYPES, TRANSITION_TYPES,
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
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * A shared, module-level call queue that spaces out EVERY Mistral
 * request from the previous one's start, regardless of how many
 * callers are concurrently trying to call in - found necessary via
 * actual live testing, not assumed: with generateSceneJSON's real
 * per-beat concurrent architecture (N beats, each with its own
 * validation-retry budget, all firing via Promise.all), even reactive
 * 429-backoff (below) wasn't enough on its own - a genuinely
 * low-rate-limit key got 429'd on nearly EVERY request for almost 3
 * minutes straight and the whole generation still ultimately failed,
 * because backoff only reacts AFTER a burst already happened; it
 * doesn't prevent the burst. This queue prevents the burst at the
 * source: every call waits its turn AND a minimum spacing, so N
 * concurrent beats naturally serialize into one evenly-paced stream
 * instead of slamming the API all at once.
 *
 * The spacing is ADAPTIVE, not a fixed constant - found necessary via
 * a SECOND real, live problem the original fixed 3.5s spacing itself
 * caused: a real production job sat "stuck" for 15+ minutes (the
 * frontend's own client-side give-up threshold) because a genuinely
 * complex, many-layer beat needed several retries, and EVERY one of
 * those retries - even though this specific key was no longer being
 * rate-limited at all - still paid the full worst-case 3.5s tax,
 * compounding across every beat sharing the one serialized queue.
 * Being permanently conservative for a rate limit that usually isn't
 * even being hit wastes real, meaningful wall-clock time on every
 * single generation, not just the rare rate-limited ones. Starting
 * fast (MIN_CALL_INTERVAL_MS) and only escalating reactively when a
 * 429 is actually observed (recordRateLimitHit, called from the 429
 * handler below) - then decaying back toward the fast floor once
 * enough time has passed without another one - keeps the common case
 * quick while still slowing down exactly when the API actually asks
 * for it, instead of guessing worst-case for every single call.
 * `.catch(() => {})` on the chained promise is deliberate - one
 * caller's request failing must never break the queue for every
 * caller after it.
 */
const MIN_CALL_INTERVAL_MS = 1200;
const MAX_CALL_INTERVAL_MS = 5000;
const RATE_LIMIT_DECAY_MS = 20000; // how long an elevated interval persists after the last 429 before easing back down
let currentCallIntervalMs = MIN_CALL_INTERVAL_MS;
let lastRateLimitHitAt = 0;

function recordRateLimitHit() {
  currentCallIntervalMs = MAX_CALL_INTERVAL_MS;
  lastRateLimitHitAt = Date.now();
}

function currentAdaptiveInterval() {
  if (currentCallIntervalMs <= MIN_CALL_INTERVAL_MS) return MIN_CALL_INTERVAL_MS;
  const sinceLastHit = Date.now() - lastRateLimitHitAt;
  if (sinceLastHit > RATE_LIMIT_DECAY_MS) {
    // Ease back down by half once the decay window has passed, rather
    // than snapping straight back to the fast floor - a real rate
    // limit that was just hit is more likely to still be nearby than
    // one from a while ago, so this eases off gradually.
    currentCallIntervalMs = Math.max(MIN_CALL_INTERVAL_MS, Math.round(currentCallIntervalMs / 2));
    lastRateLimitHitAt = Date.now();
  }
  return currentCallIntervalMs;
}

let callQueueTail = Promise.resolve();
function queueMistralCall(fn) {
  const scheduled = callQueueTail.then(() => sleep(currentAdaptiveInterval())).then(fn);
  callQueueTail = scheduled.catch(() => {});
  return scheduled;
}

/**
 * How many times a single call will transparently retry a 429 (rate
 * limit) before giving up and throwing. Found as a REAL, live gap
 * during actual testing (not theorized): generateSceneJSON fires one
 * treatment call, THEN N beat-encoding calls CONCURRENTLY (each with
 * its own internal validation-retry budget) - a real burst of
 * simultaneous requests against one API key. Before this fix, ANY 429
 * on ANY single one of those calls threw immediately with no backoff,
 * which (via Promise.all in generateSceneJSON) failed the ENTIRE
 * generation even though every other beat may have succeeded fine.
 * Confirmed directly: a live run hit exactly this - one beat's request
 * got rate-limited and took the whole video generation down with it.
 */
const MAX_RATE_LIMIT_RETRIES = 5;

async function callMistralRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 12000, temperature = 0.7 } = {}, rateLimitRetriesLeft = MAX_RATE_LIMIT_RETRIES) {
  // Only the actual network call is queued/spaced - NOT the retry
  // recursion below it, so a 429 retry re-enters the same shared queue
  // (and gets its own turn + spacing) rather than bypassing it.
  let response;
  try {
    response = await queueMistralCall(() => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);
      return fetch('https://api.mistral.ai/v1/chat/completions', {
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
      }).finally(() => clearTimeout(timeout));
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Mistral request timed out after ${MISTRAL_TIMEOUT_MS}ms`);
    // Real, live-confirmed gap: a transient network error (ECONNRESET,
    // ETIMEDOUT, DNS hiccups - routine and expected over enough HTTP
    // calls, not exceptional) used to propagate straight up and, via
    // Promise.all in generateSceneJSON, kill the ENTIRE multi-beat
    // generation even when every other beat's own retries were
    // otherwise converging fine - confirmed directly: a live run's
    // beats were making real progress (successfully catching and
    // fixing real validation errors) when one single ECONNRESET on one
    // beat's one request took the whole generation down. Retried the
    // same way as a 429 (same shared backoff/attempt budget) rather
    // than left to fail immediately, since this is exactly the kind of
    // routine transient failure a normal HTTP client is expected to
    // absorb, not surface as a hard error.
    // node-fetch v2 FetchError normally forwards the underlying Node
    // error's `.code`, but that's not 100% guaranteed across every
    // failure path - falling back to checking the message text too
    // means this still catches the real case even if `.code` is ever
    // missing/different than expected.
    const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
    const isTransientNetworkError = transientCodes.includes(err.code)
      || transientCodes.some((code) => String(err.message).includes(code));
    if (isTransientNetworkError && rateLimitRetriesLeft > 0) {
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[mistralClient] transient network error (${err.code}), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callMistralRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 429 && rateLimitRetriesLeft > 0) {
      recordRateLimitHit(); // slow the shared queue down for every OTHER in-flight caller too, not just this retry
      // Prefer the server's own Retry-After if it sent one; otherwise
      // exponential backoff with jitter (jitter matters specifically
      // BECAUSE several beats retry concurrently - without it, they'd
      // all wake up and re-hit the API in the same instant, recreating
      // the exact burst that caused the 429 in the first place).
      const retryAfterHeader = response.headers.get('retry-after');
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[mistralClient] rate limited (429), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callMistralRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
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
against a real 2D compositing engine (comparable in capability to
After Effects: real bezier shapes, real per-character text animation,
real blend modes and track mattes, real blur/color-grading/glitch/
distort effects, real transitions, and 2D scale/skew/rotation tricks
for fake depth/perspective moves - see the PERSPECTIVE & DEPTH section
below). Your job is to compose these real primitives into
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
{"scenes":[{"params":{"duration":2.5},"visual":{"layers":[...]}}]}
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

FIVE COMPLETELY SEPARATE "type" VOCABULARIES - THEY NEVER CROSS OVER.
This schema has five different closed lists of names that all sound
adjacent but belong to five unrelated fields. Using a name from the
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
    "imagePrompt": string     // fetches a REAL AI-generated photo for this
                               // beat (free, via Pollinations/Flux) - this is
                               // the PRIMARY hero-visual tool, not an
                               // afterthought. Write it like a real photo/
                               // render brief: concrete subject, lighting,
                               // angle, mood, color grade (e.g. "a
                               // translucent humanoid robot head in profile,
                               // studio lighting, cinematic, soft blue-grey
                               // palette" - not just "a robot"). Reference
                               // the fetched photo from a layer via
                               // {"type":"image","src":"beatImage"} (see the
                               // "photo card" recipe above). Set this on
                               // MOST beats by default; only skip it for a
                               // beat that's specifically a pure data/chart/
                               // icon moment where vector genuinely serves
                               // the point better than a photo would.
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

  "position": AnimatableValue<[x,y]> - pixel coordinates, [0,0] is the
            frame's TOP-LEFT corner, [${COMP_WIDTH / 2},${COMP_HEIGHT / 2}]
            is the frame's CENTER. Default [0,0].
  "rotation": AnimatableValue<number> (degrees),
  "scale": AnimatableValue<[sx,sy]>,
  "anchor": AnimatableValue<[x,y]> - the pivot point for rotation/scale,
            ALSO the point of the layer's OWN CONTENT that lands
            exactly at "position". THE CORRECT VALUE TO CENTER A LAYER
            DEPENDS ON ITS TYPE - this is not one uniform rule, and
            getting it backwards silently shifts the layer off by half
            its own width/height (confirmed as a real, live bug: a
            420x60 badge given anchor:[210,30] - "half its size", the
            wrong choice for a shape - rendered shifted a full 210px
            off its intended center, clipped off the frame edge):
              - "shape"/"text" layers: their own content is ALREADY
                drawn CENTERED on local (0,0) (matching real vector-
                tool authoring). To center this layer on "position",
                OMIT "anchor" entirely (default [0,0] already IS the
                center) - do NOT set anchor:[width/2,height/2] here,
                that shifts a centered shape/text layer OFF-center by
                half its own size, the exact opposite of the intent.
              - "image"/"generate"/"precomp" layers: their content draws
                TOP-LEFT anchored at local (0,0) (matching how a photo/
                texture naturally fills a box from its corner - a
                "precomp" is no different here, it's rendered into its
                own width x height buffer and that buffer's top-left
                corner is what lands at "position"). To center any of
                these three on "position", DO set explicit
                anchor:[width/2,height/2] - here (and only here) that's
                correct, since without it "position" places the top-left
                corner, not the middle. Confirmed as a real, live bug: a
                400x300 "precomp" chart at position:[270,480] (frame
                center) with no anchor set rendered with its top-left
                corner AT the frame center instead - i.e. the whole
                chart shifted down-and-right by half its own size,
                clipping most of it off the right/bottom edges.
            An off-center PIVOT (rotation/scale around a corner or
            edge, e.g. a page-flip) is a real, legitimate reason to set
            a different anchor value on either layer type - just don't
            reach for width/2,height/2 out of habit on a shape/text
            layer expecting it to center things, it does the opposite.

  "blendMode": ${BLEND_MODE_NAMES.join(' | ')}  // default "normal"
  "trackMatte": { "source": <layerId>, "type": ${TRACK_MATTE_TYPES.map((t) => `"${t}"`).join(' | ')} },
                 // clips THIS layer to another layer's shape/luma.
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
  "width", "height": number  // REQUIRED for "shape"/"generate" layers.
                              // CRITICAL, stated bluntly because this is
                              // THE single most common real generation
                              // mistake by far: this is a TOP-LEVEL field
                              // on the LAYER object itself (a sibling of
                              // "id"/"type"/"position"/"contents"), NOT
                              // nested inside a content item's
                              // shape.params. A rectangle/ellipse's own
                              // "width"/"height" inside its shape.params
                              // describes that ONE path's geometry - it
                              // does NOT also satisfy the layer's own
                              // separate width/height requirement, even
                              // when the numbers would be identical.
                              // WRONG (layer-level width/height missing,
                              // even though the shape's own params have
                              // them): {"type":"shape","position":[270,480],
                              // "contents":[{"type":"path","shape":
                              // {"kind":"rectangle","params":{"width":300,
                              // "height":300}}},{"type":"fill","color":
                              // "#fff"}]}
                              // RIGHT (both present - the layer's OWN
                              // width/height, AND the shape's own,
                              // matching in this common case but two
                              // genuinely separate fields):
                              // {"type":"shape","width":300,"height":300,
                              // "position":[270,480],"contents":[{"type":
                              // "path","shape":{"kind":"rectangle","params":
                              // {"width":300,"height":300}}},{"type":"fill",
                              // "color":"#fff"}]}
                              // Before finishing, check EVERY "shape" and
                              // "generate" layer in the whole beat has its
                              // own top-level width/height set - not just
                              // the ones that feel like they need it.
                              // Omitting it defaults to the full frame
                              // size, correct for a full-frame background,
                              // wrong for anything smaller.

  // --- type:"shape" ---
  "contents": [ ShapeContentItem, ... ],   // see below

  // --- type:"text" ---
  "text": string, "fontFamily": string, "fontWeight": string, "fontSize": number,
  "lineHeight": number, "maxWidth": number, "fillStyle": color,
      // "maxWidth" controls line-wrapping (text wraps to a new line once a
      // line would exceed it) - omitting it defaults to a safe ${COMP_WIDTH - 60}px
      // (comp width minus margin), but for a large headline set it
      // explicitly to control exactly where it wraps, e.g. ${Math.round(COMP_WIDTH * 0.85)}
      // for most single-column text on this ${COMP_WIDTH}px-wide canvas.
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
      // A precomp's own "width"/"height" is the FULL EXTENT of its
      // children's coordinate space - it is rendered into its own
      // private width x height buffer FIRST, in total isolation from
      // the outer frame's size, and every child layer's "position" is
      // relative to THAT buffer's top-left corner (0,0), not the outer
      // ${COMP_WIDTH}x${COMP_HEIGHT} frame. A child positioned outside
      // [0,width]x[0,height] renders outside the precomp's own buffer
      // and is clipped, gone, exactly as if it were outside the main
      // frame. Confirmed as a real, live bug: a precomp declared
      // "width":400,"height":300 for a bar chart, whose own child bars
      // were positioned using y:400-600 - coordinates that would only
      // make sense in the full outer frame's much taller space, not
      // this precomp's actual 300px-tall inner canvas - rendered with
      // most of the chart clipped off entirely. Before finishing, check
      // that EVERY child layer inside a precomp uses position values
      // that make sense for THAT precomp's own declared width/height
      // (typically centered around [width/2,height/2] for content
      // meant to sit centered within it), not values sized for the
      // outer frame.

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
here: ${SHAPE_CONTENT_TYPES.join(', ')}. Every EFFECTS-list name
(gaussianBlur, dropShadow, outerGlow, addGrain, addNoise, rgbShift,
curves, and everything else in the EFFECTS list below) belongs on the
LAYER's own "effects" array instead, NEVER inside "contents" - this is
a real, repeated live mistake (both "outerGlow" AND "dropShadow"
specifically keep showing up inside "contents" arrays, confirmed
across separate real generations), stated again here because it is the
single most common shape-content error despite already being covered
by the cross-vocabulary section above. Two complete, correct worked
examples showing the SAME right pattern with two different effects,
since this is a general rule about the FIELD, not a one-off exception
for a single effect name:
  {"type":"shape","id":"orb","width":120,"height":120,"contents":[
    {"type":"path","shape":{"kind":"ellipse","params":{"width":120,"height":120}}},
    {"type":"fill","color":"#00D4AA"}
  ],"effects":[
    {"type":"outerGlow","params":{"color":"#00D4AA","opacity":0.6,"blur":20,"blendMode":"screen"}}
  ]}
  {"type":"shape","id":"card","width":300,"height":200,"contents":[
    {"type":"path","shape":{"kind":"rectangle","params":{"width":300,"height":200,"roundness":16}}},
    {"type":"fill","color":"#F5F5F5"}
  ],"effects":[
    {"type":"dropShadow","params":{"color":"#000000","opacity":0.5,"distance":10,"angle":90,"blur":20}}
  ]}
In BOTH, the effect name sits in "effects" (a sibling of "contents" on
the LAYER object, not an entry inside "contents" itself) - "contents"
always ends at the last "fill"/"stroke", it never contains an effect
name at any point, for ANY effect, not just these two.
=====================================================================
{ "type": "path", "shape": { "kind": ${SHAPE_KINDS.map((k) => `"${k}"`).join(' | ')}, "params": {...} } }
    rectangle: { width, height, position:[x,y] (default [0,0], CENTERED on
      position), roundness (px corner radius) }
    ellipse:   { width, height, position:[x,y] (default [0,0], centered) }
    polygon:   { points (side count), radius, position, rotation (deg), roundness }
    star:      { points, innerRadius, outerRadius, position, rotation (deg),
                 innerRoundness, outerRoundness }
    customPath: { anchors: [ {"point":[x,y], "outTangent":[dx,dy]?,
                 "inTangent":[dx,dy]?}, ... ] (2+ points, REQUIRED),
                 closed: boolean (default true) }
      // the real Pen tool: an author-drawn bezier path from explicit
      // points, for custom icon/glyph/mark shapes the 4 primitives
      // above genuinely can't produce (a checkmark, an arrow, a custom
      // logo mark). Each anchor is one point the path passes through,
      // in the shape's own LOCAL coordinate space (same centered-on-
      // (0,0) convention as every other shape kind - NOT frame pixel
      // coordinates). outTangent/inTangent are OPTIONAL control-handle
      // OFFSETS (not absolute points) from that anchor, matching AE's
      // own direction-handle behavior - omit both for a straight line
      // into/out of that anchor, a real, common, valid choice, not a
      // fallback. THERE IS NO "path" shape kind - if you want a custom
      // shape, "kind" is "customPath", not "path" (that word is
      // already used one level up, for the CONTENT ITEM's own "type").
    NOTE: shape geometry is centered on its own local (0,0) by default,
    matching real vector-tool authoring - the LAYER's own position/anchor is
    what actually places it on screen, not the shape's own "position" param
    (that param only re-centers the path within the layer's local space).
{ "type": "trim", "start": AnimatableValue<0-100>, "end": AnimatableValue<0-100>,
    "offset": AnimatableValue<0-100>, "multiple": "individually" | "simultaneously" }
    // real Trim Paths - animate start/end for a genuine "drawing on" reveal.
    // CRITICAL, stated again here because it is the single most common
    // real mistake in actual generated output despite being flagged
    // repeatedly: "trim" is a SHAPE CONTENT item, a sibling of "path"/
    // "fill"/"stroke" INSIDE a shape layer's own "contents" array. It is
    // NEVER an entry in any layer's "effects" array, no matter how
    // natural that placement feels (After Effects' own UI shows "Trim
    // Paths" nested under a shape's contents too, not in the Effects
    // panel - the two engines actually agree here). A complete, correct
    // worked example - a circle that draws itself on, start to finish:
    //   {"type":"shape","width":200,"height":200,"contents":[
    //     {"type":"path","shape":{"kind":"ellipse","params":{"width":200,"height":200}}},
    //     {"type":"trim","start":0,"end":{"keyframes":[{"time":0,"value":0},{"time":1,"value":100}]},"offset":0},
    //     {"type":"stroke","color":"#00D4AA","width":6}
    //   ]}
    // Notice "trim" sits BETWEEN "path" and "stroke" in "contents" -
    // never inside a top-level "effects":[...] array anywhere.
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
    //
    // CRITICAL: every field inside "transform" (position/rotation/
    // scale/anchor) MUST be a plain static number (or [x,y] of plain
    // numbers) - NEVER an AnimatableValue (no keyframes, no
    // {"expression":...}), and there is NO "index"/"i"/per-copy
    // variable available inside them. Confirmed as a real, completely
    // silent live bug: a repeater given
    // {"position":[{"expression":"Math.cos(index*45)*200","base":0},...]}
    // (assuming, reasonably but wrongly, that each copy could compute
    // its own placement) rendered exactly ONE copy instead of 8, with
    // no error anywhere - the engine doesn't evaluate per-copy
    // expressions at all, it takes the ONE transform you give it and
    // COMPOUNDS it across copies (copy 2 = transform applied twice,
    // copy 3 = three times, ...), exactly matching real After Effects'
    // own Repeater. This is not a workaround-needed limitation - it's
    // the CORRECT, powerful way to build a fan/circle/spiral/ring: set
    // "rotation" to the angle between copies (e.g. 45 for 8 copies
    // evenly around a circle, since 8*45=360) and/or "position" to a
    // fixed offset, and the compounding does the rest automatically.
    // Want 8 shards scattered evenly in a ring? Don't compute 8
    // positions yourself - build the PATH itself already offset from
    // local (0,0) (e.g. a small shape drawn 200px up from origin), then
    // use transform:{"rotation":45} (360/8 copies) with position left
    // at its [0,0] default: each successive copy is that same fixed
    // rotation compounded ON TOP of the last (45, then 90, then 135...),
    // which spins that one offset shape all the way around into a
    // perfect ring automatically - no per-copy math needed anywhere.
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

NEVER set a layer's own top-level "opacity" to a static 0 just because
it has a per-character reveal animator - the animator's "opacity"
DELTA only ever controls per-CHARACTER alpha inside the text draw
call, it has NO WAY to reach back and override the LAYER's own
opacity, which gates the entire composited layer multiplicatively no
matter what the animator does internally. A static "opacity":0 at the
layer level makes the WHOLE layer permanently invisible for its entire
duration, animator or not - confirmed as a real, live bug: a headline
with "opacity":0 plus a correctly-configured reveal animator rendered
as nothing at all, the whole beat through. To start a layer invisible
and reveal it, either OMIT "opacity" entirely (default 1) and let the
per-character animator's own "opacity" delta do the reveal, or animate
the LAYER's own "opacity" with real keyframes (0 -> 1) - never a plain
static 0.

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

NAMES THAT KEEP GETTING WRONGLY USED AS AN EFFECT TYPE - confirmed
directly, repeatedly, across many real generations, despite the
warning above already being present, so read this list literally
before writing ANY effects[].type:
  "gradientRamp"/"checkerboard"/"grid"/"lensFlare"/"fractalNoise" -
    these are GENERATE KINDS (generate.kind on a "generate" layer),
    never an effect.
  "trim"/"path"/"fill"/"stroke"/"repeater"/"pathOp"/"group" - these are
    SHAPE CONTENT types (inside a shape layer's "contents" array),
    never an effect.
  "linearWipe"/"crossDissolve"/"cardFlip3D"/"glitchCut" (or any other
    TRANSITION_TYPES name) - these connect one BEAT to the next via
    visual.transitionIn, never a per-layer effect.
  "wiggle" - THERE IS NO "wiggle" EFFECT. For organic per-character
    text motion, use the "wiggly" SELECTOR inside a text layer's
    "animators" array instead (see TEXT ANIMATORS below) - a
    completely different mechanism from the effects array.
  "expression" - THERE IS NO "expression" EFFECT. An expression is an
    AnimatableValue shape ({"expression":"...", "base":...}) that can
    be used for almost any individual field (position, opacity, a
    shape param, an effect PARAM's value) - it is never itself a
    standalone entry in an effects array.
  "adjustmentLayer" - not a real name anywhere. An adjustment layer is
    isAdjustmentLayer:true on a normal layer, not a type or effect name.
  "blendMode" - not an effect. "blendMode" is a LAYER-level field
    (a sibling of "type"/"position"/"effects" on the layer itself, set
    to one of the real blend mode names), never an item inside the
    "effects" array.

  gaussianBlur: { radius=8 }  // real per-pixel cost, genuinely
      // measured: radius=80 on a full ${COMP_WIDTH}x${COMP_HEIGHT} buffer
      // costs ~1.8 SECONDS of render time for that ONE layer on ONE
      // frame - multiplied across every frame of the beat, this alone
      // can blow the render budget. A tasteful blur (defocus, soft
      // shadow, glow) rarely needs more than radius 15-25; reserve
      // anything above ~30 for a layer with an explicit, SMALL
      // width/height (blurring a 100x100 badge instead of the full
      // frame costs a small fraction as much for the same visual
      // softness), not a full-frame background/adjustment layer.
  boxBlur: { radius=8, iterations=1 }
  directionalBlur: { length=20, angle=0 (deg) }
  radialBlur: { amount=10, center=[x,y] (default layer center), mode="zoom"|"spin", samples=12 }
      // also genuinely expensive on a full frame - measured ~2.3
      // SECONDS for samples=12 at full ${COMP_WIDTH}x${COMP_HEIGHT}. Keep
      // "samples" at 8-12 (going higher buys little visible smoothness
      // for real added cost) and use it sparingly - at most once per
      // beat, not stacked on multiple layers.
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
PERSPECTIVE & DEPTH - this engine is 2D-only, no real camera/3D layers
=====================================================================
There is no true 3D rendering here - no camera, no lighting, no
perspective-projected planes. Every "depth"/"tilt"/"parallax" look is
built from ordinary 2D position/rotation/scale, the same real technique
professional 2D motion graphics has always used:
  - PARALLAX: put several flat layers at different sizes/positions and
    animate them at DIFFERENT speeds/amounts (background moves less,
    foreground moves more) - reads as depth without any 3D math.
  - FAKE TILT/CARD FLIP: animate "scale":[sx,1] or [1,sy] down toward
    (near) 0 on one axis while the layer is mid-transition, optionally
    paired with a small opposite-direction "rotation" - a classic,
    convincing "turning away/edge-on" illusion using only an affine
    scale, no perspective needed. (This is exactly how the
    "card3DFlip" transition below works internally now.)
  - DEPTH VIA SIZE/BLUR/GRADE: a "background" layer slightly smaller-
    scaled, less saturated (hueSaturation effect), and/or softly
    blurred (gaussianBlur) reads as "further away" next to a sharp,
    full-contrast foreground layer - real depth-of-field, faked
    cheaply and convincingly.
  - LAYER ORDER IS YOUR ONLY "Z-AXIS": stacking order in the "layers"
    array (later = drawn on top) is the entire depth model. There is
    no z-position field on a layer at all.

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
  card3DFlip: { axis="x"|"y" }  // a 2D scale-based card-flip illusion
                                 // (see PERSPECTIVE & DEPTH above) -
                                 // NOT real 3D despite the name.
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
  color every time. Use the PERSPECTIVE & DEPTH techniques above
  (parallax, fake tilt/flip, depth-via-blur) for at least some beats in
  a longer video to keep it from feeling flat and static.
- Use color with intent (a coherent palette across the whole video, not
  random hex values per beat) and real hierarchy (one clear focal
  element per beat, not several competing ones).
- EVERY layer in "layers" needs its OWN "position" - a real, common
  live mistake: 2+ layers left at the same position (very often
  [${COMP_WIDTH / 2},${COMP_HEIGHT / 2}], the frame center, the natural
  default to reach for) stack fully on top of each other instead of
  reading as the row/grid/scattered composition that was probably
  intended. Before finishing a beat, scan every layer's "position" and
  make sure no two non-parented siblings share an identical value
  (unless they're genuinely both full-frame background/overlay layers,
  where sharing the center IS correct).
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

REAL PHOTOGRAPHIC CONTENT IS YOUR PRIMARY VISUAL TOOL, not a fallback.
Every beat can fetch a real, on-prompt AI-generated photo (any subject:
people, objects, environments, portraits, product shots, surreal
composites - describe it like a real photography/render brief: subject,
lighting, mood, angle, color grade) via "imagePrompt". THIS IS HOW
PROFESSIONAL "AI facts"/tech/story short-form content actually looks -
think a photorealistic hero image filling most of the frame, with
vector graphics layered OVER it as ACCENTS (not the other way around):
a dashed annotation box, a swooping arc, bold kinetic type with a drop
shadow, a subtle RGB-split glitch on the headline. A video built ONLY
from flat vector shapes with no photographic content reads as cheap
and empty by comparison - default to giving most beats a real fetched
photo as the hero visual UNLESS the beat is specifically a data/chart/
icon moment where pure vector genuinely is the stronger choice.

The professional "photo card" composite (this is the single most
valuable recipe in this whole toolkit - use it constantly): (1) an
"image" layer with src:"beatImage" sized to the desired card
dimensions, (2) a "trackMatte" on it pointing at a rounded-rectangle
shape layer (type:"alpha") to crop the photo to soft rounded corners
instead of a hard rectangle, (3) a "dropShadow" effect on the image
layer for real depth/lift off the background, (4) a slow, subtle
animated scale (e.g. 1.0 -> 1.08 over the whole beat) for a Ken-Burns
drift instead of a static, dead photo. Layer kinetic type and small
accent shapes (dashed lines, arcs, corner brackets) around/over the
card, exactly like a real motion-graphics template.

Beyond photography, the engine ALSO genuinely supports: real bezier
shapes (rectangles/ellipses/polygons/stars, with trim-path "draw on"
reveals, repeaters, boolean path operations), real per-character text
animation (staggered reveals, organic wiggle, text on a bezier path),
2D fake-depth techniques (parallax layering - several flat layers
moving at different speeds/amounts; scale-based card flips - animating
scale toward 0 on one axis to fake a "turning edge-on" illusion;
depth-via-blur/desaturation - a softly-blurred, less-saturated
background reads as "further away" next to a sharp foreground; there
is NO real 3D camera or lighting in this engine, don't plan a shot
around one), real blend modes and track mattes (one layer's shape or luma
masking another), adjustment layers (a color grade or effect applied
to everything below), and a real effects library: blur (gaussian/
directional/radial), color grading (curves/hue-sat/color-balance/
levels), glow/drop-shadow/inner-shadow/stroke, film grain/noise, glitch
(RGB-shift/scan-lines/block-displace), stylize (posterize/emboss/edge-
detect), and distort warps (twirl/bulge/ripple/wave). Real transitions
(cross-dissolve, wipes, a scale-based card flip, glitch) connect beats.
Plan USING these real capabilities, specifically and by name where they
fit - don't describe something vague this engine can't build, and
don't undersell it with something generic when a specific technique
would sell the shot better.

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
   - Depth and movement: does this beat use parallax (layers moving at
     different speeds), a scale-based tilt/flip on an element, or
     depth-via-blur (a softened background behind a sharp foreground)?
     Prefer at least one of these in some beats of a longer video -
     flat, static layers with no depth trick feel cheap by comparison.
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
  if (priorErrors) {
    // Real pattern found via live testing: a beat with many layers
    // sometimes fails with a WALL of near-identical errors (e.g.
    // "layers[1]: must be an object" repeated for layers[1] through
    // layers[7]) - one underlying mistake (several array entries
    // weren't full objects) reported as many separate lines, which
    // buries the actual, single, fixable pattern instead of making it
    // obvious. When that shape shows up, call it out explicitly before
    // the full list so the retry fixes the ROOT cause instead of
    // patching each line individually (which risks leaving the same
    // root mistake elsewhere the validator didn't happen to flag).
    const objectErrors = priorErrors.filter((e) => e.includes('must be an object'));
    const notes = [];
    if (objectErrors.length >= 3) {
      notes.push(`${objectErrors.length} of these errors are "must be an object" on array entries - this usually means you wrote a plain string, a summary, or omitted an entry instead of a COMPLETE JSON object for every single array element (every layer, every content item, every effect). Every array in this schema requires a FULL object at every index - never a shorthand/placeholder value standing in for one.`);
    }
    // Real, observed pattern: this exact error ("visual.layers: is
    // required and must be an array") recurred VERBATIM, unchanged,
    // across every retry for one real beat - not converging toward a
    // fix at all, unlike every other error type which at least changed
    // shape between attempts. That strongly suggests the model doesn't
    // understand WHAT structural mistake produces this message (likely
    // nesting "layers" somewhere else, e.g. inside "params" instead of
    // "visual", or naming it something else), so spell out the exact
    // required shape literally rather than repeating the same abstract
    // error a 2nd/3rd/4th time.
    if (priorErrors.some((e) => e.includes('visual.layers') && e.includes('required and must be an array'))) {
      notes.push('The root object MUST be exactly {"params":{"duration":...,...},"visual":{"layers":[...],...}} - "layers" is a direct property of "visual" (a sibling of "background"/"transitionIn"), an ARRAY of LayerDef objects. It is never nested inside "params", never renamed, and never omitted even for a simple beat (a single layer is still layers:[{...}], not an empty/missing array).');
    }
    // Real, observed pattern: "a shape layer requires width/height"
    // recurred across MULTIPLE retries for the same beat, exhausting
    // the entire retry budget without ever fully converging (unlike
    // most other error types, which typically clear within 1-2
    // retries) - the model seems to correct SOME flagged shape layers
    // each attempt while leaving (or newly introducing) others, rather
    // than treating it as a blanket rule to apply to every shape layer
    // at once. Called out explicitly as a checklist instruction instead
    // of letting it read as N separate, easy-to-address-one-at-a-time
    // line items.
    const widthHeightErrors = priorErrors.filter((e) => e.includes('requires its own top-level "width" and "height"'));
    if (widthHeightErrors.length >= 2) {
      notes.push(`${widthHeightErrors.length} separate "shape" layers are missing required width/height. This is not N separate problems to fix one at a time - go through EVERY "shape" layer in this beat (not just the ones listed below) and confirm each one has an explicit top-level "width" and "height", since a fix pass that only touches the flagged layers risks leaving others (or introducing new ones) broken the same way.`);
    }
    const rootCauseNote = notes.length ? `\n\nNOTE: ${notes.join(' ')}` : '';
    userMessage += `\n\nYour previous attempt for THIS beat produced invalid JSON:\n${priorErrors.join('\n')}${rootCauseNote}\n\nFix these specific problems and output the complete, corrected beat JSON.`;
  }

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
      parsed.beats.map((beatChunk, i) => generateOneBeat(parsed.preamble, beatChunk, i, parsed.beats.length, { retriesLeft: 7 })),
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

/**
 * Real, missing safety net found while investigating a production
 * report of a job stuck "processing" until the FRONTEND's own 15-
 * minute client-side give-up kicked in: unlike the render phase
 * (longVideoOrchestrator.js's per-chunk 4-minute timeout, with proper
 * IPC failure reporting on every exit path), the GENERATION phase had
 * no outer bound at all - its worst case was whatever a chain of
 * nested retry budgets happened to add up to (per-beat validation
 * retries x per-call rate-limit/network retries x however many beats),
 * which is technically finite but not usefully bounded. Even a
 * generation that's genuinely still making progress, just slowly, is
 * indistinguishable from a real hang to a user watching a spinner -
 * and renderWorker.js's own try/catch only catches THROWN errors, not
 * "still running, just taking a very long time."
 *
 * Wrapping the exported entry points (not internal call sites) means
 * every caller gets this for free with no other file needing changes.
 * 6 minutes leaves real room for a genuinely rich multi-beat
 * generation with several retries (each beat: up to 7 validation
 * retries x up to 5 rate-limit/network retries, at the queue's now-
 * adaptive 1.2-5s spacing) while still failing fast and CLEANLY well
 * before the frontend's own 15-minute threshold - the difference
 * between "the job failed, try again" appearing at minute 6 versus a
 * dead spinner for 15 minutes with no real information either way.
 */
const GENERATION_HARD_TIMEOUT_MS = 6 * 60 * 1000;

function withHardTimeout(promiseFactory, label) {
  return async (...args) => {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} exceeded its ${GENERATION_HARD_TIMEOUT_MS / 1000}s hard timeout - failing fast instead of leaving the job stuck "processing" indefinitely.`)),
        GENERATION_HARD_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([promiseFactory(...args), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

module.exports = {
  generateSceneJSON: withHardTimeout(generateSceneJSON, 'generateSceneJSON'),
  generateEditedSceneJSON: withHardTimeout(generateEditedSceneJSON, 'generateEditedSceneJSON'),
};
