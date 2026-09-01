const fetch = require('node-fetch');

/**
 * Text generation via Groq's OpenAI-compatible chat completions API -
 * promoted to primary scene-generation engine (geminiClient.js's
 * callLLMRaw tries this first) after a real production incident: a
 * single generation hit three consecutive 45s timeouts across all
 * three configured Gemini keys, then three more 503s, before finally
 * succeeding - Google's own infrastructure having a bad stretch, not
 * anything in this codebase. Groq runs on dedicated LPU hardware (not
 * shared GPUs) and is genuinely free with no credit card required.
 *
 * Model: llama-3.3-70b-versatile - picked over Groq's other free-tier
 * options specifically for its 12,000 TPM ceiling (double the 6,000
 * TPM default most Groq models get), the highest among models actually
 * capable of this task's complexity (Gemma 2 9B has a higher raw TPM
 * ceiling but is far too small a model for reliably generating this
 * project's nested scene JSON - keyframes, animators, layer stacks).
 */

const GROQ_MODEL = 'llama-3.3-70b-versatile';
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
