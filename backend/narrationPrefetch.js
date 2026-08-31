const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { generateSpeech } = require('./ttsGen');

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

// Real, confirmed-live finding: this free TTS gateway rejects almost
// any SSML beyond the plainest <prosody> wrapper - <emphasis>, style
// tags, and even the basic <break time="..."/> pause tag were all
// tested directly here and every one of them closes the connection
// outright ("stream closed, no turn.end received"). That's the actual
// reason narration reads as one flat, rushed stream instead of how a
// person actually speaks it - a real person breaks a sentence into
// short breath-group PHRASES with a pause between each ("It's actually
// / a deep-seated instinct / from when they were kittens", not one
// unbroken run), and there's no SSML tag on this tier that can mark
// those pauses.
//
// Fixed WITHOUT SSML: each phrase (scenePrompts.js has the model write
// narration as one phrase per line) becomes its OWN separate, plain-
// text TTS call - guaranteed to work, since it's just text, the one
// thing this gateway never rejects - and the phrases are stitched back
// together into one clip with a real, controlled silence gap between
// them via ffmpeg concat, the same reliable mechanism this file
// already uses for inter-beat gaps (audioMux.js's generateSilence).
// Calibrated down from an initial 0.22s after direct measurement on a
// real render: the inserted gap isn't the ONLY silence a listener
// hears there - trimClipSilence deliberately leaves a small residual
// pause on both the outgoing phrase's tail and the incoming phrase's
// head (see its own doc comment), which stacks additively with this
// gap. Measured live: 0.22s here produced ~0.4-0.47s of ACTUAL
// silence between phrases, barely distinguishable from the longer
// ~0.4s inter-BEAT pause - defeating the whole point of a short,
// breath-like pause that reads as different from a bigger structural
// gap between ideas. Lowered to compensate for that stacking.
const INTRA_PHRASE_GAP_SECONDS = 0.1;

function generateGapClip(outPath, seconds) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds), '-q:a', '4', outPath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg gap-clip exited ${code}: ${stderr.slice(-500)}`))));
    ff.on('error', reject);
  });
}

/** Stream-copy concat (all inputs share the identical mp3 encoding, generated by the same TTS call in sequence) - fast, lossless, the same technique longVideoOrchestrator.js already uses for whole chunk files. */
function concatClips(clipPaths, outPath) {
  return new Promise((resolve, reject) => {
    const listPath = `${outPath}.concat-list.txt`;
    fs.writeFileSync(listPath, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const ff = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => {
      fs.unlink(listPath, () => {});
      (code === 0 ? resolve() : reject(new Error(`ffmpeg concat exited ${code}: ${stderr.slice(-500)}`)));
    });
    ff.on('error', reject);
  });
}

/**
 * Generates ONE beat's full narration clip, phrase by phrase - splits
 * on real newlines (scenePrompts.js instructs the model to write one
 * natural breath-group phrase per line), trims each phrase's own
 * leading/trailing silence individually (same trimClipSilence as a
 * single-phrase beat always used), then concatenates them with a short
 * gap between each. A beat with no internal line breaks is exactly one
 * phrase - same single TTS call + trim this file always did, just
 * routed through the same code path instead of a separate branch.
 */
async function generateBeatNarrationClip(narrationText, dir, index) {
  const phrases = narrationText.split('\n').map((p) => p.trim()).filter(Boolean);
  const segments = [];
  for (let p = 0; p < phrases.length; p++) {
    const buf = await generateSpeech(phrases[p]);
    const rawPath = path.join(dir, `${index}-p${p}-raw.mp3`);
    fs.writeFileSync(rawPath, buf);
    const trimmedPath = path.join(dir, `${index}-p${p}.mp3`);
    try {
      await trimClipSilence(rawPath, trimmedPath);
      fs.unlink(rawPath, () => {});
    } catch (trimErr) {
      console.warn(`[narrationPrefetch] beat ${index} phrase ${p} silence trim failed, using untrimmed clip: ${trimErr.message}`);
      fs.renameSync(rawPath, trimmedPath);
    }
    segments.push(trimmedPath);
  }

  if (segments.length === 1) return segments[0];

  const gapPath = path.join(dir, `${index}-gap.mp3`);
  await generateGapClip(gapPath, INTRA_PHRASE_GAP_SECONDS);
  const withGaps = [];
  segments.forEach((seg, i) => {
    withGaps.push(seg);
    if (i < segments.length - 1) withGaps.push(gapPath);
  });
  const finalPath = path.join(dir, `${index}.mp3`);
  await concatClips(withGaps, finalPath);
  for (const seg of segments) fs.unlink(seg, () => {});
  fs.unlink(gapPath, () => {});
  return finalPath;
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
      const filePath = await generateBeatNarrationClip(scene.params.narration.trim(), dir, index);
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
