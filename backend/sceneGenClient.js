const { jsonrepair } = require('jsonrepair');
const { validateSceneJSON } = require('./sceneSchema');
const {
  buildTreatmentSystemPrompt, buildMinimalGenerationSystemPrompt, buildEditSystemPrompt, listTreatmentBeatHeaders,
} = require('./scenePrompts');
const { callGroqRaw } = require('./groqClient');
const { callGeminiRaw } = require('./geminiClient');

/**
 * Scene generation, split across TWO providers matched to what each is
 * actually good at:
 * - Groq: PRIMARY for both the treatment-planning call AND the whole-
 *   scene JSON-encoding call (via buildMinimalGenerationSystemPrompt,
 *   ~1720 tokens - small enough to fit Groq's flat 8000 TPM ceiling for
 *   the encoding step too, not just the treatment). Direct user
 *   instruction: "we are meant to use groq as the main ai."
 * - Gemini: FALLBACK ONLY for the JSON-encoding call, if Groq's
 *   transport genuinely fails (not a validation retry, an actual
 *   transport failure). Direct user finding from real production logs:
 *   Gemini "causes alott of troublesss" (repeated 45s timeouts and 503s
 *   observed live, costing 70+ seconds on a single fallback) - kept as
 *   a last resort only, never primary, so a real Groq outage still has
 *   somewhere to go rather than failing the whole job outright.
 *
 * Mistral REMOVED entirely, direct user instruction (2026-09-05): "we
 * aint meant to be using mistral atalll, like i even removed the keys."
 * It used to sit as a further fallback (and, in narrationTagging.js, as
 * the PRIMARY provider for a different call) - both are gone now,
 * pointed at Groq instead. See narrationTagging.js's own doc comment
 * for why sending Groq that file's parallel per-beat calls is safe now
 * in a way it wasn't when Mistral was first brought in.
 *
 * This file is a fork of what used to live in geminiClient.js - the
 * provider-agnostic orchestration (JSON extraction/repair, schema-
 * validation retry loop, beat-count checking, creative-angle variation,
 * the hard timeout) is unchanged, just pointed at these transports.
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

// The FALLBACK path for the big JSON-encoding call, only reached when
// Groq's own transport genuinely fails (see callMinimalSceneJSONTransport
// below) - Gemini's own retry/timeout/multi-key resilience already
// lives inside callGeminiRaw. No further fallback past Gemini - Mistral
// used to sit here but is removed per direct user instruction (its keys
// no longer exist); if Gemini also fails, the caller's own retry loop
// (generateWholeSceneJSON) is what gets another shot, not a third
// provider.
async function callSceneJSONTransport(systemPrompt, userMessage, maxTokens) {
  return callGeminiRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens });
}

// Real, direct user demand this session: "REDUCE THE FUCKING INPUT" so
// Groq (free, fast, but a flat ~8000 TPM ceiling per key per request)
// can actually run the whole-scene JSON-encoding call, not just the
// small treatment step. buildMinimalGenerationSystemPrompt measures at
// ~3,350 real tokens (gpt-tokenizer-measured, not estimated) after the
// MOGRAPH section was added - down from buildGenerationSystemPrompt's
// ~17,700 - by cutting everything this session's own mechanical passes
// (ensureSustainedWordMotion/ensureDropShadowOnDominant/
// ensureActiveBackgroundElement/ensureBackgroundSwoosh/
// ensureDecorativeAccent/varyHeadlinePositions, all in sceneSchema.js)
// already guarantee regardless of what the model outputs - see that
// function's own doc comment for the full reasoning. Groq first (fits
// comfortably now), Gemini as real fallback if Groq's transport itself
// fails - same fallback shape as the rich path above, just a different
// primary.
//
// maxTokens cut 5000 -> 3500 specifically when MOGRAPH was added here:
// Groq's flat 8000 TPM ceiling is checked against system+user+max_tokens
// as REQUESTED, not actual usage (confirmed live: a real "Requested
// 10437, Limit 8000" error from this exact failure mode elsewhere in
// this file's own history) - system alone grew to ~3350 tokens, so the
// old 5000 left almost no room for the userMessage (treatment text +
// beat headers) before hitting the ceiling. 3500 is still generous for
// real output: a mograph spec is far more compact per beat than a raw
// "layers" array ever was (a maxed-out 6-item connectorList beat is
// ~100 tokens of JSON), so encouraging mograph should need LESS output
// budget than before, not more.
async function callMinimalSceneJSONTransport(systemPrompt, userMessage, maxTokens) {
  try {
    return await callGroqRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 3500 });
  } catch (err) {
    console.warn(`[sceneGenClient] Groq failed (${err.message}), falling back to Gemini`);
    return callSceneJSONTransport(systemPrompt, userMessage, maxTokens);
  }
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
// content-quality gate. Direct user instruction: "get another AI... It
// can be the Grok, or it can be the Gemini... preferably Grok" -
// checked Grok's real current API pricing (paid, same category as
// Claude/OpenAI, no free tier) before committing to anything, then the
// user's own immediate follow-up: "WE FUCKINGGGG ALREADYYYY HVE groq
// implemented so just extend from that one" - Groq for BOTH roles,
// zero new provider/key setup, reusing the exact same proven-reliable
// callGroqRaw this file already leans on everywhere else.
//
// Judged separately from JSON-encoding retries (a different failure
// axis - a script can be perfectly valid JSON and still be a boring
// documentary read) and capped at its own small budget
// (MAX_JUDGE_ROUNDS) - each round costs a real extra Groq call, and an
// infinitely-harsh judge could otherwise loop forever chasing a verdict
// that never comes; after the cap, the LAST attempt ships regardless
// rather than block the whole generation on taste forever.
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
    // this reason text gets re-injected into the NEXT encode round's
    // user message - see generateWholeSceneJSON's own doc comment for
    // the real 413 this caused live when it was allowed to run long.
    const raw = await callGroqRaw(SCRIPT_JUDGE_SYSTEM_PROMPT, numberedScript, { jsonMode: false, maxTokens: 80, temperature: 0.6 });
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

async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft = 16, priorErrors = null, judgeFeedback = null } = {}) {
  const systemPrompt = buildMinimalGenerationSystemPrompt(targetDurationSeconds);
  const beatHeaders = listTreatmentBeatHeaders(treatment);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every real beat/idea below must become its own real text layer, never simplified or dropped to something generic. The treatment may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead (a hard hit, a flash, a snap into place) rather than inventing a nonexistent field. Only use real fields from the schema above - never invent new ones. Motion, effects, and background decoration are already handled automatically - focus entirely on real words and layout.):\n${treatment}\n\nOriginal request: ${userPrompt}`;
  // Real, direct-user-requested feedback loop: a SEPARATE brutal judge
  // model already reviewed a PREVIOUS attempt's narration script and
  // rejected it as boring - this is that judge's own specific critique,
  // framed distinctly from priorErrors below (that one means "your JSON
  // was structurally invalid"; this one means "your JSON was valid but
  // the SCRIPT ITSELF wasn't good enough" - a real, different kind of
  // problem, worth its own clear framing so the model doesn't confuse
  // a content note for a syntax one).
  //
  // Real, live-confirmed bug (2026-09-03): this used to be a full
  // paragraph wrapping the judge's own (previously unbounded) reason
  // text - harmless-looking, but Groq's flat 8000 TPM per-request
  // ceiling has almost no slack once the base prompt (system + treatment
  // + beat headers) is already accounted for (measured live: round 1,
  // no feedback, fits; round 2/3, WITH this paragraph added, hit a real
  // 413 "Requested 8143, Limit 8000" - a ~143 token overage that lines
  // up almost exactly with how much this wrapping text plus a verbose
  // judge reason used to cost). Trimmed to the essentials - the judge's
  // OWN reason is now also capped short (see SCRIPT_JUDGE_SYSTEM_PROMPT)
  // so this stays cheap on every round, not just the first one.
  if (judgeFeedback) userMessage += `\n\nA brutal judge rejected your last script as boring: "${judgeFeedback}" Rewrite the narration (and matching on-screen text) to fix this - same treatment, same beat count.`;
  if (priorErrors) userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;
  if (beatHeaders.length > 0) {
    userMessage += `\n\nThe treatment above contains EXACTLY ${beatHeaders.length} beats:\n${beatHeaders.join('\n')}\n\nYour "scenes" array MUST contain EXACTLY ${beatHeaders.length} entries, one per beat above, in this same order - not fewer, not merged, not summarized. Before you finish, go down this list one at a time and confirm each has its own real entry in "scenes".`;
  }

  const result = await callSceneJSONForJSON(systemPrompt, userMessage, retriesLeft, (err, nextRetriesLeft) => generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: nextRetriesLeft, priorErrors, judgeFeedback }), callMinimalSceneJSONTransport);

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
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { retriesLeft: retriesLeft - 1, priorErrors: allErrors, judgeFeedback });
    }
    throw new Error(`Groq-generated scene JSON failed schema validation after retries: ${allErrors.join('; ')}`);
  }
  return result;
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
