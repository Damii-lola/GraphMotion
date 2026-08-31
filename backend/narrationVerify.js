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

// Real, confirmed-live regression: an earlier version of this prompt
// put pause-naturalness and "sounds robotic" in the SAME fail
// condition as objective content errors (hallucinated/missing words,
// non-speech noise). A full pipeline test measured close to a 100%
// rejection rate under that prompt - nearly every beat burned all
// MAX_ATTEMPTS retries, because a sufficiently critical judge can
// almost always find SOME subjective delivery quibble, and retrying
// doesn't reliably fix a subjective judgment the way it reliably fixes
// "did it hallucinate a stray word" (a coin-flip that a fresh attempt
// can just re-flip). Split into two categories per direct user
// feedback: HARD issues (objective, verifiable, worth blocking and
// retrying on) vs SOFT issues (subjective quality, worth reporting and
// feeding into the next retag attempt's guidance, but not worth an
// unbounded retry loop over). Only hardIssues gates pass/fail now -
// see judgeNarrationAudio below, which computes `pass` itself from
// hardIssues.length rather than trusting the model's own top-level
// verdict.
const JUDGE_SYSTEM_PROMPT = `You are a QA judge for AI-generated short-form video narration. You'll be given an audio clip and the exact script it was supposed to say. Respond ONLY with JSON, no markdown fences, no explanation outside the JSON.

Check for TWO separate categories of problems - keep them strictly separate, never report a soft problem as a hard one:

HARD problems (objective and verifiable - these actually break correctness):
- The audio contains ANY sound that isn't the script's words spoken cleanly - an extra word, a mumble, laughing, coughing, humming, static, a sound effect, or any other noise not in the script, anywhere in the clip (start, middle, or end).
- The audio is missing words from the script, or changes/reorders any of the script's actual words.
- IMPORTANT EXCEPTION: a word that is a true HOMOPHONE of the script's word (sounds identical when spoken, even though spelled differently - e.g. "knead"/"need", "their"/"there"/"they're", "write"/"right", "sight"/"site") is NEVER a hard issue by itself. This applies to inflected forms too - "kneading" and "needing" sound just as identical as "knead" and "need" do (the "k" is always silent), "kneads" and "needs" the same way, and so on for any homophone pair with the same suffix added to both. You are judging AUDIO, not spelling - if it sounds exactly like the intended word, it IS the intended word correctly spoken, regardless of which homophone you'd transcribe it as.

SOFT problems (subjective delivery quality - real, but not a correctness failure):
- A pause lands somewhere a real human speaker probably wouldn't pause when saying this sentence out loud (not every comma gets spoken with a pause in real speech).
- The delivery sounds robotic, monotone, or otherwise noticeably synthetic rather than like a real person talking.

Respond with exactly this JSON shape:
{"hardIssues": ["short specific issue", "..."], "softIssues": ["short specific issue", "..."], "retagInstruction": "one or two sentences of concrete guidance for how to re-tag this exact script's emotion/pause markup differently next time, addressing whichever issues above are present - empty string if there are none of either kind"}

Use empty arrays ([]) for either list when that category has no problems.`;

