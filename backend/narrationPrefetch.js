const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const deepgramTts = require('./deepgramTtsGen');
const edgeTts = require('./ttsGen');
const { annotateNarrationTags } = require('./narrationTagging');
const { getWordTimings } = require('./wordTiming');

/**
 * Production narration voice promoted to Deepgram's Aura-2 (orpheus)
 * after direct user comparison against Fish Audio's free tier - a real
 * generated sample, blind listen, "sounds way better." Fish Audio
 * REMOVED entirely (2026-09-17, direct user request) - it was a
 * transitional middle tier from before Deepgram became primary, no
 * longer needed. Two-tier fallback now: Deepgram first (needs
 * DEEPGRAM_API_KEY + its own account), then msedge-tts's Eric
 * (zero-key/zero-account, the original zero-dependency fallback this
 * project has always had) if Deepgram fails outright.
 */
async function generateSpeech(text) {
  try {
    return await deepgramTts.generateSpeech(text);
  } catch (err) {
    console.warn(`[narrationPrefetch] Deepgram TTS failed, falling back to Eric: ${err.message}`);
    return edgeTts.generateSpeech(text);
  }
}

function narrationDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-narration`);
}

/** Generic ffmpeg run, same pattern audioMux.js already uses - needed here now that capToMaxDuration has to physically re-trim the shared narration clip (a real ffmpeg pass), not just filter a per-beat map. */
function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))));
    p.on('error', reject);
  });
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
 * Drops trailing beats (and the now-excess tail of the one shared
 * narration clip) once the running total would exceed the cap - always
 * keeps at least the first beat, even in the pathological case where one
 * beat alone is longer than the cap, so a video is never reduced to
 * nothing. `narration` is the single {path, duration} object the whole
 * video's audio now lives in (see prefetchNarration's own doc comment) -
 * when beats get cut, the audio has to be physically trimmed to match,
 * not just left to run past the now-shorter video: the final mux's own
 * `-shortest` flag would otherwise chop it off mid-word at whatever
 * instant the video happens to end, instead of this doing it cleanly at
 * the real beat boundary.
 */
async function capToMaxDuration(sceneJSON, narration) {
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
  if (cutIndex >= sceneJSON.scenes.length) return { sceneJSON, narration };

  console.warn(`[narrationPrefetch] generated video ran long - trimming to ${cutIndex} of ${sceneJSON.scenes.length} beats (~${total.toFixed(1)}s) to stay under the ${MAX_TOTAL_DURATION_SECONDS}s MVP cap`);

  let trimmedNarration = narration;
  if (narration && narration.path && narration.duration > total + 0.05) {
    const dir = path.dirname(narration.path);
    const trimmedPath = path.join(dir, 'combined-capped.mp3');
    try {
      await run(['-y', '-i', narration.path, '-t', String(total), '-c:a', 'libmp3lame', '-q:a', '4', trimmedPath]);
      trimmedNarration = { path: trimmedPath, duration: total };
    } catch (err) {
      console.warn(`[narrationPrefetch] failed to trim shared narration clip to the cap, leaving it untrimmed (the final mux's own -shortest will still clip it to the video): ${err.message}`);
    }
  }

  return {
    sceneJSON: { ...sceneJSON, scenes: sceneJSON.scenes.slice(0, cutIndex) },
    narration: trimmedNarration,
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
// Real, direct user report: "the audio for the script sometimes feels
// incomplete and cut off" - reported right after narration lines
// shrank to 3-8 words (see the new MAX_NARRATION_WORDS cap). This
// function's own thresholds (a 0.6s+ gap after 40% of the clip) were
// tuned against the OLD, longer 8-14 word narration, where a genuine
// sentence-final pause sits well past 40% and a hallucinated tail is
// still a small fraction of a long clip. For a short 1-2s clip, a
// perfectly normal end-of-sentence pause (from the mandatory trailing
// "..." every sentence gets - see narrationTagging.js) is now a much
// BIGGER relative fraction of the whole clip, and this project already
// has direct evidence elsewhere this session that this TTS engine's
// own pause length has real per-call variance - raising real risk of
// misfiring on a short clip's own legitimate ending, not just on an
// actual hallucinated artifact. Hallucinated trailing content is also
// a real ARTICLE of complexity - a short, simple 3-8 word utterance is
// inherently less likely to trigger it than a longer, more complex one
// this function was originally built for. Skipped entirely under this
// duration - the risk/reward no longer favors trying.
const MIN_DURATION_FOR_TAIL_TRIM_S = 2.5;

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
      if (totalDuration < MIN_DURATION_FOR_TAIL_TRIM_S) { fs.copyFileSync(inputPath, outputPath); resolve(); return; }
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

  // Real, previously-uncaught bug found auditing this function
  // (2026-09-03): typewriter-mode beats (sceneSchema.js's own
  // ensureTypewriterReveal) intentionally want a FIXED, independent
  // typing-speed reveal, never real audio timing - a terminal-style
  // typing effect is a deliberate visual device, not meant to track
  // spoken word boundaries. Marked via a real, checkable id
  // ('__typewriter_text__') rather than inferred from animator shape,
  // so this stays a simple, explicit opt-out.
  if (bestLayer.id === '__typewriter_text__') return;

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

  // Real, previously-uncaught bug found the same audit
  // (2026-09-03): this used to REPLACE bestLayer.animators wholesale
  // (`bestLayer.animators = [...]`) - correct for swapping the OLD
  // estimated word-reveal sweep (ensureSustainedWordMotion's own
  // color-sweep animator, the only thing that used to live here when
  // this was written) for the real-audio-timed one, but sceneSchema.js
  // has since grown OTHER animators on the same dominant layer that
  // have nothing to do with the reveal at all - ensureEmphasisWordScale's
  // own static per-word "scale" boost, most notably - and a wholesale
  // overwrite would have silently deleted those in every real
  // production job (every local render test this session verified
  // these features against called renderTimelineRange directly,
  // bypassing this real-audio-timing step entirely, so this never
  // actually got exercised until this audit). Fixed to remove ONLY the
  // old reveal-type animator (identified by "properties.color" - the
  // one and only property ensureSustainedWordMotion's own sweep ever
  // sets on this layer, confirmed by reading that function directly)
  // and preserve everything else.
  const preservedAnimators = Array.isArray(bestLayer.animators)
    ? bestLayer.animators.filter((a) => !(isPlainObject(a) && isPlainObject(a.properties) && a.properties.color !== undefined))
    : [];
  bestLayer.animators = [
    ...preservedAnimators,
    {
      selector: { type: 'range', start: 0, end: { keyframes }, basedOn: 'words' },
      properties: { opacity: -1 },
    },
  ];

  // Real, confirmed bug found via a production render (2026-09-03):
  // ensureHighlightChip (sceneSchema.js) can only ESTIMATE when its
  // target word lands, since real audio timing doesn't exist yet at
  // JSON-generation time - but this function has the ACTUAL per-word
  // start time right here (wordTimings), so replace the estimate with
  // the exact real value for the word the highlight is anchored to.
  if (Array.isArray(bestLayer.highlights) && bestLayer.highlights.length > 0) {
    const hl = bestLayer.highlights[0];
    if (isPlainObject(hl) && isPlainObject(hl.selector) && typeof hl.selector.start === 'number') {
      const hlWordIndex = Math.round((hl.selector.start / 100) * usedCount);
      if (hlWordIndex >= 0 && hlWordIndex < usedCount) {
        hl.appearAt = Math.max(0, wordTimings[hlWordIndex].start);
      }
    }
  }

  // tripleStack's own top caption (sceneSchema.js's
  // buildWordCascadeCaptionLayer) authors a SECOND animator on this same
  // layer - a per-word "pop" (properties.scale) whose selector.start/end
  // sweep across word-index space so the window's center lands exactly
  // on each word at that word's own reveal time (see that function's own
  // doc comment for why the pulse has to live in the SELECTOR, not a
  // static property). Authored against an ESTIMATED even split, same as
  // the reveal above - re-centering it here on the SAME real wordTimings
  // keeps the pop from drifting out of sync with when each word actually
  // becomes visible, exactly the same real-timing upgrade already
  // applied to the reveal itself just above. Identified by
  // `properties.scale` - nothing else this project ever authors on a
  // caption/headline text layer uses that property.
  const popAnimator = preservedAnimators.find((a) => isPlainObject(a) && isPlainObject(a.properties) && typeof a.properties.scale === 'number' && isPlainObject(a.selector));
  if (popAnimator) {
    const POP_HALF_WIDTH_DIVISOR = 2.6; // must match TRIPLE_STACK_CAPTION_WINDOW_HALF_WIDTH_DIVISOR (sceneSchema.js)
    const halfWidthPct = 100 / (usedCount * POP_HALF_WIDTH_DIVISOR);
    const startKfs = [];
    const endKfs = [];
    for (let i = 0; i < usedCount; i++) {
      const centerPct = ((i + 0.5) / usedCount) * 100;
      const t = Math.max(0, wordTimings[i].start);
      startKfs.push({ time: t, value: centerPct - halfWidthPct });
      endKfs.push({ time: t, value: centerPct + halfWidthPct });
    }
    popAnimator.selector.start = { keyframes: startKfs };
    popAnimator.selector.end = { keyframes: endKfs };
  }
}

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

