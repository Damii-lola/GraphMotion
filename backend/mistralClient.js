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

// Switched back to small-latest after adding real auto-repair for
// several of the exact error categories that made it fail to converge
// last time (duplicate-text layers, wiggly+position, malformed
// highlight gradients, stray typeless layer entries - see
// autoRepairBeat) - those are silently fixed in place now instead of
// forcing a retry, which directly targets several of the recurring
// failure modes observed. Small's per-call latency (11-56s measured
// live) is dramatically better than large's (100-240s) whenever it
// does converge.
const MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';

if (KEYS.length === 0) {
  console.warn('[mistralClient] No MISTRAL_API_KEYS/MISTRAL_API_KEY_N configured');
} else {
  console.log(`[mistralClient] ${KEYS.length} Mistral API key(s) configured`);
}

const { jsonrepair } = require('jsonrepair');

// Real, repeatedly-recurring live failure: mistral-small-latest
// (switched to for latency - see MODEL below) occasionally emits
// almost-valid JSON with one small syntactic slip - most often a
// missing comma between two array elements ("Expected ',' or ']'
// after array element"), sometimes an unterminated string. The OLD
// behavior treated this identically to a genuinely incomplete/garbage
// response: give up immediately and force an entire fresh ~15-240s
// Mistral call to regenerate the WHOLE document from scratch, even
// though 99% of that same response was perfectly valid content sitting
// right there. `jsonrepair` is a small, well-tested, purpose-built
// library for exactly this class of "LLM emitted almost-valid JSON"
// problem (missing/trailing commas, unquoted keys, unterminated
// strings, etc.) - tried as a fast, free, LOCAL repair attempt before
// ever falling back to a full network round-trip. Real, measured
// asymmetry driving the ordering below: a successful repair costs
// microseconds; a failed one costs nothing beyond the repair attempt
// itself, since the original JSON.parse error is what triggers a
// retry either way if repair also fails to produce valid JSON.
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in Mistral response');
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (originalErr) {
    try {
      const repaired = jsonrepair(candidate);
      const result = JSON.parse(repaired);
      console.warn(`[mistralClient] JSON parse failed (${originalErr.message}) but jsonrepair recovered it locally - no retry needed`);
      return result;
    } catch (repairErr) {
      throw originalErr; // repair didn't help either - surface the ORIGINAL error, more directly useful for debugging than jsonrepair's own
    }
  }
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
  // Raised again (18000 -> 28000) after a live run hit this ceiling
  // outright ("Mistral response was truncated") once shapes/icons
  // re-entered scope - a shape layer's own contents array (path+fill+
  // trim, or path+stroke+trim for a doodle/ripple) is real additional
  // JSON per layer that text-only beats never needed, and a 5-beat
  // video now routinely uses several such layers.
  const rawText = await callMistralRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 28000 });
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
  "layers": [ TextLayerDef | ShapeLayerDef | ImageLayerDef, ... ]  //
                                     // REQUIRED, must be NON-EMPTY - every
                                     // beat needs real content, text at
                                     // minimum. An empty "layers" array
                                     // renders as a dead, empty frame with
                                     // nothing happening for that beat's
                                     // WHOLE duration. Stacking order:
                                     // LATER entries draw ON TOP of
                                     // earlier ones - background/decorative
                                     // shapes and icons go FIRST, text
                                     // LAST, so text always reads clearly
                                     // on top.
}
There is no "background" field here, and never author one. The ENTIRE
video shares ONE continuous gradient BACKDROP, generated and panned
automatically by the render engine itself - not per beat, and not
something you request or influence. Same for the camera panning from
one beat to the next: handled ENTIRELY by the render engine,
automatically, between every beat. You never author, request, or
control either one. There is no "transitionIn" field to set right now.
That backdrop is the FLOOR, not the ceiling - real motion graphics
(shapes, icons/logos) live in "layers" ON TOP of it, exactly like a
real After Effects composition builds up from a base color into a full
scene with foreground elements, not text floating alone on a gradient.

