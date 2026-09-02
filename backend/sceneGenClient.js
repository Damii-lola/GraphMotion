const { jsonrepair } = require('jsonrepair');
const { validateSceneJSON } = require('./sceneSchema');
const {
  buildTreatmentSystemPrompt, buildGenerationSystemPrompt, buildEditSystemPrompt, listTreatmentBeatHeaders,
} = require('./scenePrompts');
const { callGroqRaw } = require('./groqClient');
const { callOpenRouterRaw } = require('./openRouterClient');

/**
 * Scene generation, entirely Gemini-free - removed per direct user
 * request, after a real incident where all three configured Gemini
 * keys hit repeated timeouts/503s in the same window (Google's own
 * infrastructure having a bad stretch). Split across two independent
 * free providers, matched to each call's real size: Groq for the
 * smaller treatment-planning call (~2185-token prompt, fits Groq's
 * flat 8000 TPM ceiling), OpenRouter for the big JSON-encoding call
 * (~16,923-token prompt - more than double Groq's ceiling, but
 * OpenRouter's free tier caps on request COUNT, not tokens, so a
 * single large request is fine). See groqClient.js and
 * openRouterClient.js for the full reasoning behind each.
 *
 * This file is a fork of what used to live in geminiClient.js - the
 * provider-agnostic orchestration (JSON extraction/repair, schema-
 * validation retry loop, beat-count checking, creative-angle variation,
 * the hard timeout) is unchanged, just pointed at these two transports
 * instead of Gemini's. geminiClient.js itself is left fully intact,
 * still usable (with its own separate API key) for audio-understanding
 * diagnostics - it's just no longer part of the live generation path.
 */

// Real, precisely diagnosed failure mode carried over unchanged from
// geminiClient.js - see that file's own doc comment for the full
// reasoning. Not Gemini-specific: any model generating this schema can
// drop the same closing brace at scene boundaries.
function fixMissingSceneCloseBrace(text) {
  return text.split('}]},{"params":').join('}]}},{"params":');
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in the model response');
  const candidate = fixMissingSceneCloseBrace(cleaned.slice(start, end + 1));
  try {
    return JSON.parse(candidate);
  } catch (originalErr) {
    try {
      const repaired = jsonrepair(candidate);
      const result = JSON.parse(repaired);
      console.warn(`[sceneGenClient] JSON parse failed (${originalErr.message}) but jsonrepair recovered it locally - no retry needed`);
      return result;
    } catch (repairErr) {
      const posMatch = originalErr.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = Number(posMatch[1]);
        const windowText = candidate.slice(Math.max(0, pos - 60), pos + 60);
        console.warn(`[sceneGenClient] JSON parse failure context (around position ${pos}): ...${windowText}...`);
      }
      throw originalErr;
    }
  }
}

