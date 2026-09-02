const fetch = require('node-fetch');

/**
 * Text generation via Mistral's OpenAI-compatible chat completions API -
 * sceneGenClient.js's JSON-encoding transport, also used by
 * narrationTagging.js's small per-beat tagging calls.
 *
 * Real, important history found in this project's OWN git log (checked
 * only AFTER a real production 429-storm today, which is exactly
 * backwards - should have been checked first): Mistral was this
 * project's production engine before Gemini replaced it, and this
 * exact class of problem (concurrent/rapid calls triggering 429s that
 * cascade into an entire generation failing) was already hit and
 * already fixed once, with a proactive adaptive-spacing queue (commit
 * bedf9bf) later tuned further (commit 8b077d5) after a fixed
 * conservative spacing was found to compound into 15+ minute stuck
 * generations on its own. Rebuilding this file from scratch today
 * skipped all of that - this restores the same proven pattern
 * (matching geminiClient.js's own queueGeminiCall, which explicitly
 * credits this file's original design), rather than inventing a new
 * one. mistral-small-latest (not large - see MISTRAL_MODEL below) was
 * also this project's own prior conclusion, independently reached
 * again today.
 */

const MISTRAL_MODEL = 'mistral-small-latest';
const MISTRAL_TIMEOUT_MS = 150000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Same proactive adaptive-spacing queue as geminiClient.js's
// queueGeminiCall (which itself is explicitly modeled on this file's
// own earlier version - see the top-of-file doc comment). Starts fast
// (close to no artificial delay), only escalates when a REAL 429 is
// observed - at which point every other in-flight/queued caller slows
// down too, not just the one that got limited - and eases back toward
// the fast floor once RATE_LIMIT_DECAY_MS has passed without another
// 429, so a transient window doesn't permanently tax the rest of a
// generation. This is what actually prevents the burst in the first
// place; MAX_RATE_LIMIT_RETRIES below is only the reactive safety net
// for whatever gets through anyway.
const MIN_CALL_INTERVAL_MS = 1200;
const MAX_CALL_INTERVAL_MS = 5000;
const RATE_LIMIT_DECAY_MS = 20000;

const queueState = { callQueueTail: Promise.resolve(), currentCallIntervalMs: MIN_CALL_INTERVAL_MS, lastRateLimitHitAt: 0 };

function recordRateLimitHit() {
  queueState.currentCallIntervalMs = MAX_CALL_INTERVAL_MS;
  queueState.lastRateLimitHitAt = Date.now();
}

function currentAdaptiveInterval() {
  if (queueState.currentCallIntervalMs <= MIN_CALL_INTERVAL_MS) return MIN_CALL_INTERVAL_MS;
  const sinceLastHit = Date.now() - queueState.lastRateLimitHitAt;
  if (sinceLastHit > RATE_LIMIT_DECAY_MS) {
    queueState.currentCallIntervalMs = Math.max(MIN_CALL_INTERVAL_MS, Math.round(queueState.currentCallIntervalMs / 2));
    queueState.lastRateLimitHitAt = Date.now();
  }
  return queueState.currentCallIntervalMs;
}

function queueMistralCall(makeFetch) {
  const scheduled = queueState.callQueueTail
    .then(() => sleep(currentAdaptiveInterval()))
    .then(() => makeFetch());
  queueState.callQueueTail = scheduled.catch(() => {});
  return scheduled;
}

const MAX_RATE_LIMIT_RETRIES = 4;

/**
 * Retries on 429 (rate limit) and 5xx (transient server error) with
 * exponential backoff - the reactive safety net for whatever gets past
 * the proactive queue above. sceneGenClient.js's own validation-retry
 * loop still separately owns retrying on a VALID-but-wrong response
 * (missing beats, schema errors); this only covers the transport
 * failing to get a usable response back at all.
 */
async function callMistralRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 8000, temperature = 0.7, model = MISTRAL_MODEL } = {}, retriesLeft = MAX_RATE_LIMIT_RETRIES) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not set');

  let res;
  try {
    res = await queueMistralCall(() => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);
      return fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      }).finally(() => clearTimeout(timeout));
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Mistral request timed out after ${MISTRAL_TIMEOUT_MS}ms`);
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (isRetryable && retriesLeft > 0) {
      if (res.status === 429) recordRateLimitHit();
      const attempt = MAX_RATE_LIMIT_RETRIES - retriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 20000) + Math.random() * 1000;
      console.warn(`[mistralClient] Mistral API error ${res.status}, waiting ${Math.round(backoffMs)}ms before retry (${retriesLeft} left)`);
      await sleep(backoffMs);
      return callMistralRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature, model }, retriesLeft - 1);
    }
    throw new Error(`Mistral API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`Mistral returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  if (choice.finish_reason === 'length') {
    throw new Error(`Mistral response was truncated (hit max_tokens=${maxTokens}) before completing`);
  }
  return text;
}

module.exports = { callMistralRaw, MISTRAL_MODEL };
