const fetch = require('node-fetch');
const { buildMistralSystemPrompt, validateSceneJSON } = require('./sceneTemplates');

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
  // Mistral is instructed to return raw JSON, but strip code fences defensively.
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in Mistral response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Sends the user's prompt to Mistral, validates the returned scene JSON
 * against sceneTemplates.js, and retries once with a correction message
 * if validation fails.
 */
async function generateSceneJSON(userPrompt, { retriesLeft = 1 } = {}) {
  const systemPrompt = buildMistralSystemPrompt();

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pickKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content;
  if (!rawText) throw new Error('Mistral returned no content');

  let parsed;
  try {
    parsed = extractJson(rawText);
    return validateSceneJSON(parsed);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[mistralClient] validation failed (${err.message}), retrying...`);
      return generateSceneJSON(
        `${userPrompt}\n\n(Your previous response was invalid: ${err.message}. Return ONLY corrected JSON matching the schema exactly.)`,
        { retriesLeft: retriesLeft - 1 }
      );
    }
    throw err;
  }
}

module.exports = { generateSceneJSON };