CRITICAL for color choices: you don't control WHICH exact backdrop hue
gets picked, but you DO know the real family it always comes from - a
rich, fairly dark, vivid jewel tone: royal blue, violet, magenta/berry,
emerald, amber/orange, or teal (never pastel, never near-black, never
near-white). Real, confirmed-live mistake: a pale/light tint of one of
these same hue families ("#C3D8FF", a soft periwinkle) as a text
"fillStyle" - it read as barely-legible low-contrast text no matter
which of these backdrops it landed on, since it's close in hue and
lightness to several of them. Pure white ("#FFFFFF") or near-white is
ALWAYS safe for primary text/body copy regardless of which exact
backdrop hue gets picked - default to it unless you have a specific,
deliberate reason (a bold accent color chosen for contrast/emphasis,
not a pastel of the backdrop's own hue family) to do otherwise.

=====================================================================
TEXTLAYERDEF - one entry in "layers"
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
      // "fontFamily" MUST be EXACTLY one of these four literal strings:
      // ${AVAILABLE_FONT_FAMILIES.map((f) => `"${f}"`).join(', ')} -
      // these are the ONLY fonts actually bundled and registered with
      // this engine (real .ttf files, loaded at startup on every host).
      // This is a closed set of exactly four strings, full stop - not
      // just "avoid the wrong Poppins weight." A real, confirmed-live
      // mistake reaching well beyond Poppins: naming a totally different
      // real commercial typeface by name ("Frutiger LT 65 Bold",
      // "Frutiger LT 55 Roman") because it felt like the right premium/
      // editorial look for the content - Helvetica, Futura, Arial,
      // Montserrat, Frutiger, or literally any other real font name is
      // EQUALLY not bundled here and fails EXACTLY the same silent way
      // as a wrong Poppins weight (falls back to a generic, unstyled
      // default). There is no "pick whatever font fits the mood" step
      // in this schema at all - the only decision is which of the four
      // exact strings above best serves the moment, never a fifth name.
      // Real, repeatedly-recurring mistake: Poppins is a well-known
      // real font family with MANY real weights (Thin, Light, Regular,
      // Medium, SemiBold, Bold, ExtraBold, Black), and the natural
      // instinct is to reach for one of those familiar weight names -
      // but this engine bundles ONLY the four exact strings above.
      // "Poppins Regular"/"Poppins SemiBold"/"Poppins Light"/bare
      // "Poppins" (no weight suffix at all) are ALL real Poppins
      // weights that do NOT exist as bundled files here and WILL
      // silently fall back to a generic, unstyled default font -
      // confirmed directly by measuring real glyph metrics, not a
      // style guess. There is no "regular"/"normal" weight bundled at
      // all - "Poppins Medium" is the closest thing to a body-text
      // weight available; use it, not "Poppins Regular". "Poppins
      // Black" (weight 900) is the workhorse for bold
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
      // "fontSize" - real, confirmed-live mistake: 90-110px on this
      // ${COMP_WIDTH}px-wide canvas for a multi-word phrase leaves NO
      // margin at all, so the text box always ends up needing to be
      // dead-center just to avoid clipping - which then makes every
      // single beat look identical (same size, same spot), the exact
      // "repetitive/boring" failure a real brutal comparison flagged.
      // For a 2+ word headline, keep fontSize in the 44-72px range so
      // the box has real room to sit off-center sometimes (see
      // "position" below); reserve 80px+ for a genuinely SHORT
      // standalone moment (one word, a single number/stat) where
      // filling more of the frame is the actual intent, not an
      // accident of picking too large a size for a longer phrase.
      // "position" - do NOT default every beat to the frame's exact
      // center ([${COMP_WIDTH / 2},${COMP_HEIGHT / 2}]) out of habit.
      // Once fontSize leaves real margin (per the note above), vary
      // where headlines actually sit beat to beat - left-of-center,
      // right-of-center, upper-third, lower-third - the same way a
      // real edit doesn't lock every single card to one fixed spot.
      // Center is still fine for a genuine title-card moment; it just
      // shouldn't be the ONLY position ever used across a whole video.
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
      // CRITICAL, real confirmed-live bug: "position"'s x is ALWAYS the
      // text box's own CENTER, regardless of "textAlign" ("left"/"right"
      // just change how each line sits WITHIN that same centered box,
      // not where the box itself is) - it is NEVER a left-margin/indent
      // value. A real broken example: "position":[71,...] with
      // "maxWidth":459 - that reads like "start near the left edge with
      // a bit of margin," but it actually centers a 459px-wide box on
      // x=71, so the box spans roughly -158 to 300 and nearly a third of
      // it renders off the left edge of this ${COMP_WIDTH}px canvas for
      // the whole beat. For text anywhere near "maxWidth" wide, keep
      // position.x within roughly maxWidth/2 of ${Math.round(COMP_WIDTH / 2)}
      // (the canvas center) so the box stays fully on-screen - to get a
      // true left-margin look, use "textAlign":"left" together with a
      // SMALLER "maxWidth" (the space actually available from that
      // margin to the right edge), keeping position.x at the CENTER of
      // that smaller box, not its left edge.
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
      // position:[0,40] moves a character 40px down when "selected").
      // CRITICAL: these four are PLAIN VALUES, never a keyframed object,
      // even though a keyframed {"keyframes":[...]} shape is legal almost
      // everywhere else in this schema (a layer's own top-level "position",
      // effect params, etc) - do NOT reuse that pattern here.
      //   WRONG: "properties": { "position": { "keyframes": [
      //            { "time": 0.2, "value": [270,180] },
      //            { "time": 0.4, "value": [270,220] } ] } }
      //   RIGHT: "properties": { "position": [0,40] }
      // The wrong form silently breaks the entire reveal at render time
      // (confirmed live) - the character never moves and stays wherever
      // its base layout/layer position put it, which is a real, common
      // bug when that base position was deliberately off-canvas so the
      // reveal could fly it in. If you want a layer to slide from an
      // off-screen spot to a final on-screen spot, do NOT use "animators"
      // for that at all - keyframe the LAYER'S OWN top-level "position"
      // field instead (that one DOES take {"keyframes":[...]}). Reserve
      // "animators"/"properties" strictly for PER-CHARACTER stagger
      // effects (each character offset by the same small fixed delta,
      // revealed one after another via the selector's sweep). "color"
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
      //
      // GENERAL RULE (the "3 FACTS" case above is one specific example
      // of this, not the only one): NEVER put the exact same "text"
      // string on two different layers in the same beat, for ANY
      // reason - this was ALSO seen live as a "plain copy + accented
      // copy" pattern (e.g. two entire separate layers both reading
      // "20 MILLION TONS dissolved in seawater", one presumably meant
      // to be the base and one meant to carry a highlight/color), which
      // is just as wrong and renders as visibly doubled, overlapping
      // text either way. This is hard-enforced by validation, not just
      // advisory - every distinct piece of text content in a beat gets
      // exactly ONE layer, and any emphasis on part of it is a
      // "highlights"/"color" addition to THAT one layer, never a
      // reason to duplicate it into a second.
}

