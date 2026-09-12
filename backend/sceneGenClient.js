const { jsonrepair } = require('jsonrepair');
const fetch = require('node-fetch');
const { validateSceneJSON, buildMographBeatVisual } = require('./sceneSchema');
const {
  buildTreatmentSystemPrompt, buildMinimalGenerationSystemPrompt, buildCompactGenerationSystemPrompt, buildEditSystemPrompt,
  pickRandomTemplates,
} = require('./scenePrompts');
const { callOpenRouterRaw } = require('./openRouterClient');
const { callCloudflareRaw } = require('./cloudflareClient');

/**
 * Scene generation, on OpenRouter's minimax/minimax-m3 model (paid -
 * see openRouterClient.js's own OPENROUTER_MODEL doc comment for why
 * the earlier minimax-m2.7:free choice had to change) for every real AI
 * call in this file (treatment planning, whole-scene JSON encoding,
 * script judging, and edits) - both Groq and Gemini are gone
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
    // Real root cause found (2026-09-10): callOpenRouterRaw's own
    // reasoning:{max_tokens} param wasn't honored for minimax-m3 at all
    // and was eating the whole budget regardless of size - see
    // openRouterClient.js's own doc comment. That param is gone now, so
    // 3200 (this call's own short verdict+reason output, unmodified from
    // before any of the reasoning-cap tuning) is real headroom again.
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

// Real, direct root cause found (2026-09-10) after several wrong guesses
// (see openRouterClient.js's own "DO NOT re-add a reasoning param" doc
// comment for the full investigation): minimax-m3 was failing on EVERY
// maxTokens value tried (7000, 16000, even as low as 2000) because
// callOpenRouterRaw was sending a reasoning:{max_tokens} param that
// isn't honored for this model at all - reasoning was consuming the
// ENTIRE budget regardless of its own size. Removing that param
// entirely (not tuning this number) was the actual fix, confirmed with
// an isolated raw-fetch test: the exact same prompt with no "reasoning"
// field succeeded immediately (finish_reason:"stop", ~2500 tokens of
// real content, 2.1s). [5000,7000] leaves real room above every real
// treatment length seen so far (that same test's own ~2500-token
// response, with margin), now that nothing is silently eating it first.
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
    // Real, direct finding (2026-09-10): with the minimum distinct-
    // template requirement raised 3->5 (now 7 templates exist total),
    // "used more than once" became a real, repeated retry failure - the
    // model kept landing on the SAME repeated template across multiple
    // attempts rather than genuinely picking a fresh one, the identical
    // "vague instruction doesn't reliably land" problem the two
    // mechanical fixes above already solved for narration. Naming the
    // exact repeated template(s) and listing what's actually left
    // removes the guesswork instead of just repeating the abstract rule.
    const repeatMatch = priorErrors.find((e) => /used more than once/.test(e));
    if (repeatMatch) {
      const ALL_TEMPLATES = ['nodeCluster', 'connectorList', 'phoneSwap', 'splitConverge', 'mergeCluster', 'nodeClusterExtended', 'textPopOut'];
      const repeatedNames = [...repeatMatch.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
      const stillAvailable = ALL_TEMPLATES.filter((t) => !repeatedNames.includes(t));
      userMessage += `\n\nMECHANICAL FIX for the repeated-template error above: ${repeatedNames.join(', ')} already appear(s) more than once in your last attempt. Find the LATER beat(s) using ${repeatedNames.join('/')} a second time and replace ONLY that beat's own "type" with one of these genuinely still-unused templates instead: ${stillAvailable.join(', ')}. Keep that beat's own narration/idea, just re-encode it as the new template's own real fields.`;
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
    // Real root cause found (2026-09-10): callOpenRouterRaw's own
    // reasoning:{max_tokens} param wasn't honored for minimax-m3 at all
    // and was eating the whole budget regardless of size (confirmed via
    // an isolated raw-fetch test - see openRouterClient.js's own doc
    // comment for the full investigation). That param is gone now.
    // 16000 (up slightly from the original 14000 that worked reliably
    // for the old model) - genuine headroom for a full multi-beat scene
    // now that nothing is silently consuming the budget first.
    raw = await callOpenRouterRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 16000 });
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

// Direct user re-scoping (2026-09-10): "the ai wont do much, it will
// just pick scenes that fit the prompt then give us the variables for
// the scenes" - replaces the old treatment-then-full-JSON-encode two-
// step process (generateCreativeTreatment/generateWholeSceneJSON below,
// kept defined but no longer called from generateSceneJSON - see their
// own doc comments) with ONE call against Cloudflare Workers AI's
// compact prompt (buildCompactGenerationSystemPrompt, scenePrompts.js -
// real, tokenizer-measured, kept under the user's own token ceiling,
// 750 -> 1000 as of 2026-09-10 - see that function's own doc comment
// for the current real count), then a pure-JS compile step into the
// real schema.

// No real narration-audio timing is available to size a beat's duration
// from (TTS is currently disabled - see narrationPrefetch.js), so each
// template gets a reasonable flat starting point; buildMographBeatVisual
// itself floors/extends several of these upward already (intro/outro
// text, nodeClusterExtended's own fixed runtime, textPopOut's word-
// count-driven minimum) - this is deliberately just a sane starting
// point for that machinery, not a real narration-derived duration.
const COMPACT_BASE_DURATION = {
  nodeCluster: 3.0,
  connectorList: 3.5,
  phoneSwap: 3.0,
  splitConverge: 2.5,
  mergeCluster: 3.0,
  nodeClusterExtended: 3.0,
  textPopOut: 3.0,
  // Deliberately tiny - this template's own real motion (3 squares pop
  // in, spin, land on a diamond) fully completes in ~1.4s
  // (SQUARE_SPIN_COMPLETE_TIME, sceneSchema.js, after the 2026-09-10
  // slow-down) - a bigger base here would just be clamped back down by
  // buildMographBeatVisual's own clampMographDuration anyway, so
  // starting close to the real value avoids relying on that clamp to do
  // all the work.
  squareSpin: 2.0,
  // Real motion (3 nodes slide in, settle, shrink, unblur) fully
  // completes in ~1.13s (TRIPLE_STACK_COMPLETE_TIME, sceneSchema.js) -
  // same "start close to the real value" reasoning as squareSpin above.
  tripleStack: 2.0,
  // Real motion (fly-in, icon-cycle, rise, 4-row cascade, a direct-user-
  // requested 1.5s pre-eat pause, sequential eat with a per-row dwell,
  // return-to-center) fully completes in ~4.0s (RETURN_END inside
  // buildNodeAbsorbLayers, sceneSchema.js) - same "start close to the real
  // value" reasoning as squareSpin/tripleStack above. Deliberately longer
  // than every other template here - the 1.5s pause is a real, explicit
  // user requirement for THIS beat's own internal pacing, not a violation
  // of the project's separate "≤1.5s hold after everything settles" rule
  // (MOGRAPH_MAX_HOLD_AFTER_SETTLE), which only governs time AFTER
  // RETURN_END, not motion still happening before it.
  nodeAbsorb: 4.0,
  // Immediately overwritten by textTiersMinDuration(wordCount) in
  // sceneSchema.js's own dispatch branch (same "resolve the real
  // duration before building" pattern textPopOut already established) -
  // this is just a reasonable seed, ~textTiersMinDuration(7) for a
  // typical 7-word phrase (bumped 2.0->3.2 alongside the hold's own
  // 0.5->2.0 increase, direct user ask for 1.5s more hold time).
  textTiers: 3.2,
  // Immediately overwritten by blueprintTextMinDuration(sentence1,
  // sentence2) in sceneSchema.js's own dispatch branch - this is just a
  // reasonable seed, ~blueprintTextMinDuration for two typical 4-word
  // sentences (matching the reference's own real word counts).
  blueprintText: 3.3,
  // Immediately overwritten by yearScrollerMinDuration(year, text) in
  // sceneSchema.js's own dispatch branch - this is just a reasonable
  // seed, ~yearScrollerMinDuration for a typical 16-year scroll + a
  // short reveal headline.
  yearScroller: 5.74,
  // Immediately overwritten by counterMinDuration(value, text) in
  // sceneSchema.js's own dispatch branch - this is just a reasonable
  // seed, ~counterMinDuration for a typical count-up + an 8-word
  // caption (real measured value, not guessed).
  counter: 6.07,
  // Immediately overwritten by lineRevealMinDuration() in sceneSchema.js's
  // own dispatch branch - this template's own pacing is entirely fixed
  // (doesn't depend on either text's length), so this seed is just that
  // same real, always-exact value.
  lineReveal: 4.41,
};

/**
 * Pure translation, no AI involved - the compact {beats:[{template,
 * narration, vars, accentColor}]} shape the AI actually produces into
 * the real {scenes:[{params,mograph}]} shape buildMographBeatVisual/
 * validateSceneJSON expect. "vars" fields map directly onto each
 * template's own real mograph fields (icons, chosenIndex, items, etc.
 * - see buildMographBeatVisual's own dispatch for the authoritative
 * list), so this is mostly a straight spread - buildMographBeatVisual's
 * own existing type/shape checks are what actually validate them, not
 * duplicated here.
 */
