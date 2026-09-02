const fetch = require('node-fetch');

/**
 * Text generation via Mistral's OpenAI-compatible chat completions API -
 * candidate replacement for OpenRouter/MiniMax as sceneGenClient.js's
 * BIG JSON-encoding transport, after MiniMax proved unreliable on REAL
 * production content: its mandatory reasoning (capped, not disabled -
 * see openRouterClient.js's own doc comment) still left real generation
 * taking 4+ minutes per attempt on the actual ~17,000-token production
 * prompt (not the short simplified prompt earlier testing mistakenly
 * used), and a real job hit the 8-minute hard timeout and failed
 * outright as a direct result.
 *
 * Mistral's free tier reportedly offers 500,000 TPM (tokens/minute) -
 * dramatically larger than Groq's flat 8000 TPM ceiling, and unlike
 * OpenRouter's free models, no confirmed mandatory-reasoning tax on the
 * token budget. This project's own git history shows Mistral was the
 * PREVIOUS production engine before Gemini replaced it, for reasons
 * this file's author no longer has full context on - worth testing
 * for real, not assuming either way.
 *
 * Model: mistral-small-latest - NOT mistral-large-latest, despite that
 * being the more capable model: confirmed directly (403 "This model is
 * not available in your subscription tier") that large is simply
 * unreachable on this account's free tier - not a rate limit or
 * transient issue, a hard access wall. small-latest is fast (3.5-24s
 * on the real ~18K-token production prompt, well under Groq/OpenRouter)
 * but real 3-trial testing found it only fully encodes ALL beats in
 * the treatment about 1 time in 3 - the other 2 produced schema-VALID
 * JSON that silently dropped 4 of 5 beats. sceneGenClient.js's own
 * generateWholeSceneJSON already has a real, working retry-on-
 * incomplete-beat-count loop for exactly this - relying on that rather
 * than assuming one-shot completeness, since each individual attempt
 * is fast enough that 2-3 retries still lands well under what
 * OpenRouter needed for ONE attempt.
 */

const MISTRAL_MODEL = 'mistral-small-latest';
const MISTRAL_TIMEOUT_MS = 150000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Real, confirmed-live finding: sceneGenClient.js's own validation-
// retry loop (generateWholeSceneJSON) recurses IMMEDIATELY with no
// delay between attempts - fine for a validation failure (a genuinely
// new attempt), but with mistral-small-latest commonly needing 2-3
// such attempts to fully encode every beat (see this file's own
// top-of-file doc comment), several rapid-fire calls in quick
// succession triggered a real 429 from Mistral mid-test. A transport-
// level retry-with-backoff for 429/5xx specifically (this project's
// own established pattern - see geminiClient.js's queueGeminiCall/
// backoff logic) is what's missing here, not a fix to the validation
// loop itself, which is doing exactly its job.
const MAX_RATE_LIMIT_RETRIES = 4;

/**
 * Retries on 429 (rate limit) and 5xx (transient server error) with
 * exponential backoff - sceneGenClient.js's own validation-retry loop
 * still owns retrying on a VALID-but-wrong response (missing beats,
 * schema errors); this only covers the transport failing to get a
 * usable response back at all.
 */
async function callMistralRaw(systemPrompt, userMessage, { jsonMode = true, maxTokens = 8000, temperature = 0.7, model = MISTRAL_MODEL } = {}, retriesLeft = MAX_RATE_LIMIT_RETRIES) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Mistral request timed out after ${MISTRAL_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (isRetryable && retriesLeft > 0) {
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
