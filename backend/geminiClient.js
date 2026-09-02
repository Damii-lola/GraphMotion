const fetch = require('node-fetch');
const { jsonrepair } = require('jsonrepair');
const { validateSceneJSON } = require('./sceneSchema');
const {
  buildTreatmentSystemPrompt, buildGenerationSystemPrompt, buildEditSystemPrompt, listTreatmentBeatHeaders,
} = require('./scenePrompts');

/**
 * Gemini replacement for the old mistralClient.js - same resilience
 * architecture (multi-key round-robin queue with adaptive rate-limit
 * backoff, transient-network retry, jsonrepair fallback, hard timeout),
 * ported directly rather than redesigned, since that architecture was
 * built and confirmed live against real, repeated production failures
 * (see git history on the old file) and none of those underlying
 * failure modes (bursty concurrent calls, 429s, transient network
 * errors, truncated JSON) are specific to which model provider is
 * behind the API. Prompt engineering itself lives in scenePrompts.js,
 * shared verbatim - only the HTTP transport differs here.
 */

function loadKeys() {
  const fromCsv = (process.env.GEMINI_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const fromNumbered = [];
  for (let i = 1; i <= 20; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v && v.trim()) fromNumbered.push(v.trim());
  }
  return [...new Set([...fromCsv, ...fromNumbered])];
}
const KEYS = loadKeys();
// gemini-3.6-flash's free tier caps at a hard 20 requests/DAY (confirmed
// live: RESOURCE_EXHAUSTED, quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier,
// quotaValue 20) - not an ordinary rate limit backoff can work around,
// and would break the LIVE deployed app after ~20 real video generations
// each day. gemini-3.1-flash-lite has its own separate per-model quota
// bucket (confirmed live, still had headroom when 3.6-flash's was
// already exhausted) and - as a bonus - doesn't appear to spend part of
// its token budget on internal "thinking" tokens the way 3.6-flash does
// (no thoughtsTokenCount in its usageMetadata), so it's also cheaper per
// call.
//
// TRIED gemini-3.8-flash (2026-09-02), REVERTED same day: a real live
// test job failed outright at the JSON-parsing stage ("Expected
// double-quoted property name in JSON") - not the anticipated daily-
// quota wall (that would show RESOURCE_EXHAUSTED), a genuinely
// different and worse failure: 3.8-flash's raw output apparently
// doesn't follow this prompt's strict compact-JSON formatting rules
// reliably enough for even jsonrepair's fallback to recover, across
// every one of generateWholeSceneJSON's own retries, ending in a hard
// failure the user actually saw ("failed" status, not just a retry).
// flash-lite has never produced a hard parse failure like this in any
// real generation this project has run.
//
// TESTING gemini-2.5-pro (2026-09-02): direct user request to try an
// OLDER, more established Gemini tier rather than another bleeding-edge
// 3.x model - 3.8-flash's break was plausibly its own "thinking"
// behavior interfering with strict JSON output, a risk newer/flashier
// models carry more of, not less. 2.5-pro is Google's strongest
// reasoning-tier model, free-tier per Google's own docs (~50 requests/
// day, more than enough for this project's real generation volume), and
// has a long track record for structured output specifically.
//
// REVERTED same day: a real live job's own logs showed every single
// call 404ing outright - "This model models/gemini-2.5-pro is no
// longer available to new users" - a THIRD distinct failure mode from
// the other two Gemini attempts (not a quota wall, not a parse
// failure - the model is simply retired for any API key created after
// some cutoff). Every call falling back to Mistral also hammered
// Mistral with real, wasted 429-retry storms for the whole job, a real
// resource cost, not just a clean "try again" - reverted immediately
// rather than burn more real API calls guessing at yet another Gemini
// tier name blind. flash-lite remains the only Gemini model confirmed
// to actually work reliably in this project, full stop.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (KEYS.length === 0) {
  console.warn('[geminiClient] No GEMINI_API_KEYS/GEMINI_API_KEY_N configured');
} else {
  console.log(`[geminiClient] ${KEYS.length} Gemini API key(s) configured, model=${MODEL}`);
}