// Real, confirmed bug found via a frame-by-frame brutal review of a
// production render (2026-09-03, second direct follow-up demanding an
// even deeper pass: "check frame by frame, go extremely indepth"):
// a beat's decorative layers (an icon or shape the MODEL itself hand-
// authored an opacity fade-out for) are written against the model's
// own ESTIMATED duration - but real spoken audio frequently runs
// longer than that estimate, and only the dominant headline's own
// reveal gets retimed to the real, now-longer duration (see
// applyRealWordTimingToText above). Everything else keeps the
// original timeline, so a decorative element that was meant to fade
// out near the END of a ~1.5s estimated beat instead fades out mid-way
// through the REAL, longer beat - confirmed directly via a real
// render: a chart-line accent vanished abruptly (a hard cut, not a
// graceful fade - its own fade-out keyframe simply landed early) with
// over a second of the beat still left to play, no motion, nothing
// filling the gap it left. Stretches the LAST leg of any such layer's
// own opacity animation (the segment ending at invisible) out to the
// real duration instead, so it stays on screen for the beat it's
// actually going to be shown in rather than the one the model guessed.
// __ripple_ rings and the typewriter cursor are excluded - both fade
// out on a deliberately short, fixed schedule by design (a hook flash,
// a "typing is done" cue), not a duration guess gone wrong.
const PREMATURE_FADEOUT_EXCLUDED_ID_PREFIXES = ['__ripple_', '__typewriter_cursor__'];
function extendPrematureLayerFadeOuts(scene, realDuration) {
  if (!isPlainObject(scene.visual) || !Array.isArray(scene.visual.layers)) return;
  const FADE_OUT_LATE_ENOUGH_FRACTION = 0.75;
  const NEAR_ZERO = 0.05;
  scene.visual.layers.forEach((layer) => {
    if (!isPlainObject(layer)) return;
    if (layer.id === '__typewriter_text__') return;
    if (typeof layer.id === 'string' && PREMATURE_FADEOUT_EXCLUDED_ID_PREFIXES.some((p) => layer.id.startsWith(p))) return;
    const opacityProp = isPlainObject(layer.opacity) ? layer.opacity : null;
    if (!opacityProp) return;
    const base = isPlainObject(opacityProp.base) ? opacityProp.base : opacityProp;
    if (!Array.isArray(base.keyframes) || base.keyframes.length < 2) return;
    const last = base.keyframes[base.keyframes.length - 1];
    if (typeof last.time !== 'number' || typeof last.value !== 'number') return;
    if (last.value > NEAR_ZERO) return; // doesn't end invisible - nothing premature to fix
    if (last.time >= realDuration * FADE_OUT_LATE_ENOUGH_FRACTION) return; // already lands late enough
    last.time = Math.max(last.time, realDuration - 0.3);
  });
}


