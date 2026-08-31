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

// Explicit request: every comma-level pause (not just between beats)
// should last 2-3s - a real, deliberate, dramatic-pause style choice,
// not a "sounds like natural conversation" one. There's no SSML way to
// insert a pause on this free TTS tier at all (<break>, like <emphasis>
// and style tags, breaks the connection outright - confirmed directly,
// see this file's own git history), so this is done the only way that
// actually works here: each comma-separated segment of a beat's
// narration becomes its OWN plain-text TTS call (guaranteed to work),
// stitched back together via ffmpeg concat with a real, silent gap
// clip between segments - the same reliable mechanism already used for
// inter-beat gaps.
const COMMA_PAUSE_SECONDS = 2.5;

function generateGapClip(outPath, seconds) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds), '-q:a', '4', outPath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg gap-clip exited ${code}: ${stderr.slice(-500)}`))));
    ff.on('error', reject);
  });
}

/** Stream-copy concat (all inputs share the identical mp3 encoding, generated in sequence) - fast, lossless, the same technique longVideoOrchestrator.js already uses for whole chunk files. */
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
 * Generates ONE beat's full narration clip, comma segment by comma
 * segment - each segment is its own separate plain-text TTS call
 * (trailing/leading commas stripped, since the 2-3s silence gap now
 * carries the pause the comma would have - leaving the comma in too
 * would just add the TTS engine's own small comma-pause on top),
 * trimmed individually (same trimClipSilence a single-segment beat
 * always used), then concatenated with COMMA_PAUSE_SECONDS of real
 * silence between segments. A beat with no comma is exactly one
 * segment - the same single TTS call + trim this file always did.
 */
async function generateBeatNarrationClip(narrationText, dir, index) {
  const segments = narrationText.split(',').map((s) => s.trim()).filter(Boolean);
  const clips = [];
  for (let s = 0; s < segments.length; s++) {
    const buf = await generateSpeech(segments[s]);
    const rawPath = path.join(dir, `${index}-s${s}-raw.mp3`);
    fs.writeFileSync(rawPath, buf);
    const trimmedPath = path.join(dir, `${index}-s${s}.mp3`);
    try {
      await trimClipSilence(rawPath, trimmedPath);
      fs.unlink(rawPath, () => {});
    } catch (trimErr) {
      console.warn(`[narrationPrefetch] beat ${index} segment ${s} silence trim failed, using untrimmed clip: ${trimErr.message}`);
      fs.renameSync(rawPath, trimmedPath);
    }
    clips.push(trimmedPath);
  }

  if (clips.length === 1) return clips[0];

  const gapPath = path.join(dir, `${index}-gap.mp3`);
  await generateGapClip(gapPath, COMMA_PAUSE_SECONDS);
  const withGaps = [];
  clips.forEach((clip, i) => {
    withGaps.push(clip);
    if (i < clips.length - 1) withGaps.push(gapPath);
  });
  const finalPath = path.join(dir, `${index}.mp3`);
  await concatClips(withGaps, finalPath);
  for (const clip of clips) fs.unlink(clip, () => {});
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
