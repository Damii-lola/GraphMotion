const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fishTts = require('./fishTtsGen');
const edgeTts = require('./ttsGen');
const { annotateNarrationTags } = require('./narrationTagging');
const { synthesizeVerified } = require('./narrationVerify');
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
 * sentence [break] pause, is itself evidence of trailing artifact
 * content sitting after it - cut the clip there rather than shipping
 * whatever comes next.
 *
 * Deliberately conservative, and deliberately picks the LAST qualifying
 * gap, not the first: a real sentence can have its OWN legitimate
 * mid-sentence [break] pause (after a comma) that's just as long as an
 * artifact-preceding gap - confirmed live in testing, where picking the
 * first gap past 40% cut a clip off mid-sentence at a real comma pause,
 * losing genuine trailing content along with the artifact it was meant
 * to remove. The LAST such gap is safe because [break][break] (the
 * sentence's own final pause) is always the last legitimate gap in
 * correctly-tagged narration - nothing real ever follows it. Anything
 * after that final gap is either nothing (clean clip - already edge-
 * trimmed away) or hallucinated artifact content (dirty clip).
 * Requires >= 600ms of silence to qualify at all (comfortably above the
 * ~0.2-0.5s a real judgment-based mid-sentence [break] tends to
 * produce on its own, based on measured pause durations on real
 * assembled narration) and only acts on a gap starting after 40% of
 * the clip's own duration (every observed hallucination has landed in
 * the back half). Leaves the clip untouched if no such gap is found -
 * this is a blunt, judge-free mechanical step (no AI call), so it only
 * acts where the evidence is unambiguous.
 */
function trimTrailingArtifact(inputPath, outputPath) {
  const ARTIFACT_GAP_THRESHOLD_S = 0.6;
  const MIN_FRACTION_OF_CLIP = 0.4;
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
 * Generates narration audio for every beat that has one, IN PARALLEL
 * across beats (like imagePrefetch.js) - was sequential when the only
 * engine was msedge-tts's single-connection-per-call websocket, but
 * Fish Audio (the primary engine now, see generateSpeech above) is a
 * stateless REST API with no such constraint, and each beat's own
 * synthesizeVerified retry loop (narrationVerify.js, up to 5 attempts
 * x 2 concurrent judge passes each) is now expensive enough that
 * running 5 beats back to back rather than together was a real,
 * measured source of the multi-minute generation times that prompted
 * this change ("add it back but can u make it faster" - direct user
 * feedback after the sequential 2-judge-pass version). Each beat only
 * ever touches its OWN index in `renderScenes`/`audioFiles`, so
 * there's no shared-state conflict between beats running concurrently.
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
      // mandatory sentence-ending [break][break] placement mechanically,
      // regardless of what the tagging model itself did or missed.
      const plainText = scene.params.narration.trim();
      // A third AI stage judges the actual synthesized audio (not just
      // the tagged text) against the real script - non-speech artifacts
      // (hallucinated words, laughing, etc) and unnatural pause
      // placement both fail it. On rejection, re-tags AND re-synthesizes
      // from scratch with the judge's feedback folded in, rather than
      // just re-rolling the same TTS call - see narrationVerify.js.
      const { taggedText, buf, passed } = await synthesizeVerified(plainText, async (feedback) => {
        const tagged = await annotateNarrationTags(plainText, feedback);
        const audioBuf = await generateSpeech(tagged);
        return { taggedText: tagged, buf: audioBuf };
      });
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

      // Mechanical last line of defense against the judge's own retry
      // budget running out (see synthesizeVerified) - cuts off a
      // trailing hallucinated artifact if one is still there, using the
      // internal-silence-gap signature described on trimTrailingArtifact
      // itself. Deliberately gated on `passed` being false: a clip the
      // judge already explicitly confirmed clean has nothing to gain
      // from this blunt heuristic and only stands to lose real content
      // if the gap-detection ever misfires (a real, confirmed failure
      // mode caught in testing - it can mistake a genuine mid-sentence
      // pause for an artifact boundary when there's only one qualifying
      // gap in the whole clip). Only worth the risk on a take that
      // wasn't trustworthy to begin with.
      let tailTrimmedPath = trimmedPath;
      if (!passed) {
        tailTrimmedPath = path.join(dir, `${index}-tailtrimmed.mp3`);
        try {
          await trimTrailingArtifact(trimmedPath, tailTrimmedPath);
          fs.unlink(trimmedPath, () => {});
        } catch (tailErr) {
          console.warn(`[narrationPrefetch] beat ${index} tail-artifact trim failed, using untrimmed clip: ${tailErr.message}`);
          fs.renameSync(trimmedPath, tailTrimmedPath);
        }
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
        await masterNarrationAudio(tailTrimmedPath, filePath);
        fs.unlink(tailTrimmedPath, () => {});
      } catch (masterErr) {
        console.warn(`[narrationPrefetch] beat ${index} per-clip mastering failed, using unmastered clip: ${masterErr.message}`);
        fs.renameSync(tailTrimmedPath, filePath);
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
  }));

  return capToMaxDuration({ ...sceneJSON, scenes: renderScenes }, audioFiles);
}

function cleanupNarration(jobId) {
  fs.rm(narrationDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchNarration, cleanupNarration, narrationDirFor };