function compileCompactSpecToSceneJSON(compact, chosenTemplates) {
  if (!compact || !Array.isArray(compact.beats) || compact.beats.length === 0) {
    throw new Error('compact spec is missing a real, non-empty "beats" array');
  }
  const fieldErrors = [];
  const scenes = compact.beats.map((beat, i) => {
    if (!beat || typeof beat.template !== 'string' || !beat.template.trim()) {
      fieldErrors.push(`beat[${i}] is missing its "template"`);
      return null;
    }
    const vars = isPlainObjectLocal(beat.vars) ? beat.vars : {};
    const fieldError = validateCompactBeatVars(beat.template, vars);
    if (fieldError) fieldErrors.push(`beat[${i}] (${beat.template}) ${fieldError}`);
    const mograph = { type: beat.template, ...vars };
    if (typeof beat.accentColor === 'string' && beat.accentColor.trim()) mograph.accentColor = beat.accentColor.trim();
    return {
      params: {
        duration: COMPACT_BASE_DURATION[beat.template] || 3.0,
        narration: typeof beat.narration === 'string' ? beat.narration.trim() : '',
      },
      mograph,
    };
  });

  // Real, direct user requirement (2026-09-10, after two separate live
  // incidents where the model's own template SELECTION was the
  // dominant failure cause): the 5-7 templates for this video are now
  // picked in CODE (pickRandomTemplates, scenePrompts.js) before the
  // model ever sees the prompt - it's just told which ones to write.
  // Verified here that it actually did, alongside the per-field errors
  // above (one combined retry message instead of ping-ponging between
  // error types across multiple retries) - this is what makes the whole
  // "wrong count/wrong distinctness" failure class structurally
  // impossible rather than just less likely.
  if (Array.isArray(chosenTemplates) && chosenTemplates.length > 0) {
    const used = compact.beats
      .map((b) => (b && typeof b.template === 'string' ? b.template.trim() : null))
      .filter(Boolean);
    const usedSet = new Set(used);
    const chosenSet = new Set(chosenTemplates);
    const missing = chosenTemplates.filter((t) => !usedSet.has(t));
    const extra = [...usedSet].filter((t) => !chosenSet.has(t));
    const dupes = [...usedSet].filter((t) => used.filter((u) => u === t).length > 1);
    if (missing.length > 0 || extra.length > 0 || dupes.length > 0) {
      const parts = [];
      if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
      if (extra.length) parts.push(`not in your assigned list: ${extra.join(', ')}`);
      if (dupes.length) parts.push(`repeated: ${dupes.join(', ')}`);
      fieldErrors.push(`"beats" must use EXACTLY your assigned ${chosenTemplates.length} templates (${chosenTemplates.join(', ')}), one each - ${parts.join('; ')}`);
    }
  }

  // Thrown BEFORE handing anything to buildMographBeatVisual - see
  // validateCompactBeatVars' own doc comment for why: its silent-drop
  // behavior turns exactly this into an unhelpful generic error later,
  // so catching it here with specific per-beat reasons first is what
  // actually gives a retry something to fix.
  if (fieldErrors.length > 0) throw new Error(fieldErrors.join('; '));
  return { scenes };
}
function isPlainObjectLocal(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Same pattern sceneSchema.js's own MOGRAPH_ICON_RE uses (kept as a
// local copy rather than exported/imported - a one-line regex isn't
// worth wiring a new export through for).
const ICON_RE = /^[a-z0-9-]+:[a-z0-9-]+$/i;
function isRealIcon(v) { return typeof v === 'string' && ICON_RE.test(v); }

/**
 * Real, direct finding (2026-09-10): buildMographBeatVisual SILENTLY
 * drops a beat whose "vars" don't match its own dispatch conditions -
 * no per-field reason, it just never builds layers for it. A real local
 * test hit validateSceneJSON's own generic "every beat was dropped as
 * unusable" error with zero indication of WHICH field on WHICH beat was
 * wrong, giving the retry prompt nothing concrete to fix. This mirrors
 * buildMographBeatVisual's own per-template conditions EXACTLY (see its
 * own dispatch in sceneSchema.js) so a bad beat gets a specific,
 * actionable error instead - "beat[2] (mergeCluster): icons needs at
 * least 2 real Iconify names, got 1" is something a retry can actually
 * act on; "every beat was dropped" isn't.
 */
function validateCompactBeatVars(template, vars) {
  const icons = Array.isArray(vars.icons) ? vars.icons.filter(isRealIcon) : [];
  switch (template) {
    case 'nodeCluster':
      if (icons.length < 3) return `needs "icons": at least 3 real Iconify names (got ${icons.length} valid ones)`;
      return null;
    case 'connectorList': {
      const items = Array.isArray(vars.items) ? vars.items.filter((it) => isPlainObjectLocal(it) && isRealIcon(it.icon) && typeof it.label === 'string' && it.label.trim()) : [];
      if (items.length < 2) return `needs "items": at least 2 entries, each a real {icon,label} (got ${items.length} valid ones)`;
      return null;
    }
    case 'phoneSwap':
      if (typeof vars.text !== 'string' || !vars.text.trim()) return 'needs a non-empty "text" (the phone-screen headline)';
      if (!isRealIcon(vars.icon)) return 'needs a real Iconify "icon" to swap to';
      return null;
    case 'splitConverge':
      if (!isRealIcon(vars.icon)) return 'needs a real Iconify "icon"';
      return null;
    case 'mergeCluster':
      if (icons.length < 2) return `needs "icons": at least 2 real Iconify names (got ${icons.length} valid ones)`;
      if (!isRealIcon(vars.resultIcon)) return 'needs a real Iconify "resultIcon"';
      return null;
    case 'nodeClusterExtended':
      if (icons.length < 3) return `needs "icons": at least 3 real Iconify names (got ${icons.length} valid ones)`;
      if (!isRealIcon(vars.newIcon)) return 'needs a real Iconify "newIcon"';
      if (typeof vars.mergeText !== 'string' || !vars.mergeText.trim()) return 'needs a non-empty "mergeText"';
      return null;
    case 'textPopOut':
      if (typeof vars.text !== 'string' || !vars.text.trim()) return 'needs a non-empty "text"';
      return null;
    case 'squareSpin':
      if (typeof vars.text !== 'string' || !vars.text.trim()) return 'needs a non-empty "text"';
      if (!isRealIcon(vars.icon1)) return 'needs a real Iconify "icon1"';
      if (!isRealIcon(vars.icon2)) return 'needs a real Iconify "icon2"';
      return null;
    case 'tripleStack': {
      const items = Array.isArray(vars.items) ? vars.items.filter((it) => isPlainObjectLocal(it) && isRealIcon(it.icon) && typeof it.text === 'string' && it.text.trim()) : [];
      if (items.length !== 3) return `needs "items": exactly 3 entries, each a real {icon,text} (got ${items.length} valid ones)`;
      return null;
    }
    case 'nodeAbsorb': {
      if (!isRealIcon(vars.headerIcon)) return 'needs a real Iconify "headerIcon"';
      if (typeof vars.headerText !== 'string' || !vars.headerText.trim()) return 'needs a non-empty "headerText"';
      const items = Array.isArray(vars.items) ? vars.items.filter((it) => isPlainObjectLocal(it) && isRealIcon(it.icon) && typeof it.text === 'string' && it.text.trim()) : [];
      if (items.length !== 4) return `needs "items": exactly 4 entries, each a real {icon,text} (got ${items.length} valid ones)`;
      return null;
    }
    case 'textTiers': {
      // Real, confirmed-live failure (2026-09-11, a real local generation
      // for the topic "Money"): the model repeatedly missed the 5-10
      // word window on this specific field across 8+ separate attempts
      // (11, 3, 12, 16, 4, 29, 13, 4 words observed), exhausting the
      // whole retry budget and failing the generation outright. The
      // UPPER bound here was actively counterproductive: sceneSchema.js's
      // own dispatch branch already does `.slice(0, 10)` before ever
      // calling the builder, so an over-length phrase was ALWAYS
      // perfectly recoverable - this check was rejecting-and-retrying
      // something the builder could already handle for free. Dropped the
      // upper bound entirely; only the lower bound (a real correctness
      // requirement - splitTextTiersLines needs at least ~4-5 words to
      // produce a real, non-degenerate 3-line split) remains a hard
      // reject.
      const words = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (words.length < 5) return `needs "text": a real phrase of at least 5 words (got ${words.length} words) - it gets auto-split into 3 lines and auto-capped at 10 words if longer, no need to count precisely`;
      return null;
    }
    case 'blueprintText': {
      // Same "no redundant upper-bound reject" lesson as textTiers above
      // - sceneSchema.js's own dispatch branch already truncates each
      // sentence to 8 words, so only a real lower-bound floor (a single
      // word isn't a "sentence") is worth hard-rejecting here.
      const w1 = typeof vars.sentence1 === 'string' ? vars.sentence1.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const w2 = typeof vars.sentence2 === 'string' ? vars.sentence2.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (w1.length < 2) return `needs "sentence1": at least 2 words (got ${w1.length})`;
      if (w2.length < 2) return `needs "sentence2": at least 2 words (got ${w2.length})`;
      return null;
    }
    case 'yearScroller': {
      // No upper-bound reject on "year" either - sceneSchema.js's own
      // dispatch branch already clamps to [1870,2040] and rounds, same
      // "the builder already tolerates it gracefully" lesson as above.
      if (!Number.isFinite(vars.year)) return 'needs "year": a real number (a specific year, e.g. 1969 or 2027)';
      const tw = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (tw.length < 1) return 'needs "text": a real headline (at least 1 word) revealed after the scroller lands';
      return null;
    }
    case 'counter': {
      // No upper-bound reject on "value" - sceneSchema.js's own dispatch
      // branch already clamps to [1, 999999999] and rounds.
      if (!Number.isFinite(vars.value)) return 'needs "value": a real number to count up to (e.g. 45355)';
      // Real lower-bound floor: splitCounterCaptionLines (sceneSchema.js)
      // needs enough words for a real 2-line split where line 2 has
      // more words than line 1 - a 1-2 word caption degenerates to a
      // single line instead.
      const tw = typeof vars.text === 'string' ? vars.text.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (tw.length < 4) return `needs "text": a real caption of at least 4 words (got ${tw.length}) - it gets auto-split into 2 lines`;
      if (vars.icon !== undefined && !isRealIcon(vars.icon)) return `"icon" is optional, but if given must be a real "prefix:name" icon (got ${JSON.stringify(vars.icon)}) - omit it entirely if no icon is needed`;
      return null;
    }
    case 'lineReveal': {
      const w1 = typeof vars.text1 === 'string' ? vars.text1.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      const w2 = typeof vars.text2 === 'string' ? vars.text2.trim().split(/\s+/).filter((w) => w.length > 0) : [];
      if (w1.length < 1) return 'needs "text1": a real bold headline (at least 1 word)';
      if (w2.length < 1) return 'needs "text2": a real secondary line (at least 1 word)';
      return null;
    }
    default:
      return `"${template}" is not one of the 15 real template names`;
  }
}

/**
 * Real, direct frame-inspection finding (2026-09-09, "trash" quality
 * complaint): validateCompactBeatVars/isRealIcon above only check an
 * icon's own STRING SHAPE ("prefix:name") - never whether that icon
 * actually exists. The 8B model regularly invents plausible-sounding
 * names that don't ("mdi:unlock" - the real one is "mdi:lock-open",
 * "mdi:balance-scale" - the real one is "mdi:scale-balance"), which
 * iconFetch.js's own render-time fetch then 404s on, silently dropping
 * the icon and leaving an empty circle/ring/dot in the final video -
 * confirmed via direct frame extraction, not assumed. Fixed by verifying
 * every icon a beat actually resolved to BEFORE accepting the spec, so a
 * hallucinated name becomes a normal, specific retry error (same
 * mechanism validateCompactBeatVars already uses) instead of a broken
 * render nobody catches until a human watches it. Iconify's own bulk
 * "does this exist" endpoint (one request per PREFIX, not per icon -
 * typically 1-3 requests total for a whole generation since most icons
 * share "mdi:") makes this cheap enough to run on every attempt; fails
 * OPEN on a transport hiccup (skips verification rather than blocking
 * generation on Iconify's own uptime) since the existing render-time
 * fallback still keeps a genuinely-unreachable check from crashing a job.
 */
function collectIconNamesFromScenes(scenes) {
  const names = [];
  const walk = (layers) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      if (layer.type === 'image' && typeof layer.icon === 'string' && layer.icon.trim()) names.push(layer.icon);
      if (layer.type === 'precomp') walk(layer.layers);
    }
  };
  for (const scene of scenes) walk(scene.visual?.layers);
  return names;
}

