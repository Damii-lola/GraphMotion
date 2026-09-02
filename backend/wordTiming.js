const fetch = require('node-fetch');

/**
 * Real, per-word audio timing for a beat's FINAL narration clip, via
 * Deepgram's own pre-recorded speech-to-text endpoint - same account/
 * API key as deepgramTtsGen.js (Deepgram sells both TTS and STT off one
 * key), so this is a zero-new-dependency way to get ground truth for
 * "when is this specific word actually spoken," which the render
 * engine needs to drive visuals off the AUDIO rather than off an even
 * split of the beat's total duration. Runs the clip back through STT
 * AFTER all of narrationPrefetch.js's own trimming, so the timings
 * measured here match the exact audio that ships in the final video,
 * not the pre-trim raw TTS output.
 */

const API_URL = 'https://api.deepgram.com/v1/listen';
const TIMEOUT_MS = 20000;

async function transcribeOnce(buffer) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_URL}?model=nova-2&punctuate=true`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/mpeg',
      },
      body: buffer,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Deepgram STT HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  const json = await res.json();
  const words = json?.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(words)) throw new Error('Deepgram STT response missing results.channels[0].alternatives[0].words');
  return words.map((w) => ({ word: w.punctuated_word || w.word, start: w.start, end: w.end }));
}

/**
 * Word timings are a real, additive enhancement, not a correctness
 * requirement - a beat with no timing data just falls back to whatever
 * the render engine already does today (even split across the beat's
 * duration). One retry on transient failure, same shape as
 * deepgramTtsGen.js's own generateSpeech; a caller that still fails
 * after the retry gets null back, not a thrown error, so one flaky STT
 * call never takes down a whole beat's narration.
 */
async function getWordTimings(buffer) {
  try {
    return await transcribeOnce(buffer);
  } catch (err) {
    try {
      return await transcribeOnce(buffer);
    } catch (err2) {
      console.warn(`[wordTiming] Deepgram STT failed twice, proceeding without word timings: ${err2.message}`);
      return null;
    }
  }
}

module.exports = { getWordTimings };
