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
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (KEYS.length === 0) {
  console.warn('[geminiClient] No GEMINI_API_KEYS/GEMINI_API_KEY_N configured');
} else {
  console.log(`[geminiClient] ${KEYS.length} Gemini API key(s) configured, model=${MODEL}`);
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
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (originalErr) {
    try {
      const repaired = jsonrepair(candidate);
      const result = JSON.parse(repaired);
      console.warn(`[geminiClient] JSON parse failed (${originalErr.message}) but jsonrepair recovered it locally - no retry needed`);
      return result;
    } catch (repairErr) {
      throw originalErr;
    }
  }
}

const GEMINI_TIMEOUT_MS = 240000;
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

async function callGeminiRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 12000, temperature = 0.7 } = {}, rateLimitRetriesLeft = MAX_RATE_LIMIT_RETRIES) {
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
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
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
    if (err.name === 'AbortError') throw new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms`);
    const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
    const isTransientNetworkError = transientCodes.includes(err.code)
      || transientCodes.some((code) => String(err.message).includes(code));
    if (isTransientNetworkError && rateLimitRetriesLeft > 0) {
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[geminiClient] transient network error (${err.code}), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callGeminiRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
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
      return callGeminiRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
    }
    if (response.status >= 500 && response.status < 600 && rateLimitRetriesLeft > 0) {
      recordRateLimitHit(usedKeyState);
      const attempt = MAX_RATE_LIMIT_RETRIES - rateLimitRetriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(`[geminiClient] Gemini server error (${response.status}), waiting ${Math.round(backoffMs)}ms before retry (${rateLimitRetriesLeft} left)`);
      await sleep(backoffMs);
      return callGeminiRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature }, rateLimitRetriesLeft - 1);
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

async function generateCreativeTreatment(userPrompt, targetDurationSeconds) {
  const systemPrompt = buildTreatmentSystemPrompt(targetDurationSeconds);
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
  buildTreatmentSystemPrompt,
  buildGenerationSystemPrompt,
  listTreatmentBeatHeaders,
};
