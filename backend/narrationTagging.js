const { callMistralRaw } = require('./mistralClient');

/**
 * Second-pass narration tagging - deliberately split from scene JSON
 * generation into its OWN focused step, per direct user request: the
 * main generation call writes a PLAIN spoken script (no tags at all,
 * so the model's attention there stays on writing something that
 * actually sounds like natural speech, not on juggling tag/pause
 * syntax at the same time), then this file's job is exclusively "take
 * that plain script and mark it up for Fish Audio" - emotion tags
 * (fishTtsGen.js/scenePrompts.js's own docs have the full verified tag
 * list this leans on) plus pause placement.
 *
 * Pauses used to be a real Fish Audio bracket tag, [break] (doubled up
 * for a longer pause at sentence ends). Real, precisely diagnosed
 * finding from direct A/B testing: across every temperature setting
 * tried (0.4, 1.0, 1.5 - temperature was never the actual variable),
 * a script ending in the literal bracket sequence "[break][break]"
 * hallucinated a trailing non-speech sound (a breath, a stray word)
 * on effectively every attempt for at least one real sentence -
 * removing that trailing tag sequence and sending NOTHING after the
 * period instead measured 2 clean takes out of 3 on the exact same
 * sentence, where every prior config (any temperature, WITH the tag)
 * had measured 0. The working theory: an artificial bracket tag sitting
 * right at the end of the input is a token sequence Fish Audio's model
 * never saw much of in training, so its stop-generation behavior gets
 * confused into thinking more content follows. An ellipsis ("...") is
 * real, extremely common punctuation - the model has genuine, well-
 * trained behavior for it - so replacing the tag with literal "..." in
 * the actual text (direct user request) gets the same "trail off/pause
 * here" effect through a token sequence the model already knows how to
 * end cleanly after, instead of an artificial one it doesn't.
 *
 * Two real risks with letting an LLM do 100% of the placement: (1) it
 * might miss a genuinely-needed sentence-ending pause - not acceptable
 * for that one HARD rule (every sentence-ender gets a trailing "...",
 * no exceptions - unlike mid-sentence commas, this one really is close
 * to universal in real speech), and (2) letting the model reword things
 * while it's at it. Both are fixed the same way as before: ensurePauseTags
 * runs as a deterministic, 100%-reliable regex pass AFTER the model's
 * own attempt (mid-sentence comma pauses are deliberately NOT force-
 * guaranteed this way - see its own comment for why), and
 * stripTagsAndNormalize's hallucination guard compares actual words
 * before trusting the model's output at all.
 */

// Emotion bracket tags ([calm], [confident], etc.) were dropped from
// this prompt when the production engine switched from Fish Audio to
// Deepgram's Aura-2 - Fish Audio had real, verified support for that
// exact tag list, but Deepgram has no SSML/bracket-tag support on its
// roadmap, so a literal "[calm]" in the text risks being read aloud as
// text rather than interpreted, a real regression, not just a wasted
// tag. Pause punctuation stays - Deepgram's own docs confirm the same
// mechanism this project already uses (commas/periods -> short pauses,
// "..." -> longer ones), so the judgment call this prompt makes about
// WHICH commas deserve a pause still carries real value under the new
// engine.
const TAGGING_SYSTEM_PROMPT = `You add natural pause punctuation to a plain spoken script, for a real TTS engine to read aloud. Output ONLY the tagged script, no explanation, no markdown fences, no quotes around it.

Pauses are real ellipsis punctuation ("...") inserted directly into the text itself, exactly like a person's writing would show a trailing-off pause.

RULES:
1. A comma, colon, or semicolon (, : ;) gets "..." inserted immediately after it ONLY where a real person speaking this sentence out loud would actually pause there. Many commas in fluent speech are spoken straight through with no pause at all, especially short ones or ones that don't mark a real breath/thought boundary - do not mechanically add a pause after every single one. Use real judgment about how this specific sentence would actually be spoken. Keep the original comma/colon/semicolon in place; the "..." is added right after it, not instead of it.
2. Insert "..." immediately after EVERY sentence-ending mark (. ? ! or an existing ...) in the script - every single one, not just some. Unlike mid-sentence commas, a brief pause between two separate sentences is natural essentially every time. Keep the original punctuation mark in place; "..." follows it.
3. Do NOT use any bracket tag, of any kind, anywhere in the output - no emotion tags, no tone tags, no [break], no [emphasis], no [soft], no breath/sound tags, nothing else, even if you believe it's real. The target engine has no tag support at all; a bracket tag in the output would be read aloud as literal text.
4. Do not add, remove, or reword any of the actual spoken words - only insert "..." between them. The spoken text itself must stay byte-for-byte the same.

Example:
Input: "Ever wonder why cats knead blankets? It's actually a deep instinct, and it starts from when they were kittens."
Output: "Ever wonder why cats knead blankets? ... It's actually a deep instinct, and it starts from when they were kittens. ..."
(Note: no pause after "instinct," in the example above - a real speaker would run that comma straight through, so it gets none.)`;