// Renamed from callGroqForJSON - the big JSON-encoding call moved to
// OpenRouter (see openRouterClient.js's own doc comment for why: the
// full scene-JSON system prompt, ~16,923 tokens, is more than double
// Groq's flat 8000 TPM ceiling, confirmed by direct testing). Groq
// stays in use elsewhere in this file for the smaller treatment call.
async function callOpenRouterForJSON(systemPrompt, userMessage, retriesLeft, onRetry) {
  const rawText = await callOpenRouterRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 28000 });
  try {
    return extractJson(rawText);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] JSON parse failed (${err.message}), retrying...`);
      return onRetry(err, retriesLeft - 1);
    }
    throw err;
  }
}

// Direct user request: real, structural creative variation across
// repeated generations of the same prompt - see geminiClient.js's git
// history for the original reasoning (temperature alone wasn't enough).
// Carried over unchanged.
const CREATIVE_ANGLES = [
  'Lead with a surprising or counter-intuitive fact most people get wrong about this - open by correcting a common misconception, not with a neutral intro.',
  'Lead with a relatable "you have definitely experienced this" moment - open on the everyday scenario itself, second person, before explaining anything.',
  'Lead with a bold, opinionated claim stated flatly as fact - confident and a little provocative, not hedged.',
  'Structure this as a rapid-fire list or countdown - distinct, separately-numbered points building to a payoff, not one flowing explanation.',
  'Lead with a specific short scenario or mini-story (a particular moment, not a general statement) and use it as the throughline for the rest of the video.',
  'Lead with a direct question aimed straight at the viewer, second person, and treat the rest of the video as answering it conversationally.',
  'Lead with a surprising number or statistic as the hook, then build the explanation around why that number is true.',
  'Structure this as myth vs. reality - state the common assumption first, then dismantle it point by point.',
  'Frame this as letting the viewer in on an insider secret or something "they don\'t want you to know" - a behind-the-scenes reveal tone.',
  'Take a warm, personal, first-person-feeling tone throughout, like a friend explaining something they find genuinely delightful, not a neutral narrator.',
  'Lead with the single most surprising or weirdest fact available on this topic, saved-for-last normally - front-load it as the hook instead.',
  'Structure this around a clear before/after or problem/solution arc - what things looked like before, what changed, why it matters now.',
];

function pickRandomCreativeAngle() {
  return CREATIVE_ANGLES[Math.floor(Math.random() * CREATIVE_ANGLES.length)];
}

// maxTokens reduced from 8000 to 5500 for Groq specifically - real,
// measured finding: this account's Groq free tier caps at a flat 8000
// TPM, and the treatment system prompt alone is ~2185 tokens - 2185 +
// 8000 (the old value) genuinely exceeded that ceiling (confirmed live:
// "Requested 10437, Limit 8000"). 5500 leaves real headroom (2185 +
// 5500 = 7685) while still being far more than a treatment plan (plain
// prose, not JSON) actually needs.
async function generateCreativeTreatment(userPrompt, targetDurationSeconds) {
  const creativeAngle = pickRandomCreativeAngle();
  console.log(`[sceneGenClient] creative angle for this generation: ${creativeAngle}`);
  const systemPrompt = buildTreatmentSystemPrompt(targetDurationSeconds, creativeAngle);
  return callGroqRaw(systemPrompt, userPrompt, { jsonMode: false, maxTokens: 5500, temperature: 0.85 });
}

async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 16, priorErrors = null } = {}) {
  const systemPrompt = buildGenerationSystemPrompt(targetDurationSeconds);
  const beatHeaders = listTreatmentBeatHeaders(treatment);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every decision below must become real text layers/animators from the schema above, never simplified or dropped to something generic. The treatment may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead (a hard hit, a flash, a snap into place) rather than inventing a nonexistent field. Only use real fields from the schema above - never invent new ones.):\n${treatment}\n\nOriginal request: ${userPrompt}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;
  if (beatHeaders.length > 0) {
    userMessage += `\n\nThe treatment above contains EXACTLY ${beatHeaders.length} beats:\n${beatHeaders.join('\n')}\n\nYour "scenes" array MUST contain EXACTLY ${beatHeaders.length} entries, one per beat above, in this same order - not fewer, not merged, not summarized. Before you finish, go down this list one at a time and confirm each has its own real entry in "scenes".`;
  }

  const result = await callOpenRouterForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  const expectedBeats = beatHeaders.length;
  const actualBeats = valid && Array.isArray(result.scenes) ? result.scenes.length : 0;
  const isTooShort = valid && expectedBeats > 0 && actualBeats < expectedBeats;

  if (!valid || isTooShort) {
    const completenessError = isTooShort
      ? [`scenes: the treatment planned ${expectedBeats} beat(s), but only ${actualBeats} scene(s) were encoded. The treatment's exact beats are:\n${beatHeaders.join('\n')}\n\nEVERY one of these must become its own entry in "scenes", in order, none skipped, merged, or summarized away. Output all ${expectedBeats}.`]
      : [];
    const allErrors = [...errors, ...completenessError];
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] generated scene JSON ${!valid ? 'failed validation' : 'was too short'} (${allErrors.length} error(s)), retrying: ${allErrors.slice(0, 3).join('; ')}`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors: allErrors });
    }
    throw new Error(`Groq-generated scene JSON failed schema validation after retries: ${allErrors.join('; ')}`);
  }
  return result;
}

async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[sceneGenClient] planning creative treatment...');
  const treatment = await generateCreativeTreatment(userPrompt, targetDurationSeconds);
  console.log('[sceneGenClient] encoding whole scene in one pass...');
  return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment);
}

async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 4, priorErrors = null } = {}) {
  const systemPrompt = buildEditSystemPrompt(targetDurationSeconds);
  let userMessage = `Current JSON:\n${JSON.stringify(previousSceneJSON)}\n\nInstruction: ${editInstruction}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`;

  const result = await callOpenRouterForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] edited scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Groq-generated edited scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
}

// Same outer safety net as geminiClient.js - see its own doc comment
// for the production incident that motivated it.
const GENERATION_HARD_TIMEOUT_MS = 8 * 60 * 1000;

function withHardTimeout(promiseFactory, label) {
  return async (...args) => {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} exceeded its ${GENERATION_HARD_TIMEOUT_MS / 1000}s hard timeout - failing fast instead of leaving the job stuck "processing" indefinitely.`)),
        GENERATION_HARD_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([promiseFactory(...args), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

module.exports = {
  generateSceneJSON: withHardTimeout(generateSceneJSON, 'generateSceneJSON'),
  generateEditedSceneJSON: withHardTimeout(generateEditedSceneJSON, 'generateEditedSceneJSON'),
};
