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

// Switched from en-US-AndrewMultilingualNeural to Eric per direct user
// preference after A/B listening across several free Edge voices - see
// this file's own git history for the comparison. Still a free-tier
// synthetic voice, not indistinguishable from human - that's a real
// ceiling of this being a $0 service, not a bug to fix (confirmed
// directly: Kokoro TTS, a real local neural model, was evaluated as an
// alternative and rejected - 250MB just to load the model, 405MB peak
// to generate one sentence, ~16s of CPU inference per sentence, all
// measured live - completely incompatible with this project's real,
// hard-won memory budget).
const DEFAULT_VOICE = 'en-US-EricNeural';

// rate=-5% (0.95x speed) per direct request (raised from an initial
// -10%/0.9x) - pitch/volume left at default. Confirmed real in this
// exact library: a slower rate measurably lengthens output (direct
// byte-size A/B on the -10% value).
const PROSODY_OPTIONS = { rate: '-5%', pitch: 'default', volume: 'default' };

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
    const tts = new MsEdgeTTS();

    // REAL LEAK, confirmed by reading msedge-tts's own source: on
    // timeout this used to just reject and walk away - it never called
    // tts.close(), so the underlying WebSocket was left fully open.
    // Worse, the 'data' listener below stays attached and keeps firing
    // for as long as that abandoned connection keeps receiving audio
    // from Microsoft's server, pushing into a `chunks` array that
    // nothing else references but the listener itself - unbounded
    // growth, held alive by a dangling event handler, for a connection
    // whose own library doc comment admits can "hang forever with no
    // error and no 'end' event" on some connections. Every retry (see
    // generateSpeech) could leak another one on top of it. This runs
    // sequentially per narration beat inside renderWorker.js's own
    // process, BEFORE any chunk is forked - so by the time the first
    // chunk starts rendering, the parent process could already be
    // sitting on several leaked open sockets eating into the same
    // <500MB host budget the chunk worker needs, which fits "Chunk 0
    // timed out" (the smallest possible slice of actual render work)
    // far better than anything in the render/chunk code itself.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { tts.close(); } catch (_) { /* best-effort */ }
      reject(new Error(`msedge-tts timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      .then(() => tts.toStream(text, PROSODY_OPTIONS))
      .then(({ audioStream }) => {
        const chunks = [];
        audioStream.on('data', (chunk) => {
          if (settled) return; // connection already abandoned via timeout/error - stop accumulating
          chunks.push(chunk);
        });
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
        try { tts.close(); } catch (_) { /* best-effort */ }
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
