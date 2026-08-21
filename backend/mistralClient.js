const fetch = require('node-fetch');
const {
  validateSceneJSON, validateBeat, LAYER_TYPES, SHAPE_KINDS, SHAPE_CONTENT_TYPES, PATH_OP_MODES,
  RANGE_SELECTOR_SHAPES, TRACK_MATTE_TYPES, GENERATE_KINDS,
  BLEND_MODE_NAMES, EASING_NAMES, EFFECT_TYPES, TRANSITION_TYPES, CUBIC_EASING_NAMES,
  TEXT_ALIGN_VALUES, AVAILABLE_FONT_FAMILIES,
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

// Two supported ways to configure keys, merged and deduped: the
// original single comma-separated MISTRAL_API_KEYS, and individually
// numbered MISTRAL_API_KEY_1, MISTRAL_API_KEY_2, ... (checked up to a
// generous ceiling so gaps/out-of-order setting still work). Multiple
// keys exist specifically so genuinely concurrent Mistral calls can
// each use a DIFFERENT key's own independent rate-limit quota instead
// of contending for one - see queueMistralCall's doc comment below for
// why that's the real point (a single key was directly confirmed live
// to NOT tolerate concurrent requests at all).
function loadKeys() {
  const fromCsv = (process.env.MISTRAL_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const fromNumbered = [];
  for (let i = 1; i <= 20; i++) {
    const v = process.env[`MISTRAL_API_KEY_${i}`];
    if (v && v.trim()) fromNumbered.push(v.trim());
  }
  return [...new Set([...fromCsv, ...fromNumbered])];
}
const KEYS = loadKeys();

const MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';

if (KEYS.length === 0) {
  console.warn('[mistralClient] No MISTRAL_API_KEYS/MISTRAL_API_KEY_N configured');
} else {
  console.log(`[mistralClient] ${KEYS.length} Mistral API key(s) configured`);
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
// Raised again (180s -> 240s) after adding per-character color accents,
// highlight chips, and a "everything has its own separately-timed
// animation" requirement (all real additional JSON content every beat
// now needs) - three separate live local runs on the SAME day measured
// individual JSON-encoding calls at 142s/166s/180s, several right at or
// past the old 180s ceiling, killing otherwise-legitimate in-progress
// responses rather than a genuine hang. Same reasoning as the prior
// raise: this is real work taking real time, not a stuck request.
const MISTRAL_TIMEOUT_MS = 240000;

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

/**
 * A tried-and-reverted 3-way concurrency pool on top of a SINGLE key
 * (see git history) hit real 429s almost immediately and made a real
 * generation fail outright - direct, live confirmation that a single
 * key's rate limit doesn't tolerate concurrent requests at all. That
 * made the actual fix obvious: concurrency needs to spend a DIFFERENT
 * key's own independent quota, not fight over one key's. Each
 * configured key gets its own fully-isolated queue state (own
 * serialized call chain, own adaptive interval, own rate-limit-hit
 * clock) - a 429 on key A only slows down key A's future calls, never
 * key B's. queueMistralCall round-robins across them, so with N keys
 * configured, up to N calls now genuinely run in parallel (matching
 * generateSceneJSON's own Promise.all-per-beat dispatch, which this
 * finally lets mean something), while each individual key still gets
 * the exact same serialized/adaptively-paced treatment that was
 * already confirmed necessary for a single key on its own.
 */
function makeKeyQueueState(key, index) {
  return {
    key, label: `key${index + 1}`, callQueueTail: Promise.resolve(), currentCallIntervalMs: MIN_CALL_INTERVAL_MS, lastRateLimitHitAt: 0,
  };
}
const keyQueues = KEYS.map(makeKeyQueueState);
let nextKeyIndex = 0;

function recordRateLimitHit(state) {
  state.currentCallIntervalMs = MAX_CALL_INTERVAL_MS;
  state.lastRateLimitHitAt = Date.now();
}

function currentAdaptiveInterval(state) {
  if (state.currentCallIntervalMs <= MIN_CALL_INTERVAL_MS) return MIN_CALL_INTERVAL_MS;
  const sinceLastHit = Date.now() - state.lastRateLimitHitAt;
  if (sinceLastHit > RATE_LIMIT_DECAY_MS) {
    // Ease back down by half once the decay window has passed, rather
    // than snapping straight back to the fast floor - a real rate
    // limit that was just hit is more likely to still be nearby than
    // one from a while ago, so this eases off gradually.
    state.currentCallIntervalMs = Math.max(MIN_CALL_INTERVAL_MS, Math.round(state.currentCallIntervalMs / 2));
    state.lastRateLimitHitAt = Date.now();
  }
  return state.currentCallIntervalMs;
}

/**
 * `makeFetch(key, state)` is called once THIS key's turn in ITS OWN
 * queue arrives - callers use `key` for the Authorization header and
 * hang onto `state` so a 429 can be reported back against the exact
 * key that hit it (see callMistralRaw). Round-robin (not random)
 * assignment so a burst of N concurrent calls (generateSceneJSON's own
 * per-beat Promise.all) spreads evenly across every configured key
 * instead of clumping.
 */
function queueMistralCall(makeFetch) {
  if (keyQueues.length === 0) throw new Error('No Mistral API keys configured (MISTRAL_API_KEYS or MISTRAL_API_KEY_1/_2/...)');
  const state = keyQueues[nextKeyIndex % keyQueues.length];
  nextKeyIndex++;
  const scheduled = state.callQueueTail
    .then(() => sleep(currentAdaptiveInterval(state)))
    .then(() => makeFetch(state.key, state));
  state.callQueueTail = scheduled.catch(() => {});
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
  // recursion below it, so a 429 retry re-enters the queue fresh (and
  // - via round-robin - likely lands on a DIFFERENT key's queue this
  // time, not necessarily the one that just got rate-limited).
  let response;
  let usedKeyState; // set synchronously inside makeFetch, before any await - always populated by the time queueMistralCall resolves or rejects past this point
  try {
    response = await queueMistralCall((key, state) => {
      usedKeyState = state;
      // Per-call timing/key logging - added specifically because a
      // real production run showed a 2-MINUTE gap between "planning
      // treatment" and "encoding beats" with no 429/retry logged in
      // between, meaning a single call itself took that long. Without
      // this, there was no way to tell WHICH call was slow or which
      // key handled it - every future slow run now logs exactly that.
      const callStart = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);
      return fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
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
      }).finally(() => {
        clearTimeout(timeout);
        console.log(`[mistralClient] ${state.label}: request took ${Date.now() - callStart}ms`);
      });
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
      recordRateLimitHit(usedKeyState); // slow only THIS key's own queue down - other keys are unaffected, independent quotas
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
    // Real, confirmed-live gap: a 429 (rate limit) and a transient
    // network error (ECONNRESET etc, above) both already retry with
    // backoff, but a genuine Mistral-side 5xx ("Service unavailable",
    // a real internal_server_error observed live, not hypothetical)
    // fell straight through to the generic throw below and killed the
    // WHOLE generation immediately - the exact kind of routine,
    // recoverable API-side blip the other two paths already treat as
    // retryable, just missing this one status-code range. Retried the
    // same way (shared backoff/attempt budget), not treated as a hard
    // failure.
    if (response.status >= 500 && response.status < 600 && rateLimitRetriesLeft > 0) {
      recordRateLimitHit(usedKeyState);
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[mistralClient] Mistral server error (${response.status}), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
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

// ---------------------------------------------------------------------
// DELIBERATELY NARROWED SCOPE (explicit product direction, not a
// missing feature): the full engine below (shapes, images, effects,
// precomps, generate kinds, fade/wipe transitions) still exists and
// still works - sceneSchema.js still validates all of it and
// sceneBuilder.js/renderEngine.js still render all of it - but the
// PROMPT right now only asks for real, well-animated TEXT. This is a
// deliberate reset after real generated output combining many feature
// categories at once (shapes, images, effects, precomps) kept
// producing broken, cluttered results despite extensive prompt/
// validation work on each one individually - getting text genuinely
// solid first, before asking for more again, is the whole point. Both
// the background AND the camera panning between beats are handled
// ENTIRELY by the render engine itself (renderEngine.js's own
// automatic board-layout/pan/gradient logic) - nothing here authors or
// controls either one, they just happen, ONE continuous background for
// the whole video, panned across rather than swapped per beat.
// ---------------------------------------------------------------------

const SCHEMA_REFERENCE = `
You are directing a REAL motion graphics rendering engine - not writing
a description of a video. Every field you output maps to an actual,
already-built function call. Your scope right now is DELIBERATELY
narrow: real, professionally-animated TEXT - that is the ENTIRE
toolkit for this task, not a starting point to build on with other
layer types. The background is handled entirely elsewhere (see
BEATVISUAL below) - you never author one. Nothing here is decorative
flavor text: every option below is real and will actually render.

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

EVERY object in a "layers" array MUST include an explicit "type" field.
Right now there is exactly ONE valid value: "type":"text" - every
single layer you write is a text layer, no exceptions.

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
    "narration": string      // optional spoken line for this beat (real TTS)
  },
  "visual": BeatVisual
}

Whole-video duration is capped at 45 seconds of narration. Pace beats
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
       { "time": 0.5, "value": 100, "interpolation": "easing", "easing": "easeInOutCubic" }
     ] }
   interpolation: "hold" | "linear" | "easing" | "bezier"
   easing (when interpolation is "easing"): MUST be one of
     ${CUBIC_EASING_NAMES.join(', ')} - NO OTHER EASING NAME. This is a
     hard requirement, enforced by validation (not a style preference):
     any "easing" interpolation keyframe using something other than
     these three real cubic presets fails validation and is rejected.
     - "easeOutCubic": motion that starts fast and settles - the
       default choice for anything ENTERING (text reveals, a highlight
       chip appearing, a value landing).
     - "easeInCubic": motion that starts slow and accelerates away -
       for anything EXITING or being dismissed.
     - "easeInOutCubic": starts AND ends at rest - for a motion that
       both begins and ends mid-timeline with nothing before/after it
       to hand off to/from.
     (${EASING_NAMES.filter((n) => !CUBIC_EASING_NAMES.includes(n)).join(', ')}
     all exist in the engine for other real uses elsewhere, but are NOT
     valid choices for the text-only content you're authoring here.)

     A bouncy, overshoot-and-settle POP feel (the natural instinct for
     a punchy scale entrance) does NOT need "easeOutBack"/
     "easeOutElastic" - fake the exact same feel with a 3-keyframe
     cubic-only scale sequence instead, overshooting PAST the landing
     value then settling back onto it:
       { "keyframes": [
           { "time": 0,    "value": [1.3,1.3], "interpolation":"easing", "easing":"easeOutCubic" },
           { "time": 0.15, "value": [0.95,0.95], "interpolation":"easing", "easing":"easeOutCubic" },
           { "time": 0.25, "value": [1,1],     "interpolation":"easing", "easing":"easeOutCubic" }
         ] }
     (starts oversized, overshoots slightly PAST 1.0 down to 0.95, then
     settles up to exactly 1.0 - reads as a real spring/bounce landing,
     entirely built from "easeOutCubic" segments). Use this pattern -
     not a non-cubic easing name - anywhere a bouncy/punchy pop is the
     actual intent.
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
  "layers": [ TextLayerDef, ... ]  // REQUIRED, must be NON-EMPTY - every
                                     // beat needs real text content. An
                                     // empty "layers" array renders as a
                                     // dead, empty frame with nothing
                                     // happening for that beat's WHOLE
                                     // duration. Stacking order: LATER
                                     // entries draw ON TOP of earlier ones.
}
There is no "background" field here, and never author one. The ENTIRE
video shares ONE continuous gradient background, generated and panned
automatically by the render engine itself - not per beat, and not
something you request or influence. Same for the camera panning from
one beat to the next: handled ENTIRELY by the render engine,
automatically, between every beat. You never author, request, or
control either one. There is no "transitionIn" field to set right now.

=====================================================================
TEXTLAYERDEF - one entry in "layers", the ONLY layer shape right now
=====================================================================
{
  "id": string,   // optional, only needed if nothing else references it
  "type": "text",

  "position": AnimatableValue<[x,y]> - pixel coordinates, [0,0] is the
            frame's TOP-LEFT corner, [${COMP_WIDTH / 2},${COMP_HEIGHT / 2}]
            is the frame's CENTER. Default [0,0].
  "rotation": AnimatableValue<number> (degrees) - a small, subtle tilt
            (e.g. -3 to 3) reads as stylistic; large values just look
            like a mistake.
  "scale": AnimatableValue<[sx,sy]>,
  "anchor": AnimatableValue<[x,y]> - text is ALREADY drawn CENTERED on
            its own local (0,0). To center this layer on "position",
            OMIT "anchor" entirely (default [0,0] already IS the
            center) - do NOT set anchor to half the text's own size,
            that shifts it OFF-center by that much instead, the exact
            opposite of the intent. An off-center PIVOT (rotating
            around one edge on purpose) is the only real reason to set
            a different value.
  "opacity": AnimatableValue<0-1> - default 1 (fully visible). NEVER
            set this to a static 0 just because the layer also has a
            per-character reveal animator (see TEXTLAYERDEF ANIMATORS
            below) - the animator's own "opacity" delta only controls
            per-CHARACTER alpha and can NEVER override this field,
            which gates the WHOLE layer multiplicatively no matter
            what the animator does. A static "opacity":0 here makes
            the entire layer permanently invisible for its whole
            duration, animator or not (confirmed as a real, live bug).
            To start invisible and reveal, either omit "opacity"
            entirely and let the animator's own delta do the reveal,
            or animate THIS field with real keyframes (0 -> 1).

  "text": string, "fontFamily": string, "fontWeight": string, "fontSize": number,
  "lineHeight": number, "maxWidth": number, "fillStyle": color, "textAlign": string,
      // "fontFamily" MUST be one of ${AVAILABLE_FONT_FAMILIES.map((f) => `"${f}"`).join(', ')}
      // - these are the ONLY fonts actually bundled and registered with
      // this engine (real .ttf files, loaded at startup on every host).
      // ANY other name (including ones that sound plausible, like
      // "Futura Condensed" or "Arial Black") is NOT installed and will
      // silently fall back to a generic, unstyled default font -
      // confirmed directly by measuring real glyph metrics, not a style
      // guess. "Poppins Black" (weight 900) is the workhorse for bold
      // headline text - a heavy, rounded geometric grotesk, exactly the
      // kind of confident, punchy display type real kinetic-typography
      // edits use. "Poppins Bold"/"Poppins Medium" for secondary/
      // supporting lines that should read as a clear step down in
      // weight from the headline. "Poppins Italic" ONLY for a
      // deliberate rhythm-break accent word (sparingly, at most once
      // per beat), never as a primary headline face. Set "fontWeight"
      // to match the family's own real weight ("900" for Black, "700"
      // for Bold, "500" for Medium) - the GLYPHS themselves are already
      // that weight; "fontWeight" here is bookkeeping, not synthetic
      // bolding.
      // "textAlign": "left" | "center" | "right", default "center".
      // Real kinetic-typography edits overwhelmingly stack MULTI-WORD
      // phrases LEFT-aligned (every line starts at the same left edge,
      // ragged right) rather than each line individually centered on
      // its own width - use "left" for any multi-line body headline
      // building up phrase-by-phrase. Reserve "center" for a short,
      // standalone one-or-two-word title-card moment (a single word or
      // short phrase alone in the frame, not part of a longer build-up).
      // "maxWidth" controls line-wrapping (text wraps to a new line once a
      // line would exceed it) - omitting it defaults to a safe ${COMP_WIDTH - 60}px
      // (comp width minus margin), but for a large headline set it
      // explicitly to control exactly where it wraps, e.g. ${Math.round(COMP_WIDTH * 0.85)}
      // for most single-column text on this ${COMP_WIDTH}px-wide canvas.
      // "lineHeight" is an ABSOLUTE PIXEL value, NOT a CSS-style
      // unitless multiplier - confirmed as a real, live bug: writing
      // "lineHeight":1.2 (meaning "1.2x the font size", a common web/
      // CSS convention) made every wrapped line render almost exactly
      // on top of the next, since 1.2 is used AS PIXELS directly. For
      // a fontSize:60 headline, use lineHeight around 66-75 (roughly
      // 1.1-1.25x the font size) - omit it entirely to get a sane
      // default (fontSize*1.15) rather than guess at a multiplier.
  "animators": [ { "selector": SelectorDef, "properties": { "opacity": number,
      "position": [dx,dy], "scale": number, "rotation": number, "color": "#rrggbb" } }, ... ],
      // real per-character animation - see SELECTORS below. opacity/position/
      // scale/rotation are DELTAS applied at full selector strength (e.g.
      // position:[0,40] moves a character 40px down when "selected"). "color"
      // is DIFFERENT - not a delta, a per-character fill-color OVERRIDE: at
      // full selector strength that character renders in this hex color
      // instead of the layer's own "fillStyle", blending smoothly at partial
      // strength. Use a selector scoped to ONE word (basedOn:"words",
      // start/end computed as that word's exact PERCENTAGE range - see
      // SELECTORS below for the precise formula) to accent a single
      // word a different color from the rest of the line - e.g. the rest of
      // a headline in white with one key word in a bright accent color.
      // Remember "invert":false (see SELECTORS below) - without it the
      // color lands on every OTHER word instead of the one you targeted.
      // A color accent needs its OWN arrival moment too, same as every
      // other property here - to make it switch ON a beat or two AFTER
      // the word has already landed, keep "start"/"end" FIXED on the
      // target word the whole time and instead keyframe the selector's
      // "amount" from 0 to 1 at the moment you want the color to
      // appear. NEVER animate "start"/"end" for this purpose - that
      // changes WHICH characters are covered (growing the selection),
      // not WHEN the color switches on, and will color far more of the
      // line than intended.
  "highlights": [ { "selector": SelectorDef, "color": "#rrggbb" (solid) OR
      "gradient": { "from": "#rrggbb", "to": "#rrggbb" }, "paddingX": number,
      "paddingY": number, "cornerRadius": number }, ... ],
      // a "marker highlighter" chip - a rounded-rect box drawn BEHIND one
      // word (or a short run of characters), like a highlighter stroke or a
      // call-out label. Scope the selector to the target word with
      // basedOn:"words" and start/end computed as the exact PERCENTAGE
      // range for that one word index (see SELECTORS below for the
      // precise formula and a worked example - do NOT guess small
      // arbitrary numbers). Unlike an animator, a highlight's selector
      // is used AS-IS with no invert - the word(s) your start/end
      // percentage range actually covers are exactly what gets boxed,
      // nothing more.
      // paddingX/paddingY default to 8/4px, cornerRadius defaults to 6px.
      // NEVER give a highlight static full coverage - a real reference
      // example of this exact effect shows the marker box arriving with
      // its OWN motion, not present from the word's first frame. To
      // animate it in: keep "start"/"end" FIXED on the target word's
      // exact percentage range for the WHOLE beat (never animate them -
      // see the "color" note above for exactly why that goes wrong),
      // and instead keyframe "amount" from 0 to 1 over ~0.15-0.3s,
      // timed to land shortly AFTER the word itself has already
      // landed, so the chip visibly draws ON behind the still-correct
      // word as its own distinct, later-timed motion - not simultaneous
      // with the text reveal, and never simply "on" the whole time.
      // NOT supported together with "onPath".
      //
      // CRITICAL: a highlight (or a "color" accent animator) ALWAYS
      // lives on the SAME layer as the text it's decorating, targeting
      // one word of THAT layer's own "text" string via the selector -
      // it is NEVER a second, separate layer that repeats the same
      // word next to the original. Real, confirmed-live mistake: a
      // headline layer with text "3 FACTS" (wrapping to two lines,
      // "3" then "FACTS") got a SECOND, entirely separate text layer
      // containing just "3" with a highlight on it, hand-positioned to
      // try to sit on top of the headline's own "3" - since no author
      // can know exactly where a wrapped multi-line headline's
      // individual words land in pixels ahead of render time, the
      // guessed position landed wrong and the two literal "3"s
      // rendered overlapping each other, illegible. The correct way to
      // highlight the "3" in "3 FACTS" is a "highlights" entry ON THAT
      // SAME "3 FACTS" layer, with a selector scoped to just its first
      // character/word (e.g. basedOn:"characters", start:0,end:X% to
      // cover only "3") - never a duplicate sibling layer.
      //
      // Every "type":"text" layer's "text" field is REQUIRED and must
      // be a real, non-empty string - there is no such thing as a
      // "decoration-only" or "highlight-only" text layer with no text
      // of its own. If a layer exists purely to add visual emphasis
      // (a color accent, a highlight chip), that emphasis belongs as
      // "highlights"/an animator "color" on an EXISTING layer that
      // already has real words - it is never a reason to add another
      // layer, and never a reason for a layer's own "text" to be
      // omitted or empty.
}

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
  //
  // "start"/"end" are PERCENTAGES OF POSITION THROUGH THE TEXT (0-100),
  // NEVER literal word/character indices - a real, confirmed-live
  // mistake: writing {"start":6,"end":22} trying to target "the 3rd
  // word" of an 8-word sentence actually selects almost nothing (word
  // index has to be converted to a percentage first). To target ONE
  // specific word at index i (0-indexed) out of N total words:
  //   start = (i / N) * 100
  //   end   = ((i + 1) / N) * 100
  // Concrete worked example: highlighting exactly the 3rd word ("HOME",
  // index 2) of "IT'S HOME TO SHARKS" (4 words total, N=4): start =
  // (2/4)*100 = 50, end = (3/4)*100 = 75. NEVER guess small arbitrary
  // numbers hoping they'll land near the right word - always compute
  // the percentage from the real word count and target index.
  //
  // "invert" (on the ANIMATOR wrapping this selector, not the selector
  // itself - see TEXTLAYERDEF's "animators" above) defaults to TRUE,
  // meaning by default an animator applies its "properties" delta to
  // the CHARACTERS NOT SELECTED by the range, not the ones selected -
  // this is the correct default for the classic reveal case (start
  // fixed at 0, end sweeping to 100: "not yet reached by the sweep" =
  // hidden/offset, "reached" = landed). But a "color" accent animator
  // is NOT a reveal - you want the color applied exactly where you
  // targeted, not its complement. A real, confirmed-live bug: a
  // "color" animator scoped to one word with no "invert" field ended
  // up coloring EVERY OTHER word in the sentence instead, because the
  // default invert flipped the selection. ALWAYS set "invert":false
  // explicitly on any "color" animator (or any other non-reveal
  // accent) targeting a specific word range - only leave "invert" at
  // its default (or explicitly true) for an actual entrance reveal.
  //
  // DEFAULT REVEAL STYLE: a real, fast-cut kinetic-typography edit does
  // NOT slowly wipe each character in one at a time - words/short
  // phrases POP IN as a unit, fast (~0.15-0.35s total), landing on the
  // very NEXT phrase before the last one has time to feel static. Use
  // "basedOn":"words" with "end" sweeping 0->100 over that short a
  // window as the DEFAULT (every word in the current phrase lands
  // within a fraction of a second of each other, not staggered letter
  // by letter) - reserve a slower "basedOn":"characters" sweep for the
  // rare deliberate exception, not the default assumption. Pair the
  // reveal with a small "scale" delta (e.g. properties.scale: 1.15-1.3)
  // in addition to opacity/position for a punchy pop-in landing feel,
  // not just a flat fade.
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
DESIGN QUALITY - this is the whole point, not an afterthought
=====================================================================
- Every beat should feel deliberately DESIGNED, not a plain slide: a
  real per-character text reveal, at minimum, every single beat (the
  background is already handled for you).
- NOTHING IS STATIC. This is not just about the text reveal - EVERY
  element that has its own timing (the headline's entrance, a
  supporting label's entrance, a "color" accent switching on, a
  "highlights" chip drawing in) needs its OWN separately-timed
  animation, not all bundled into one simultaneous moment. Build beats
  the way a real kinetic-typography edit is cut: short phrases
  building up word-by-word or line-by-line, each new piece of text
  landing roughly every 0.3-1s rather than one full sentence appearing
  and sitting there - and once text HAS landed, a color accent or
  highlight chip on it should still arrive its own beat later (a
  distinctly separate, later-timed animation), never baked in from
  that text's very first frame. A beat where everything animates in
  at once and then nothing moves again is exactly the "static" failure
  this rule exists to prevent, even if the initial reveal itself was
  well-animated.
- Use TEXT color with intent - a coherent palette across the whole
  video (related hues from beat to beat, not random unrelated ones).
  For the single most important word in a headline, consider an
  animator "color" accent or a "highlights" chip behind it instead of
  leaving the whole line one flat color - used sparingly (one accented
  word per beat, not every word), this is what makes a headline read
  as designed rather than a plain text dump.
- EVERY layer in "layers" needs its OWN "position" - a real, common
  live mistake: 2+ layers left at the same position (very often
  [${COMP_WIDTH / 2},${COMP_HEIGHT / 2}], the frame center, the natural
  default to reach for) stack fully on top of each other instead of
  reading as the intended composition. Before finishing a beat, scan
  every layer's "position" and make sure no two share an identical
  value (unless they're genuinely both meant to sit dead-center at
  different moments in time via animation).
- Prefer real keyframed motion with "easing" interpolation for primary
  text, and ALWAYS use one of ${CUBIC_EASING_NAMES.join(', ')} for it -
  no other easing name is valid here (see ANIMATABLE VALUES above);
  keep position-based per-character animator deltas small (15-40px) so
  characters don't visually overlap mid-reveal (see SELECTORS above
  for the full reasoning).
- FILL THE FRAME with intent. A tiny line of text confined to one
  corner while most of the ${COMP_WIDTH}x${COMP_HEIGHT} frame sits
  empty reads as unfinished - use font size, line breaks, and multiple
  text layers (a headline plus a supporting label/stat) to give the
  frame real visual weight, not just one small centered line.
- NEVER let a beat go visually static for more than a fraction of a
  second. A real per-character reveal should always be happening (or
  just landed) somewhere on screen - a beat that's just a single
  motionless line of text sitting there for its whole duration reads
  as dead air and is the single fastest way to lose a short-form
  viewer. Match each beat's duration to how much text/reveal is
  actually happening in it - don't stretch one short line across
  several empty seconds.
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
  return `You are a world-class motion graphics director specializing in
kinetic typography - the kind of person clients pay a premium for
because every single frame of TEXT is intentional, well-paced, and
alive. You are planning (NOT building yet) a ${targetDurationSeconds}-second
short-form vertical video (${COMP_WIDTH}x${COMP_HEIGHT}px, 9:16) for the
request below.

Your toolkit right now is DELIBERATELY narrow, on purpose: real,
professionally-animated TEXT - that's it. No photos, no shapes, no
icons, no effects layers, no charts. The video's background is a
single continuous gradient handled entirely by the render engine
itself (not something you plan or describe) - your whole job is the
text. This is not a limitation to work around or apologize for - great
kinetic typography (bold, well-paced, well-composed text alone) is a
complete, respected genre of short-form content on its own, and the
ENTIRE job here is nailing that, not describing things this pass can't
build.

Write a concrete, opinionated, beat-by-beat treatment - not mood words,
actual decisions a senior director would hand an animator to build
frame-for-frame:

1. THE HOOK: the exact words on screen in the first half-second and
   why they earn attention immediately (specific, not "an engaging
   headline").
2. PALETTE & MOOD: 2-4 specific TEXT colors (precise enough to pick
   real hex values from - the background itself is handled entirely by
   the render engine, not something you plan) and the visual mood they
   create together, held consistent across the whole video.
3. BEAT BY BEAT (beats are typically 2-4s each): keep this section
   clearly structured - start each beat with its own line reading
   "===BEAT n=== duration:X.Xs" (n starting at 0, X.X the beat's own
   length in seconds, all beats summing to approximately
   ${targetDurationSeconds}s) on its own line, with nothing else on
   that line. Everything between one "===BEAT n===" line and the next
   is that beat's own full description - this is YOUR OWN plan, which
   YOU will encode into the final "scenes" JSON array yourself in the
   next step, so a clear, well-separated breakdown here directly makes
   that easier to get right, every beat covering ALL of:
   - The exact text/words on screen (a headline, a stat, a short
     label) - be specific about the actual copy, not just its topic.
     Favor SHORT phrases landing one after another (roughly every 0.3-
     1s of screen time each) over one long sentence appearing all at
     once - the pacing of a fast, well-cut kinetic-typography edit, not
     a static caption card.
   - How the text reveals: a fast word-level pop-in (~0.15-0.35s, the
     default - see SELECTORS below), timing, any position/scale motion
     on the reveal - specific enough to actually author
   - Hierarchy when a beat has more than one text element (which is
     the dominant headline vs. a smaller supporting label, and roughly
     where each sits)
   - Where a color accent or highlight marker belongs, and WHEN it
     switches on relative to the text's own landing moment - it should
     always be its own later, separately-timed beat of motion, never
     simultaneous with (or baked into) the text reveal itself
   - How this beat's text lands and settles before the next beat -
     nothing in this beat should ever go fully motionless for more
     than a fraction of a second; something is always either still
     arriving, switching on, or settling
4. Fill the frame with intent every beat - real font size and, where
   it earns its place, multiple text elements (a headline plus a
   supporting stat/label) - avoid one small line lost in a big empty
   frame.

Example of the beat-header format:
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

// Only used to COUNT how many beats the treatment itself planned (a
// structural sanity check on the whole-scene encoding step below) -
// NOT to split/parse the treatment into pieces the way the removed
// per-beat architecture used to. A plain occurrence count of the
// treatment's own "===BEAT n===" headers, unrelated to that deleted
// mechanism.
const BEAT_HEADER_RE = /===\s*BEAT\s+\d+\s*===/gi;
function countTreatmentBeats(treatment) {
  return (treatment.match(BEAT_HEADER_RE) || []).length;
}

/**
 * THE generation path - one single call encodes the ENTIRE
 * {scenes:[...]} document from the treatment at once, with real
 * retry-with-errors-fed-back on validation failure.
 *
 * Explicit product reset (not a return to an old default by accident):
 * this used to be only a rare fallback, with per-beat CONCURRENT
 * independent generation (each beat its own isolated call, no
 * visibility into any other beat) as the primary path. Removed after
 * real, repeated live failures traced directly to that isolation, not
 * to whole-scene generation itself: beats generated with zero
 * awareness of each other produced duplicate content (the same exact
 * headline written twice, as two separate beats each independently
 * decided it was a good hook), and a single stubborn beat exhausting
 * its own retry budget failed the ENTIRE video even when every other
 * beat had already generated correctly. One call that sees the whole
 * treatment at once and writes every scene together doesn't have
 * either failure mode - it has full context for what's already been
 * said, and validation/retry now covers the whole video as one
 * coherent unit rather than N independent ones.
 */
async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 6, priorErrors = null } = {}) {
  const systemPrompt = buildGenerationSystemPrompt(targetDurationSeconds);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every decision below must become real text layers/animators from the schema above, never simplified or dropped to something generic. The treatment may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead (a hard hit, a flash, a snap into place) rather than inventing a nonexistent field. Only use real fields from the schema above - never invent new ones.):\n${treatment}\n\nOriginal request: ${userPrompt}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;

  const result = await callMistralForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  // Real, confirmed-live gap: structural validation alone doesn't
  // catch a response that's simply too SHORT - a real generation
  // produced a fully valid, error-free 1-2 scene, 2-4 second video
  // when the treatment itself planned 5 beats summing to ~12s. Nothing
  // about that is a SCHEMA violation, so validateSceneJSON alone would
  // never flag it - it's a completeness problem, not a correctness
  // one, and needs its own check against what the treatment actually
  // asked for. A real "you asked for 5, only 2 arrived" retry message
  // is far more likely to fix this than hoping the prose instruction
  // ("encode this EXACTLY and FAITHFULLY") gets followed reliably on
  // its own.
  const expectedBeats = countTreatmentBeats(treatment);
  const actualBeats = valid && Array.isArray(result.scenes) ? result.scenes.length : 0;
  const isTooShort = valid && expectedBeats > 0 && actualBeats < expectedBeats * 0.7;

  if (!valid || isTooShort) {
    const completenessError = isTooShort
      ? [`scenes: the treatment planned ${expectedBeats} beat(s) ("===BEAT n===" headers), but only ${actualBeats} scene(s) were encoded - EVERY beat in the treatment must become its own entry in "scenes", none skipped, merged, or summarized away. Output all ${expectedBeats}.`]
      : [];
    const allErrors = [...errors, ...completenessError];
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] generated scene JSON ${!valid ? 'failed validation' : 'was too short'} (${allErrors.length} error(s)), retrying: ${allErrors.slice(0, 3).join('; ')}`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors: allErrors });
    }
    throw new Error(`Mistral-generated scene JSON failed schema validation after retries: ${allErrors.join('; ')}`);
  }
  return result;
}

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[mistralClient] planning creative treatment...');
  const treatment = await generateCreativeTreatment(userPrompt, targetDurationSeconds);
  console.log('[mistralClient] encoding whole scene in one pass...');
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
 *
 * Raised again (6min -> 8min) alongside MISTRAL_TIMEOUT_MS's own raise
 * above, same day, same real cause: per-character color accents,
 * highlight chips, and mandatory separately-timed animations make
 * every beat's own JSON genuinely bigger, and a single retry at the
 * new, still-legitimate ~200s per-call cost can now eat well over half
 * the old 360s budget on its own, before a SECOND retry even starts.
 * 8 minutes stays well clear of the 15-minute frontend threshold this
 * was always bounded against, so there's real room to give without
 * losing the "fail fast and cleanly" guarantee this exists for.
 */
const GENERATION_HARD_TIMEOUT_MS = 8 * 60 * 1000;

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
