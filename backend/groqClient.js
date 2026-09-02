const fetch = require('node-fetch');

/**
 * Text generation via Groq's OpenAI-compatible chat completions API -
 * used for sceneGenClient.js's SMALLER treatment-planning call only
 * (not the big JSON-encoding step - see openRouterClient.js for that).
 * Real, directly measured finding: this account's free tier caps at a
 * flat 8000 TPM (tokens per minute) - confirmed identical across every
 * model tried (openai/gpt-oss-120b, qwen/qwen3.6-27b both hit the exact
 * same ceiling), not a per-model variation the way older docs
 * described. The treatment prompt (~2185 tokens) plus a real,
 * generous output budget fits comfortably under that; the full scene-
 * JSON prompt (~16,923 tokens on its own) does not, no matter which
 * model - confirmed by direct testing, not assumed.
 *
 * Model: openai/gpt-oss-120b - the largest, most capable model
 * confirmed actually available on this account's real /v1/models list
 * (llama-3.3-70b-versatile, cited by earlier research, turned out to
 * be fully retired - a live model-list query is what caught this, not
 * documentation). Genuinely free, no credit card, independent LPU
 * hardware from Gemini's own infrastructure.
 */

const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_TIMEOUT_MS = 45000;

/**
 * Single call, no retry of its own - callLLMRaw (geminiClient.js) owns
 * the fallback-to-Gemini behavior on ANY failure here (missing key,
 * rate limit, timeout, truncated response), so retrying internally
 * would just delay reaching that fallback for no benefit.
 */
async function callGroqRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 8000, temperature = 0.7 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
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
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Groq request timed out after ${GROQ_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`Groq returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  if (choice.finish_reason === 'length') {
    throw new Error(`Groq response was truncated (hit max_tokens=${maxTokens}) before completing`);
  }
  return text;
}

module.exports = { callGroqRaw, GROQ_MODEL };
