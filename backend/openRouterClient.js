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
 * Model: nvidia/nemotron-3.5-lightning:free - direct user decision
 * (2026-09-10), after minimax/minimax-m3 (see git history on this file
 * for that whole saga: a live outage when m2.7:free got discontinued,
 * then a real "reasoning silently eats the entire token budget" bug
 * that took two wrong fixes and provider-exclusion to work around) - at
 * that point the user stepped back from "which MiniMax model" entirely
 * and re-scoped the ACTUAL task instead: the AI's real job here is
 * lightweight (pick which of 7 known templates fit a beat, fill in a
 * handful of short fields per beat), not the kind of task that needs a
 * heavy paid reasoning model. Nemotron 3.5 Lightning fits that
 * directly: free, and (unlike the other free Nemotron variants already
 * tried and rejected below) explicitly small - 3B ACTIVE parameters
 * (vs 12-55B for Nemotron 3 Super/Ultra) - built for "high-throughput
 * agentic workloads," i.e. fast turnaround on a simple task rather than
 * deep reasoning on a hard one.
 *
 * Earlier free-model rejections, kept for context - don't re-try these
 * without a real reason, they were each ruled out for a concrete,
 * measured problem, not a guess:
 *   - google/gemma-4-26b-a4b-it:free: served through GOOGLE'S OWN "AI
 *     Studio" infrastructure as the backing provider (confirmed via the
 *     error response's provider_name field), defeating the entire point
 *     of moving off Gemini, on top of being rate-limited when tried.
 *   - nvidia/nemotron-3-super-120b-a12b:free: worked, but consistently
 *     ~255s for the OLD, much bigger encode-a-full-scene task - a
 *     different, heavier model than Lightning, and a different
 *     (heavier) task than what this file does now.
 *   - nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free: similarly
 *     slow (~240s) AND unreliable on that same old task - one attempt
 *     returned only 112 characters, another returned a real structural
 *     bug (all 5 beats crammed into ONE object via duplicate "params"/
 *     "visual" keys, JSON.parse silently discarding 4 of 5 beats).
 */

const OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning:free';
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
        // No "reasoning" param sent - direct user instruction to try
        // Nemotron 3.5 Lightning "with the prompt as-is" first, before
        // touching anything else. See this file's own top doc comment
        // and git history for the real, hard-won "reasoning silently
        // eats the whole token budget" lesson from the two MiniMax
        // models this file used before - worth checking for the SAME
        // symptom (finish_reason:"length", empty content) here too if
        // this model ever needs a reasoning param added later.
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