Colors are always full 6-digit hex ("#rrggbb" or "#rrggbbaa") - 3-digit
shorthand ("#333") is NOT supported and will render wrong.

=====================================================================
SHAPELAYERDEF - real vector shapes: backgrounds, reveals, doodles, rings
=====================================================================
{
  "id": string, "type": "shape",
  "position", "rotation", "scale", "anchor", "opacity": AnimatableValue (same as TEXTLAYERDEF),
  "width": number, "height": number,  // REQUIRED, ALWAYS a DIRECT SIBLING
      // of "position"/"contents" on the LAYER itself - never nested
      // inside a content item, never omitted. Real, repeatedly-
      // recurring mistake: writing the shape's size ONLY inside
      // contents[0].shape.params (see below) and leaving the LAYER's
      // own top-level width/height out entirely - these are TWO
      // SEPARATE fields that must BOTH be set, usually to the same
      // numbers.
  "contents": [ ShapeContentItem, ... ]  // REQUIRED, stacks top-to-bottom
}

CRITICAL, the single most common mistake with shapes: ShapeContentItem's
"type" is ONLY EVER one of these SIX literal strings:
${SHAPE_CONTENT_TYPES.map((s) => `"${s}"`).join(', ')} - it is NEVER
"rectangle"/"ellipse"/"customPath"/"polygon"/"star" directly, and NEVER
a layer type like "text"/"image"/"shape" either. Those shape KIND names
are real, but they belong ONE LEVEL DEEPER, inside a "path" item's own
"shape.kind" field - "rectangle" is a value of "shape.kind", never a
value of "type" itself. Concrete WRONG vs RIGHT for the exact same
100x100 rounded rectangle:
  WRONG: { "type": "rectangle", "width": 100, "height": 100 }
  RIGHT: { "type": "path", "shape": { "kind": "rectangle",
            "params": { "width": 100, "height": 100, "roundness": 8 } } }
Full worked example - a complete shape layer (a 100x100 rounded
rectangle, red fill, no stroke):
{
  "type": "shape", "width": 100, "height": 100, "position": [270, 480],
  "contents": [
    { "type": "path", "shape": { "kind": "rectangle",
        "params": { "width": 100, "height": 100, "roundness": 8 } } },
    { "type": "fill", "color": "#ff3366" }
  ]
}
Note the size (100, 100) appears TWICE, once as the layer's own top-
level "width"/"height", once inside the path's own "shape.params" -
both are required and should normally match.

