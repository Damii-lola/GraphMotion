const { jsonrepair } = require('jsonrepair');
const { validateSceneJSON, buildMographBeatVisual } = require('./sceneSchema');
const {
  buildTreatmentSystemPrompt, buildMinimalGenerationSystemPrompt, buildEditSystemPrompt,
} = require('./scenePrompts');
const { callOpenRouterRaw } = require('./openRouterClient');

/**
 * Scene generation, on OpenRouter's minimax/minimax-m2.7:free model for
 * every real AI call in this file (treatment planning, whole-scene JSON
 * encoding, script judging, and edits) - both Groq and Gemini are gone
 * from this codebase entirely, direct user instruction (2026-09-05):
 * Groq's organization-wide daily quota stayed exhausted long past when
 * it should have reset ("Groq is still not working, just remove it
 * completely"), and Gemini - the temporary stand-in while that was
 * being sorted out - then hit its OWN real outage live in production
 * (repeated "Gemini server error (503)" across all 3 keys, confirmed
 * directly in Render's own logs, 15-45s per failed attempt). Two
 * providers down independently in the same session was the actual
 * trigger for consolidating onto a single, different one rather than
 * layering in a third fallback.
 *
 * Model choice and its own real trade-offs (measured spread across 3
 * back-to-back calls: 24.9s/29.9s/84.8s - genuinely variable, not
 * uniformly fast) are documented in openRouterClient.js itself, not
 * repeated here. Real, known constraint worth remembering: OpenRouter's
 * free tier is REQUEST-count limited (50/day, 20/min), not token-limited
 * like Groq was - every call this file (and narrationTagging.js) makes
 * now draws from that same shared daily budget.
 *
 * Mistral REMOVED entirely, direct user instruction (2026-09-05): "we
 * aint meant to be using mistral atalll, like i even removed the keys."
 *
 * This file is a fork of what used to live in geminiClient.js - the
 * provider-agnostic orchestration (JSON extraction/repair, schema-
 * validation retry loop, beat-count checking, creative-angle variation,
 * the hard timeout) is unchanged, just pointed at this transport.
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

// Kept for generateEditedSceneJSON below - buildEditSystemPrompt shares
// SCHEMA_REFERENCE with the old rich generation prompt (~18,000 tokens,
// gpt-tokenizer-confirmed). OpenRouter's free tier has no per-request
// token cap (see openRouterClient.js's own doc comment), so this large
// a prompt is fine here without its own minimal rewrite.
async function callSceneJSONTransport(systemPrompt, userMessage, maxTokens) {
  return callOpenRouterRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens });
}

async function callSceneJSONForJSON(systemPrompt, userMessage, retriesLeft, onRetry, transport = callSceneJSONTransport) {
  const rawText = await transport(systemPrompt, userMessage, 28000);
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

// Real, direct user request: a second AI acting as an EXTREMELY BRUTAL
// judge of the narration script's own actual entertainment value - not
// JSON validity (already covered by validateSceneJSON), a genuine
// content-quality gate. Reuses this file's same OpenRouter/MiniMax
// transport - no separate provider/key setup for a second opinion.
//
// Judged separately from JSON-encoding retries (a different failure
// axis - a script can be perfectly valid JSON and still be a boring
// documentary read) and capped at its own small budget
// (MAX_JUDGE_ROUNDS) - each round costs a real extra call against the
// shared OpenRouter daily request budget, and an infinitely-harsh judge
// could otherwise loop forever chasing a verdict that never comes;
// after the cap, the LAST attempt ships regardless rather than block
// the whole generation on taste forever.
const MAX_JUDGE_ROUNDS = 3;

const SCRIPT_JUDGE_SYSTEM_PROMPT = `You are an EXTREMELY BRUTAL, non-sugarcoating short-form video script judge. You judge exactly ONE thing: would a 10-year-old with severe ADHD, scrolling TikTok, watch this ENTIRE video without swiping away?

Specifically:
1. Would they swipe away within the first 3 seconds? Judge the FIRST line alone against this - it has to be a genuine scroll-stopper, not a neutral setup.
2. Would they stay for the WHOLE video, or get bored and swipe partway through?

A script that survives this test is shocking, surprising, funny, or makes a real personal/emotional stake obvious immediately - NOT dry facts, NOT documentary narration, NOT a generic statement that could sit in a Wikipedia article unchanged.

You will be given a numbered list of narration lines, one per beat, meant to be read in order as ONE continuous script. Respond in EXACTLY this format and nothing else, no other commentary:
VERDICT: PASS or FAIL
REASON: <if FAIL, ONE short sentence, under 15 words, no quoting the line back verbatim - just the line number(s) and the core problem (e.g. "Line 1 is a cliche did-you-know question, no real stakes"). If PASS, write "N/A".>

Be harsh. Most scripts you see should FAIL this test on a real first read. Only PASS a script that is genuinely gripping start to finish, not merely "fine" or "informative." Keep REASON short - it gets fed back into a token-constrained rewrite step, not read by a human.`;

function buildNumberedScript(sceneJSON) {
  if (!sceneJSON || !Array.isArray(sceneJSON.scenes)) return '';
  return sceneJSON.scenes
    .map((s, i) => (s && s.params && typeof s.params.narration === 'string' ? `${i + 1}. ${s.params.narration.trim()}` : null))
    .filter(Boolean)
    .join('\n');
}

/** Returns { pass: boolean, reason: string } - fails OPEN (pass:true) on any transport/parse problem, since a judge that can't be reached should never be the reason a whole generation dies. */
async function judgeNarrationScript(sceneJSON) {
  const numberedScript = buildNumberedScript(sceneJSON);
  if (!numberedScript) return { pass: true, reason: '' };
  try {
    // maxTokens capped hard at 80 (was 400) - not just the system
    // prompt's own "under 15 words" request, a real ceiling. The prompt
    // instruction alone doesn't guarantee brevity (this session's own
    // "mechanical enforcement beats prompt guidance" lesson again) and
    // this reason text gets re-injected into the next whole-scene encode
    // round - a real 413 was caused live by an unbounded version of this
    // same text once already.
    const raw = await callOpenRouterRaw(SCRIPT_JUDGE_SYSTEM_PROMPT, numberedScript, { jsonMode: false, maxTokens: 80, temperature: 0.6 });
    const verdictMatch = raw.match(/VERDICT:\s*(PASS|FAIL)/i);
    const reasonMatch = raw.match(/REASON:\s*([\s\S]*)/i);
    const pass = verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : true;
    const reason = reasonMatch ? reasonMatch[1].trim() : '';
    return { pass, reason };
  } catch (err) {
    console.warn(`[sceneGenClient] script judge call failed (${err.message}) - passing this round open rather than block the generation on a judge that couldn't be reached`);
    return { pass: true, reason: '' };
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

// Real, measured margin: this model's own free-endpoint reasoning is
// mandatory and draws from this SAME max_tokens budget (see
// openRouterClient.js's own doc comment) - 5000 leaves real room above
// every treatment length seen so far, with one escalation step for a
// rare unusually-long one rather than a hard truncation failure.
const TREATMENT_MAX_TOKENS_STEPS = [5000, 7000];
async function generateCreativeTreatment(userPrompt, targetDurationSeconds, attempt = 0) {
  const creativeAngle = pickRandomCreativeAngle();
  console.log(`[sceneGenClient] creative angle for this generation: ${creativeAngle}`);
  const systemPrompt = buildTreatmentSystemPrompt(targetDurationSeconds, creativeAngle);
  try {
    return await callOpenRouterRaw(systemPrompt, userPrompt, { jsonMode: false, maxTokens: TREATMENT_MAX_TOKENS_STEPS[attempt], temperature: 0.85 });
  } catch (err) {
    if (attempt + 1 < TREATMENT_MAX_TOKENS_STEPS.length) {
      console.warn(`[sceneGenClient] treatment call failed (${err.message}), retrying with a higher token cap...`);
      return generateCreativeTreatment(userPrompt, targetDurationSeconds, attempt + 1);
    }
    throw err;
  }
}

// Whole-scene-in-one-call, not a per-beat split - OpenRouter's free tier
// is REQUEST-count limited (50/day, 20/min - see openRouterClient.js's
// own doc comment), not token-limited the way Groq was, so splitting one
// video into many small calls would only multiply request count against
// exactly the ceiling that actually matters here. One call per video is
// the right shape for a request-count-limited provider.
async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 4, priorErrors = null, judgeFeedback = null } = {}) {
  const systemPrompt = buildMinimalGenerationSystemPrompt(targetDurationSeconds);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every real beat/idea below must become its own real mograph spec or (rarely) a raw "layers" array. Only use real fields from the schema above.):\n${treatment}\n\nOriginal request: ${userPrompt}\n\nEncode EVERY beat the treatment planned above, in order, into "scenes" - none skipped, merged, or summarized away. Keep each beat's own "params.narration" SHORT (8 words max, one real sentence or fragment) even if the treatment's own prose for that beat reads longer - condense it down to a short spoken line, don't copy the treatment's descriptive text verbatim.`;
  if (judgeFeedback) userMessage += `\n\nA brutal judge rejected your last script as boring: "${judgeFeedback}" Rewrite the narration (and matching on-screen text) to fix this - same treatment, same beat count.`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;

  let raw;
  try {
    raw = await callOpenRouterRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 8000 });
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] whole-scene call failed (${err.message}), retrying...`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors, judgeFeedback });
    }
    throw err;
  }

  let sceneJSON;
  try {
    sceneJSON = extractJson(raw);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] JSON parse failed (${err.message}), retrying...`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors, judgeFeedback });
    }
    throw err;
  }

  if (Array.isArray(sceneJSON.scenes)) sceneJSON.scenes.forEach(buildMographBeatVisual);
  const { valid, errors } = validateSceneJSON(sceneJSON);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors: errors, judgeFeedback });
    }
    throw new Error(`Generated scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return sceneJSON;
}