// Real gap found (2026-09-10, direct user follow-up after the
// splitConverge fallback fix: "have u fix this" re: icons still
// occasionally rendering blank): this used to silently give up
// verification for a whole prefix on ANY single failure (a transient
// 429/500, a timeout) via a bare `if (!res.ok) return`, no retry at
// all - a bad/hallucinated icon name hitting that exact moment would
// slip through completely unverified and only surface later as a blank
// icon at render time. Retries with the same backoff-with-jitter
// pattern fetchAndRasterizeIcon (iconFetch.js) already uses, so a
// transient hiccup here no longer means "skip verification entirely".
const ICON_EXISTENCE_CHECK_MAX_ATTEMPTS = 3;
async function findNonexistentIcons(iconNames) {
  const uniqueNames = [...new Set(iconNames)].filter(isRealIcon);
  if (uniqueNames.length === 0) return [];
  const byPrefix = new Map();
  for (const full of uniqueNames) {
    const [prefix, ...rest] = full.split(':');
    const name = rest.join(':');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }
  const notFound = [];
  await Promise.all([...byPrefix.entries()].map(async ([prefix, names]) => {
    const url = `https://api.iconify.design/${encodeURIComponent(prefix)}.json?icons=${names.map(encodeURIComponent).join(',')}`;
    for (let attempt = 1; attempt <= ICON_EXISTENCE_CHECK_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, { timeout: 8000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const missing of data.not_found || []) notFound.push(`${prefix}:${missing}`);
        return;
      } catch (err) {
        if (attempt < ICON_EXISTENCE_CHECK_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1) + Math.random() * 200));
          continue;
        }
        // Fails OPEN only after exhausting real retries, not on the
        // first hiccup - a genuinely down Iconify shouldn't block
        // generation outright (the render-time fallback still catches
        // a truly-bad icon, just less gracefully than catching it here).
        console.warn(`[sceneGenClient] icon existence check failed for prefix "${prefix}" after ${attempt} attempt(s) (${err.message}) - skipping verification for these`);
      }
    }
  }));
  return notFound;
}

