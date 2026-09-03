const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const deepgramTts = require('./deepgramTtsGen');
const fishTts = require('./fishTtsGen');
const edgeTts = require('./ttsGen');
const { annotateNarrationTags } = require('./narrationTagging');
const { getWordTimings } = require('./wordTiming');

/**
 * Production narration voice promoted to Deepgram's Aura-2 (orpheus)
 * after direct user comparison against Fish Audio's free tier - a real
 * generated sample, blind listen, "sounds way better." Three-tier
 * fallback, each a real independent failure mode worth falling back
 * from rather than losing a beat's narration entirely: Deepgram first
 * (needs DEEPGRAM_API_KEY + its own account), then Fish Audio (needs
 * FISH_API_KEY, was the previous primary), then msedge-tts's Eric
 * (zero-key/zero-account, the original zero-dependency fallback this
 * project has always had).
 */
async function generateSpeech(text) {
  try {
    return await deepgramTts.generateSpeech(text);
  } catch (err) {
    console.warn(`[narrationPrefetch] Deepgram TTS failed, falling back to Fish Audio: ${err.message}`);
  }
  try {
    return await fishTts.generateSpeech(text);
  } catch (err) {
    console.warn(`[narrationPrefetch] Fish Audio TTS also failed, falling back to Eric: ${err.message}`);
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
 * Real, repeatedly-confirmed pattern from testing narrationVerify.js's
 * judge: when Fish Audio hallucinates trailing content (a sigh, a
 * laugh, a stray word), it consistently lands AFTER a long INTERNAL
 * silence gap - one trimClipSilence can't touch, since that filter
 * only ever strips silence from the two edges of the file, and this
 * gap is sandwiched between real audio on both sides. On a genuinely
 * clean clip, no such gap survives trimClipSilence - whatever pause
 * the TTS engine left past the real last word is, by definition, edge
 * silence, and already gone by this point in the pipeline. So: any
 * silence gap still present in the LATTER part of an already
 * edge-trimmed clip, long enough to be well past a normal within-
 * sentence pause, is itself evidence of trailing artifact content
 * sitting after it - cut the clip there rather than shipping whatever
 * comes next.
 *
 * Deliberately conservative, and deliberately picks the LAST qualifying
 * gap, not the first: a real sentence can have its OWN legitimate
 * mid-sentence pause (an inserted "..." after a comma - see
 * narrationTagging.js) that's just as long as an artifact-preceding
 * gap - confirmed live in testing, where picking the first gap past
 * 40% cut a clip off mid-sentence at a real comma pause, losing genuine
 * trailing content along with the artifact it was meant to remove. The
 * LAST such gap is safe because the sentence's own final "..." is
 * always the last legitimate gap in correctly-tagged narration -
 * nothing real ever follows it. Anything after that final gap is
 * either nothing (clean clip - already edge-trimmed away) or
 * hallucinated artifact content (dirty clip). Requires >= 600ms of
 * silence to qualify at all (comfortably above the ~0.2-0.5s a real
 * judgment-based mid-sentence pause tends to produce on its own, based
 * on measured pause durations on real assembled narration) and only
 * acts on a gap starting after 40% of
 * the clip's own duration (every observed hallucination has landed in
 * the back half). Leaves the clip untouched if no such gap is found -
 * this is a blunt, judge-free mechanical step (no AI call), so it only
 * acts where the evidence is unambiguous.
 *
 * SECOND safety check, added after a real production miss: a beat
 * whose narration accidentally had TWO full sentences (a scenePrompts.js
 * gap since fixed, but the model won't always obey it) has TWO
 * legitimate "..." gaps - the one between its sentences, and its real
 * final one. If the true trailing artifact after the SECOND sentence
 * has less silence before it than ARTIFACT_GAP_THRESHOLD_S (a quiet
 * breath sound, observed in production, can follow almost immediately
 * with barely a pause), the between-sentences gap becomes the only
 * "last qualifying gap" found - and cutting there discards the ENTIRE
 * second sentence, real content, not an artifact. Real trailing
 * artifacts are always brief (a word, a breath, a laugh) - if cutting
 * at the chosen gap would discard more than MAX_DISCARD_S of audio,
 * that's a strong sign this is real content, not an artifact, and the
 * clip is left untouched instead (a missed artifact is a much smaller
 * loss than a discarded sentence).
 */
function trimTrailingArtifact(inputPath, outputPath) {
  const ARTIFACT_GAP_THRESHOLD_S = 0.6;
  const MIN_FRACTION_OF_CLIP = 0.4;
  const MAX_DISCARD_S = 2.0;
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-i', inputPath, '-af', `silencedetect=noise=-30dB:d=${ARTIFACT_GAP_THRESHOLD_S}`, '-f', 'null', '-']);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', () => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!durationMatch) { fs.copyFileSync(inputPath, outputPath); resolve(); return; }
      const totalDuration = (+durationMatch[1]) * 3600 + (+durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
      const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
      const qualifying = starts.filter((s) => s > totalDuration * MIN_FRACTION_OF_CLIP);
      const cutPoint = qualifying.length > 0 ? qualifying[qualifying.length - 1] : undefined;
      if (cutPoint === undefined) { fs.copyFileSync(inputPath, outputPath); resolve(); return; }
      if (totalDuration - cutPoint > MAX_DISCARD_S) {
        console.warn(`[narrationPrefetch] tail-artifact trim skipped - candidate cut would discard ${(totalDuration - cutPoint).toFixed(2)}s, too long to be a real artifact (likely a second sentence instead)`);
        fs.copyFileSync(inputPath, outputPath);
        resolve();
        return;
      }
      const cutFf = spawn(ffmpegPath, ['-y', '-i', inputPath, '-t', String(cutPoint), outputPath]);
      let cutStderr = '';
      cutFf.stderr.on('data', (d) => { cutStderr += d.toString(); });
      cutFf.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg tail-artifact cut exited ${code}: ${cutStderr.slice(-500)}`))));
      cutFf.on('error', reject);
    });
    ff.on('error', reject);
  });
}

/**
 * Real, direct user request after watching a reference video: "the
 * on-screen text matches the audio one to one, like as the voice is
 * saying it, the text is appearing." Everything built before this
 * point (sceneSchema.js's ensureSustainedWordMotion) only ever had an
 * ESTIMATED word-reveal timing to work with - a fraction of the beat's
 * own AUTHORED duration, computed during JSON generation, before any
 * narration audio exists at all. Real, per-word timing (wordTiming.js,
 * via Deepgram STT on the actual final clip) only becomes available
 * HERE, after narration is generated - this is the real version of
 * that same idea, replacing whatever generic reveal timing the beat's
 * matching text layer already has with the REAL moment each word is
 * actually spoken.
 *
 * Only applies when a text layer's own word count is within 1 of the
 * narration's real spoken word count - scenePrompts.js's own minimal
 * prompt now directly asks for the dominant text layer to BE the
 * narration line, word for word, specifically so this can work, but a
 * mismatch is still possible (a differently-worded secondary label, a
 * model that didn't follow the instruction). Applying a sync built for
 * one word count to a DIFFERENTLY-worded layer would desync almost
 * immediately - worse than the generic estimate it would replace - so
 * this skips cleanly rather than guess, leaving the existing mechanical
 * reveal in place.
 *
 * Builds real "hold" keyframes (a genuine AE-style step interpolation,
 * not an eased ramp - each word's own reveal percentage holds constant
 * from the instant that word starts until the next one does, then
 * jumps) rather than the smooth continuous sweep ensureSustainedWordMotion
 * uses - real speech pacing is NOT constant word-to-word, so only a
 * per-word step function can actually track it.
 */
function applyRealWordTimingToText(scene, wordTimings) {
  if (!Array.isArray(wordTimings) || wordTimings.length === 0) return;
  if (!isPlainObject(scene.visual) || !Array.isArray(scene.visual.layers)) return;
  const textLayers = scene.visual.layers.filter((l) => isPlainObject(l) && l.type === 'text' && typeof l.text === 'string');
  if (textLayers.length === 0) return;

  const narrationWordCount = wordTimings.length;
  let bestLayer = null;
  let bestDiff = Infinity;
  for (const layer of textLayers) {
    const layerWordCount = layer.text.trim().split(/\s+/).filter(Boolean).length;
    const diff = Math.abs(layerWordCount - narrationWordCount);
    if (diff < bestDiff) { bestDiff = diff; bestLayer = layer; }
  }
  if (!bestLayer || bestDiff > 1) return;

  const layerWordCount = bestLayer.text.trim().split(/\s+/).filter(Boolean).length;
  const usedCount = Math.min(layerWordCount, narrationWordCount);
  const keyframes = [];
  if (wordTimings[0].start > 0.02) keyframes.push({ time: 0, value: 0, interpolation: 'hold' });
  for (let i = 0; i < usedCount; i++) {
    keyframes.push({
      time: Math.max(0, wordTimings[i].start),
      value: Math.round(((i + 1) / usedCount) * 10000) / 100,
      interpolation: 'hold',
    });
  }
  if (keyframes.length === 0) return;

  bestLayer.animators = [{
    selector: { type: 'range', start: 0, end: { keyframes }, basedOn: 'words' },
    properties: { opacity: -1 },
  }];
}

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/**
 * Generates narration audio for every beat that has one, IN PARALLEL
 * across beats (like imagePrefetch.js) - was sequential when the only
 * engine was msedge-tts's single-connection-per-call websocket, but
 * Fish Audio (the primary engine now, see generateSpeech above) is a
 * stateless REST API with no such constraint. Narration verification
 * has a real history here worth knowing if this ever needs revisiting:
 * first a judge call with up to 5 retries, then a single judge call
 * with no retry (real API-call-volume consequences from the retry
 * version - see git history), and now no AI judge at all - direct user
 * request once production logs showed rendering, not narration, is the
 * actual dominant cost of a generation, so trading away this stage's
 * own quality gate barely moves total time but does cut a full Gemini
 * call and a few seconds of latency per beat. trimTrailingArtifact
 * (below) is what's left doing quality control here, unconditionally
 * now instead of judge-gated - see its own doc comment for why that's
 * still safe. Beats still run in parallel since there's no reason not
 * to. Each beat only ever touches its OWN index in
 * `renderScenes`/`audioFiles`, so there's no shared-state conflict
 * between beats running concurrently.
 * For each beat with narration, measures the real spoken duration and
 * OVERRIDES that beat's `duration` param to match (+ a small buffer) -
 * visual pacing follows how long the narration actually takes to say,
 * not an arbitrary authored guess.
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

  await Promise.all(beatsWithNarration.map(async ({ scene, index }) => {
    try {
      // Scene generation writes PLAIN narration on purpose (see
      // scenePrompts.js) - tag annotation is this deliberately separate
      // second pass (narrationTagging.js), which also guarantees the
      // mandatory sentence-ending "..." pause placement mechanically,
      // regardless of what the tagging model itself did or missed.
      const plainText = scene.params.narration.trim();
      // No AI audio judge anymore, and no retry - direct user request
      // to cut every remaining second/API-call off the narration stage
      // once real production logs showed rendering (not narration) is
      // the actual dominant cost anyway, so trading away this stage's
      // own quality gate barely moves total generation time but does
      // remove a full Gemini call + a few seconds of latency per beat.
      // Tag, synthesize, done - trimTrailingArtifact below now runs
      // UNCONDITIONALLY instead of only on a judge-flagged clip; its
      // own internal safety checks (a qualifying silence gap must
      // exist, and cutting it can't discard more than 2s of audio -
      // see its own doc comment) are what keep this safe without an AI
      // judgment call deciding whether it's worth attempting.
      const taggedText = await annotateNarrationTags(plainText);
      const buf = await generateSpeech(taggedText);
      console.log(`[narrationPrefetch] beat ${index} tagged text: ${taggedText}`);
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

      // Mechanical (no AI call) tail-artifact cleanup - now runs on
      // EVERY clip unconditionally, since there's no judge verdict left
      // to gate it on. Safe to run unconditionally specifically because
      // trimTrailingArtifact only ever acts when it finds an unambiguous
      // internal silence gap AND cutting there would discard 2 seconds
      // or less (see its own doc comment) - a clean clip simply has no
      // such gap to find, so this is a fast no-op cost (one ffmpeg
      // silencedetect pass) on the common case, not a real risk.
      const tailTrimmedPath = path.join(dir, `${index}-tailtrimmed.mp3`);
      try {
        await trimTrailingArtifact(trimmedPath, tailTrimmedPath);
        fs.unlink(trimmedPath, () => {});
      } catch (tailErr) {
        console.warn(`[narrationPrefetch] beat ${index} tail-artifact trim failed, using untrimmed clip: ${tailErr.message}`);
        fs.renameSync(trimmedPath, tailTrimmedPath);
      }

      // Mastering (highpass/compressor/loudnorm/alimiter) REMOVED per
      // direct user request after switching to Deepgram's Aura-2 -
      // that whole chain was tuned entirely around Fish Audio's very
      // quiet (-23.9 LUFS), noisy raw output. Deepgram's raw output
      // needs none of that, and the chain was a real, confirmed
      // contributor to a "sounds like an auditorium" complaint: a
      // spectrogram comparison showed raw Deepgram audio has genuine
      // energy up to its own true ~11-12kHz ceiling, while the final
      // processed render only had real content up to ~8.8kHz - each
      // extra lossy mp3 re-encode pass this file went through (this
      // mastering step included) compounds quality loss. Deepgram's
      // own output is used PLAIN now - just the trim/tail-artifact
      // safety steps, no gain/EQ/dynamics processing on top.
      const filePath = path.join(dir, `${index}.mp3`);
      try {
        fs.renameSync(tailTrimmedPath, filePath);
      } catch (renameErr) {
        console.warn(`[narrationPrefetch] beat ${index} final rename failed: ${renameErr.message}`);
      }

      const duration = await getAudioDurationSeconds(filePath);
      audioFiles.set(index, { path: filePath, duration });

      // Real, audio-measured per-word timing (start/end seconds within
      // THIS clip) - see wordTiming.js's own doc comment. Read back off
      // disk rather than reusing `buf` above since `buf` is the PRE-trim
      // TTS output; this needs to match the exact audio that ships.
      const wordTimings = await getWordTimings(fs.readFileSync(filePath));
      if (wordTimings) {
        renderScenes[index].params.wordTimings = wordTimings;
        applyRealWordTimingToText(renderScenes[index], wordTimings);
      }
      // Buffer so the visual doesn't cut away the instant speech ends -
      // a beat that's ONLY as long as the narration reads as clipped,
      // not intentional. This gap is also the actual audible pause
      // between one beat's last word and the next beat's first one
      // (muxNarrationOntoVideo inserts real silence to fill exactly this
      // remainder - see its own beat.duration - audio.duration math).
      // Direct user request, based on a real staged A/B listening test:
      // 1.5s read as having a "very slight, barely noticeable" but real
      // difference from raw - pulled back to 0.5s. SPEED_FACTOR in
      // audioMux.js is also being set to 1.0 (no speed-up) per the same
      // test, so this value IS the real perceived pause length directly -
      // no multiply-by-speed-factor derivation needed while that stays
      // at 1.0 (see audioMux.js's own comment if that ever changes).
      renderScenes[index].params.duration = duration + 0.5;
    } catch (err) {
      console.warn(`[narrationPrefetch] beat ${index} narration failed, keeping authored duration: ${err.message}`);
    }
  }));

  return capToMaxDuration({ ...sceneJSON, scenes: renderScenes }, audioFiles);
}

function cleanupNarration(jobId) {
  fs.rm(narrationDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchNarration, cleanupNarration, narrationDirFor };