/** Synthesizes + trims one beat's clip (the same tag->TTS->silence-trim->tail-trim pipeline this file has always run), writing to attempt-numbered files so a re-synth never collides with or depends on the previous attempt's output. Returns the final clip path for this attempt. */
async function synthesizeBeatClip(taggedText, dir, index, attempt) {
  const buf = await generateSpeech(taggedText);
  const rawPath = path.join(dir, `${index}-raw-${attempt}.mp3`);
  fs.writeFileSync(rawPath, buf);

  const trimmedPath = path.join(dir, `${index}-trimmed-${attempt}.mp3`);
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

  // Mechanical (no AI call) tail-artifact cleanup - see its own doc
  // comment. Runs regardless of the Gemini verification result below;
  // that check is a separate, additional safety net, not a replacement.
  const tailTrimmedPath = path.join(dir, `${index}-tailtrimmed-${attempt}.mp3`);
  try {
    await trimTrailingArtifact(trimmedPath, tailTrimmedPath);
    fs.unlink(trimmedPath, () => {});
  } catch (tailErr) {
    console.warn(`[narrationPrefetch] beat ${index} tail-artifact trim failed, using untrimmed clip: ${tailErr.message}`);
    fs.renameSync(trimmedPath, tailTrimmedPath);
  }
  return tailTrimmedPath;
}

