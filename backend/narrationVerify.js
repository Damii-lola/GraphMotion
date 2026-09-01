const { callGeminiWithAudio } = require('./geminiClient');

/**
 * Real, confirmed-live bug found by actually transcribing production
 * audio (not just measuring loudness/silence): Fish Audio's TTS model
 * occasionally hallucinates extra sound that isn't in the script at
 * all - trailing filler-like interjections, breaths, and, confirmed
 * separately, actual laughter tacked onto the end of a clip. Every
 * real hallucination found across this entire project, without
 * exception, has landed at the very END of a clip - never the start
 * or middle. That consistency is what narrationPrefetch.js's
 * trimTrailingArtifact (a free, judge-free, ffmpeg-only mechanical
 * step - no API call at all) is built around: it finds the internal
 * silence gap right before trailing artifact content and cuts there.
 *
 * This file used to run up to 5 retry attempts, each with TWO
 * concurrent Gemini judge calls (a broad content/delivery check plus
 * this narrower tail-only check), re-tagging and re-synthesizing from
 * scratch between attempts. Real, serious consequence found the hard
 * way: that call volume, compounded across many beats and many test
 * generations in a single session, got flagged by Google as repeated
 * ToS abuse and disabled 6 of 7 production Gemini API keys. Direct
 * user request afterward: "is there a way we can stop all these
 * problems and retries so everything happens once and finishes."
 *
 * Pulled WAY back as a result: exactly ONE synthesis attempt, ONE
 * judge call (just this narrow tail-check, not the broader content
 * pass - the tail is what actually decides whether the free mechanical
 * trim runs, and every real failure mode observed has been a tail
 * problem anyway), no retry loop, no re-tagging based on judge
 * feedback. If the tail isn't clean, `passed: false` tells
 * narrationPrefetch.js to run trimTrailingArtifact - free, no further
 * API calls - instead of paying for another full attempt. This trades
 * away some of the old system's ability to catch OTHER problems (wrong
 * words, robotic delivery) for a large, direct cut in API call volume,
 * which is the higher priority now given what happened.
 */

const TAIL_CHECK_SYSTEM_PROMPT = `You are doing ONE narrow, focused check on an audio clip - not a general quality review. You will be told the script the clip should contain. Listen VERY carefully and specifically to the END of the clip, after the script's true final word is spoken. Is there ANY sound there at all - a word, a syllable, a mumble, a breath, a sigh, a laugh, a click, a hum, absolutely anything - even if it's brief or quiet? Respond ONLY with JSON, no markdown fences: {"clean": true or false, "description": "exactly what you heard after the real ending, or empty string if there was nothing"}`;

function parseJudgeResponse(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in judge response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function judgeAudioTail(audioBuffer, plainText) {
  const promptText = `Script: "${plainText}"\n\nListen closely to the very end of this clip, after those words finish. Is there anything audible there at all?`;
  const raw = await callGeminiWithAudio(TAIL_CHECK_SYSTEM_PROMPT, audioBuffer, 'audio/mpeg', promptText, { jsonMode: true, maxTokens: 300, temperature: 0.0 });
  const parsed = parseJudgeResponse(raw);
  return { clean: parsed.clean !== false, description: parsed.description || '' };
}

/**
 * Single-shot now, deliberately: calls `tagAndSynthesize('')` exactly
 * ONCE (the empty string is the unused vestige of the old feedback-loop
 * signature narrationPrefetch.js still passes through), judges only
 * the tail, and returns immediately either way - no retry loop at all.
 * Returns { taggedText, buf, passed } - `passed` is true only when the
 * judge explicitly confirmed a clean tail. narrationPrefetch.js uses
 * this to decide whether to run the free mechanical
 * trimTrailingArtifact step - a judge-confirmed clean clip skips it
 * (nothing to gain, real risk if the heuristic ever misfires), an
 * unclean or unverified one gets it as the one remaining safety net.
 * If the judge call itself fails (Gemini outage, bad JSON), the audio
 * is accepted unverified - same tradeoff as before, just without a
 * retry loop backing it up now.
 */
async function synthesizeVerified(plainText, tagAndSynthesize) {
  const last = await tagAndSynthesize('');
  let tailVerdict;
  try {
    tailVerdict = await judgeAudioTail(last.buf, plainText);
  } catch (err) {
    console.warn(`[narrationVerify] judge call failed, accepting audio unverified: ${err.message}`);
    return { ...last, passed: false };
  }
  if (tailVerdict.clean) return { ...last, passed: true };
  console.warn(`[narrationVerify] tail check rejected: extra sound at the very end (${tailVerdict.description}) - falling back to the mechanical trim, not retrying`);
  return { ...last, passed: false };
}

module.exports = { synthesizeVerified, judgeAudioTail };
