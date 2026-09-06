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
//
// 3 -> 2 (2026-09-06): a real production job (28s target) failed
// outright, blowing through even the just-tripled 660s hard timeout,
// traced via full logs to a compounding-cost bug: each round called
// generateWholeSceneJSON with a FRESH retriesLeft budget (see
// TOTAL_STRUCTURAL_RETRY_BUDGET below for the actual fix to that), so
// worst case was 3 rounds x up to 5 structural attempts each x up to
// 150s/call (OPENROUTER_TIMEOUT_MS) plus 3 judge calls - a theoretical
// ceiling far beyond 660s, and the observed real job burned the whole
// budget mostly on round-to-round retries rather than genuine judge
// iteration. Fewer, more effective rounds (paired with the mechanical
// rewrite instructions added below, which target the actual recurring
// failure instead of hoping a vague "try again" converges) converges
// faster in practice than more rounds ever did.
const MAX_JUDGE_ROUNDS = 2;

// Real bug (2026-09-06, traced from the same production log above):
// generateWholeSceneJSON used to get handed a FRESH retriesLeft=4 on
// EVERY judge round (the outer loop below never threaded remaining
// budget between rounds), so the true worst case was MAX_JUDGE_ROUNDS x
// 5 structural attempts, not 5 total - the exact compounding that blew
// past even an 11-minute hard timeout. This budget object is created
// ONCE per generateSceneJSON call and passed BY REFERENCE into every
// round's generateWholeSceneJSON call, so structural retries are now
// capped ACROSS the whole generation, not per round.
const TOTAL_STRUCTURAL_RETRY_BUDGET = 3;

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
    // maxTokens capped hard at 80 (was 400), then found to be a real,
    // guaranteed-failure bug (2026-09-06, traced directly from
    // production logs): openRouterClient.js's own mandatory reasoning
    // pass draws up to REASONING_MAX_TOKENS (3000) from this SAME
    // budget before the actual PASS/FAIL verdict ever gets written - an
    // 80-token ceiling can NEVER survive that, so this call was hitting
    // finish_reason:"length" with zero usable content on effectively
    // every single invocation, confirmed live, silently auto-passing
    // every round (see the catch block below) while still burning a
    // real 20+ second round trip for it. Raised to 3200 (3000 reasoning
    // + genuine headroom for the short verdict/reason text) so the judge
    // can actually complete instead of being structurally guaranteed to
    // fail before this fix. The OLD 80-token ceiling was ALSO
    // (accidentally) what kept the re-injected "reason" text short
    // enough to avoid the prior live 413 - raising maxTokens for the
    // reasoning problem above removes that accidental protection, so
    // the explicit slice() below is what deliberately restores it now,
    // rather than relying on an unrelated ceiling to happen to do it.
    const raw = await callOpenRouterRaw(SCRIPT_JUDGE_SYSTEM_PROMPT, numberedScript, { jsonMode: false, maxTokens: 3200, temperature: 0.6 });
    const verdictMatch = raw.match(/VERDICT:\s*(PASS|FAIL)/i);
    const reasonMatch = raw.match(/REASON:\s*([\s\S]*)/i);
    const pass = verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : true;
    const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 300) : '';
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
async function generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { budget = { left: TOTAL_STRUCTURAL_RETRY_BUDGET }, priorErrors = null, judgeFeedback = null } = {}) {
  const systemPrompt = buildMinimalGenerationSystemPrompt(targetDurationSeconds);
  let userMessage = `CREATIVE TREATMENT (already planned by a senior director - encode this EXACTLY and FAITHFULLY, missing nothing; every real beat/idea below must become its own real mograph spec or (rarely) a raw "layers" array. Only use real fields from the schema above.):\n${treatment}\n\nOriginal request: ${userPrompt}\n\nEncode EVERY beat the treatment planned above, in order, into "scenes" - none skipped, merged, or summarized away. Keep each beat's own "params.narration" SHORT (8 words max, one real sentence or fragment) even if the treatment's own prose for that beat reads longer - condense it down to a short spoken line, don't copy the treatment's descriptive text verbatim.`;
  if (judgeFeedback) userMessage += `\n\nA brutal judge rejected your last script as boring: "${judgeFeedback}" Rewrite the narration (and matching on-screen text) to fix this - same treatment, same beat count.`;
  if (priorErrors) {
    userMessage += `\n\nYour previous attempt produced invalid JSON:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON - still encoding the treatment above.`;
    // Real bug (2026-09-06, traced from production logs): the two most
    // common validation errors were each hit 3-5+ times IN A ROW by the
    // same generation, with only cosmetic rewording between attempts
    // ("Hours of work. Disappears into the feed." -> "Hours of work. It
    // just disappears." -> "Months of posts. Nobody's watching.") that
    // never actually satisfied the mechanical check. Asking the model to
    // creatively "fix" a hook is exactly the kind of vague instruction
    // this project already learned (everywhere else this session) not
    // to rely on - so when these two SPECIFIC errors appear, give an
    // unambiguous mechanical patch instead of hoping a rewrite lands.
    if (priorErrors.some((e) => /scenes\[0\]\.params\.narration/.test(e))) {
      userMessage += `\n\nMECHANICAL FIX for the scenes[0] narration error above: keep the same underlying fact/claim, but the SENTENCE FORM must change. Do ONE of these, literally, and nothing fancier: (a) start the sentence with "You" or "Your", (b) end the sentence with "?", (c) end the sentence with "!", or (d) start the sentence with one of: Stop, Imagine, Picture, Wait, Guess, What if, Never. Pick whichever is easiest to bolt onto your last attempt and apply it directly - do not just reword the fact again without doing one of these four things.`;
    }
    if (priorErrors.some((e) => /params\.narration:.*too long/.test(e))) {
      userMessage += `\n\nCOUNT THE WORDS in EVERY beat's narration before responding, not just the one flagged above - fixing one beat while another drifts over the limit is not a fix. Every single beat needs 8 words or fewer, no exceptions.`;
    }
  }

  let raw;
  try {
    // 8000 -> 14000 (2026-09-06): real, confirmed-live failure mode
    // traced directly from production logs, not guessed - this call
    // repeatedly returned finish_reason:"length" with ZERO usable
    // content. openRouterClient.js's own mandatory reasoning pass draws
    // up to REASONING_MAX_TOKENS (3000) from this SAME budget before any
    // real JSON gets written, leaving only ~5000 for a full 3-6-beat
    // scene - not always enough, especially once a beat's own mograph
    // spec runs long (a big icons array, a label, etc.) or the model's
    // reasoning itself runs long. Each length-truncated failure forces a
    // full retry (another 60-100s+ call from scratch, per this exact
    // production log), so paying for more headroom up front is a net
    // latency win over guaranteeing a wasted round trip.
    raw = await callOpenRouterRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 14000 });
  } catch (err) {
    if (budget.left > 0) {
      budget.left -= 1;
      console.warn(`[sceneGenClient] whole-scene call failed (${err.message}), retrying (${budget.left} structural retries left)...`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { budget, priorErrors, judgeFeedback });
    }
    throw err;
  }

  let sceneJSON;
  try {
    sceneJSON = extractJson(raw);
  } catch (err) {
    if (budget.left > 0) {
      budget.left -= 1;
      console.warn(`[sceneGenClient] JSON parse failed (${err.message}), retrying (${budget.left} structural retries left)...`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { budget, priorErrors, judgeFeedback });
    }
    throw err;
  }

  if (Array.isArray(sceneJSON.scenes)) sceneJSON.scenes.forEach(buildMographBeatVisual);
  const { valid, errors } = validateSceneJSON(sceneJSON);
  if (!valid) {
    if (budget.left > 0) {
      budget.left -= 1;
      console.warn(`[sceneGenClient] scene JSON failed validation (${errors.length} error(s)), retrying (${budget.left} structural retries left): ${errors.slice(0, 3).join('; ')}`);
      return generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { budget, priorErrors: errors, judgeFeedback });
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

  // Script-quality judge loop TEMPORARILY DISABLED - direct user request
  // (2026-09-07): "comment out the audio script and the judge to judge
  // the audio script... Rn we are trying to get the motion graphics in
  // place, that's the priority." Narration audio itself is also
  // disabled right now (see narrationPrefetch.js's prefetchNarration),
  // so judging the narration script's hook/entertainment value is moot
  // until audio comes back. Commented out below, not deleted - re-enable
  // by restoring the loop and deleting this single-pass replacement.
  const budget = { left: TOTAL_STRUCTURAL_RETRY_BUDGET };
  const sceneJSON = await generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { budget });
  return sceneJSON;

  /*
  let sceneJSON = null;
  let judgeFeedback = null;
  // Shared, by-reference structural-retry budget - see
  // TOTAL_STRUCTURAL_RETRY_BUDGET's own doc comment. Created ONCE here
  // and passed into every round below so retries are capped across the
  // WHOLE generation, not reset fresh on every judge round.
  const budget = { left: TOTAL_STRUCTURAL_RETRY_BUDGET };
  for (let round = 1; round <= MAX_JUDGE_ROUNDS; round++) {
    console.log(`[sceneGenClient] encoding whole scene (script round ${round}/${MAX_JUDGE_ROUNDS})...`);
    sceneJSON = await generateWholeSceneJSON(userPrompt, targetDurationSeconds, treatment, { budget, judgeFeedback });

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
  */
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
// 8 -> 11 minutes (2026-09-06): a real 28s-target job hit this ceiling
// outright and failed, confirmed live. A genuinely successful generation
// earlier the same session took 5.3 minutes for a shorter (~12s target,
// fewer required beats) video against this same slow provider - a
// longer target needs more distinct templates to fill 3-6 beats, each
// beat's own encode/validate/retry cycle costing real time (MiniMax via
// OpenRouter runs 60-100s+ per call), so a longer video plausibly just
// needed more of that same real, working-as-designed retry time rather
// than being newly stuck. Raised rather than left to fail outright on
// exactly the videos users are more likely to actually want (a 12s
// default is already on the short end for real content).
const GENERATION_HARD_TIMEOUT_MS = 11 * 60 * 1000;

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