/**
 * Generates ONE continuous narration clip for the WHOLE video - direct,
 * explicit user requirement (2026-09-18): "I WANT ONE SINGLAR LONGG
 * AUDIO, THAT ISNT PER BEAT... ONLYYY THIS TTS AUDIO WILL BE THERE,
 * THERE WILL BE NO OTHER TTS AUDIO, NO BEAT TAGGED AUDIO OR TEXT."
 * Replaces the old per-beat pipeline (generate N separate clips, tag
 * each independently, concatenate with a silence pad between every one -
 * see git history) entirely: that per-beat padding (both the deliberate
 * +0.5s buffer and any extra silence to fill a beat's own visual
 * duration) is exactly what produced the audible per-beat pauses this
 * was a direct complaint about, even though each individual piece of
 * that old design had its own real reasoning at the time.
 *
 * New shape: every beat's own PLAIN narration is joined into ONE
 * continuous script (in beat order), tagged as ONE piece (so
 * narrationTagging.js's pause punctuation only lands at genuine sentence
 * boundaries within the combined text - still real pauses where a
 * sentence actually ends, just not an EXTRA artificial gap stitched
 * between every beat on top of that), and sent through exactly one TTS
 * call. Real per-word timing for the whole thing (one Deepgram STT call,
 * not one per beat) is then sliced back into per-beat ranges using each
 * beat's own already-known word count, in order - which is also what
 * sets each beat's real VISUAL duration: exactly its own slice of the
 * one continuous track, cumulative beat durations therefore staying
 * perfectly aligned with the single real audio timeline by construction,
 * with nothing to pad.
 *
 * Real, direct trade-off worth knowing about: this no longer takes
 * Math.max(authored/template-minimum duration, audio duration) the way
 * the old per-beat version did (see git history for that fix's own
 * reasoning - "the audio should be the one to fit the scene, not the
 * other way around") - doing that here would mean padding a beat's
 * OWN slice of the shared track with silence whenever its template
 * needed more time than its natural speech did, exactly the kind of
 * per-beat pause this change exists to remove. A beat whose template
 * genuinely needs more time than its own real speech slice gives will
 * now just run for exactly that slice - very rarely tight in practice
 * (real spoken sentences of typical narration length already tend to
 * run longer than a template's own minimum completion time), but a real
 * theoretical trade-off, not a lucky freebie.
 *
 * Returns a NEW sceneJSON-shaped object (render-only, same pattern as
 * imagePrefetch.js - the original passed in is never mutated) plus the
 * single narration `{path, duration} | null` audioMux.js now lays under
 * the whole video directly.
 */