function parseJudgeResponse(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in judge response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function judgeNarrationAudio(audioBuffer, plainText) {
  const promptText = `Intended script: "${plainText}"\n\nJudge the audio clip against this script.`;
  // Real bug caught in production testing: 400 tokens was sometimes not
  // enough room for the model to list every issue it found AND close
  // the JSON object, so the response got truncated mid-way through a
  // REJECTION - which callGeminiRaw treats as a hard error (no valid
  // JSON to parse), which synthesizeVerified below then treats as "the
  // judge is unavailable, accept this attempt unverified" - the exact
  // opposite of what should happen to a take bad enough to trigger a
  // long issues list. 700 gives real headroom.
  const raw = await callGeminiWithAudio(JUDGE_SYSTEM_PROMPT, audioBuffer, 'audio/mpeg', promptText, { jsonMode: true, maxTokens: 700, temperature: 0.0 });
  const parsed = parseJudgeResponse(raw);
  const hardIssues = parsed.hardIssues || [];
  const softIssues = parsed.softIssues || [];
  // Computed here, not trusted from the model's own output - keeps the
  // pass/fail boundary strictly tied to hardIssues regardless of
  // whether the model's own internal notion of "pass" agrees.
  return { pass: hardIssues.length === 0, hardIssues, softIssues, retagInstruction: parsed.retagInstruction || '' };
}

// Real, confirmed-live false negative: a live website test transcribed
// a full assembled video and found a stray "Boo." tacked onto the end
// of a beat the FIRST judge pass had already explicitly PASSED - the
// broad, holistic judge call missed it. Every real hallucination found
// across this whole session, without exception, has landed at the very
// END of a clip - never the start or middle. A second, narrower pass
// whose ONLY job is "listen closely to the tail, is there anything at
// all after the sentence's real last word" is more likely to catch
// what a broader single judgment call can overlook, precisely because
// it isn't dividing attention across content-accuracy AND pause-
// naturalness AND overall delivery at the same time - it only has one
// narrow thing to listen for.
const TAIL_CHECK_SYSTEM_PROMPT = `You are doing ONE narrow, focused check on an audio clip - not a general quality review. You will be told the script the clip should contain. Listen VERY carefully and specifically to the END of the clip, after the script's true final word is spoken. Is there ANY sound there at all - a word, a syllable, a mumble, a breath, a sigh, a laugh, a click, a hum, absolutely anything - even if it's brief or quiet? Respond ONLY with JSON, no markdown fences: {"clean": true or false, "description": "exactly what you heard after the real ending, or empty string if there was nothing"}`;

async function judgeAudioTail(audioBuffer, plainText) {
  const promptText = `Script: "${plainText}"\n\nListen closely to the very end of this clip, after those words finish. Is there anything audible there at all?`;
  const raw = await callGeminiWithAudio(TAIL_CHECK_SYSTEM_PROMPT, audioBuffer, 'audio/mpeg', promptText, { jsonMode: true, maxTokens: 300, temperature: 0.0 });
  const parsed = parseJudgeResponse(raw);
  return { clean: parsed.clean !== false, description: parsed.description || '' };
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
 *
 * Returns { taggedText, buf, passed } - `passed` is true only when
 * BOTH judge passes explicitly confirmed this exact audio, false for
 * the "still rejected after N attempts" and "judge call failed" paths.
 * Callers use this to decide whether it's worth risking the mechanical
 * tail-artifact trim (narrationPrefetch.js's trimTrailingArtifact) on
 * the result - a judge-CONFIRMED clean clip has nothing to gain from
 * that blunt heuristic and only stands to lose real content if it ever
 * misfires, so it should only run on the unverified/rejected path
 * where the audio wasn't already trusted anyway.
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
      return { ...last, passed: false };
    }
    if (verdict.pass) {
      if (verdict.softIssues.length > 0) {
        console.warn(`[narrationVerify] attempt ${attempt}/${MAX_ATTEMPTS} passed first judge pass with soft (non-blocking) notes: ${verdict.softIssues.join('; ')}`);
      }
      // Second, narrower pass - see judgeAudioTail's own doc comment
      // for why this specifically re-checks the tail rather than
      // repeating the same broad question.
      let tailVerdict;
      try {
        tailVerdict = await judgeAudioTail(last.buf, plainText);
      } catch (err) {
        console.warn(`[narrationVerify] second-pass tail check failed, accepting first pass's verdict: ${err.message}`);
        return { ...last, passed: true };
      }
      if (tailVerdict.clean) return { ...last, passed: true };
      console.warn(`[narrationVerify] attempt ${attempt}/${MAX_ATTEMPTS} passed the first judge pass but REJECTED by the second (tail) pass: ${tailVerdict.description}`);
      feedback = `A previous take had extra sound at the very end of the clip after the script's real last word (${tailVerdict.description}), even though the rest of the content was fine - make sure the delivery stops cleanly right after the last word with nothing more.`;
      continue;
    }
    console.warn(`[narrationVerify] attempt ${attempt}/${MAX_ATTEMPTS} rejected by judge (hard issues): ${verdict.hardIssues.join('; ')}`);
    feedback = verdict.retagInstruction || '';
  }
  console.warn(`[narrationVerify] still rejected after ${MAX_ATTEMPTS} attempts - using the last attempt anyway`);
  return { ...last, passed: false };
}

module.exports = { synthesizeVerified, judgeNarrationAudio, judgeAudioTail };