// Real, direct user request: "the first AI will be generated and give
// it to this new AI, the new ai will make corrections and give it back
// to the first ai to regenerate... the cycle will repeat over and over
// till we get a VERY NICE INTERESTING EYECATCHING SCROLLSTOPPING
// script." Wired as its own outer loop, separate from
// generateWholeSceneJSON's own schema-validation retries (a script can
// be perfectly valid JSON on the first try and still fail the judge,
// or vice versa) - capped at MAX_JUDGE_ROUNDS total attempts; if the
// judge still hasn't passed by then, ships the LAST attempt anyway
// rather than block the whole generation on taste forever.
async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[sceneGenClient] planning creative treatment...');
  const treatment = await generateCreativeTreatment(userPrompt, targetDurationSeconds);

  let sceneJSON = null;
  let judgeFeedback = null;
  for (let round = 1; round <= MAX_JUDGE_ROUNDS; round++) {
    console.log(`[sceneGenClient] encoding whole scene (script round ${round}/${MAX_JUDGE_ROUNDS})...`);
    sceneJSON = await generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { judgeFeedback });

    console.log('[sceneGenClient] judging narration script...');
    const verdict = await judgeNarrationScript(sceneJSON);
    if (verdict.pass) {
      console.log(`[sceneGenClient] script judge: PASS (round ${round})`);
      break;
    }
    console.log(`[sceneGenClient] script judge: FAIL (round ${round}) - ${verdict.reason}`);
    if (round === MAX_JUDGE_ROUNDS) {
      console.warn(`[sceneGenClient] script judge still failing after ${MAX_JUDGE_ROUNDS} rounds - shipping the last attempt rather than block the job further`);
      break;
    }
    judgeFeedback = verdict.reason;
  }
  return sceneJSON;
}

async function generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds = 12, { retriesLeft = 4, priorErrors = null } = {}) {
  const systemPrompt = buildEditSystemPrompt(targetDurationSeconds);
  let userMessage = `Current JSON:\n${JSON.stringify(previousSceneJSON)}\n\nInstruction: ${editInstruction}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`;

  const result = await callSceneJSONForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: nextRetriesLeft, priorErrors }));

  const { valid, errors } = validateSceneJSON(result);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] edited scene JSON failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 3).join('; ')}`);
      return generateEditedSceneJSON(previousSceneJSON, editInstruction, targetDurationSeconds, { retriesLeft: retriesLeft - 1, priorErrors: errors });
    }
    throw new Error(`Edited scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }
  return result;
}

// Real production incident this guards against: a hung generation call
// leaving a job stuck "processing" forever with no way for the user to
// tell it had actually died rather than just being slow.
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
