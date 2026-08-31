const fetch = require('node-fetch');

/**
 * Text-to-speech via Fish Audio's REST API - evaluated as an
 * alternative to msedge-tts (ttsGen.js) after direct user rejection of
 * how narration sounded on the free engine ("robotic", the mastering
 * chain amplifying the source's own noise floor). Unlike msedge-tts,
 * this requires a real account + API key (FISH_API_KEY) - there is no
 * anonymous/keyless path here.
 *
 * Kept as its OWN file, matching ttsGen.js's shape (generateSpeech(text)
 * -> Promise<Buffer>) rather than folded into ttsGen.js directly, so
 * the two engines can be A/B compared cheaply before either commits to
 * being "the" production narration path in narrationPrefetch.js.
 */

const API_URL = 'https://api.fish.audio/v1/tts';
const TIMEOUT_MS = 20000;

// Real voice IDs from Fish Audio's own voice library (fish.audio/discovery),
// picked for narration/explainer suitability - NOT yet verified to sound
// good for this project's content, only confirmed to be real, resolvable
// IDs. "s2.1-pro-free" is Fish Audio's own $0 model tier (their docs:
// "free to use under fair-use limits") - the paid s2.1-pro model is
// used only if FISH_MODEL is explicitly overridden.
const VOICES = {
  adrian: 'bf322df2096a46f18c579d0baa36f41d', // "A steady and reliable narrator"
  slax: 'c5f56a6cc2ec4fa8920cb4c5889a3fb7', // "Clear, precise, and measured narration, ideal for educational content"
  ethan: '536d3a5e000945adb7038665781a4aca', // "A curious explainer"
};
const DEFAULT_VOICE_ID = VOICES.adrian;
const MODEL = process.env.FISH_MODEL || 's2.1-pro-free';

// Fish Audio's own documented "expressiveness" controls. Raised from
// the API's own default (0.7/0.7) per direct user preference after a
// real A/B listen against 0.7 and 0.9 on identical text - 1.0 was
// picked as sounding least "monotone" (the user's real complaint,
// distinct from the separate noise/gain-staging issue already fixed
// in audioMux.js - this is about pitch/delivery variation, not noise).
const TEMPERATURE = 1.0;
const TOP_P = 0.95;

/**
 * Single call, no retry - generateSpeech (below) owns the retry, same
 * split as ttsGen.js's speakOnce/generateSpeech. A hard timeout is
 * imposed the same way ttsGen.js already does for msedge-tts - no
 * reason to assume a REST API can't also hang on a bad connection.
 */
async function speakOnce(text, voiceId) {
  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) throw new Error('FISH_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: MODEL,
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId,
        format: 'mp3',
        mp3_bitrate: 128,
        temperature: TEMPERATURE,
        top_p: TOP_P,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Fish Audio TTS HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Generates speech audio for one line of narration, with one retry on failure/timeout - mirrors ttsGen.js's generateSpeech shape exactly, so narrationPrefetch.js could swap engines with a one-line import change. */
async function generateSpeech(text, voiceId = DEFAULT_VOICE_ID) {
  try {
    return await speakOnce(text, voiceId);
  } catch (err) {
    return await speakOnce(text, voiceId);
  }
}

module.exports = { generateSpeech, VOICES, DEFAULT_VOICE_ID };
