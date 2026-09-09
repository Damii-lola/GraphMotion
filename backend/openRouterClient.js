const fetch = require('node-fetch');

/**
 * Text generation via OpenRouter's OpenAI-compatible chat completions
 * API - now the SOLE AI provider for this whole backend, direct user
 * instruction (2026-09-05): both Groq (organization-wide daily quota
 * stayed exhausted) and Gemini (its own real 503 outage, hit live in
 * production the same day) got removed entirely rather than layering
 * in a third fallback. Used by sceneGenClient.js for every real call it
 * makes (treatment planning, whole-scene JSON encoding, script judging,
 * edits) and by narrationTagging.js for its own per-beat tag pass.
 *
 * Originally brought in for JUST the big JSON-encoding step (the full
 * scene-JSON system prompt alone is ~16,923 tokens - more than double
 * Groq's flat 8000 TPM ceiling, confirmed by direct testing across
 * multiple models) - OpenRouter's free tier has no per-request token
 * cap at all, the limit is purely request COUNT (20/min, 50/day before
 * any $10 lifetime purchase, 1000/day after). That request-count
 * ceiling now matters more broadly than it used to: every call this
 * whole backend makes (scene generation AND narration tagging) draws
 * from the SAME shared daily budget, worth remembering if generations
 * start failing in a way that smells like a quota wall.
 *
 * Model: minimax/minimax-m3 - direct user decision (2026-09-10), a real
 * live-production outage forced the move: minimax/minimax-m2.7:free
 * (the earlier choice, see below for that own A/B testing writeup)
 * stopped being served on OpenRouter's free tier without warning -
 * every real generation on the live site failed immediately with
 * "OpenRouter API error 404: This model is unavailable for free," which
 * itself suggested minimax/minimax-m2.1 as a replacement slug. Checked
 * OpenRouter directly (not assumed): minimax-m2.1 has no free tier
 * either, and neither does minimax-m3 - this is a PAID model
 * (~$0.23-0.30/M input, $0.96-1.20/M output tokens depending on
 * provider), a real, explicit, informed cost tradeoff the user chose
 * over hunting for another free model, given free-tier MiniMax
 * availability had already proven unstable once.
 *
 * Original minimax-m2.7:free selection reasoning (2026-09-05), kept for
 * context - chosen after real, direct A/B testing across 4 candidates,
 * not from documentation:
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

const OPENROUTER_MODEL = 'minimax/minimax-m3';
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
        // Real, confirmed finding (2026-09-10) - DO NOT re-add a
        // "reasoning" param here for minimax-m3. The OLD model
        // (minimax-m2.7:free) genuinely required one: its endpoint had
        // MANDATORY reasoning (a request with reasoning:{effort:'none'}
        // got a hard 400, "Reasoning is mandatory for this endpoint and
        // cannot be disabled"), and reasoning:{max_tokens:3000} was the
        // real, working fix for that model (3/3 trials passed reliably).
        // minimax-m3 is the OPPOSITE: multiple real, billed production
        // tests (2026-09-10) with reasoning:{max_tokens:N} - even raised
        // as high as 22000 total / 6000 reasoning, even cut as low as
        // 2000 total - EVERY one came back finish_reason:"length" with
        // COMPLETELY EMPTY content, reasoning apparently consuming the
        // whole budget regardless of the cap's own size (so the cap
        // itself likely isn't honored for this model at all - OpenRouter's
        // own reasoning-tokens docs list Anthropic/Gemini/some Qwen
        // models as respecting reasoning.max_tokens, not MiniMax).
        // Isolated, direct test (bypassing this function, raw fetch)
        // proved it conclusively: the EXACT SAME prompt with NO
        // "reasoning" field at all succeeded immediately (finish_reason:
        // "stop", full real content, 2.1s) - so for m3, omitting the
        // param entirely is the fix, not tuning its value... except that
        // fix alone still failed live in production (2026-09-10, same
        // day) with the IDENTICAL symptom - the difference was the
        // "provider" field in the failed response: "Minimax" (the model
        // author's own direct hosting), not one of the ~11 other
        // companies OpenRouter's own pricing page lists as also hosting
        // this model (CoreWeave, GMICloud, DeepInfra, Together, etc.).
        // MiniMax's own infrastructure most likely enforces mandatory
        // reasoning at the API level regardless of what OpenRouter's
        // unified "reasoning" param does or doesn't send - the exact
        // same "mandatory, cannot disable" behavior the OLD model
        // (m2.7:free) had, just now specific to THIS ONE provider rather
        // than the model as a whole. Excluded via OpenRouter's own
        // provider-routing API (real, documented: provider.ignore) so
        // requests only ever land on a host that actually behaves.
        provider: { ignore: ['minimax'] },
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