Each ShapeContentItem shape:
  { "type":"path", "shape": { "kind": ${SHAPE_KINDS.map((s) => `"${s}"`).join(' | ')},
      "params": {...} } }
    // rectangle: {width,height,roundness?}  ellipse: {width,height}
    // polygon: {points,radius,rotation?}  star: {points,outerRadius,innerRadius,rotation?}
    //   - "points" here is a plain NUMBER (how many sides/points the
    //   REGULAR shape has, e.g. 6 for a hexagon, 5 for a 5-pointed
    //   star) - it generates the shape from a side count + radius, it
    //   is NEVER an array of hand-specified vertex coordinates (that
    //   confusion with customPath's "anchors" crashed a real render):
    //     WRONG: "points": [{"point":[0,-60]},{"point":[60,0]},...]
    //     RIGHT: "points": 6, "radius": 60
    //   For anything that isn't a regular polygon/star, use
    //   "customPath" with real "anchors" instead.
    // customPath: {closed, anchors:[{point:[x,y],outTangent?,inTangent?},...]}
    //   - anchors is an OBJECT array, each {"point":[x,y]} - NOT bare
    //   [x,y] pairs. This is how you hand-draw a line/squiggle/curve
    //   (the tutorial's "Pen tool" equivalent) - a handful of anchor
    //   points with small outTangent/inTangent offsets for curve, or
    //   omit both for straight segments. Needs at least 2 anchors.
  { "type":"fill", "color":"#rrggbb", "opacity": 0-1 }
  { "type":"stroke", "color":"#rrggbb", "width": number,
      "cap": "butt"|"round"|"square", "join": "miter"|"round"|"bevel",
      "dash": [on,off]? }
    // "cap":"round" is what makes a hand-drawn line/doodle look
    // smooth-ended instead of blunt-cut - use it for any decorative
    // line, not the default "butt".
  { "type":"trim", "start": AnimatableValue<0-100>, "end": AnimatableValue<0-100>,
      "offset": AnimatableValue<0-100>, "multiple": "individually"|"simultaneously" }
    // THE reveal-a-shape-drawing-itself mechanic - see AE TECHNIQUE
    // PATTERNS below for the real recipes this powers.
  { "type":"pathOp", "mode": ${PATH_OP_MODES.map((s) => `"${s}"`).join(' | ')} }
  { "type":"repeater", "copies": number,
      "transform": {"position":[x,y],"rotation":number,"scale":[sx,sy],"anchor":[x,y]},
      "startOpacity": 0-1, "endOpacity": 0-1, "order": "below"|"above" }
    // "transform" fields are PLAIN STATIC NUMBERS, never AnimatableValue
    // or expressions - the SAME transform COMPOUNDS across every copy
    // (copy 2 gets it applied twice, copy 3 three times...), which is
    // how you fan a shape into a circle/spiral/ring from one small
    // rotation/position value, not by hand-placing each copy.
  { "type":"group", "contents":[...], "transform":{...} }

A shape layer's own content draws CENTERED on its local (0,0) - to
center it on "position", omit "anchor" entirely (default [0,0] is
already correct); do NOT set anchor to half the width/height, that
shifts it OFF-center by that much (the exact opposite of centering).

=====================================================================
IMAGELAYERDEF / ICONS - real icons and brand logos, not invented ones
=====================================================================
{
  "id": string, "type": "image",
  "position", "rotation", "scale", "anchor", "opacity": AnimatableValue,
  "width": number, "height": number,
  "icon": "prefix:name",     // a REAL Iconify icon - see below
  "iconColor": "#rrggbb"     // optional, recolors the icon (most Iconify
                              // icons are single-color and take this
                              // cleanly; omit for a multi-color icon
                              // like a brand logo that should keep its
                              // real colors)
}
"icon" MUST be a real icon that actually exists in Iconify's open
library (api.iconify.design, ~200,000 icons, free, no key needed) -
never invent a plausible-sounding name. Reliable, generic-concept sets
to draw from (prefix "mdi:" = Material Design Icons, by far the
largest/safest general-purpose set - rocket, lightbulb, chart-line,
clock, star, heart, check-circle, alert, trending-up, and thousands
more genuinely exist under "mdi:"). For a REAL brand/product logo, use
the "simple-icons:" prefix with the lowercase product name (e.g.
"simple-icons:youtube", "simple-icons:instagram", "simple-icons:apple")
- this is a real, maintained set of actual brand marks, not something
to guess the shape of yourself. If you are not confident an exact icon
name is real, prefer a well-known "mdi:" concept icon over guessing at
a more specific or brand-specific one.
An image layer needs either "icon" or "src":"beatImage" (an AI-
generated hero photo for this beat) - never both, never neither.

=====================================================================
AE TECHNIQUE PATTERNS - real recipes, not abstract capability
=====================================================================
These are concrete constructions to actually use, adapted directly
from real professional motion-graphics technique - not a menu to
sample from lightly. A beat that only uses per-character text reveals
is not using this engine's real range; reach for these often.

1. STAGGERED COLOR-BLOCK REVEAL (a classic intro background build):
   2-3 rectangle shape layers, each FULL-FRAME size, each a different
   flat fill color, each with a "trim" whose "end" sweeps 0->100 (start
   fixed at 0, or set "offset" around -20 to -40 to angle the wipe in
   from a corner) - but stagger each layer's OWN reveal to begin a few
   frames (0.1-0.2s) after the previous one, so the colors stack in
   with a rhythmic cascade, not all at once. Draw them BELOW your text
   layers in "layers" order.
2. SCALE POP-IN (any shape/icon, not just text): "scale" keyframes
   [0,0] -> [1,1] (or a slight overshoot per the cubic-overshoot
   pattern in ANIMATABLE VALUES above) with easeOutCubic - the exact
   "text pops up" technique, equally real for an icon or a shape.
3. HAND-DRAWN LINE DOODLE: a "customPath" shape, NO fill, only a
   "stroke" (cap:"round", width 2-4px, a color that fits your palette),
   with a "trim" whose "start" AND "end" both sweep 0->100 but "start"
   trails "end" by a beat or two - the shape "grows" then the tail
   "catches up and disappears", reading as a lively traveling stroke,
   not a static line popping into place. Scatter 2-3 of these as small
   accents around a headline, never dominating it.