// Separate from TOTAL_STRUCTURAL_RETRY_BUDGET (3, tuned for the OLD,
// slow/paid OpenRouter path where every retry cost 60-100s+) - real
// local testing found the free 8B model occasionally needs more than 3
// attempts to land a fully valid spec (one real run hit "every beat
// dropped as unusable" 3 times in a row). Since a retry here costs
// single-digit seconds and nothing per call, a more generous budget is
// free real reliability, not a real latency tradeoff.
// 6 -> 10 -> 18 (2026-09-09): real local testing kept hitting full
// exhausted-budget failures even at 10, across a wide variety of
// DIFFERENT causes each time (narration hook style, a hallucinated icon
// name, an empty required field, a repeated-first-word mistake) - no
// single fix eliminates all of them, and a small 8B model landing every
// constraint at once is inherently probabilistic. A real timed run
// against this exact budget showed most individual retries fail fast
// (~2-3s each), so even a much larger budget stays well under the 220s+
// that drove the original move off OpenRouter - and outright failing the
// whole job is a strictly worse outcome than one more retry, for both
// the speed and quality complaints this pipeline exists to fix.
const COMPACT_RETRY_BUDGET = 18;

/**
 * The single Cloudflare call plus its own structural-retry loop -
 * mirrors generateWholeSceneJSON's own shape (parse -> build mograph ->
 * validate -> feed errors back -> retry) but against the much smaller
 * compact prompt/output, so a retry here is cheap (real measured speed:
 * 3-6s per call) rather than the 60-100s+ round trips the old OpenRouter
 * path paid for every retry.
 */
