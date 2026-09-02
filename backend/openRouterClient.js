const fetch = require('node-fetch');

/**
 * Text generation via OpenRouter's OpenAI-compatible chat completions
 * API - used for sceneGenClient.js's BIG JSON-encoding call, the one
 * step that structurally could not fit Groq's free tier (the full
 * scene-JSON system prompt alone is ~16,923 tokens - more than double
 * Groq's flat 8000 TPM ceiling, confirmed by direct testing across
 * multiple models). OpenRouter's free tier has no per-request token
 * cap at all - the limit is purely request COUNT (20/min, 50/day
 * before any $10 lifetime purchase, 1000/day after) - which is exactly
 * the shape this call needs: one large request, not many small ones.
 *
 * Model: minimax/minimax-m2.7:free - chosen after real, direct A/B
 * testing across 4 candidates, not from documentation:
 *   - google/gemma-4-26b-a4b-it:free: ruled out immediately - actually
 *     served through GOOGLE'S OWN "AI Studio" infrastructure as the
 *     backing provider (confirmed via the error response's
 *     provider_name field), defeating the entire purpose of moving off
 *     Gemini, on top of being rate-limited when tried.
 *   - nvidia/nemotron-3-super-120b-a12b:free: worked, but consistently
 *     ~255s for the full pipeline - too slow.
 *   - nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free: similarly
 *     slow (~240s) AND unreliable - one real attempt returned only 112
 *     characters, another returned a full-length response with a real
 *     structural bug (all 5 beats crammed into ONE object via duplicate
 *     "params"/"visual" keys instead of 5 separate array entries -
 *     JSON.parse silently keeps only the last pair, discarding 4 of 5
 *     beats without ever throwing a parse error).
 *   - minimax/minimax-m2.7:free: real measured spread across 3 back-
 *     to-back identical calls: 24.9s / 29.9s / 84.8s - genuinely
 *     variable, not a fixed fast number, and comparable to (not
 *     clearly faster than) Gemini's own ~18-28s NORMAL-condition speed
 *     from this session's own logs. Kept anyway per direct user
 *     decision: the point isn't raw speed, it's using a genuinely
 *     independent provider so a Gemini-style multi-key outage (three
 *     keys, three consecutive 45s timeouts, then three more 503s, all
 *     in one window) doesn't stall this step too.
 */

const OPENROUTER_MODEL = 'minimax/minimax-m2.7:free';
// 150s, not 90s - real measured headroom: the slowest observed single
// call so far was 84.8s, and 90s left almost no margin above that
// before falsely aborting a call that was actually still working.
const OPENROUTER_TIMEOUT_MS = 150000;

/**
 * Single call, no retry of its own - sceneGenClient.js's own
 * validation-retry loop (generateWholeSceneJSON) already retries on
 * failure with corrective feedback, so an inner retry here would just
 * duplicate that at the cost of burning OpenRouter's limited daily
 * request budget faster for no benefit.
 */
async function callOpenRouterRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 8000, temperature = 0.7 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`OpenRouter returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  if (choice.finish_reason === 'length') {
    throw new Error(`OpenRouter response was truncated (hit max_tokens=${maxTokens}) before completing`);
  }
  return text;
}

module.exports = { callOpenRouterRaw, OPENROUTER_MODEL };