/**
 * Deterministic guarantee for rule 2 (sentence-enders) only - comma/
 * colon/semicolon pauses are the tagging model's judgment call (rule
 * 1), not force-inserted here, per direct feedback ("there are parts
 * that dont need pauses" - real speech doesn't pause at every comma,
 * and a blanket mechanical rule can't tell which ones actually want
 * one). Sentence-boundary pauses stay guaranteed since that one really
 * is close to universal in real speech. Skips insertion where "..."
 * already immediately follows (won't pile on a spot the model already
 * got right). An existing ellipsis (2+ dots, whether it's the model's
 * own inserted pause or genuine "..." in the original writing) already
 * IS a pause and is left completely alone - only a bare ., ?, or !
 * gets one appended.
 */
function ensurePauseTags(text) {
  return text.replace(/(\.{2,})|([.?!])(?!\s*\.\.\.)/g, (match, ellipsis, single) => (ellipsis ? ellipsis : `${single} ...`));
}

/**
 * Strips every [emotion tag] and every piece of PURE punctuation
 * (ellipsis, comma, semicolon, colon, em/en dash), replacing each with
 * a single space before collapsing whitespace - what a tagged string's
 * actual SPOKEN WORDS reduce to, for comparing against the original
 * plain text. This function had real, confirmed-live bugs of its own,
 * found chasing a "the voice sounds robotic" report that turned out to
 * be caused by this guard's own false positives, not the voice itself:
 * (1) Only ellipsis was stripped, and to a SPACE - fine when the
 * removed text already sat between two spaced words, but a false
 * mismatch whenever a pause got inserted directly against punctuation
 * with no surrounding space of its own (e.g. an em-dash written with
 * no spaces: "better—dogs" -> tagged "better...—dogs" -> stripped
 * became "better —dogs", a phantom space the original never had).
 * (2) Commas/semicolons/colons/dashes were never stripped at all -
 * real, observed behavior: this project's tagging model reliably
 * REPLACES the original comma/dash with "..." (e.g. "cues, picking" ->
 * "cues... picking", or drops an em-dash entirely) instead of keeping
 * both as instructed. Punctuation is never a spoken word, so it should
 * never have been part of this comparison at all.
 * Fixed by replacing EVERY one of these with a plain space (not
 * removing outright, which caused its own asymmetry when the original
 * text had no surrounding whitespace) and letting the whitespace-
 * collapse pass normalize the result either way. Together the old
 * bugs meant nearly every real generation fell back to mechanical-only
 * tagging (losing ALL comma/dash-pause judgment on every beat) even
 * when the model's actual output was perfectly safe - confirmed
 * directly against 5 real failing cases from production logs, all 5
 * now correctly match; a genuine hallucination (an entire extra
 * sentence never in the original) still correctly fails to match and
 * still correctly falls back to mechanical tagging.
 */
function stripTagsAndNormalize(text) {
  return text.replace(/\[[^\]]*\]/g, ' ').replace(/\.{2,}/g, ' ').replace(/[,;:—–]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Real, confirmed-live bug caught testing this file: the tagging model
 * doesn't just insert tags - on at least one real call it HALLUCINATED
 * entire extra sentences that were never in the input at all, a direct
 * violation of its own "do not add/remove/reword words" rule. Nothing
 * downstream would have caught that - ensurePauseTags only ever ADDS
 * pause punctuation, it has no concept of "is this still the same
 * words" - so a hallucinated script would have gone straight to TTS,
 * producing narration audio far longer than the beat's own visual
 * timing was ever built for. Fixed here: after tagging, strip every
 * tag and pause mark back out and compare against the original plain
 * text (normalized) - if they don't match, the tagged version is
 * discarded and mechanical-only tagging is used instead, exactly like
 * a call failure. Losing the emotion tags on one beat is a real but
 * minor loss; sending hallucinated content to TTS is not something to
 * risk.
 */
// Real, confirmed-live bug found via production logs: this used to call
// Groq (like sceneGenClient.js's treatment step) - but this file runs
// its call for EVERY beat IN PARALLEL (narrationPrefetch.js's
// Promise.all), right after the treatment call already spent Groq's
// entire 8000 TPM budget for that minute. Result: some beats' tagging
// calls got real LLM comma-pause judgment, others hit a 429 and fell
// back to mechanical-only tagging (still safe - see ensurePauseTags -
// but no comma-pause judgment at all) - INCONSISTENT pacing between
// beats within the SAME video, a real, if subtle, cause of a video
// reading as "off" even with no single beat outright broken. Moved to
// Mistral instead - a separate provider with its own much larger
// budget (500,000 TPM vs Groq's 8000), so this no longer competes with
// the treatment call at all.
async function annotateNarrationTags(plainText, feedback = '') {
  const userMessage = feedback
    ? `${plainText}\n\n(A previous take of this exact script was reviewed by an audio QA judge and rejected - apply this specific feedback this time: ${feedback})`
    : plainText;
  try {
    const tagged = (await callMistralRaw(TAGGING_SYSTEM_PROMPT, userMessage, { jsonMode: false, maxTokens: 1000, temperature: 0.4 })).trim();
    if (stripTagsAndNormalize(tagged) !== stripTagsAndNormalize(plainText)) {
      console.warn(`[narrationTagging] tagged text changed the actual words (likely hallucinated content) - using mechanical pause tags only. Original: "${plainText}" | Got: "${tagged}"`);
      return ensurePauseTags(plainText);
    }
    return ensurePauseTags(tagged);
  } catch (err) {
    console.warn(`[narrationTagging] tag annotation failed, using mechanical pause tags only: ${err.message}`);
    return ensurePauseTags(plainText);
  }
}

module.exports = { annotateNarrationTags, ensurePauseTags };