async function prefetchNarration(sceneJSON, jobId) {
  const renderScenes = sceneJSON.scenes.map((scene) => ({ ...scene, params: { ...scene.params } }));

  const beatsWithNarration = renderScenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => typeof scene.params?.narration === 'string' && scene.params.narration.trim().length > 0);

  if (beatsWithNarration.length === 0) {
    return capToMaxDuration({ ...sceneJSON, scenes: renderScenes }, null);
  }

  const dir = narrationDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });

  let narration = null;
  try {
    // Scene generation writes PLAIN narration on purpose (see
    // scenePrompts.js) - tag annotation is this deliberately separate
    // second pass (narrationTagging.js). Joined with a single space, in
    // beat order, into ONE script and tagged as one continuous piece -
    // not tagged per-beat then joined, which would bake in an extra
    // "..." right at every beat boundary on top of whatever the
    // sentence's own real ending already gets.
    const plainTexts = beatsWithNarration.map(({ scene }) => scene.params.narration.trim());
    const combinedPlainText = plainTexts.join(' ');
    const taggedText = await annotateNarrationTags(combinedPlainText);
    console.log(`[narrationPrefetch] combined tagged script (${beatsWithNarration.length} beats): ${taggedText}`);

    // Gemini-based audio verification REMOVED, direct user instruction
    // (2026-09-05): "DONT FUCKING CARE ABT AUDIO... NOOOO GEMINIIII" -
    // trimTrailingArtifact (inside synthesizeBeatClip) stays as the
    // mechanical, no-AI-call safety net; this file makes no AI calls of
    // its own. synthesizeBeatClip's own per-clip pipeline (TTS -> trim
    // leading/trailing silence -> trim any hallucinated tail artifact)
    // is unchanged - it was always written to take one script and
    // produce one clip, "index" was never anything but a filename
    // component, so passing 'combined' here needs no changes to it at
    // all.
    const clipPath = await synthesizeBeatClip(taggedText, dir, 'combined', 1);
    const filePath = path.join(dir, 'combined.mp3');
    try {
      fs.renameSync(clipPath, filePath);
    } catch (renameErr) {
      console.warn(`[narrationPrefetch] combined clip final rename failed: ${renameErr.message}`);
    }

    const totalDuration = await getAudioDurationSeconds(filePath);
    narration = { path: filePath, duration: totalDuration };

    // Real, audio-measured per-word timing for the WHOLE combined clip -
    // see wordTiming.js's own doc comment. One Deepgram STT call instead
    // of one per beat.
    const wordTimings = await getWordTimings(fs.readFileSync(filePath));

    const beatWordCounts = plainTexts.map((t) => t.split(/\s+/).filter(Boolean).length);
    const totalWordsExpected = beatWordCounts.reduce((a, b) => a + b, 0);
    // Tolerates a small mismatch between the expected word count (from
    // splitting the plain script on whitespace) and what Deepgram's STT
    // actually detected (an occasional merge/split of one word) - beyond
    // a small tolerance, the per-beat mapping can't be trusted at all, so
    // every beat falls back together to an even, word-count-proportional
    // split of the one real total duration instead of individually-wrong
    // slices.
    const sliceOk = Array.isArray(wordTimings) && wordTimings.length > 0;
    const countMismatch = sliceOk ? Math.abs(wordTimings.length - totalWordsExpected) : Infinity;
    const useRealPerBeatTiming = sliceOk && countMismatch <= Math.max(2, Math.round(totalWordsExpected * 0.05));

    let cursor = 0;
    let prevEnd = 0;
    beatsWithNarration.forEach(({ index }, i) => {
      const wordCount = beatWordCounts[i];
      const isLast = i === beatsWithNarration.length - 1;
      let beatEnd;
      if (useRealPerBeatTiming) {
        const remaining = wordTimings.length - cursor;
        const take = Math.max(0, Math.min(wordCount, remaining));
        const slice = wordTimings.slice(cursor, cursor + take);
        cursor += take;
        beatEnd = slice.length > 0 ? (isLast ? totalDuration : slice[slice.length - 1].end) : prevEnd;
        if (slice.length > 0) {
          // Translated to beat-LOCAL time (subtract this beat's own
          // start in the shared track) - applyRealWordTimingToText
          // builds keyframes against the beat's own composition, which
          // always starts at 0 regardless of where its slice of the
          // shared audio actually sits.
          const localTimings = slice.map((w) => ({
            ...w, start: Math.max(0, w.start - prevEnd), end: Math.max(0, w.end - prevEnd),
          }));
          renderScenes[index].params.wordTimings = localTimings;
          applyRealWordTimingToText(renderScenes[index], localTimings);
        }
      } else {
        // Fallback: proportional split of the one real total duration by
        // this beat's own share of the total word count - still driven
        // by the real measured audio length, just without per-word sync.
        const share = totalWordsExpected > 0 ? wordCount / totalWordsExpected : 1 / beatsWithNarration.length;
        beatEnd = isLast ? totalDuration : prevEnd + share * totalDuration;
      }
      const audioDrivenDuration = Math.max(0, beatEnd - prevEnd);
      prevEnd = beatEnd;
      renderScenes[index].params.duration = audioDrivenDuration;
      extendPrematureLayerFadeOuts(renderScenes[index], audioDrivenDuration);
    });
  } catch (err) {
    console.warn(`[narrationPrefetch] combined narration failed, all beats keep their authored durations: ${err.message}`);
    narration = null;
  }

  return capToMaxDuration({ ...sceneJSON, scenes: renderScenes }, narration);
}

function cleanupNarration(jobId) {
  fs.rm(narrationDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchNarration, cleanupNarration, narrationDirFor };
