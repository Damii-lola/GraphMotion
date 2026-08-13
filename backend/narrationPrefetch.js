const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { generateSpeech } = require('./ttsGen');

function narrationDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-narration`);
}

/**
 * ffmpeg-static ships ffmpeg only, not ffprobe - but `ffmpeg -i <file>`
 * with no output still prints the input's stream info (including
 * Duration) to stderr before erroring out for lack of an output, which
 * is enough to parse a real duration without needing ffprobe at all.
 */
function getAudioDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-i', filePath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!match) { reject(new Error('could not parse audio duration from ffmpeg output')); return; }
      resolve((+match[1]) * 3600 + (+match[2]) * 60 + parseFloat(match[3]));
    });
    ff.on('error', reject);
  });
}

/**
 * Generates narration audio for every beat that has one, SEQUENTIALLY
 * (not parallel like imagePrefetch.js - this free TTS service is a
 * single-connection-per-call websocket, and total narration length
 * across a video's beats is naturally bounded, unlike a burst of
 * simultaneous image requests). For each beat with narration, measures
 * the real spoken duration and OVERRIDES that beat's `duration` param
 * to match (+ a small buffer) - visual pacing follows how long the
 * narration actually takes to say, not an arbitrary authored guess.
 *
 * Returns a NEW sceneJSON-shaped object (render-only, same pattern as
 * imagePrefetch.js - the original passed in is never mutated, so
 * whatever gets persisted/reused for edits keeps its author-intended
 * durations) plus a Map of beatIndex -> {path, duration} for
 * audioMux.js to assemble into the final narration track.
 */
async function prefetchNarration(sceneJSON, jobId) {
  const renderScenes = sceneJSON.scenes.map((scene) => ({ ...scene, params: { ...scene.params } }));
  const beatsWithNarration = renderScenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => typeof scene.params?.narration === 'string' && scene.params.narration.trim().length > 0);

  const audioFiles = new Map();
  if (beatsWithNarration.length === 0) {
    return { sceneJSON: { ...sceneJSON, scenes: renderScenes }, audioFiles };
  }

  const dir = narrationDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });

  for (const { scene, index } of beatsWithNarration) {
    try {
      const buf = await generateSpeech(scene.params.narration.trim());
      const filePath = path.join(dir, `${index}.mp3`);
      fs.writeFileSync(filePath, buf);
      const duration = await getAudioDurationSeconds(filePath);
      audioFiles.set(index, { path: filePath, duration });
      // Small buffer so the visual doesn't cut away the instant speech
      // ends - a beat that's ONLY as long as the narration reads as
      // clipped, not intentional.
      renderScenes[index].params.duration = duration + 0.4;
    } catch (err) {
      console.warn(`[narrationPrefetch] beat ${index} narration failed, keeping authored duration: ${err.message}`);
    }
  }

  return { sceneJSON: { ...sceneJSON, scenes: renderScenes }, audioFiles };
}

function cleanupNarration(jobId) {
  fs.rm(narrationDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchNarration, cleanupNarration, narrationDirFor };
