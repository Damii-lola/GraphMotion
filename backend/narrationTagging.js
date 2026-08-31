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

const TAGGING_SYSTEM_PROMPT = `You add Fish Audio TTS voice tags to a plain spoken script. Output ONLY the tagged script, no explanation, no markdown fences, no quotes around it.

Real, verified Fish Audio tags (use ONLY these exact names - no other tag names exist):
Emotions: [happy] [sad] [angry] [excited] [calm] [nervous] [confident] [surprised] [satisfied] [delighted] [scared] [worried] [upset] [frustrated] [embarrassed] [disgusted] [proud] [relaxed] [grateful] [curious] [sarcastic] [confused] [disappointed] [hopeful] [determined]
Tone: [whispering] [soft] [emphasis] [shouting] [in a hurry tone]
Breath/sound: [laughing] [chuckling] [sighing] [gasping] [clear throat] [panting] [groaning]
Pauses: [break] [long-break]

HARD RULES, no exceptions:
1. The script MUST start with [soft] before anything else.
2. Insert [break] immediately after EVERY comma, colon, or semicolon (, : ;) in the script - every single one, not just some.
3. Insert [long-break] immediately after EVERY sentence-ending mark (. ? ! or ...) in the script - every single one, not just some.
4. Beyond rules 2-3, add 1-3 emotion/tone tags per sentence where they genuinely fit the meaning - place emotion tags at the START of the sentence they apply to. Don't tag every single word; use judgment.
5. Never invent a tag name that isn't in the list above.
6. Do not add, remove, or reword any of the actual spoken words - only insert bracket tags between them. The spoken text itself must stay byte-for-byte the same.

Example:
Input: "Ever wonder why cats knead blankets? It's actually a deep instinct, from when they were kittens."
Output: "[soft] [curious] Ever wonder why cats knead blankets? [long-break] It's actually a deep instinct, [break] from when they were kittens. [long-break]"`;

/** Deterministic guarantee for the two pause rules - runs regardless of what the model did, so rules 2-3 above are never actually optional. Skips insertion where a break/long-break tag is already immediately present (avoids double-tagging a spot the model already got right). Ellipsis ("...") is matched as ONE unit, not three separate sentence-enders. */
function ensurePauseTags(text) {
  let out = text.replace(/([,:;])(?!\s*\[(?:break|long-break)\])/g, '$1 [break]');
  out = out.replace(/(\.{2,}|[.?!])(?!\s*\[(?:break|long-break)\])/g, '$1 [long-break]');
  if (!/^\s*\[soft\]/.test(out)) out = `[soft] ${out}`;
  return out;
}

/**
 * Annotates one beat's plain narration with real Fish Audio tags.
 * Falls back to a PURELY mechanical tagging (just ensurePauseTags on
 * the untouched plain text, no emotion tags) if the Gemini call fails
 * for any reason - losing the contextual emotion tags on one beat is
 * a real but minor quality loss; losing that beat's narration entirely
 * over a tagging-step failure would not be.
 */
async function annotateNarrationTags(plainText) {
  try {
    const tagged = await callGeminiRaw(TAGGING_SYSTEM_PROMPT, plainText, { jsonMode: false, maxTokens: 1000, temperature: 0.4 });
    return ensurePauseTags(tagged.trim());
  } catch (err) {
    console.warn(`[narrationTagging] tag annotation failed, using mechanical pause tags only: ${err.message}`);
    return ensurePauseTags(plainText);
  }
}

module.exports = { annotateNarrationTags, ensurePauseTags };