/**
 * Real, precisely diagnosed failure mode - previous versions of this
 * file's own prompt guidance guessed the repeated "Expected double-
 * quoted property name" failure was about unescaped quotes in
 * narration text. It wasn't (or at least, that's not what was actually
 * happening in the reproduced cases). Confirmed instead by dumping raw
 * failed JSON to disk and inspecting it directly: the model reliably
 * drops exactly ONE closing brace at scene boundaries. Each scene is
 * `{"params":{...},"visual":{"layers":[...]}}}` - that OUTER wrapper
 * needs its own closing "}" before the "," that starts the next scene,
 * and the model consistently stops one brace short there specifically,
 * not randomly elsewhere: `..."layers":[...]}]},{"params":...` (three
 * closes - last layer, layers array, visual object) where it should be
 * `..."layers":[...]}]}},{"params":...` (a fourth close for the scene
 * wrapper itself). Confirmed identical across every reproduced sample.
 * Cheap and safe to apply unconditionally before jsonrepair: the
 * literal sequence this targets doesn't occur in valid output from
 * this schema - the only OTHER place "params" appears is nested inside
 * a shape's "path" (e.g. `"shape":{"kind":"rectangle","params":...}`),
 * which is never preceded by three closing brackets, so this never
 * fires on a false positive. A no-op (via split/join) on any input
 * that doesn't contain the exact pattern.
 */
function fixMissingSceneCloseBrace(text) {
  return text.split('}]},{"params":').join('}]}},{"params":');
}

// Same jsonrepair-before-retry strategy as the old mistralClient.js: a
// local repair of near-valid JSON (missing comma, unterminated string)
// costs microseconds; a failed repair costs nothing beyond the attempt,
// since the original parse error still drives a retry either way.
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in Gemini response');
  const candidate = fixMissingSceneCloseBrace(cleaned.slice(start, end + 1));
  try {
    return JSON.parse(candidate);
  } catch (originalErr) {
    try {
      const repaired = jsonrepair(candidate);
      const result = JSON.parse(repaired);
      console.warn(`[geminiClient] JSON parse failed (${originalErr.message}) but jsonrepair recovered it locally - no retry needed`);
      return result;
    } catch (repairErr) {
      // Diagnostic only, and only on the expensive path (jsonrepair
      // ALSO failed, meaning a full retry is about to happen) - the
      // error message alone never showed what the model actually wrote,
      // making every past instance of this a guess rather than a
      // diagnosed fix. Logs a window of the raw text around the
      // reported failure position so the actual malformed content is
      // visible next time this fires, instead of just the position.
      const posMatch = originalErr.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = Number(posMatch[1]);
        const windowText = candidate.slice(Math.max(0, pos - 60), pos + 60);
        console.warn(`[geminiClient] JSON parse failure context (around position ${pos}): ...${windowText}...`);
        console.warn(`[geminiClient] JSON parse failure exact char at ${pos}: ${JSON.stringify(candidate[pos])}, chars ${pos - 3}-${pos + 3}: ${JSON.stringify(candidate.slice(pos - 3, pos + 3))}`);
      }
      if (process.env.DUMP_JSON_FAILURES) {
        require('fs').writeFileSync(`C:/Users/SIFON/AppData/Local/Temp/claude/C--Users-SIFON-Downloads-GraphMotion-main-GraphMotion-main/efb7c23c-4417-43ff-a5d1-00cc9d8f82de/scratchpad/failed-json-${Date.now()}.txt`, candidate);
      }
      throw originalErr;
    }
  }
}

// Real, directly measured finding: a production job's own logs showed
// a single Gemini call taking 200279ms (3min20s) before Gemini's OWN
// server finally responded - with a 503, i.e. that entire wait was for
// nothing. The old 240000ms (4min) timeout never got a chance to
// protect against this, since Gemini responded (with a failure) just
// under that ceiling. Checked every real request-time log line from
// this project's actual production traffic across many jobs: every
// LEGITIMATE successful call completed well under 28s; nothing has
// ever genuinely needed more than that to succeed. Cut to 45000ms
// (45s) - real margin over the slowest successful call ever observed,
// while turning a worst-case hung/overloaded request from a ~4min
// dead wait into a fast abort-and-retry-on-a-different-key instead.
// The retry loop below already handles a failed attempt correctly
// (confirmed live in the same log - the very next key's retry
// succeeded in under 4s) - the problem was never retry logic, only
// how long one doomed attempt was allowed to sit before failing.
const GEMINI_TIMEOUT_MS = 45000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Same per-key serialized-queue-with-adaptive-spacing design as the old
// mistralClient.js's queueMistralCall - see that file's git history for
// why (a single key was directly confirmed live to not tolerate bursty
// concurrent requests; a fixed worst-case spacing was directly confirmed
// to waste real wall-clock time on the common un-rate-limited case).
const MIN_CALL_INTERVAL_MS = 1200;
const MAX_CALL_INTERVAL_MS = 5000;
const RATE_LIMIT_DECAY_MS = 20000;

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
    state.currentCallIntervalMs = Math.max(MIN_CALL_INTERVAL_MS, Math.round(state.currentCallIntervalMs / 2));
    state.lastRateLimitHitAt = Date.now();
  }
  return state.currentCallIntervalMs;
}

