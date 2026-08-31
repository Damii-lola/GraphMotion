const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fishTts = require('./fishTtsGen');
const edgeTts = require('./ttsGen');
const { annotateNarrationTags } = require('./narrationTagging');
const { masterNarrationAudio } = require('./audioMux');

/**
 * Production narration voice switched to Fish Audio's "Adrian" per
 * direct user preference after a real A/B listen against 2 other Fish
 * voices and msedge-tts's Eric. Falls back to msedge-tts (Eric, the
 * previous production voice, zero-key/zero-account) if the Fish Audio
 * call fails for ANY reason - a real, meaningful risk this engine
 * carries that msedge-tts never did: it needs a real account + API key
 * (FISH_API_KEY) and a paid/fair-use-limited service behind it, so a
 * missing key, exhausted fair-use quota (402), or a transient outage
 * (503) are all real failure modes worth falling back from rather than
 * losing that beat's narration entirely.
 */
async function generateSpeech(text, voiceId = fishTts.DEFAULT_VOICE_ID) {
  try {
    return await fishTts.generateSpeech(text, voiceId);
  } catch (err) {
    console.warn(`[narrationPrefetch] Fish Audio TTS failed, falling back to Eric: ${err.message}`);
    return edgeTts.generateSpeech(text);
  }
}

function narrationDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-narration`);
}

// Explicit product decision: no video may exceed 45s, period, regardless
// of the user's prompt. targetDurationSeconds already asks Mistral for
// <=45s (server.js), but that's a request, not a guarantee - narration
// duration below is measured from the REAL generated audio, which can
// run longer than whatever line length the model intended. This is the
// actual enforcement: whatever comes out the other end of narration
// gets hard-trimmed to fit, not just asked nicely.
const MAX_TOTAL_DURATION_SECONDS = 45;

/**
 * Drops trailing beats (and their audio) once the running total would
 * exceed the cap - always keeps at least the first beat, even in the
 * pathological case where one beat alone is longer than the cap, so a
 * video is never reduced to nothing.
 */
function capToMaxDuration(sceneJSON, audioFiles) {
  let total = 0;
  let cutIndex = sceneJSON.scenes.length;
  for (let i = 0; i < sceneJSON.scenes.length; i++) {
    const beatDuration = sceneJSON.scenes[i].params.duration || 0;
    if (i > 0 && total + beatDuration > MAX_TOTAL_DURATION_SECONDS) {
      cutIndex = i;
      break;
    }
    total += beatDuration;
  }
  if (cutIndex >= sceneJSON.scenes.length) return { sceneJSON, audioFiles };

  console.warn(`[narrationPrefetch] generated video ran long - trimming to ${cutIndex} of ${sceneJSON.scenes.length} beats (~${total.toFixed(1)}s) to stay under the ${MAX_TOTAL_DURATION_SECONDS}s MVP cap`);

  const trimmedAudioFiles = new Map();
  for (const [index, entry] of audioFiles) {
    if (index < cutIndex) trimmedAudioFiles.set(index, entry);
  }
  return {
    sceneJSON: { ...sceneJSON, scenes: sceneJSON.scenes.slice(0, cutIndex) },
    audioFiles: trimmedAudioFiles,
  };
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

// Real, directly measured finding: msedge-tts's own generated clips
// carry meaningful internal silence - a real isolated clip for "It's a
// comfort thing." (1.22s total) measured out to 0.14s of DEAD AIR
// before the first word and 0.33s after the last one, via ffmpeg's own
// silencedetect filter. Since this file's own beat-duration math below
// treats the clip's FULL file duration as "how long the narration
// takes," that trailing 0.33s was being counted as real speech time,
// then the deliberate +0.4s buffer was added ON TOP of it - roughly
// DOUBLING the real gap a viewer actually hears between one beat's
// last spoken word and the next beat's first one (confirmed live via
// silencedetect on a real assembled track: ~0.87s measured gaps
// against the ~0.4s the code's own math implies). Fixed by trimming
// each clip's leading/trailing silence BEFORE measuring its duration,
// so the "+0.4s buffer" is added to the clip's ACTUAL spoken length,
// not spoken-length-plus-however-much-dead-air-the-TTS-engine-left.
//
// The classic "trim both ends" ffmpeg idiom: silenceremove only ever
// strips from the START of a stream, so trimming the END requires
// reversing, stripping the (now-leading) silence, and reversing back.
// `start_silence=0.05` deliberately leaves a small residual pause
// rather than a hard, unnatural cut straight into the first phoneme.
function trimClipSilence(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const filter = 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-35dB:detection=peak,'
      + 'areverse,'
      + 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-35dB:detection=peak,'
      + 'areverse';
    const ff = spawn(ffmpegPath, ['-y', '-i', inputPath, '-af', filter, outputPath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg silence trim exited ${code}: ${stderr.slice(-500)}`))));
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
    return capToMaxDuration({ ...sceneJSON, scenes: renderScenes }, audioFiles);
  }

  const dir = narrationDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });

  for (const { scene, index } of beatsWithNarration) {
    try {
      // Scene generation writes PLAIN narration on purpose (see
      // scenePrompts.js) - tag annotation is this deliberately separate
      // second pass (narrationTagging.js), which also guarantees the
      // mandatory [break]/[long-break]/[soft] placement mechanically,
      // regardless of what the tagging model itself did or missed.
      const taggedText = await annotateNarrationTags(scene.params.narration.trim());
      console.log(`[narrationPrefetch] beat ${index} tagged text: ${taggedText}`);
      const buf = await generateSpeech(taggedText);
      const rawPath = path.join(dir, `${index}-raw.mp3`);
      fs.writeFileSync(rawPath, buf);

      const trimmedPath = path.join(dir, `${index}-trimmed.mp3`);
      try {
        await trimClipSilence(rawPath, trimmedPath);
        fs.unlink(rawPath, () => {});
      } catch (trimErr) {
        // Silence trimming is polish, not correctness - if it fails for
        // any reason, fall back to the untrimmed clip rather than
        // losing this beat's narration entirely over it.
        console.warn(`[narrationPrefetch] beat ${index} silence trim failed, using untrimmed clip: ${trimErr.message}`);
        fs.renameSync(rawPath, trimmedPath);
      }

      // Mastered PER CLIP, here, before assembly - not just on the
      // final whole-track mix in audioMux.js. See masterNarrationAudio's
      // own doc comment for the real, measured reason: normalizing the
      // whole assembled track (every beat's clip plus every silence gap
      // between them) computes its gain against an average that's been
      // diluted quiet by all that deliberate silence, so it ends up
      // boosting the actual VOICE more than the voice alone needs.
      const filePath = path.join(dir, `${index}.mp3`);
      try {
        await masterNarrationAudio(trimmedPath, filePath);
        fs.unlink(trimmedPath, () => {});
      } catch (masterErr) {
        console.warn(`[narrationPrefetch] beat ${index} per-clip mastering failed, using unmastered clip: ${masterErr.message}`);
        fs.renameSync(trimmedPath, filePath);
      }

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

  return capToMaxDuration({ ...sceneJSON, scenes: renderScenes }, audioFiles);
}

function cleanupNarration(jobId) {
  fs.rm(narrationDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchNarration, cleanupNarration, narrationDirFor };
