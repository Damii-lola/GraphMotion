const fetch = require('node-fetch');

/**
 * Text generation via Cloudflare Workers AI's REST API - direct user
 * decision (2026-09-10) after OpenRouter's MiniMax M3 couldn't be made
 * reliably fast (see openRouterClient.js's own git history for that
 * whole saga) and a real re-scoping of the task itself: the AI's real
 * job is now lightweight (pick which of 7 known templates fit a beat,
 * fill in a handful of short real fields), not full raw-JSON encoding
 * against a giant schema prompt. Verified directly, not assumed: a real
 * test call against this exact API, with response_format:json_object,
 * returned a single valid JSON object (7 correctly-picked distinct
 * templates, no repeats) in 3.4s - dramatically faster than anything
 * else tried this session (OpenRouter attempts ranged 21s-220s+, most
 * ending in failure).
 *
 * Genuinely free (not a trial): 10,000 Neurons/day, resets daily at
 * 00:00 UTC, no credit card required. A lightweight call like this
 * one costs on the order of tens of Neurons, comfortably supporting
 * 100+ real generations/day within the free allocation alone.
 *
 * Model: @cf/meta/llama-3.1-8b-instruct-fp8-fast - Cloudflare's own
 * speed-optimized (fp8-quantized) 8B Llama variant. Confirmed directly:
 * WITHOUT response_format:json_object, this model's own JSON discipline
 * was weak (a real test returned several separate {"beats":[...]}
 * fragments concatenated together instead of one valid object) - WITH
 * it, the same prompt produced one clean, correctly-structured object
 * every time tried. response_format is not optional for this model.
 */

const CLOUDFLARE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
// Real measured speed (3.4-6s per call) leaves enormous margin below
// this - kept generous only as a genuine safety net against a rare
// slow/hung request, not because normal calls come anywhere close.
const CLOUDFLARE_TIMEOUT_MS = 30000;

/**
 * Single call, no retry of its own - sceneGenClient.js's own
 * validation-retry loop already retries on failure with corrective
 * feedback, matching the same convention callOpenRouterRaw uses.
 */
async function callCloudflareRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 1500, temperature = 0.7 } = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUDFLARE_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_MODEL}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature,
        max_tokens: maxTokens,
        // Real, confirmed-live finding: NOT optional for this model -
        // see this file's own top doc comment for the direct before/
        // after test that found this.
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Cloudflare Workers AI request timed out after ${CLOUDFLARE_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Cloudflare Workers AI error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  // Real shape, confirmed directly: {success, result: {choices:[{message:{content}, finish_reason}]}}
  // - an OpenAI-compatible chat-completion envelope nested one level
  // deeper under "result" than OpenRouter/Groq's own top-level shape.
  if (data.success === false) {
    throw new Error(`Cloudflare Workers AI returned an error: ${JSON.stringify(data.errors || data).slice(0, 500)}`);
  }
  const choice = data.result?.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`Cloudflare Workers AI returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  if (choice.finish_reason === 'length') {
    throw new Error(`Cloudflare Workers AI response was truncated (hit max_tokens=${maxTokens}) before completing`);
  }
  return text;
}

module.exports = { callCloudflareRaw, CLOUDFLARE_MODEL };
