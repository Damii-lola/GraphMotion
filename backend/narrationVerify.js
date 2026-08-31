const { callGeminiWithAudio } = require('./geminiClient');

/**
 * Real, confirmed-live bug found by actually transcribing production
 * audio (not just measuring loudness/silence): Fish Audio's TTS model
 * occasionally hallucinates extra sound that isn't in the script at
 * all - trailing filler-like interjections ("Puh, puh.", "Hmm.",
 * "Crin.") and, confirmed separately, actual laughter tacked onto the
 * end of a clip with nothing to do with the actual words it was asked
 * to say. A/B testing (varying temperature, varying whether pause tags
 * were present) found no single reliable cause - it happens across
 * settings, so there's no config knob that eliminates it at the
 * source. This is the downstream guard instead.
 *
 * First version of this file only checked word count against a plain
 * transcription, which quietly missed the laughter bug entirely - a
 * "transcribe verbatim" prompt describes spoken WORDS, and a laugh
 * isn't a word, so it just never showed up in the transcript at all.
 * Replaced with a proper holistic QA judge (still just one more Gemini
 * multimodal call, same infra) that listens for non-speech artifacts
 * AND judges pause naturalness, not just word-for-word content -
 * directly requested by the user as a third AI stage: "it will hear
 * and check the audio generated and it will be a judge... it will
 * state what needs to change and it will send it back to the 1st and
 * 2nd ai call to redo the audio". On rejection, the judge's feedback is
 * fed back into narrationTagging.js's annotateNarrationTags for the
 * next attempt (re-tagging AND re-synthesizing together) rather than
 * just re-synthesizing the same tagged text, since a bad pause
 * placement is a tagging problem, not just an unlucky TTS roll.
 */

const JUDGE_SYSTEM_PROMPT = `You are a strict QA judge for AI-generated short-form video narration. You'll be given an audio clip and the exact script it was supposed to say. Respond ONLY with JSON, no markdown fences, no explanation outside the JSON.

Fail the audio (pass: false) if ANY of these are true:
- It contains ANY sound that isn't the script's words spoken cleanly - an extra word, a mumble, laughing, coughing, humming, static, or any noise not in the script, anywhere in the clip (start, middle, or end).
- It's missing words from the script, or changes/reorders any of the script's actual words.
- A pause happens somewhere a real human speaker would never actually pause when saying this sentence out loud (e.g. after a short/minor comma that doesn't need a breath, breaking the sentence's natural flow) - not every comma in written text gets spoken with a pause in real speech.
- The delivery sounds robotic, monotone, or otherwise clearly synthetic rather than like a real person talking.

Pass the audio (pass: true) only if it says exactly the script's words, cleanly, with no extra sounds, and any pauses present land somewhere a real speaker plausibly would.

Respond with exactly this JSON shape:
{"pass": true or false, "issues": ["short specific issue", "..."], "retagInstruction": "one or two sentences of concrete guidance for how to re-tag this exact script's emotion/pause markup differently next time - empty string if pass is true"}`;

function parseJudgeResponse(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in judge response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function judgeNarrationAudio(audioBuffer, plainText) {
  const promptText = `Intended script: "${plainText}"\n\nJudge the audio clip against this script.`;
  const raw = await callGeminiWithAudio(JUDGE_SYSTEM_PROMPT, audioBuffer, 'audio/mpeg', promptText, { jsonMode: true, maxTokens: 400, temperature: 0.0 });
  return parseJudgeResponse(raw);
}

// A real full-pipeline test run (5 beats) measured a high per-call
// hallucination rate for the old word-count check: 4 of 5 beats
// hallucinated on their FIRST attempt, and one beat still hadn't
// produced a clean take after 3 straight attempts. 5 gives real
// headroom against that kind of failure rate.
const MAX_ATTEMPTS = 5;

/**
 * Calls `tagAndSynthesize(feedback)` up to MAX_ATTEMPTS times - it's
 * expected to re-tag AND re-synthesize from scratch each time (not
 * just re-run the same TTS call), returning { taggedText, buf }.
 * `feedback` is the judge's retagInstruction from the previous
 * rejected attempt (empty string on the first attempt), threaded
 * through so a bad pause-placement problem actually gets a chance to
 * be re-tagged differently, not just re-rolled with identical input.
 * Accepts the first attempt the judge passes. If judging itself fails
 * (Gemini call error, bad JSON), the audio is accepted unverified -
 * losing this safety net for one beat is a real but minor risk;
 * blocking a whole video's narration on a QA-step outage would not be.
 * If every attempt is still rejected, the last attempt is used anyway
 * rather than looping forever.
 */
async function synthesizeVerified(plainText, tagAndSynthesize) {
  let feedback = '';
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await tagAndSynthesize(feedback);
    let verdict;
    try {
      verdict = await judgeNarrationAudio(last.buf, plainText);
    } catch (err) {
      console.warn(`[narrationVerify] judge call failed, accepting audio unverified: ${err.message}`);
      return last;
    }
    if (verdict.pass) return last;
    console.warn(`[narrationVerify] attempt ${attempt}/${MAX_ATTEMPTS} rejected by judge: ${(verdict.issues || []).join('; ')}`);
    feedback = verdict.retagInstruction || '';
  }
  console.warn(`[narrationVerify] still rejected after ${MAX_ATTEMPTS} attempts - using the last attempt anyway`);
  return last;
}

module.exports = { synthesizeVerified, judgeNarrationAudio };
