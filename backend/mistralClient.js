const fetch = require('node-fetch');
const { buildMistralSystemPrompt, buildMistralEditSystemPrompt, validateSceneJSON } = require('./sceneTemplates');

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

/**
 * Shared by both the fresh-generation and edit paths - same API call
 * shape, same truncation detection, same validate+retry logic. Only
 * the system prompt and the retry-continuation callback differ
 * between the two, so those are the only things parameterized here
 * rather than duplicating this whole function twice.
 */
// Every OTHER external call in this codebase has an explicit timeout
// (imageGen.js's 20s AbortController, ttsGen.js's 15s + connection
// close) - this one didn't. node-fetch has no default timeout of its
// own, so a stalled connection to Mistral's API left this awaitable
// forever, with nothing anywhere upstream (server.js has no overall
// job timeout either) to ever catch it - a job could sit in
// "writing_scenes" indefinitely with no error, no retry, nothing.
const MISTRAL_TIMEOUT_MS = 45000;

async function callMistralForSceneJSON(systemPrompt, userMessage, targetDurationSeconds, retriesLeft, onRetry) {
  const estimatedScenes = Math.min(42, Math.max(4, Math.round(targetDurationSeconds / 3)));
  const maxTokens = Math.min(16000, 1200 + estimatedScenes * 220);

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
    throw new Error(
      `Mistral response was truncated (hit max_tokens=${maxTokens}) before completing the JSON - the requested video length may need a smaller scene count, or max_tokens needs raising further.`
    );
  }

  try {
    const parsed = extractJson(rawText);
    return validateSceneJSON(parsed);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] validation failed (${err.message}), retrying...`);
      return onRetry(err, retriesLeft - 1);
    }
    throw err;
  }
}

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12, { retriesLeft = 1 } = {}) {
  const systemPrompt = buildMistralSystemPrompt(targetDurationSeconds);
  return callMistralForSceneJSON(systemPrompt, userPrompt, targetDurationSeconds, retriesLeft, (err, nextRetriesLeft) =>
    generateSceneJSON(
      `${userPrompt}\n\n(Your previous response was invalid: ${err.message}. Return ONLY corrected JSON matching the schema exactly.)`,
      targetDurationSeconds,
      { retriesLeft: nextRetriesLeft }
    )
  );
}

/**
 * The edit path - previousSceneJSON is embedded directly into the
 * system prompt (see buildMistralEditSystemPrompt), so the user
 * message here is just the plain edit instruction itself ("make the
 * car blue"), not the whole video re-described from scratch.
 */
async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 1 } = {}) {
  const systemPrompt = buildMistralEditSystemPrompt(previousSceneJSON, targetDurationSeconds);
  return callMistralForSceneJSON(systemPrompt, editInstruction, targetDurationSeconds, retriesLeft, (err, nextRetriesLeft) =>
    generateEditedSceneJSON(
      previousSceneJSON,
      `${editInstruction}\n\n(Your previous response was invalid: ${err.message}. Return ONLY corrected JSON matching the schema exactly.)`,
      targetDurationSeconds,
      { retriesLeft: nextRetriesLeft }
    )
  );
}

module.exports = { generateSceneJSON, generateEditedSceneJSON };
