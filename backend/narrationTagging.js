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
 * miss a comma or period here and there - "close enough" for creative
 * writing, not acceptable for a HARD rule the user gave explicitly
 * ("[break] immediately after every comma-like mark, [long-break]
 * after every sentence-ender, no exceptions"), and (2) the tag names
 * are new/unfamiliar enough (this project's own earlier testing found
 * a user-supplied tag list had 2 wrong names) that a model could
 * plausibly invent a slightly-wrong tag. Both are fixed by NOT trusting
 * the model's punctuation-pause placement alone - ensurePauseTags below
 * runs as a deterministic, 100%-reliable regex pass AFTER the model's
 * own attempt, guaranteeing every comma/colon/semicolon and every
 * sentence-ending mark gets its required tag regardless of what the
 * model did or didn't do, the same "AI does the judgment-based part,
 * code guarantees the mechanical part" split this codebase already
 * uses throughout sceneSchema.js's auto-repair pipeline.
 */

// Deliberately pulled BACK to just two tag categories after direct
// user feedback: word-level [emphasis] (nuclear/contrastive stress,
// content-word tagging - real English phonetics, verified working in
// isolated tests) and [soft] were both tried and, in real full videos,
// judged to still not sound natural - "if not the emotional tags and
// the break tags, it shouldn't use any other tag." Only emotion tags
// (one per sentence, real mood) and break/long-break (pause timing)
// remain - everything else (tone tags, [emphasis], breath/sound tags)
// is removed from what the model is even offered, not just discouraged.
const TAGGING_SYSTEM_PROMPT = `You add Fish Audio TTS voice tags to a plain spoken script. Output ONLY the tagged script, no explanation, no markdown fences, no quotes around it.

Real, verified Fish Audio tags (use ONLY these exact names - no other tag names exist, and no other tags may be used at all, even ones you know are real Fish Audio tags):
Emotions: [happy] [sad] [angry] [excited] [calm] [nervous] [confident] [surprised] [satisfied] [delighted] [scared] [worried] [upset] [frustrated] [embarrassed] [disgusted] [proud] [relaxed] [grateful] [curious] [sarcastic] [confused] [disappointed] [hopeful] [determined]
Pauses: [break] [long-break]

HARD RULES, no exceptions:
1. Insert [break] immediately after EVERY comma, colon, or semicolon (, : ;) in the script - every single one, not just some.
2. Insert [long-break] immediately after EVERY sentence-ending mark (. ? ! or ...) in the script - every single one, not just some.
3. Add ONE emotion tag at the start of each sentence where it genuinely fits the meaning.
4. Do NOT use any tag outside the two lists above - no tone tags, no [emphasis], no [soft], no breath/sound tags, nothing else, even if you believe it's a real Fish Audio tag.
5. Never invent a tag name that isn't in the list above.
6. Do not add, remove, or reword any of the actual spoken words - only insert bracket tags between them. The spoken text itself must stay byte-for-byte the same.

Example:
Input: "Ever wonder why cats knead blankets? It's actually a deep instinct, from when they were kittens."
Output: "[curious] Ever wonder why cats knead blankets? [long-break] It's actually a deep instinct, [break] from when they were kittens. [long-break]"`;

/** Deterministic guarantee for the two pause rules - runs regardless of what the model did, so rules 1-2 above are never actually optional. Skips insertion where a break/long-break tag is already immediately present (avoids double-tagging a spot the model already got right). Ellipsis ("...") is matched as ONE unit, not three separate sentence-enders. */
function ensurePauseTags(text) {
  let out = text.replace(/([,:;])(?!\s*\[(?:break|long-break)\])/g, '$1 [break]');
  out = out.replace(/(\.{2,}|[.?!])(?!\s*\[(?:break|long-break)\])/g, '$1 [long-break]');
  return out;
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
async function annotateNarrationTags(plainText) {
  try {
    const tagged = (await callGeminiRaw(TAGGING_SYSTEM_PROMPT, plainText, { jsonMode: false, maxTokens: 1000, temperature: 0.4 })).trim();
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
