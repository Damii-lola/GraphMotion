const fetch = require('node-fetch');

/**
 * Text-to-speech via Deepgram's Aura-2 REST API - promoted to primary
 * narration engine after direct user comparison against Fish Audio's
 * free tier: blind listen on a real generated sample, "sounds way
 * better." Same generateSpeech(text) -> Promise<Buffer> shape as
 * fishTtsGen.js/ttsGen.js on purpose, so narrationPrefetch.js's
 * fallback chain can try all three with zero shape mismatches.
 *
 * Free-tier economics: $200 signup credit, no credit card required, no
 * expiry, at $0.03/1K characters - roughly 6.67M characters before any
 * cost is incurred, which for this project's per-video narration length
 * (a few hundred characters) is a very long runway.
 *
 * Aura-2 takes pacing cues directly from punctuation - commas/periods
 * for short pauses, "..." for longer ones - same mechanism
 * narrationTagging.js already produces, so the pause-insertion pipeline
 * carries over largely unchanged. What does NOT carry over: Fish
 * Audio's [emotion] bracket tags - Deepgram has no SSML/tag support on
 * its roadmap, so a literal "[calm]" in the text risks being read aloud
 * as text rather than interpreted, not just silently ignored. Emotion
 * tagging was dropped from narrationTagging.js's prompt for this
 * reason when this engine was wired in.
 */

const API_URL = 'https://api.deepgram.com/v1/speak';
const TIMEOUT_MS = 20000;

// Real voice IDs from Deepgram's Aura-2 catalog (developers.deepgram.com/docs/tts-models).
// "arcas" picked as the default narrator voice after a direct user A/B
// listen against 2 other male candidates (orpheus, orion) on a real
// generated sample - orpheus was rejected as "very robotic," arcas won.
const VOICES = {
  arcas: 'aura-2-arcas-en', // professional male - production default
  orpheus: 'aura-2-orpheus-en', // smooth, articulate male - rejected, sounded robotic
  orion: 'aura-2-orion-en', // deep, authoritative male
  thalia: 'aura-2-thalia-en', // default female voice
};
const DEFAULT_MODEL = VOICES.arcas;

/**
 * Single call, no retry - generateSpeech (below) owns the retry, same
 * split as fishTtsGen.js's speakOnce/generateSpeech.
 */
async function speakOnce(text, model) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_URL}?model=${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Deepgram TTS HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Generates speech audio for one line of narration, with one retry on failure/timeout - mirrors fishTtsGen.js's generateSpeech shape exactly. */
async function generateSpeech(text, model = DEFAULT_MODEL) {
  try {
    return await speakOnce(text, model);
  } catch (err) {
    return await speakOnce(text, model);
  }
}

module.exports = { generateSpeech, VOICES, DEFAULT_MODEL };