4. RIPPLE/PULSE CIRCLE: an ellipse shape, NO fill, only a stroke -
   keyframe the stroke's own "width" from a real value down to 0 (the
   ring thins out and vanishes) WHILE ALSO keyframing "scale" from
   [0,0] up past [1,1] with easeOutCubic (the ring grows outward) - a
   real expanding-ripple/pulse effect. Use sparingly as a small accent
   near an icon or a number, not a dominant element.
5. ICON + LABEL PAIR: an icon (scale pop-in, per #2) paired with a
   short supporting text label near it - a real, common motion-
   graphics pattern (a stat with its own icon, a feature with its own
   icon) that reads far more designed than a bare text-only stat.
6. TEXT DEPTH via drop shadow: give a primary headline layer an
   "effects": [{"type":"dropShadow","params":{"color":"#000000",
   "blur":6-10,"offsetX":0,"offsetY":4-8,"opacity":0.3-0.5}}] - real,
   confirmed-live comparison against professional reference work showed
   this is a large part of what makes flat text read as "designed" vs.
   "static/lifeless" - a headline with NO depth at all looks pasted-on.
   NOT OPTIONAL: every beat's single largest/dominant text layer gets
   this - a real brutal side-by-side against reference footage showed
   video after video with zero drop shadow anywhere, and flat text
   next to the reference's consistently-shadowed text is exactly what
   reads as "lifeless" vs "designed." Skip it only on a small
   secondary/supporting label, never on the beat's main headline.
7. TRAVELING ACCENT (not just revealing IN PLACE): a small decorative
   shape (a short dash/line, a small ring/circle) that starts at ONE
   position, near but not touching the text, then ANIMATES ITS OWN
   "position" (not just opacity/scale) to travel a real, visible
   distance (40-100px) to a final resting spot relative to the text
   (e.g. becoming an underline swoosh beneath a headline, or landing
   just after the last character) - arriving a beat AFTER the main
   text has already settled, per the separately-timed-arrival rule.
   This reads as a genuinely composed, lively flourish; a decorative
   shape that only fades/scales in without ever traveling reads as
   scattered set-dressing instead. Real, confirmed-live reference
   comparison: exactly this technique (a small dash + ring drifting
   into a final underline-and-accent position beneath a title) is what
   separates a professional title card from a flatter one.
8. TIGHT COMPOSITION: cluster a beat's elements (headline, accents,
   icon) around ONE shared focal point/region with real breathing room
   around the whole group, rather than spreading them to fill the
   entire frame independently - a professional title card reads as one
   deliberate, compact composition, not several unrelated elements each
   claiming their own patch of the frame.