function queueGeminiCall(makeFetch) {
  if (keyQueues.length === 0) throw new Error('No Gemini API keys configured (GEMINI_API_KEYS or GEMINI_API_KEY_1/_2/...)');
  const state = keyQueues[nextKeyIndex % keyQueues.length];
  nextKeyIndex++;
  const scheduled = state.callQueueTail
    .then(() => sleep(currentAdaptiveInterval(state)))
    .then(() => makeFetch(state.key, state));
  state.callQueueTail = scheduled.catch(() => {});
  return scheduled;
}

const MAX_RATE_LIMIT_RETRIES = 5;

/** Shared transport for both plain-text prompts and multimodal (e.g. audio) parts - callGeminiRaw and callGeminiWithAudio are thin wrappers that just build a different `parts` array around this. */
async function callGeminiParts(systemPrompt, parts, { jsonMode = true, maxTokens = 12000, temperature = 0.7 } = {}, rateLimitRetriesLeft = MAX_RATE_LIMIT_RETRIES) {
  let response;
  let usedKeyState;
  try {
    response = await queueGeminiCall((key, state) => {
      usedKeyState = state;
      const callStart = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
      return fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      }).finally(() => {
        clearTimeout(timeout);
        console.log(`[geminiClient] ${state.label}: request took ${Date.now() - callStart}ms`);
      });
    });
  } catch (err) {
    // Real bug found immediately after cutting GEMINI_TIMEOUT_MS from
    // 240000 to 45000: an AbortError (our OWN client-side timeout
    // firing) used to throw straight out, bypassing the retry path
    // below entirely - never wired in because aborts were rare enough
    // under the old 4-minute ceiling to not matter much. Shortening the
    // timeout to fail fast on purpose means aborts now happen far more
    // often (that was the whole point), but every single one was
    // killing the ENTIRE generation outright instead of retrying on a
    // different key - confirmed live, a real job failed hard on exactly
    // this within minutes of deploying the timeout change. An abort is
    // just as retryable as a transient network error or a 5xx - it
    // means THIS attempt didn't get a usable response in time, not that
    // every attempt won't.
    const isAbort = err.name === 'AbortError';
    const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
    const isTransientNetworkError = transientCodes.includes(err.code)
      || transientCodes.some((code) => String(err.message).includes(code));
    if ((isAbort || isTransientNetworkError) && rateLimitRetriesLeft > 0) {
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      const reason = isAbort ? `timed out after ${GEMINI_TIMEOUT_MS}ms` : `transient network error (${err.code})`;
      console.warn(`[geminiClient] ${reason}, waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callGeminiParts(systemPrompt, parts, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
    if (isAbort) throw new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms (retries exhausted)`);
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 429 && rateLimitRetriesLeft > 0) {
      recordRateLimitHit(usedKeyState);
      const retryAfterHeader = response.headers.get('retry-after');
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[geminiClient] rate limited (429), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callGeminiParts(systemPrompt, parts, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
    if (response.status >= 500 && response.status < 600 && rateLimitRetriesLeft > 0) {
      recordRateLimitHit(usedKeyState);
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[geminiClient] Gemini server error (${response.status}), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callGeminiParts(systemPrompt, parts, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 800)}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error(`Gemini returned no content (finishReason=${candidate?.finishReason}): ${JSON.stringify(data).slice(0, 500)}`);

  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error(`Gemini response was truncated (hit maxOutputTokens=${maxTokens}) before completing`);
  }

  return rawText;
}

async function callGeminiRaw(systemPrompt, userMessage, opts = {}) {
  return callGeminiParts(systemPrompt, [{ text: userMessage }], opts);
}

/** Sends inline audio (e.g. a synthesized narration clip) to Gemini alongside a text prompt (transcription request, QA judgment request, etc) - reuses the exact same key-rotation/retry/timeout machinery as text-only prompts, just with a different `parts` payload. */
async function callGeminiWithAudio(systemPrompt, audioBuffer, mimeType, promptText, opts = {}) {
  return callGeminiParts(systemPrompt, [
    { inline_data: { mime_type: mimeType, data: audioBuffer.toString('base64') } },
    { text: promptText },
  ], opts);
}

async function callGeminiForJSON(systemPrompt, userMessage, retriesLeft, onRetry) {
  const rawText = await callGeminiRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 28000 });
  try {
    return extractJson(rawText);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[geminiClient] JSON parse failed (${err.message}), retrying...`);
      return onRetry(err, retriesLeft - 1);
    }
    throw err;
  }
}

// Direct user request: "how is it that we run the same prompt many
// times and get EXTREMELY similar result... i want variation, do it
// like how u do it, if i rerun a chat on claude it WILL be different."
// Sampling temperature (already 0.85 below, already fairly high)
// wasn't enough on its own - confirmed by reasoning through WHY, not
// just cranking temperature further: for a topic with a small set of
// "obvious" facts (why cats knead blankets has maybe 3-4 commonly-known
// real explanations), a model asked the same question repeatedly tends
// to reach for the same most-associated answer regardless of sampling
// noise, the same way a person asked to "just pick a number" usually
// reaches for the same few numbers even when genuinely trying to be
// random. Randomly picking and INJECTING a concrete creative angle
// into the prompt itself (see buildTreatmentSystemPrompt's own
// handling of this) forces real structural variation - which facts to
// lead with, what tone, what structure - rather than leaving that
// entirely up to chance.
const CREATIVE_ANGLES = [
  'Lead with a surprising or counter-intuitive fact most people get wrong about this - open by correcting a common misconception, not with a neutral intro.',
  'Lead with a relatable "you have definitely experienced this" moment - open on the everyday scenario itself, second person, before explaining anything.',
  'Lead with a bold, opinionated claim stated flatly as fact - confident and a little provocative, not hedged.',
  'Structure this as a rapid-fire list or countdown - distinct, separately-numbered points building to a payoff, not one flowing explanation.',
  'Lead with a specific short scenario or mini-story (a particular moment, not a general statement) and use it as the throughline for the rest of the video.',
  'Lead with a direct question aimed straight at the viewer, second person, and treat the rest of the video as answering it conversationally.',
  'Lead with a surprising number or statistic as the hook, then build the explanation around why that number is true.',
  'Structure this as myth vs. reality - state the common assumption first, then dismantle it point by point.',
  'Frame this as letting the viewer in on an insider secret or something "they don\'t want you to know" - a behind-the-scenes reveal tone.',
  'Take a warm, personal, first-person-feeling tone throughout, like a friend explaining something they find genuinely delightful, not a neutral narrator.',
  'Lead with the single most surprising or weirdest fact available on this topic, saved-for-last normally - front-load it as the hook instead.',
  'Structure this around a clear before/after or problem/solution arc - what things looked like before, what changed, why it matters now.',
];

function pickRandomCreativeAngle() {
  return CREATIVE_ANGLES[Math.floor(Math.random() * CREATIVE_ANGLES.length)];
}

async function generateCreativeTreatment(userPrompt, targetDurationSeconds) {
  const creativeAngle = pickRandomCreativeAngle();
  console.log(`[geminiClient] creative angle for this generation: ${creativeAngle}`);
  const systemPrompt = buildTreatmentSystemPrompt(targetDurationSeconds, creativeAngle);
  return callGeminiRaw(systemPrompt, userPrompt, { jsonMode: false, maxTokens: 8000, temperature: 0.85 });
}

async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 16, priorErrors = null } = {}) {
  const systemPrompt = buildGenerationSystemPrompt(targetDurationSeconds);
  const beatHeaders = listTreatmentBeatHeaders(treatment);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every decision below must become real text layers/animators from the schema above, never simplified or dropped to something generic. The treatment may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead (a hard hit, a flash, a snap into place) rather than inventing a nonexistent field. Only use real fields from the schema above - never invent new ones.):\n${treatment}\n\nOriginal request: ${userPrompt}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;
  if (beatHeaders.length > 0) {
    userMessage += `\n\nThe treatment above contains EXACTLY ${beatHeaders.length} beats:\n${beatHeaders.join('\n')}\n\nYour "scenes" array MUST contain EXACTLY ${beatHeaders.length} entries, one per beat above, in this same order - not fewer, not merged, not summarized. Before you finish, go down this list one at a time and confirm each has its own real entry in "scenes".`;
  }

  const result = await callGeminiForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  const expectedBeats = beatHeaders.length;
  const actualBeats = valid && Array.isArray(result.scenes) ? result.scenes.length : 0;
  // Was a 70%-tolerant "close enough" threshold (ported from the old
  // Mistral pipeline), but live harvester testing against Gemini showed
  // this let a real, systemic 1-beat-short pattern through as
  // "acceptable" every single time (3/3 real attempts, all landing at
  // exactly 3-of-4 beats) - which then failed the harvester's own much
  // stricter structural gate (qualityScore.js's beatMismatchPenalty
  // treats ANY shortfall as a hard penalty) 100% of the time, wasting
  // the entire generation on an output that could never be stored.
  // Requiring an exact match here spends the ALREADY-budgeted retries
  // actually reaching the count the downstream gate demands, instead of
  // accepting "close" and letting it fail later for free.
  const isTooShort = valid && expectedBeats > 0 && actualBeats < expectedBeats;

  if (!valid || isTooShort) {
    const completenessError = isTooShort
      ? [`scenes: the treatment planned ${expectedBeats} beat(s), but only ${actualBeats} scene(s) were encoded. The treatment's exact beats are:\n${beatHeaders.join('\n')}\n\nEVERY one of these must become its own entry in "scenes", in order, none skipped, merged, or summarized away. Output all ${expectedBeats}.`]
      : [];
    const allErrors = [...errors, ...completenessError];
    if (retriesLeft > 0) {
      console.warn(`[geminiClient] generated scene JSON ${!valid ? 'failed validation' : 'was too short'} (${allErrors.length} error(s)), retrying: ${allErrors.slice(0, 3).join('; ')}`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors: allErrors });
    }
    throw new Error(`Gemini-generated scene JSON failed schema validation after retries: ${allErrors.join('; ')}`);
  }
  return result;
}

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[geminiClient] planning creative treatment...');
  const treatment = await generateCreativeTreatment(userPrompt, targetDurationSeconds);
  console.log('[geminiClient] encoding whole scene in one pass...');
  return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment);
}

