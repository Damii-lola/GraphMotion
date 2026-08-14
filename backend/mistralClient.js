const fetch = require('node-fetch');

/**
 * MECHANICAL SKELETON ONLY. buildMistralSystemPrompt/
 * buildMistralEditSystemPrompt/validateSceneJSON all lived in
 * sceneTemplates.js, deleted in a deliberate teardown of the entire
 * video-generation/design layer - see the plan this was executed from.
 * What's left here is exactly the "Mistral" piece that teardown was
 * scoped to keep: key rotation, the actual HTTP call with its timeout,
 * truncation detection, and JSON extraction from the response. There
 * is no real system prompt and no schema validation anymore - a
 * follow-up rebuild supplies both. generateSceneJSON/
 * generateEditedSceneJSON keep their exported names/signatures so
 * renderWorker.js needed no edits.
 */

const KEYS = (process.env.MISTRAL_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

const MODEL = process.env.MISTRAL_MODEL || 'mistral-large-latest';

if (KEYS.length === 0) {
  console.warn('[mistralClient] No MISTRAL_API_KEYS configured');
}

function pickKey() {
  return KEYS[Math.floor(Math.random() * KEYS.length)];
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in Mistral response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const MISTRAL_TIMEOUT_MS = 75000;

/**
 * Shared by both the fresh-generation and edit paths - same API call
 * shape, same truncation detection. Only the system/user prompt
 * differ between the two callers below.
 */
async function callMistralForJSON(systemPrompt, userMessage, retriesLeft, onRetry) {
  const maxTokens = 8000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pickKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Mistral request timed out after ${MISTRAL_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content;
  if (!rawText) throw new Error('Mistral returned no content');

  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error(`Mistral response was truncated (hit max_tokens=${maxTokens}) before completing the JSON`);
  }

  try {
    return extractJson(rawText);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] JSON parse failed (${err.message}), retrying...`);
      return onRetry(err, retriesLeft - 1);
    }
    throw err;
  }
}

// Placeholder - no real schema/template vocabulary exists anymore.
// A follow-up rebuild replaces this with a real system prompt.
const PLACEHOLDER_SYSTEM_PROMPT = 'Output ONLY valid JSON, no markdown, no prose, no code fences.';

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12, { retriesLeft = 1 } = {}) {
  return callMistralForJSON(PLACEHOLDER_SYSTEM_PROMPT, userPrompt, retriesLeft, (err, nextRetriesLeft) =>
    generateSceneJSON(userPrompt, targetDurationSeconds, { retriesLeft: nextRetriesLeft })
  );
}

async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 1 } = {}) {
  const userMessage = `Current JSON:\n${JSON.stringify(previousSceneJSON)}\n\nInstruction: ${editInstruction}`;
  return callMistralForJSON(PLACEHOLDER_SYSTEM_PROMPT, userMessage, retriesLeft, (err, nextRetriesLeft) =>
    generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: nextRetriesLeft })
  );
}

module.exports = { generateSceneJSON, generateEditedSceneJSON };
