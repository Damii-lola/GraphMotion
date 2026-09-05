const fetch = require('node-fetch');

/**
 * Text generation via Groq's OpenAI-compatible chat completions API -
 * used for sceneGenClient.js's smaller treatment-planning call and
 * narrationTagging.js's small per-beat tagging calls (NOT the big
 * JSON-encoding step - that prompt, ~16,923 tokens on its own, is
 * bigger than a SINGLE key's own 8000 TPM ceiling regardless of how
 * many keys exist, since one request can only draw from one key's
 * budget - see mistralClient.js for that step instead).
 *
 * Multi-key round-robin, same proven design as geminiClient.js's
 * queueGeminiCall - added after a real production 429-storm: treatment
 * and tagging used to share ONE key's 8000 TPM budget, so tagging's 5
 * parallel calls firing right after treatment already spent that
 * minute's budget meant every one of them failed over to mechanical-
 * only pause tagging. A second key gives real, separate headroom -
 * each key gets its own adaptive-spacing queue, requests round-robin
 * across whichever keys are configured.
 *
 * Model: openai/gpt-oss-120b - the largest, most capable model
 * confirmed actually available on this account's real /v1/models list
 * (llama-3.3-70b-versatile, cited by earlier research, turned out to
 * be fully retired - a live model-list query is what caught this, not
 * documentation). Genuinely free, no credit card, independent LPU
 * hardware from Gemini's own infrastructure.
 */

function loadKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY.trim());
  for (let i = 2; i <= 10; i++) {
    const v = process.env[`GROQ_API_KEY_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  return [...new Set(keys)];
}
const KEYS = loadKeys();
if (KEYS.length === 0) {
  console.warn('[groqClient] No GROQ_API_KEY/GROQ_API_KEY_N configured');
} else {
  console.log(`[groqClient] ${KEYS.length} Groq API key(s) configured`);
}

const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_TIMEOUT_MS = 45000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Same adaptive-spacing design as geminiClient.js's queueGeminiCall and
// mistralClient.js's queueMistralCall - starts fast, escalates only on
// a real observed 429 (per-key, not shared), eases back after a clean
// window.
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

function queueGroqCall(makeFetch) {
  if (keyQueues.length === 0) throw new Error('No Groq API keys configured (GROQ_API_KEY/GROQ_API_KEY_N)');
  const state = keyQueues[nextKeyIndex % keyQueues.length];
  nextKeyIndex++;
  const scheduled = state.callQueueTail
    .then(() => sleep(currentAdaptiveInterval(state)))
    .then(() => makeFetch(state.key, state));
  state.callQueueTail = scheduled.catch(() => {});
  return scheduled;
}

// Raised 4 -> 6, direct user instruction (2026-09-05): "I DONT WANT IT
// TO EVER FALL BACK TO GEMINI, I WANT GROK" - sceneGenClient.js's beat
// generation no longer falls back to Gemini at all (see
// callBeatJSONTransport there), so a 429 has to be outlasted on Groq
// alone. Real, measured reality this retry budget has to survive: with
// only 2 keys, one key's own 8000 TPM/minute is checked against
// CUMULATIVE usage that minute, not just this one call - a single
// treatment-planning call alone can burn ~5100 of that (confirmed live,
// gpt-tokenizer-measured), leaving a beat call landing on that same key
// no room until the rolling window actually clears. 6 retries with this
// function's own exponential backoff (capped at 20s/attempt) sums to
// enough real wall-clock time to span past a minute boundary even in
// the worst case, so persistence alone - not a second provider - gets
// there.
const MAX_RATE_LIMIT_RETRIES = 6;

/**
 * Retries on 429/5xx with exponential backoff, rotating to the next
 * key in the round-robin on each retry (the queue's own key selection
 * already advances nextKeyIndex per call, so a recursive retry
 * naturally lands on a different key without extra logic here).
 */
async function callGroqRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 8000, temperature = 0.7 } = {}, retriesLeft = MAX_RATE_LIMIT_RETRIES) {
  let res;
  let usedState;
  try {
    res = await queueGroqCall((key, state) => {
      usedState = state;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
      return fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature,
          max_tokens: maxTokens,
          // Groq's JSON Object Mode - guarantees syntactically valid JSON
          // (not full JSON-Schema constrained decoding, which would need
          // this project's whole scene schema translated into Groq's
          // schema format - a bigger follow-up, not done here). Still a
          // real improvement over Gemini's own jsonMode: this project has
          // repeatedly hit malformed-JSON failures (missing braces, stray
          // backticks) that Object Mode's syntax guarantee rules out
          // entirely, even without guaranteeing schema conformance too.
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      }).finally(() => clearTimeout(timeout));
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Groq request timed out after ${GROQ_TIMEOUT_MS}ms`);
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (isRetryable && retriesLeft > 0) {
      if (res.status === 429 && usedState) recordRateLimitHit(usedState);
      const attempt = MAX_RATE_LIMIT_RETRIES - retriesLeft;
      const backoffMs = Math.min(2000 * 2 ** attempt, 20000) + Math.random() * 1000;
      console.warn(`[groqClient] Groq API error ${res.status}, waiting ${Math.round(backoffMs)}ms before retry (${retriesLeft} left)`);
      await sleep(backoffMs);
      return callGroqRaw(systemPrompt, userMessage, { jsonMode, maxTokens, temperature }, retriesLeft - 1);
    }
    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  // Real, confirmed-live bug found via production logs (2026-09-05):
  // openai/gpt-oss-120b is a reasoning model - on a short, low-effort
  // prompt (the script judge's terse VERDICT/REASON format is the
  // observed case) it sometimes puts its ENTIRE answer in the OpenAI-
  // reasoning-model-style "message.reasoning" field and leaves
  // "message.content" empty, rather than the reverse. The old
  // content-only read treated that as "no content" and threw, which
  // silently broke the whole script-judge feature (judgeNarrationScript
  // fails open on any error, so this never crashed a job - it just
  // meant the judge always passed by default without ever actually
  // reading the model's real verdict). Falling back to "reasoning" when
  // "content" is empty recovers the real answer either way, without
  // guessing WHICH field a given response will use.
  const text = choice?.message?.content || choice?.message?.reasoning;
  if (!text) throw new Error(`Groq returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  if (choice.finish_reason === 'length') {
    throw new Error(`Groq response was truncated (hit max_tokens=${maxTokens}) before completing`);
  }
  return text;
}

module.exports = { callGroqRaw, GROQ_MODEL };