async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 4, priorErrors = null } = {}) {
  const systemPrompt = buildEditSystemPrompt(targetDurationSeconds);
  let userMessage = `Current JSON:\n${JSON.stringify(previousSceneJSON)}\n\nInstruction: ${editInstruction}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`;

  const result = await callGeminiForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[geminiClient] edited scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Gemini-generated edited scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
}

// Same outer safety net as the old mistralClient.js - see its git
// history for the production incident that motivated it (a job stuck
// "processing" until the frontend's own 15-minute client-side give-up
// kicked in, with no bound on the generation phase itself). 8 minutes
// leaves room for a genuinely rich multi-beat generation with several
// retries while still failing fast and cleanly well before that
// threshold.
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
  // Exposed for narrationTagging.js's second-pass tag-annotation call -
  // a plain, low-level "ask Gemini a focused question" primitive
  // (key rotation/retry/timeout already handled inside it), reused
  // rather than re-implemented for a call that isn't generating scene
  // JSON at all.
  callGeminiRaw: withHardTimeout(callGeminiRaw, 'callGeminiRaw'),
  // Not used by the production pipeline itself (narration's own AI
  // audio judge was removed - see narrationPrefetch.js's own doc
  // comment for why), but kept and exported deliberately: same low-
  // level primitive split as callGeminiRaw, just for inline audio
  // instead of a text prompt, and genuinely useful on its own for
  // transcribing/verifying TTS output during debugging - reach for
  // this instead of guessing at an audio-quality fix blind.
  callGeminiWithAudio: withHardTimeout(callGeminiWithAudio, 'callGeminiWithAudio'),
  buildTreatmentSystemPrompt,
  buildGenerationSystemPrompt,
  listTreatmentBeatHeaders,
};
