const { jsonrepair } = require('jsonrepair');
const { validateSceneJSON, validateBeat, buildMographBeatVisual } = require('./sceneSchema');
const {
  buildTreatmentSystemPrompt, buildMinimalGenerationSystemPrompt, buildEditSystemPrompt,
} = require('./scenePrompts');
const { callGroqRaw } = require('./groqClient');
const { callGeminiRaw } = require('./geminiClient');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

// Gemini-only transport, kept ONLY for generateEditedSceneJSON below -
// buildEditSystemPrompt shares SCHEMA_REFERENCE with the old rich
// generation prompt (~18,000 tokens, gpt-tokenizer-confirmed), nowhere
// close to fitting Groq's 8000 TPM ceiling without its own dedicated
// minimal rewrite (a separate, not-yet-done piece of work - editing
// wasn't the reported failure this session's fixes targeted). NOT used
// by beat generation any more - see callBeatJSONTransport below.
async function callSceneJSONTransport(systemPrompt, userMessage, maxTokens) {
  return callGeminiRaw(systemPrompt, userMessage, { jsonMode: true, maxTokens });
}

// Real, direct user demand this session: "REDUCE THE FUCKING INPUT" so
// Groq (free, fast, but a flat ~8000 TPM ceiling per key per request,
// checked against system+user+max_tokens as REQUESTED, not actual
// usage) can actually run the JSON-encoding step, not just the small
// treatment step. buildMinimalGenerationSystemPrompt measures at
// ~3,350 real tokens (gpt-tokenizer-measured) after MOGRAPH was added -
// a FIXED cost every call pays regardless of video length, since it's
// the same schema teaching every time.
//
// Real, confirmed-live failure this transport exists to prevent
// (2026-09-05): the OLD design sent the WHOLE video's treatment (every
// beat's own plan, concatenated) plus every beat's own retry error text
// in ONE call - both grow with video length AND with how many retries
// a round needs, so total request size was fundamentally unbounded
// against a FIXED ceiling. Confirmed live: "Request too large... Limit
// 8000, Requested 9351" on a completely ordinary 5-beat video, one
// retry round in. Direct user fix suggestion, implemented here exactly
// as described: "Split it into small chunks to give to grok" - one
// Groq call per BEAT (see generateOneBeatJSON below), not one call for
// the whole video. Each call's own user message is just ONE beat's own
// treatment text, a near-constant, small size regardless of how many
// beats the video has - the thing that used to grow unboundedly is
// gone entirely, not just budgeted more carefully around.
//
// Gemini fallback REMOVED, direct user instruction (2026-09-05): "I
// DONT WANT IT TO EVER FALL BACK TO GEMINI, I WANT GROK." Groq alone
// now, relying on callGroqRaw's own more-patient retry budget (see its
// own doc comment) plus generateOneBeatJSON's OWN outer retry (a
// transport failure is caught there the same way a validation failure
// already was, not left to throw uncaught) to outlast a rate-limit
// window rather than escalate to a second provider.
//
// jsonMode (Groq's response_format:{type:"json_object"}) turned OFF
// here, direct fix for a real, confirmed-live, repeat failure: two
// separate production runs both hit "json_validate_failed" with a
// completely EMPTY failed_generation - Groq's OWN server-side JSON
// validator rejecting the response with nothing recoverable, not a
// truncation (finish_reason wasn't "length") and not a rate limit
// (no 429 involved). generateCreativeTreatment, right above in this
// same file, has been 100% reliable across every real test today - the
// one difference is it never sets jsonMode at all, just asks for JSON
// as plain text and leans on extractJson's own robust extraction
// (finds the outermost {...}) plus jsonrepair as a fallback for minor
// syntax slips. Matching that proven-reliable approach here instead of
// continuing to fight openai/gpt-oss-120b's apparent occasional
// instability under Groq's separate json_object constrained-decoding
// path - the system prompt already tells the model to output ONLY a
// compact JSON object either way, so this only removes the extra Groq-
// side validation layer that kept failing, not the instruction itself.
async function callBeatJSONTransport(systemPrompt, userMessage, maxTokens) {
  return callGroqRaw(systemPrompt, userMessage, { jsonMode: false, maxTokens });
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
    // this reason text gets re-injected into every beat's own next
    // encode round (see generateOneBeatJSON) - a real 413 was caused
    // live by an unbounded version of this same text once already.
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
// TPM PER KEY, checked against CUMULATIVE usage within a rolling
// minute, not just this one call's own size.
//
// Real, confirmed-live regression (2026-09-05): cut further to 3200 in
// an earlier pass of this same fix, on the strength of ONE measured
// real treatment needing only ~2767 tokens - but a real production
// video hit a genuinely LONGER treatment (more beats/detail, this
// call's own output has real variance across topics/durations) that
// needed more than 3200 and got hard-truncated - "Groq response was
// truncated (hit max_tokens=3200) before completing" - which had NO
// retry at all here, killing the entire job outright. A hard failure is
// far worse than the token-budget squeeze this was trying to reduce, so
// this reverts to 5000 (real margin above the one measured real case,
// short of the original 5500) AND adds actual retry-with-escalation
// below, so a rare unusually-long treatment gets a genuine second shot
// at a higher cap instead of killing the job.
const TREATMENT_MAX_TOKENS_STEPS = [5000, 7000];
async function generateCreativeTreatment(userPrompt, targetDurationSeconds, attempt = 0) {
  const creativeAngle = pickRandomCreativeAngle();
  console.log(`[sceneGenClient] creative angle for this generation: ${creativeAngle}`);
  const systemPrompt = buildTreatmentSystemPrompt(targetDurationSeconds, creativeAngle);
  try {
    return await callGroqRaw(systemPrompt, userPrompt, { jsonMode: false, maxTokens: TREATMENT_MAX_TOKENS_STEPS[attempt], temperature: 0.85 });
  } catch (err) {
    if (attempt + 1 < TREATMENT_MAX_TOKENS_STEPS.length) {
      console.warn(`[sceneGenClient] treatment call failed (${err.message}), retrying with a higher token cap...`);
      return generateCreativeTreatment(userPrompt, targetDurationSeconds, attempt + 1);
    }
    throw err;
  }
}

// Splits a treatment's plain-prose HOOK/PALETTE section off (never sent
// to the per-beat call - it's director's-notes-to-self, not part of any
// one beat's own plan) and the rest into one chunk per "===BEAT n==="
// section, each chunk keeping its own header line. Mirrors
// listTreatmentBeatHeaders' own BEAT_HEADER_RE exactly (duplicated
// rather than imported - scenePrompts.js doesn't export the regex
// itself, just the header-listing function built on it).
const BEAT_HEADER_RE = /===\s*BEAT\s+\d+\s*===[^\n]*/gi;
function splitTreatmentIntoBeats(treatment) {
  const indices = [];
  let m;
  const re = new RegExp(BEAT_HEADER_RE.source, BEAT_HEADER_RE.flags);
  while ((m = re.exec(treatment))) indices.push(m.index);
  if (indices.length === 0) return [treatment.trim()].filter(Boolean);
  return indices.map((start, i) => treatment.slice(start, indices[i + 1] ?? treatment.length).trim());
}

// Generates and validates exactly ONE beat - the direct fix for a real,
// confirmed-live failure (2026-09-05): the OLD design sent the WHOLE
// treatment plus accumulated retry-error text in ONE Groq call, both of
// which grow with video length/retry count against Groq's FIXED 8000
// TPM ceiling - confirmed live: "Request too large... Limit 8000,
// Requested 9351" on an ordinary 5-beat video. Direct user fix
// suggestion, implemented exactly as described: "Split it into small
// chunks to give to grok." Each call's own userMessage is just ONE
// beat's own treatment text - small and essentially CONSTANT size
// regardless of total video length, so the thing that used to grow
// unboundedly against a fixed ceiling is structurally gone, not just
// budgeted more carefully around.
async function generateOneBeatJSON(userPrompt, beatText, beatIndex, totalBeats, systemPrompt, { retriesLeft = 6, priorErrors = null, judgeFeedback = null } = {}) {
  let userMessage = `Video topic: ${userPrompt}\nThis is beat ${beatIndex + 1} of ${totalBeats} in the video.\nEncode this ONE beat EXACTLY and faithfully as a single Beat object matching the schema above (the top-level object itself, NOT wrapped in a "scenes" array - just {"params":...,"mograph":...}, with "mograph" a TOP-LEVEL sibling of "params", never nested inside "visual" - leave "visual" out entirely when you set "mograph", it fills in automatically). The plan may reference sound cues/audio for pacing feel (a "clink", a "whoosh") - this engine has no sound-effect field, only spoken narration via params.narration, so translate any such cue into a well-timed VISUAL beat instead. Only use real fields from the schema above.\n\nThis beat's own plan:\n${beatText}`;
  if (judgeFeedback) userMessage += `\n\nA brutal judge rejected the previous full script as boring: "${judgeFeedback}" Make THIS beat's narration genuinely sharper and more hooked, not generic - keep the same core idea.`;
  if (priorErrors) userMessage += `\n\nYour previous attempt at this beat was invalid:\n${priorErrors.join('\n')}\n\nFix these specific problems and output the complete, corrected single Beat object.`;

  // maxTokens history on this call, real measured evidence at each
  // step, not guesses: 1500 (original) -> 600 (real json_validate_failed,
  // jsonMode:true) -> 1000 (still real json_validate_failed under load)
  // -> now 1000 with jsonMode OFF hit REPEATED real truncation instead
  // ("hit max_tokens=1000 before completing") - openai/gpt-oss-120b's
  // own reasoning tokens (see callBeatJSONTransport's own doc comment
  // for why jsonMode is off) count against this SAME budget, and
  // apparently need real room on their own before any JSON gets
  // written, regardless of how small the actual JSON answer is (a
  // maxed-out beat's real JSON is only ~120 tokens by itself). Raised to
  // 2200 - a genuine, confirmed-necessary increase, not a reversion to
  // guessing small - still a real cut from the original 1500 in
  // intent/footprint terms is no longer the safe move here; reliability
  // (this call actually completing) matters more than shaving this
  // specific number down further.
  let raw;
  try {
    raw = await callBeatJSONTransport(systemPrompt, userMessage, 2200);
  } catch (err) {
    // Real, direct consequence of removing the Gemini fallback (user
    // instruction: "I DONT WANT IT TO EVER FALL BACK TO GEMINI, I WANT
    // GROK") - callBeatJSONTransport no longer has anywhere else to go
    // on a transport failure, so THIS retry loop (on top of
    // callGroqRaw's own internal one) is what has to actually outlast a
    // persistent rate-limit window instead.
    //
    // Real, confirmed-live bug this backoff fixes (found via a deep-dive
    // stress test, 2026-09-05): this retry used to recurse IMMEDIATELY,
    // no delay at all - a transient network blip (confirmed live: a
    // brief "getaddrinfo ENOTFOUND api.groq.com" DNS failure) got hit 6
    // times in a row, all within milliseconds, burning the ENTIRE retry
    // budget before the transient issue had any real chance to clear,
    // then hard-failing the whole beat. callGroqRaw's own 429 handling
    // already backs off before retrying; this outer layer never did.
    // Same exponential-with-jitter shape, so a real network hiccup (DNS,
    // a dropped connection, a momentary host issue) gets genuine time to
    // resolve instead of being retried into the ground instantly.
    if (retriesLeft > 0) {
      const attempt = 6 - retriesLeft;
      const backoffMs = Math.min(1500 * 2 ** attempt, 15000) + Math.random() * 500;
      console.warn(`[sceneGenClient] beat ${beatIndex} Groq transport failed (${err.message}), waiting ${Math.round(backoffMs)}ms before retry (${retriesLeft} left)...`);
      await sleep(backoffMs);
      return generateOneBeatJSON(userPrompt, beatText, beatIndex, totalBeats, systemPrompt, { retriesLeft: retriesLeft - 1, priorErrors, judgeFeedback });
    }
    throw err;
  }
  let beat;
  try {
    beat = extractJson(raw);
  } catch (err) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] beat ${beatIndex} JSON parse failed (${err.message}), retrying...`);
      return generateOneBeatJSON(userPrompt, beatText, beatIndex, totalBeats, systemPrompt, { retriesLeft: retriesLeft - 1, priorErrors, judgeFeedback });
    }
    throw err;
  }

  const hadMographAttempt = beat && typeof beat === 'object' && beat.mograph && typeof beat.mograph === 'object';
  // Mechanical enforcement, direct user instruction (2026-09-05): "MAKE
  // MOTION GRAPHICS THE MAIN THING... THIS VID IS STILL BAD CUZ IT'S
  // STILL GOING BACK TO THE OLD TEXT FIRST SYSTEM" - a real generation
  // came back with only 1 of 5 beats using mograph, the rest falling
  // back to a raw "layers" array. The schema always allowed that
  // fallback for a beat that "genuinely doesn't fit" any mograph type,
  // but prompt wording alone clearly isn't enough to make the model
  // reach for mograph as the DEFAULT rather than an occasional pick -
  // this session's own repeated lesson (narration length, hook openers,
  // now this). Rejecting a beat that skipped "mograph" entirely forces
  // every retry to genuinely attempt it; only gives up and accepts a
  // raw beat once retries are fully exhausted, so a beat that truly
  // can't fit mograph after real attempts still ships instead of
  // failing the whole video.
  if (!hadMographAttempt && retriesLeft > 0) {
    const err = 'mograph: this beat has no "mograph" field at all - REQUIRED. Every beat must be one of nodeCluster/connectorList/phoneSwap (see MOGRAPH above) - do not write a raw "visual":{"layers":[...]} array. Look at this beat\'s own plan again and pick whichever of the three types genuinely fits it best - a beat about a list of things is connectorList, a beat introducing/focusing on one idea among several is nodeCluster, a beat about an app/tool/screen is phoneSwap. Output the corrected Beat object with a real top-level "mograph" field.';
    console.warn(`[sceneGenClient] beat ${beatIndex} skipped mograph entirely, retrying: ${err}`);
    return generateOneBeatJSON(userPrompt, beatText, beatIndex, totalBeats, systemPrompt, { retriesLeft: retriesLeft - 1, priorErrors: [err], judgeFeedback });
  }
  buildMographBeatVisual(beat);
  // Real, confirmed-live gap this closes: when a "mograph" spec is
  // present but malformed (too few icons, bad type name, ...),
  // buildMographBeatVisual deliberately leaves beat.visual untouched
  // rather than guessing - validateBeat then fails with a generic
  // "visual.layers is required" error that never mentions "mograph" at
  // all, which reads to the model as "you forgot layers", not "your
  // mograph spec was wrong" - a real production run confirmed this
  // exact confusion (a beat that DID attempt "mograph" got this generic
  // error, then gave up on mograph entirely on retry). Detected here by
  // checking whether a mograph attempt existed but visual.layers still
  // never materialized, and given its own explicit, actionable error
  // instead of falling through to the generic one.
  const mographSilentlyFailed = hadMographAttempt && !(beat.visual && Array.isArray(beat.visual.layers));
  if (mographSilentlyFailed) {
    // Real, confirmed-live bug found via a deep-dive stress test
    // (2026-09-05): a beat told its mograph spec was malformed
    // sometimes "fixed" it on retry by DROPPING "mograph" entirely and
    // writing raw "layers" instead - which then immediately triggered
    // the OTHER mandatory-mograph rejection above, bouncing the model
    // between two different corrections instead of converging. The
    // message now states explicitly, up front, not to do that, and
    // gives one concrete worked example of the exact shape expected
    // (not just a field-by-field description) so there's a real correct
    // answer to copy the pattern of, not just rules to interpret.
    const typeLabel = typeof beat.mograph.type === 'string' ? `"${beat.mograph.type}"` : '(missing entirely)';
    const err = `mograph: your "mograph" spec (type ${typeLabel}) could not be built. DO NOT remove "mograph" or fall back to a raw "visual" layers array - fix the spec's fields instead, it still must stay a TOP-LEVEL "mograph" field. Required fields per type: nodeCluster needs "type":"nodeCluster", "icons" (3-8 real Iconify names), "chosenIndex" (a number, 0-based, less than icons.length). connectorList needs "type":"connectorList", "items" (2-6 objects, each {"icon":"...", "label":"..."}). phoneSwap needs "type":"phoneSwap", "text" (a string), "icon" (a real Iconify name). Worked example: {"type":"nodeCluster","icons":["mdi:heart","mdi:brain","mdi:water"],"chosenIndex":0,"accentColor":"#8B5CF6"} - match this exact shape for whichever type fits this beat.`;
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] beat ${beatIndex} mograph spec malformed, retrying: ${err}`);
      return generateOneBeatJSON(userPrompt, beatText, beatIndex, totalBeats, systemPrompt, { retriesLeft: retriesLeft - 1, priorErrors: [err], judgeFeedback });
    }
    throw new Error(`Groq-generated beat ${beatIndex}: ${err}`);
  }

  const { valid, errors } = validateBeat(beat, `beat${beatIndex}`);
  if (!valid) {
    if (retriesLeft > 0) {
      console.warn(`[sceneGenClient] beat ${beatIndex} failed validation (${errors.length} error(s)), retrying: ${errors.slice(0, 2).join('; ')}`);
      return generateOneBeatJSON(userPrompt, beatText, beatIndex, totalBeats, systemPrompt, { retriesLeft: retriesLeft - 1, priorErrors: errors, judgeFeedback });
    }
    throw new Error(`Groq-generated beat ${beatIndex} failed schema validation after retries: ${errors.join('; ')}`);
  }
  return beat;
}

// Outer assembly: one generateOneBeatJSON call per beat, SEQUENTIAL -
// not Promise.all - direct fix for a real, confirmed-live 429-storm
// (2026-09-05): firing every beat's own call at once round-robins them
// across keys, but they all LAND at once too, piling several calls onto
// the SAME still-hot key (its cumulative usage-this-minute already high
// from whatever landed there moments earlier) before any of them has a
// chance to complete and reveal whether that key even has room. Doing
// them one at a time doesn't change the underlying per-key TPM math,
// but it stops the pile-up itself - a call that lands on a hot key now
// just retries onto the OTHER key on its own next attempt, instead of
// several calls compounding the same collision simultaneously. Slower
// in the best case (no free concurrency), but real production logs
// showed the parallel version wasn't actually faster anyway once a
// 429-storm hit - it was slower AND noisy.
//
// Then the FULL validateSceneJSON on the assembled {scenes:[...]} for
// the whole-video-level checks per-beat validation alone can't do (the
// opening-hook check, ensureCumulativeListBeats, varyHeadlinePositions,
// the shared background-decoration seed). Beat COUNT is structurally
// guaranteed correct by construction now (exactly one call per treatment
// beat, each retried until individually valid) - the old "beat count
// came back short" check is gone because there's no longer a way for it
// to happen.
//
// A residual whole-scene-level error (rare - individual beats already
// passed their own validateBeat) is repaired by regenerating ONLY the
// specific beat(s) named in the error (parsed from "scenes[N]." prefix),
// not the whole video - same "small, targeted retry" principle as the
// per-beat generation itself, also sequential for the same reason.
const MAX_WHOLE_SCENE_REPAIR_ROUNDS = 3;
async function generateAllBeatsJSON(userPrompt, targetDurationSeconds, treatment, judgeFeedback) {
  const systemPrompt = buildMinimalGenerationSystemPrompt(targetDurationSeconds);
  const beatChunks = splitTreatmentIntoBeats(treatment);
  const beats = [];
  for (let i = 0; i < beatChunks.length; i++) {
    beats.push(await generateOneBeatJSON(userPrompt, beatChunks[i], i, beatChunks.length, systemPrompt, { judgeFeedback }));
  }

  for (let round = 0; round <= MAX_WHOLE_SCENE_REPAIR_ROUNDS; round++) {
    const sceneJSON = { scenes: beats };
    const { valid, errors } = validateSceneJSON(sceneJSON);
    if (valid) return sceneJSON;
    if (round === MAX_WHOLE_SCENE_REPAIR_ROUNDS) {
      throw new Error(`Groq-generated scene JSON failed whole-scene validation after ${MAX_WHOLE_SCENE_REPAIR_ROUNDS} repair rounds: ${errors.join('; ')}`);
    }
    const byBeatIndex = new Map();
    const unindexed = [];
    for (const err of errors) {
      const m = err.match(/^scenes\[(\d+)\]/);
      if (m) {
        const idx = Number(m[1]);
        if (!byBeatIndex.has(idx)) byBeatIndex.set(idx, []);
        byBeatIndex.get(idx).push(err);
      } else {
        unindexed.push(err);
      }
    }
    if (byBeatIndex.size === 0) {
      // No single beat to blame (a genuinely whole-video-level problem,
      // e.g. the root object shape itself) - nothing targeted to retry.
      throw new Error(`Groq-generated scene JSON failed whole-scene validation with no specific beat to repair: ${unindexed.join('; ')}`);
    }
    console.warn(`[sceneGenClient] whole-scene validation found ${byBeatIndex.size} beat(s) needing repair (round ${round + 1}/${MAX_WHOLE_SCENE_REPAIR_ROUNDS}): ${[...byBeatIndex.keys()].join(',')}`);
    // Sequential, same reasoning as the initial per-beat loop above -
    // see its own doc comment.
    for (const [idx, beatErrors] of byBeatIndex.entries()) {
      if (idx >= beatChunks.length) continue; // stale index from a prior round's now-fixed array shape
      beats[idx] = await generateOneBeatJSON(userPrompt, beatChunks[idx], idx, beatChunks.length, systemPrompt, { priorErrors: beatErrors, judgeFeedback });
    }
  }
  // Unreachable (the loop above always returns or throws), kept only to
  // satisfy control-flow analysis.
  return { scenes: beats };
}

// Real, direct user request: "the first AI will be generated and give
// it to this new AI, the new ai will make corrections and give it back
// to the first ai to regenerate... the cycle will repeat over and over
// till we get a VERY NICE INTERESTING EYECATCHING SCROLLSTOPPING
// script." Wired as its own outer loop, separate from
// generateAllBeatsJSON's own schema-validation retries (a script can
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
    console.log(`[sceneGenClient] encoding scene, one beat at a time (script round ${round}/${MAX_JUDGE_ROUNDS})...`);
    sceneJSON = await generateAllBeatsJSON(userPrompt, targetDurationSeconds, treatment, judgeFeedback);

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