9. TWO-TIER TYPOGRAPHY LOCKUP for a title-card-style beat (a name, a
   topic reveal, a CTA card - anywhere ONE headline IS the beat, not a
   fact building alongside other copy): a SMALL label line directly
   above/below a MUCH LARGER, heavier headline word/phrase, with
   NEAR-ZERO vertical gap between them (the small line's own descender
   almost touching the big line's cap-height) so they read as ONE
   cohesive lockup, not two independent floating text layers. Real
   confirmed-live reference comparison: this tight two-size pairing
   (e.g. a 32-40px "Poppins Medium" label sitting right above a
   90-140px "Poppins Black" headline) is a large part of what makes a
   reference title card read as one deliberate unit instead of loose,
   randomly-spaced lines - achieve the tight gap with each layer's own
   "position" y-values close together (roughly the small line's own
   fontSize*1.1 apart, not the usual generous beat-wide spacing).

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
- Real motion graphics, not just text - reach for SHAPELAYERDEF/
  IMAGELAYERDEF often (see AE TECHNIQUE PATTERNS above): a staggered
  color-block reveal behind an early headline, an icon paired with a
  stat or label, a hand-drawn line accent near a callout, a ripple
  ring behind a number. A whole video that never uses a single shape
  or icon is under-using this engine's real range - aim for most beats
  having at least one non-text element, not as decoration bolted on
  but as a real part of the composition.
- NOTHING IS STATIC. Every single text layer needs a REAL entrance -
  either a per-character "animators" reveal, or a keyframed "opacity"/
  "scale"/"position"/"rotation" that actually moves it from an
  offset/hidden state to its landed one. A layer with none of these at
  all appears with an instant hard cut and never moves again - a real,
  confirmed-live failure found via direct JSON audit of a generated
  video, not a style guess. This is not just about the text reveal -
  EVERY element that has its own timing (the headline's entrance, a
  supporting label's entrance, a "color" accent switching on, a
  "highlights" chip drawing in) needs its OWN separately-timed
  animation, not all bundled into one simultaneous moment.
  IMPORTANT DISTINCTION, a real confirmed-live mistake: "landing
  roughly every 0.3-1s" below describes the STAGGER TIMING BETWEEN
  successive words/lines WITHIN a longer, multi-part beat - it is NOT
  a target for how short the WHOLE BEAT's own "duration" should be. A
  real generation read it that way for a short single-phrase beat and
  produced a 0.5s beat - barely enough time for its own entrance to
  finish settling, let alone be read, and it made the whole video feel
  like it was cutting too fast to follow. Every beat's own "duration"
  needs real room regardless of how few words it has - roughly 1.2-2.5s
  at minimum, even for a single short phrase, so its entrance can
  finish AND the words stay readable before the next beat replaces it.
  Build beats the way a real kinetic-typography edit is cut: short
  phrases building up word-by-word or line-by-line, each new piece of
  text landing roughly every 0.3-1s rather than one full sentence
  appearing and sitting there - and once text HAS landed, a color
  accent or highlight chip on it should still arrive its own beat later
  (a distinctly separate, later-timed animation), never baked in from
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
  return `You are a world-class motion graphics director - the kind of
person clients pay a premium for because every single frame is
intentional, well-paced, and alive, not just the text but the whole
composition around it. You are planning (NOT building yet) a
${targetDurationSeconds}-second short-form vertical video
(${COMP_WIDTH}x${COMP_HEIGHT}px, 9:16) for the request below.

Your real toolkit: professionally-animated TEXT, real vector SHAPES
(rectangles/circles/hand-drawn lines - built and animated the way a
real After Effects artist would, trim-path reveals, staggered color
blocks, hand-drawn doodle accents, ripple/pulse rings), and real ICONS/
brand logos. The video's shared backdrop gradient is still handled
entirely by the render engine (not something you plan or describe) -
but everything IN FRONT of it - shapes, icons, text - is yours to
direct. This is a real motion-graphics toolkit, not text-only anymore -
plan compositions that actually use it: a staggered color-block reveal
behind a headline, an icon paired with a stat, a hand-drawn accent line
near a callout, not text floating alone on a plain backdrop.

Write a concrete, opinionated, beat-by-beat treatment - not mood words,
actual decisions a senior director would hand an animator to build
frame-for-frame:

1. THE HOOK: the exact words on screen in the first half-second and
   why they earn attention immediately (specific, not "an engaging
   headline") - AND what's visually happening around it (a color-block
   reveal building in, an icon popping in alongside).
2. PALETTE & MOOD: 2-4 specific colors (precise enough to pick real hex
   values from) used consistently across TEXT, shape fills/strokes, and
   icon colors alike - one coherent palette for the whole video, not a
   text-only concern anymore. Real, confirmed-live reference comparison:
   professional reference work is far more RESTRAINED than this
   consistently lands on - typically ONE dominant color plus white/black
   text plus at most ONE accent color used sparingly (a single small
   highlight, never competing for attention), not 3+ different
   saturated hues all active in the same beat. Within any ONE beat,
   pick ONE accent color and reuse that SAME one for every accent in
   that beat (a highlight chip, a decorative shape, an icon) rather
   than a different color for each - a beat mixing red AND lime-green
   AND teal all at once reads as busier and less "branded" than
   confidently committing to one.
3. BEAT BY BEAT (beats are typically 2.5-4s each - see the real,
   confirmed-live pacing note right below before planning how MANY):
   keep this section
   clearly structured - start each beat with its own line reading
   "===BEAT n=== duration:X.Xs" (n starting at 0, X.X the beat's own
   length in seconds, all beats summing to approximately
   ${targetDurationSeconds}s) on its own line, with nothing else on
   that line. Everything between one "===BEAT n===" line and the next
   is that beat's own full description - this is YOUR OWN plan, which
   YOU will encode into the final "scenes" JSON array yourself in the
   next step, so a clear, well-separated breakdown here directly makes
   that easier to get right, every beat covering ALL of:
   REAL, CONFIRMED-LIVE PACING NOTE: prefer FEWER, more complete beats
   over many rapid-fire ones for a given ${targetDurationSeconds}s total -
   roughly ${Math.max(3, Math.round(targetDurationSeconds / 3))}-${Math.max(4, Math.round(targetDurationSeconds / 2.5))} beats total is the right range, not 8-10+. A
   real user complaint traced directly to this: too many short beats
   cutting rapidly between each other read as chaotic and low-quality,
   even when each individual beat was well-made - a viewer never gets
   time to actually register one idea before the next replaces it.
   Every beat also needs enough of its own duration to let its text
   ACTUALLY finish revealing (a real per-character reveal takes real
   time - roughly 35ms per character at minimum for it to read as a
   genuine typewriter effect, not an instant pop) AND still sit fully
   visible for a moment afterward so it can be read, not just glimpsed
   mid-animation. A short phrase still needs real seconds, not a
   fraction of one.
   - The exact text/words on screen (a headline, a stat, a short
     label) - be specific about the actual copy, not just its topic.
     Favor SHORT phrases landing one after another (roughly every 0.3-
     1s of screen time each) over one long sentence appearing all at
     once - the pacing of a fast, well-cut kinetic-typography edit, not
     a static caption card.
   - What SHAPES/ICONS are in this beat, if any - a specific real icon
     concept (not "an icon", name what it actually represents - a
     rocket, a lightbulb, a checkmark), where it sits relative to the
     text, and its own entrance (see AE TECHNIQUE PATTERNS in the next
     step's schema - scale pop-ins, ripple rings). Not every beat needs
     one, but a video with NONE anywhere is under-using the toolkit.
   - How the text reveals: a fast word-level pop-in (~0.15-0.35s, the
     default - see SELECTORS below), timing, any position/scale motion
     on the reveal - specific enough to actually author
   - Hierarchy when a beat has more than one element (which is the
     dominant headline vs. a smaller supporting label or icon, and
     roughly where each sits)
   - Where a color accent or highlight marker belongs, and WHEN it
     switches on relative to the text's own landing moment - it should
     always be its own later, separately-timed beat of motion, never
     simultaneous with (or baked into) the text reveal itself
   - How this beat's elements land and settle before the next beat -
     nothing in this beat should ever go fully motionless for more
     than a fraction of a second; something is always either still
     arriving, switching on, or settling
4. Fill the frame with intent every beat - real font size, shapes/icons
   where they earn their place, multiple elements (a headline plus a
   supporting stat/label/icon) - avoid one small line lost in a big
   empty frame. BUT cap it at roughly 4-5 total elements (text + shapes
   + icons combined) in any single beat - real, confirmed-live failure:
   beats crammed with 8-10 elements at once routinely came out with
   several of them visually overlapping, no matter how carefully
   they're positioned, simply because there isn't enough of a
   ${COMP_WIDTH}x${COMP_HEIGHT} frame to cleanly separate that many
   things at once. A clean beat with 3-4 well-placed elements always
   reads better than a busy one with 9 fighting for the same space -
   if you need more elements than that to land an idea, that idea
   deserves its own beat instead of being crammed into one.

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
FINAL CHECKLIST - re-read this right before you write, and again for
EVERY beat after the first (rules stated once at the top of a long
generation are the ones most likely to slip by the last beat):
=====================================================================
- "easing" is ALWAYS one of ${CUBIC_EASING_NAMES.join(', ')} - never
  easeOutQuad/easeOutBack/easeInOutSine/etc, on ANY property
  (position/opacity/scale/rotation alike), on EVERY beat, not just the
  first one you write.
- "fontFamily" is ALWAYS EXACTLY one of ${AVAILABLE_FONT_FAMILIES.map((f) => `"${f}"`).join(', ')}
  - never "Poppins Regular"/"Poppins SemiBold"/bare "Poppins"/any other
  real Poppins weight name that sounds plausible but isn't bundled.
- A shape content item's "type" is ALWAYS one of
  ${SHAPE_CONTENT_TYPES.map((s) => `"${s}"`).join(', ')} - shape KIND
  names ("rectangle"/"ellipse"/"customPath"/etc) belong one level
  deeper, inside "shape.kind", never as the content item's own "type".
- No two layers in the same beat ever share identical "text".
- Every keyframe object has both a real "time" (number) and "value" -
  never omit either.
- A text layer's "animators[].properties" (opacity/position/scale/
  rotation) are ALWAYS plain values ("position":[dx,dy], the rest plain
  numbers) - NEVER a {"keyframes":[...]} object there, even though that
  shape is legal for a layer's own top-level "position". Putting
  keyframes inside "animators.properties" silently breaks the reveal at
  render time - the text stays frozen wherever its base position put
  it, which is a real, confirmed, common failure when that base
  position was deliberately off-canvas for a fly-in effect.
- A text layer's "position" x is ALWAYS the box's own CENTER, never a
  left-margin value - for anything near "maxWidth" wide, keep it within
  roughly maxWidth/2 of ${Math.round(COMP_WIDTH / 2)} or it renders
  clipped off one edge of the canvas for the whole beat.
- MANDATORY, every single beat, no exceptions: at least one "text" layer
  with real, non-empty words. A beat with only shapes/icons and no text
  conveys nothing and is REJECTED outright - this is not a style
  preference, it is a hard requirement checked on every beat you write.
- MANDATORY, every "image" layer: a real "icon" (Iconify "prefix:name")
  or "src":"beatImage" - one of the two, always. An image layer with
  neither has nothing to draw and is REJECTED outright.
- MANDATORY: encode EVERY beat the treatment planned, none skipped,
  merged, or summarized away - if the treatment planned N beats, your
  "scenes" array has EXACTLY N entries. Stopping after fewer is the
  single most common mistake on long generations; count your own
  "scenes" entries against the treatment's own beat headers before you
  consider the response finished.

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

// Matches the treatment's own "===BEAT n===" header lines - used below
// to list (not to split/parse the treatment into pieces the way the
// removed per-beat architecture used to) how many beats it planned and
// what each one is, as a structural sanity check on the whole-scene
// encoding step. Captures the WHOLE line, not just the "===...==="
// delimiter itself - the duration that follows on the same line
// ("===BEAT 0=== duration:2.5s") is real, useful identifying context
// for the model to check itself against, not just the bare number.
const BEAT_HEADER_RE = /===\s*BEAT\s+\d+\s*===[^\n]*/gi;

// Real, confirmed-live gap: "too short" was the single most common
// failure by far across a live run's own retries (roughly half of all
// attempts) - the model routinely wrote a full, well-formed BEAT 4 or
// BEAT 5 in its own treatment, then simply stopped encoding after 1-3
// scenes anyway, with no truncation error (it wasn't hitting
// max_tokens - it was choosing to stop early). A single generic
// "encode every beat" line among many other checklist items, and a
// retry message reporting only a bare COUNT ("only 2 of 5 encoded"),
// both give the model nothing concrete to act on - it has to somehow
// infer WHICH beats it dropped with no list to check itself against.
// Extracts each beat's own header line (its exact duration too) so
// both the fresh-attempt prompt and every retry can spell out a real,
// checkable list - "here are the N beats by name, your scenes array
// must have exactly N entries in this order" - rather than a single
// buried instruction and a bare number.
function listTreatmentBeatHeaders(treatment) {
  const matches = treatment.match(BEAT_HEADER_RE) || [];
  return matches.map((header, i) => `${i}. ${header.replace(/=+/g, ' ').replace(/\s+/g, ' ').trim()}`);
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
// Raised 6 -> 16 after switching MODEL to mistral-small-latest: real,
// directly measured tradeoff - the smaller model's individual calls
// are dramatically faster (11-56s observed live, vs 100-240s on
// mistral-large-latest for the same schema) but it needs meaningfully
// MORE correction passes to converge on this schema's complexity - a
// live run burned through all 6 retries and still ended on genuinely
// broken structural output (missing scenes, wrong root shape), never
// once reaching valid JSON. Since each retry is now so much cheaper in
// wall-clock terms, affording more of them is the correct lever: 16
// retries at ~15-20s average lands around 240-320s, still comfortably
// inside GENERATION_HARD_TIMEOUT_MS - likely FASTER overall than the
// old 6-retry budget on the slower model, while giving real room to
// actually converge instead of exhausting attempts on a hard schema.
async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 16, priorErrors = null } = {}) {
  const systemPrompt = buildGenerationSystemPrompt(targetDurationSeconds);
  const beatHeaders = listTreatmentBeatHeaders(treatment);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every decision below must become real text layers/animators from the schema above, never simplified or dropped to something generic. The treatment may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead (a hard hit, a flash, a snap into place) rather than inventing a nonexistent field. Only use real fields from the schema above - never invent new ones.):\n${treatment}\n\nOriginal request: ${userPrompt}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;
  // Stated again here, concretely, as the LAST thing before generation
  // starts (not just once as a generic bullet buried in the system
  // prompt's own checklist) - "too short" (fewer scenes than the
  // treatment planned) was by far the single most common failure in
  // real live runs, often over half of all retries on one generation,
  // with no truncation error involved (the model wasn't hit by
  // max_tokens, it simply stopped early). A bare instruction to
  // "encode every beat" gives it nothing to actually check itself
  // against; a real, numbered list of the exact beats it must produce,
  // read right before it starts writing, is a mechanical thing it can
  // literally count off one at a time.
  if (beatHeaders.length > 0) {
    userMessage += `\n\nThe treatment above contains EXACTLY ${beatHeaders.length} beats:\n${beatHeaders.join('\n')}\n\nYour "scenes" array MUST contain EXACTLY ${beatHeaders.length} entries, one per beat above, in this same order - not fewer, not merged, not summarized. Before you finish, go down this list one at a time and confirm each has its own real entry in "scenes".`;
  }

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
  const expectedBeats = beatHeaders.length;
  const actualBeats = valid && Array.isArray(result.scenes) ? result.scenes.length : 0;
  const isTooShort = valid && expectedBeats > 0 && actualBeats < expectedBeats * 0.7;

  if (!valid || isTooShort) {
    // Lists the exact beats by name/duration again here, not just a
    // bare count - same reasoning as the fresh-attempt instruction
    // above (see its own doc comment), just re-stated as a concrete
    // retry instruction instead of a pre-emptive one.
    const completenessError = isTooShort
      ? [`scenes: the treatment planned ${expectedBeats} beat(s), but only ${actualBeats} scene(s) were encoded. The treatment's exact beats are:\n${beatHeaders.join('\n')}\n\nEVERY one of these must become its own entry in "scenes", in order, none skipped, merged, or summarized away. Output all ${expectedBeats}.`]
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
