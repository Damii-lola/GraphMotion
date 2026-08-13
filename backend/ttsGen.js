const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

/**
 * Free, no-API-key text-to-speech via Microsoft Edge's neural voice
 * service (the same one behind Edge's "Read Aloud" feature) - confirmed
 * working directly before building anything around it: a real ~4s MP3
 * for a 9-word sentence, natural-sounding. This exists so narration can
 * carry a video's actual message, instead of trying to cram a full
 * script onto the screen as text (see sceneTemplates.js's narration
 * guidance for why that split matters).
 */

// Microsoft's newer-generation "Multilingual" voice model - noticeably
// less flat/robotic than the older GuyNeural default used originally.
// Still a free-tier synthetic voice, not indistinguishable from human -
// that's a real ceiling of this being a $0 service, not a bug to fix.
const DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural';

const TIMEOUT_MS = 15000;

/**
 * A single call, no retry - generateSpeech (below) owns the retry, same
 * split as imageGen.js's fetchOnce/generateImage. Confirmed directly
 * (the hard way, mid-debugging a duration bug) that this websocket-based
 * library can simply hang forever with no error and no 'end' event on
 * some connections - there is no built-in timeout anywhere in msedge-tts
 * itself, so one has to be imposed here, or a single stuck connection
 * hangs the entire render job indefinitely.
 */
function speakOnce(text, voice) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`msedge-tts timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    const tts = new MsEdgeTTS();
    tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      .then(() => tts.toStream(text))
      .then(({ audioStream }) => {
        const chunks = [];
        audioStream.on('data', (chunk) => chunks.push(chunk));
        audioStream.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          tts.close();
          resolve(Buffer.concat(chunks));
        });
        audioStream.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          tts.close();
          reject(err);
        });
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
  });
}

/**
 * Generates speech audio for one line of narration, with one retry on
 * failure/timeout - mirrors imageGen.js's generateImage shape. One TTS
 * call per beat, not one call for the whole script - keeps each clip's
 * duration independently measurable so it can drive that specific
 * beat's timing (see narrationPrefetch.js).
 */
async function generateSpeech(text, voice = DEFAULT_VOICE) {
  try {
    return await speakOnce(text, voice);
  } catch (err) {
    return await speakOnce(text, voice);
  }
}

module.exports = { generateSpeech, DEFAULT_VOICE };
