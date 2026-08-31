const { callGeminiRaw } = require('./geminiClient');

/**
 * Second-pass narration tagging - deliberately split from scene JSON
 * generation into its OWN focused step, per direct user request: the
 * main generation call writes a PLAIN spoken script (no tags at all,
 * so the model's attention there stays on writing something that
 * actually sounds like natural speech, not on juggling tag syntax at
 * the same time), then this file's job is exclusively "take that
 * plain script and mark it up for Fish Audio's real tag system"
 * (fishTtsGen.js/scenePrompts.js's own docs have the full verified tag
 * list this leans on).
 *
 * Two real risks with letting an LLM do 100% of this: (1) it might
 * miss a genuinely-needed sentence-ending pause - not acceptable for
 * that one HARD rule (every sentence-ender gets [break][break], no
 * exceptions - unlike mid-sentence commas, this one really is close to
 * universal in real speech), and (2) the tag names are new/unfamiliar
 * enough (this project's own earlier testing found a user-supplied tag
 * list had 2 wrong names) that a model could plausibly invent a
 * slightly-wrong tag. The sentence-ending rule is fixed by NOT trusting
 * the model's punctuation-pause placement alone there - ensurePauseTags
 * below runs as a deterministic, 100%-reliable regex pass AFTER the
 * model's own attempt, guaranteeing every sentence-ending mark gets its
 * required tag regardless of what the model did or didn't do (mid-
 * sentence comma pauses are deliberately NOT force-guaranteed this way
 * - see ensurePauseTags' own comment for why). Same "AI does the
 * judgment-based part, code guarantees the mechanical part" split this
 * codebase already uses throughout sceneSchema.js's auto-repair
 * pipeline, just narrower in scope than it used to be.
 */

// Deliberately pulled BACK to just two tag categories after direct
// user feedback: word-level [emphasis] (nuclear/contrastive stress,
// content-word tagging - real English phonetics, verified working in
// isolated tests) and [soft] were both tried and, in real full videos,
// judged to still not sound natural - "if not the emotional tags and
// the break tags, it shouldn't use any other tag." Only emotion tags
// (one per sentence, real mood) and [break] (pause timing) remain -
// everything else (tone tags, [emphasis], breath/sound tags) is
// removed from what the model is even offered, not just discouraged.
// [long-break] itself was later dropped too, per further direct
// feedback ("remove [long-break] completely, replace it with two
// breaks") - a longer pause is now just [break][break] back to back,
// so there is only ever one real pause tag in the whole system.
const TAGGING_SYSTEM_PROMPT = `You add Fish Audio TTS voice tags to a plain spoken script. Output ONLY the tagged script, no explanation, no markdown fences, no quotes around it.

Real, verified Fish Audio tags (use ONLY these exact names - no other tag names exist, and no other tags may be used at all, even ones you know are real Fish Audio tags):
Emotions: [happy] [sad] [angry] [excited] [calm] [nervous] [confident] [surprised] [satisfied] [delighted] [scared] [worried] [upset] [frustrated] [embarrassed] [disgusted] [proud] [relaxed] [grateful] [curious] [sarcastic] [confused] [disappointed] [hopeful] [determined]
Pause: [break]

RULES:
1. A comma, colon, or semicolon (, : ;) gets a [break] immediately after it ONLY where a real person speaking this sentence out loud would actually pause there. Many commas in fluent speech are spoken straight through with no pause at all, especially short ones or ones that don't mark a real breath/thought boundary - do not mechanically add [break] after every single one. Use real judgment about how this specific sentence would actually be spoken.
2. Insert [break][break] (two [break] tags back to back, no other text between them) immediately after EVERY sentence-ending mark (. ? ! or ...) in the script - every single one, not just some. Unlike mid-sentence commas, a brief pause between two separate sentences is natural essentially every time. There is no separate "long pause" tag - a longer pause is always written as two [break] tags in a row, never anything else.
3. Add ONE emotion tag at the start of each sentence where it genuinely fits the meaning.
4. Do NOT use any tag outside the two lists above - no tone tags, no [emphasis], no [soft], no breath/sound tags, no [long-break], nothing else, even if you believe it's a real Fish Audio tag.
5. Never invent a tag name that isn't in the list above.
6. Do not add, remove, or reword any of the actual spoken words - only insert bracket tags between them. The spoken text itself must stay byte-for-byte the same.

Example:
Input: "Ever wonder why cats knead blankets? It's actually a deep instinct, and it starts from when they were kittens."
Output: "[curious] Ever wonder why cats knead blankets? [break][break] It's actually a deep instinct, and it starts from when they were kittens. [break][break]"
(Note: no [break] after "instinct," in the example above - a real speaker would run that comma straight through, so it gets none.)`;

/**
 * Deterministic guarantee for rule 2 (sentence-enders) only - comma/
 * colon/semicolon pauses are now the tagging model's judgment call
 * (rule 1), not force-inserted here, per direct feedback ("there are
 * parts that dont need pauses" - real speech doesn't pause at every
 * comma, and a blanket mechanical rule can't tell which ones actually
 * want one). Sentence-boundary pauses stay guaranteed since that one
 * really is close to universal in real speech. Skips insertion where a
 * [break] is already immediately present (won't pile a third [break]
 * onto a spot that already has one or two). Ellipsis ("...") is
 * matched as ONE unit, not three separate sentence-enders.
 */
function ensurePauseTags(text) {
  return text.replace(/(\.{2,}|[.?!])(?!\s*\[break\])/g, '$1 [break][break]');
}

/** Strips every [tag] and collapses whitespace - what a tagged string's actual WORDS reduce to, for comparing against the original plain text. */
function stripTagsAndNormalize(text) {
  return text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Real, confirmed-live bug caught testing this file: the tagging model
 * doesn't just insert tags - on at least one real call it HALLUCINATED
 * entire extra sentences that were never in the input at all, a direct
 * violation of its own "do not add/remove/reword words" rule. Nothing
 * downstream would have caught that - ensurePauseTags only ever ADDS
 * pause tags, it has no concept of "is this still the same words" - so
 * a hallucinated script would have gone straight to TTS, producing
 * narration audio far longer than the beat's own visual timing was
 * ever built for. Fixed here: after tagging, strip every tag back out
 * and compare against the original plain text (normalized) - if they
 * don't match, the tagged version is discarded and mechanical-only
 * tagging is used instead, exactly like a call failure. Losing the
 * emotion tags on one beat is a real but minor loss; sending
 * hallucinated content to TTS is not something to risk.
 */
async function annotateNarrationTags(plainText, feedback = '') {
  const userMessage = feedback
    ? `${plainText}\n\n(A previous take of this exact script was reviewed by an audio QA judge and rejected - apply this specific feedback this time: ${feedback})`
    : plainText;
  try {
    const tagged = (await callGeminiRaw(TAGGING_SYSTEM_PROMPT, userMessage, { jsonMode: false, maxTokens: 1000, temperature: 0.4 })).trim();
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
