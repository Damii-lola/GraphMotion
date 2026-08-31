const { callGeminiWithAudio } = require('./geminiClient');

/**
 * Real, confirmed-live bug found by actually transcribing production
 * audio (not just measuring loudness/silence): Fish Audio's TTS model
 * occasionally hallucinates extra sound that isn't in the script at
 * all - trailing filler-like interjections ("Puh, puh.", "Hmm.",
 * "Crin.") tacked onto a clip that has nothing to do with the actual
 * words it was asked to say. Direct A/B testing (varying temperature,
 * varying whether pause tags were present) found no single reliable
 * cause - it happens across settings, so there's no config knob that
 * eliminates it at the source. This is the downstream guard instead:
 * transcribe the clip Fish Audio actually produced and compare it
 * against the real script (the plain, untagged narration - the ground
 * truth of what SHOULD have been said), retrying synthesis if the
 * audio doesn't match. Mirrors narrationTagging.js's own
 * text-hallucination guard - "the model can misbehave, so verify its
 * output against the known-good input rather than trusting it blindly"
 * - just applied one stage later, to the actual audio Fish Audio
 * returns rather than the tagged text sent to it.
 */

const TRANSCRIBE_SYSTEM_PROMPT = 'You are a precise audio transcription tool. Transcribe the spoken audio VERBATIM, including every filler word, disfluency, repeated word, "um", "uh", "like", stutter, or any sound that isn\'t a clean clear word - do not clean it up, do not paraphrase, do not skip anything. Output ONLY the raw transcript, nothing else.';

function normalizeWords(text) {
  return text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

/**
 * Word-count-based check rather than exact-match - real transcription
 * has minor near-homophone noise ("used" heard as "use") that doesn't
 * change word COUNT and isn't the bug being guarded against here. Zero
 * tolerance on EXTRA words: every real hallucination observed in
 * testing ("Puh, puh.", "Hmm.", "Crin.", "come.", "minum, no.") was
 * purely additional trailing content, never a same-length word
 * substitution - so any excess word count at all is treated as a
 * mismatch. (An earlier +2 tolerance let "Puh, puh." - exactly 2 extra
 * words - through undetected; caught by testing against the actual
 * observed hallucination strings, not just clean input.) A false
 * positive here (e.g. a contraction transcribed as two words) just
 * costs one extra synthesis attempt, which is a fine trade against
 * missing real hallucinated content.
 */
function matchesScript(transcript, plainText) {
  const heardWords = normalizeWords(transcript);
  const expectedWords = normalizeWords(plainText);
  return heardWords.length <= expectedWords.length;
}

// A real full-pipeline test run (5 beats) measured a much higher
// hallucination rate than small isolated samples suggested: 4 of 5
// beats hallucinated on their FIRST attempt, and one beat still hadn't
// produced a clean take after 3 straight attempts (shipped with "numb."
// tacked onto the end regardless). At that kind of per-call failure
// rate, 3 attempts leaves a meaningful chance of still shipping garbage
// audio - 5 gives real headroom (a ~65% single-call failure rate would
// still fail 5 straight attempts only ~12% of the time, vs ~27% at 3).
const MAX_ATTEMPTS = 5;

/**
 * Calls `synthesize()` (expected to return a Buffer of mp3 audio) up to
 * MAX_ATTEMPTS times, transcribing each result and accepting the first
 * one whose transcript actually matches `plainText`. If verification
 * itself fails (Gemini call error) the audio is accepted unverified -
 * losing this safety net for one beat is a real but minor risk;
 * blocking a whole video's narration on a verification-step outage
 * would not be. If every attempt still comes back with extra content,
 * the last attempt is used anyway rather than looping forever.
 */
async function synthesizeVerified(plainText, synthesize) {
  let lastBuf;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastBuf = await synthesize();
    let transcript;
    try {
      transcript = await callGeminiWithAudio(TRANSCRIBE_SYSTEM_PROMPT, lastBuf, 'audio/mpeg', { jsonMode: false, maxTokens: 500, temperature: 0.0 });
    } catch (err) {
      console.warn(`[narrationVerify] audio verification call failed, accepting audio unverified: ${err.message}`);
      return lastBuf;
    }
    if (matchesScript(transcript, plainText)) return lastBuf;
    console.warn(`[narrationVerify] attempt ${attempt}/${MAX_ATTEMPTS} produced audio with extra/hallucinated content - expected: "${plainText}" | heard: "${transcript.trim()}"`);
  }
  console.warn(`[narrationVerify] still had extra content after ${MAX_ATTEMPTS} attempts - using the last attempt anyway`);
  return lastBuf;
}

module.exports = { synthesizeVerified, matchesScript };