async function generateCompactBeatSpec(userPrompt, {
  retriesLeft = COMPACT_RETRY_BUDGET, priorErrors = null, chosenTemplates = null,
} = {}) {
  // Picked ONCE per generation, not re-rolled per retry - a real,
  // direct user requirement: "make them randomize but make it that if
  // a scene is chosen at random it cant be chosen again." A retry
  // passes the SAME chosenTemplates back through (see every recursive
  // call below) so it only ever fixes narration/vars issues, never
  // re-picks the template set mid-generation.
  const templates = chosenTemplates || pickRandomTemplates();
  const systemPrompt = buildCompactGenerationSystemPrompt(templates);
  let userMessage = `Topic: ${userPrompt}\n\nCreative angle for this generation: ${pickRandomCreativeAngle()}`;
  if (priorErrors) userMessage += `\n\nYour previous attempt was invalid:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected JSON.`;

  // 1500 -> 3000 -> 4096 (2026-09-09): a real local test hit finish_reason:
  // "length" at 1500, then AGAIN at 3000, once the model tried to write
  // out 6+ full beats worth of JSON (icons arrays, labels, a retry's own
  // echoed prior-error text, etc.) - Cloudflare's free tier has no
  // per-token cost the way the earlier paid MiniMax path did, so there's
  // no real downside to generous headroom here; calls stay in the
  // single-digit seconds regardless.
  let raw;
  try {
    // 0.8 -> 0.5 (2026-09-09): real local testing found this small 8B
    // model's own format/constraint adherence (exact beat count, valid
    // JSON shape, no repeated templates) was the actual bottleneck, not
    // a lack of creative variety - a lower temperature is the standard,
    // well-established lever for exactly that failure mode on a small
    // model, at the cost of somewhat less varied phrasing, which matters
    // far less here than actually landing a valid spec.
    raw = await callCloudflareRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens: 4096, temperature: 0.5 });
  } catch (err) {
    // Real, confirmed-live bug (2026-09-09): this call was never wrapped
    // in the retry loop at all - a transport failure (truncation, a
    // timeout, a Cloudflare hiccup) threw straight out of this whole
    // function regardless of how much retriesLeft budget remained,
    // killing the entire job on what should have just been one more
    // attempt. Retries are cheap here (single-digit seconds, free) -
    // there's no reason a transport blip should be fatal when a bad
    // JSON shape from the SAME call already gets retried below.
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] Cloudflare call failed (${err.message}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors, chosenTemplates: templates });
    }
    throw err;
  }
  let compact;
  try {
    compact = extractJson(raw);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] compact spec JSON parse failed (${err.message}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors: [`Your last response was not valid JSON: ${err.message}`], chosenTemplates: templates });
    }
    throw err;
  }

  let sceneJSON;
  try {
    sceneJSON = compileCompactSpecToSceneJSON(compact, templates);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] compact spec shape invalid (${err.message}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors: [err.message], chosenTemplates: templates });
    }
    throw err;
  }

  sceneJSON.scenes.forEach(buildMographBeatVisual);
  const { valid, errors } = validateSceneJSON(sceneJSON);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] compiled scene JSON failed validation (${errors.length} error(s)), retrying (${retriesLeft - 1} left): ${errors.slice(0, 3).join('; ')}`);
      return generateCompactBeatSpec(userPrompt, { retriesLeft: retriesLeft - 1, priorErrors: errors, chosenTemplates: templates });
    }
    throw new Error(`Generated scene JSON failed schema validation after retries: ${errors.join('; ')}`);
  }

  const notFoundIcons = await findNonexistentIcons(collectIconNamesFromScenes(sceneJSON.scenes));
  if (notFoundIcons.length > 0) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] ${notFoundIcons.length} icon(s) don't exist on Iconify (${notFoundIcons.join(', ')}), retrying (${retriesLeft - 1} left)...`);
      return generateCompactBeatSpec(userPrompt, {
        retriesLeft: retriesLeft - 1,
        priorErrors: [`These icon names don't exist on Iconify and must be replaced with real ones: ${notFoundIcons.join(', ')}`],
        chosenTemplates: templates,
      });
    }
    console.warn(`[sceneGenClient] ${notFoundIcons.length} icon(s) don't exist after exhausting retries (${notFoundIcons.join(', ')}) - shipping anyway, render-time fallback will drop them`);
  }

  return sceneJSON;
}

// targetDurationSeconds kept as a parameter (callers still pass it) but
// not used yet - the compact flow assigns each beat a flat base
// duration (COMPACT_BASE_DURATION above) rather than deriving pacing
// from a target total, since there's no real narration-audio length to
// size against right now anyway (TTS disabled). Worth revisiting - e.g.
// scaling COMPACT_BASE_DURATION per beat toward this target - if a real
// need for duration targeting comes up.
async function generateSceneJSON(userPrompt, targetDurationSeconds = 12) {
  console.log('[sceneGenClient] generating compact beat spec (Cloudflare Workers AI)...');
  return generateCompactBeatSpec(userPrompt);
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
