const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
// From the canvas-free timeline module, not renderEngine.js directly -
// this file runs in the PARENT process (renderWorker.js), which never
// draws a frame itself (that's exclusively done in forked chunk-worker
// processes) - requiring renderEngine.js here would load @napi-rs/canvas
// into the parent for zero benefit. See engine/timeline.js's own doc
// comment for the real, measured cost this avoids.
const { buildTimeline } = require('./engine/timeline');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))));
    p.on('error', reject);
  });
}

// Voiceover mastering chain (highpass/compressor/loudnorm/alimiter)
// REMOVED per direct user request after switching the production voice
// to Deepgram's Aura-2. History for why it existed at all, kept for
// context: it was built to fix msedge-tts's raw -20.5 LUFS output
// reading as quiet/thin, then tuned further for Fish Audio's even
// quieter -23.9 LUFS raw output. Deepgram's raw output needs none of
// it, and the chain became a real, measured liability once Deepgram
// was primary - a spectrogram comparison showed the chain's repeated
// lossy mp3 re-encode passes (this mastering step ran TWICE per video:
// once per clip, once on the whole assembled track) were stripping
// real high-frequency content Deepgram's own output actually had,
// correlating with a user complaint of narration sounding "like an
// auditorium."
//
// Real follow-up regression found after removing the WHOLE chain: it
// fixed the echo complaint but ALSO silently removed loudness
// correction, which was never the actual problem. Measured on a real
// render: -29.5dB mean volume (Deepgram's raw output sits around -28
// LUFS, completely unboosted) - reads as quiet/thin against the ~-14
// to -16 LUFS modern platforms target, a real, separate issue from the
// echo one. The ACTUAL culprit for the echo/reverb complaint was the
// COMPRESSOR specifically (rapid gain-reduction pumping on phrases with
// close-together pauses, pulling up whatever sits below its threshold
// along with the voice) - not loudnorm itself, which just applies one
// flat measured gain to the whole signal with no threshold/attack/
// release dynamics to pump. Added back below as loudness-ONLY
// normalization (no highpass, no compressor, no per-clip duplicate
// pass) - keeps the echo fix while fixing the volume regression it
// accidentally introduced.
const NARRATION_LOUDNESS_TARGET = 'I=-16:TP=-2:LRA=11';

/** Same as run(), but resolves with the captured stderr text on success - needed for loudnorm's own analysis pass, which prints its measured stats to stderr as JSON rather than stdout. */
function runCapture(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))));
    p.on('error', reject);
  });
}

/**
 * Loudness-only normalization (2-pass accurate EBU R128) - see the
 * NARRATION_LOUDNESS_TARGET comment above for why this exists and why
 * it's safe against the compressor-pumping issue the old full chain
 * had. Applied exactly ONCE, on the final whole assembled track (not
 * per-clip like the old chain), to minimize the OTHER real finding
 * from the same investigation - repeated lossy mp3 re-encode passes
 * compounding real quality/bandwidth loss - down to a single extra
 * generation instead of the old chain's two full passes. A light
 * alimiter stays as cheap safety insurance against linear-mode
 * loudnorm's predicted true peak landing hotter than its own TP target
 * (a real, previously-measured gap, not a hypothetical) - alimiter
 * only acts on true-peak overshoot, never touches quiet content the
 * way a compressor does, so it can't reintroduce the pumping issue.
 */
async function applyLoudnessNormalization(inputPath, outputPath) {
  let stats;
  try {
    const analyzeOutput = await runCapture(['-i', inputPath, '-af', `loudnorm=${NARRATION_LOUDNESS_TARGET}:print_format=json`, '-f', 'null', '-']);
    const jsonMatch = analyzeOutput.match(/\{[^]*?"target_offset"[^]*?\}/);
    stats = jsonMatch && JSON.parse(jsonMatch[0]);
  } catch (err) {
    stats = null;
  }
  if (!stats) {
    // Loudness correction is polish, not correctness - if the analysis
    // pass fails for any reason, fall back to the untouched track
    // rather than failing the whole render over audio polish.
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const secondPassFilter = `loudnorm=${NARRATION_LOUDNESS_TARGET}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true,alimiter=limit=0.891`;
  await run(['-y', '-i', inputPath, '-af', secondPassFilter, '-c:a', 'libmp3lame', '-q:a', '4', outputPath]);
  return outputPath;
}

// Real, directly measured bug found chasing "why does the voice sound
// so deep": this used to hardcode -ar 24000 (and generateSilence's own
// anullsrc rate), a value that made sense for msedge-tts's real native
// output (OUTPUT_FORMAT.AUDIO_24KHZ_...) but was never revisited when
// narration switched to Fish Audio - confirmed directly, Fish Audio's
// raw mp3 output is actually 44100Hz. Downsampling 44100->24000 does
// NOT shift pitch (verified live: resampled duration matched the
// original to within MP3 frame-boundary rounding, so it's a real
// resample, not a broken reinterpretation) - but it DOES throw away
// every frequency above 12kHz (24000's Nyquist limit), stripping a
// voice's upper harmonics/sibilance/"air". Losing that brightness
// reads as a darker, heavier, "deeper"-sounding voice even though the
// actual fundamental pitch never moved - a real, measurable quality
// loss, not a subjective impression. Kept at Fish Audio's own native
// rate instead of downsampling to a value inherited from a different
// engine entirely.
const NARRATION_SAMPLE_RATE = 44100;

async function generateSilence(outPath, seconds) {
  await run(['-y', '-f', 'lavfi', '-i', `anullsrc=r=${NARRATION_SAMPLE_RATE}:cl=mono`, '-t', String(Math.max(0.05, seconds)), '-q:a', '4', outPath]);
}

function getDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-i', filePath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!match) { reject(new Error(`could not read duration of ${filePath}`)); return; }
      resolve((+match[1]) * 3600 + (+match[2]) * 60 + parseFloat(match[3]));
    });
    ff.on('error', reject);
  });
}

/**
 * Assembles per-beat narration clips + silence gaps into ONE continuous
 * audio track spanning the whole video, then muxes it onto the
 * finished render. Uses buildTimeline() - the SAME function
 * renderEngine.js used to lay out beats for the actual frames - so the
 * audio track is built against the exact same start/end times the
 * video was rendered with; two separately-produced things (frames,
 * audio) that can never drift out of sync as a result, rather than
 * two independent duration calculations that happen to usually agree.
 *
 * Re-encodes every segment (not `-c copy`) before concatenating -
 * msedge-tts's mp3 output and ffmpeg's anullsrc-generated silence
 * aren't guaranteed to share one exact stream format, which the concat
 * demuxer's stream-copy mode requires; re-encoding sidesteps that.
 */
async function muxNarrationOntoVideo(videoPath, sceneJSON, audioFiles, jobId, workDir) {
  if (!audioFiles || audioFiles.size === 0) return videoPath;

  // Confirmed the hard way: ffmpeg's concat demuxer resolves relative
  // paths INSIDE the list file relative to the list file's own
  // directory, not the process's cwd - so a relative workDir here
  // silently double-nests every referenced segment path (e.g.
  // "out/x.mp3" listed inside "out/list.txt" resolves to
  // "out/out/x.mp3", which doesn't exist) and ffmpeg's concat demuxer
  // can carry on past the missing entries rather than hard-failing,
  // producing a valid-looking but drastically truncated output instead
  // of an error. Every path this function builds must be absolute
  // regardless of what the caller passed in - never trust that alone.
  videoPath = path.resolve(videoPath);
  workDir = path.resolve(workDir);

  // renderEngine.js's buildTimeline() returns `beatRanges`, not `beats`
  // - real regression found here (not assumed): its own return shape
  // was rewritten in the sceneBuilder.js integration without checking
  // every consumer, and this file's destructuring of a since-renamed
  // field silently produced `undefined`, throwing on the very next
  // `.length` access. Per-beat shape (`duration`, `end`) is unchanged
  // and still exactly what this function needs.
  const { beatRanges: beats } = buildTimeline(sceneJSON);
  const listPath = path.join(workDir, `${jobId}-audio-concat.txt`);
  const segmentPaths = [];
  const cleanupPaths = [];

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const audio = audioFiles.get(i);
    if (audio) {
      segmentPaths.push(audio.path);
      const remaining = beat.duration - audio.duration;
      if (remaining > 0.05) {
        const silencePath = path.join(workDir, `${jobId}-silence-${i}.mp3`);
        await generateSilence(silencePath, remaining);
        segmentPaths.push(silencePath);
        cleanupPaths.push(silencePath);
      }
    } else {
      const silencePath = path.join(workDir, `${jobId}-silence-${i}.mp3`);
      await generateSilence(silencePath, beat.duration);
      segmentPaths.push(silencePath);
      cleanupPaths.push(silencePath);
    }
  }

  fs.writeFileSync(listPath, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  let assembledPath = path.join(workDir, `${jobId}-assembled-narration.mp3`);
  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-q:a', '4', assembledPath]);

  // Hard safety net, not a nice-to-have: confirmed directly that this
  // concat step can silently produce an audio track SHORTER than the
  // sum of its own inputs under some not-yet-root-caused condition
  // (reproduced twice, including once running two renders concurrently).
  // `-shortest` on the final mux below would then silently truncate the
  // VIDEO to match - i.e. real rendered content quietly deleted, which
  // is a far worse failure than an extra second of trailing silence.
  // So: verify the assembled length against what the video actually is,
  // and pad with silence if short, unconditionally, regardless of why
  // it came up short. This makes video length authoritative no matter
  // what goes wrong in audio assembly.
  const expectedTotal = beats.length > 0 ? beats[beats.length - 1].end : 0;
  const actualAssembled = await getDurationSeconds(assembledPath).catch(() => 0);
  if (actualAssembled + 0.15 < expectedTotal) {
    const shortfall = expectedTotal - actualAssembled;
    console.warn(`[audioMux] assembled narration (${actualAssembled.toFixed(2)}s) came up ${shortfall.toFixed(2)}s short of the video (${expectedTotal.toFixed(2)}s) - padding with trailing silence rather than letting -shortest truncate the video.`);
    const padPath = path.join(workDir, `${jobId}-pad.mp3`);
    await generateSilence(padPath, shortfall);
    const paddedPath = path.join(workDir, `${jobId}-assembled-padded.mp3`);
    const padListPath = path.join(workDir, `${jobId}-pad-list.txt`);
    fs.writeFileSync(padListPath, [assembledPath, padPath].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', padListPath, '-c:a', 'libmp3lame', '-q:a', '4', paddedPath]);
    fs.unlink(padPath, () => {});
    fs.unlink(padListPath, () => {});
    fs.unlink(assembledPath, () => {});
    assembledPath = paddedPath;
  }

  // Real, direct user report (2026-09-18): "the tts volume rn is
  // extremely silent." Loudnorm-based correction was already tried
  // TWICE for this exact -29.5dB/-28 LUFS "too quiet" issue (Deepgram's
  // raw, unboosted output) and pulled back out both times - full
  // mastering chain (highpass/compressor/loudnorm/alimiter) caused an
  // "auditorium"/echo complaint, and even the pared-down loudnorm-only
  // version (no compressor) was later rejected in a real staged A/B
  // test for sounding "unnatural" against the plain track. Reaching for
  // loudnorm a third time risks the exact same rejection - it's a multi-
  // pass, psychoacoustically-modeled correction that reshapes the signal,
  // not a pure "turn it up." This is deliberately the simplest possible
  // alternative instead: a single FLAT linear gain (no dynamics, no
  // per-band modeling, nothing adaptive to "pump" or otherwise color the
  // voice) sized off the same real -29.5dB measurement that motivated
  // both earlier attempts, landing around a -17dB mean - audible and
  // comfortable next to modern platform norms without pushing all the
  // way to loudnorm's own -16 LUFS target, some margin held back
  // specifically because a flat gain (unlike loudnorm) has no per-signal
  // headroom awareness of its own. alimiter is pure safety insurance
  // against a peak that happens to sit hotter than the measured mean
  // clipping post-boost - it only ever acts on rare peak overshoot, never
  // touches quiet passages the way the earlier rejected compressor did,
  // so it can't reintroduce that same pumping artifact.
  const NARRATION_VOLUME_BOOST_DB = 12.5;
  const boostedPath = path.join(workDir, `${jobId}-assembled-narration-boosted.mp3`);
  await run(['-y', '-i', assembledPath, '-af', `volume=${NARRATION_VOLUME_BOOST_DB}dB,alimiter=limit=0.891`, '-c:a', 'libmp3lame', '-q:a', '4', boostedPath]);
  fs.unlink(assembledPath, () => {});
  assembledPath = boostedPath;
  // assembledPath goes into sound-design mixing next, then the final mux.

  // Direct user request (2026-09-17): "audio feels so empty" - a
  // continuous music bed underneath the whole video, plus real sound
  // effects at real animation moments (not just narration+silence).
  // Mixed into its own audio track HERE, before the final video mux -
  // keeps this step independently testable/skippable (mixSoundDesign
  // returns assembledPath unchanged if anything about it fails) without
  // touching the already-proven video+narration mux below at all.
  const finalAudioPath = await mixSoundDesign(assembledPath, sceneJSON, beats, workDir, jobId).catch((err) => {
    console.warn(`[audioMux] sound-design mix failed, shipping plain narration instead: ${err.message}`);
    return assembledPath;
  });

  const outputPath = videoPath.replace(/\.mp4$/, '-narrated.mp4');
  await run(['-y', '-i', videoPath, '-i', finalAudioPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', outputPath]);

  fs.unlink(listPath, () => {});
  fs.unlink(assembledPath, () => {});
  if (finalAudioPath !== assembledPath) fs.unlink(finalAudioPath, () => {});
  cleanupPaths.forEach((p) => fs.unlink(p, () => {}));

  return outputPath;
}

const SFX_DIR = path.join(__dirname, 'assets', 'sfx');
const MUSIC_PATH = path.join(__dirname, 'assets', 'music', 'background.mp3');
// Kenney's free UI/Interface Sounds packs (CC0 - kenney.nl, no
// attribution required, commercial use explicitly allowed). Which of
// pop/tick/drop/chime a given cue resolves to is decided in
// sceneSchema.js's deriveSoundCuesFromLayers/NODE_SOUND_CUE_RULES, based
// on what the moment actually is (a lock-in, a settle, the outro CTA,
// etc.) - this file just plays whatever `cue.sound` name it's given.
const SFX_VOLUME = 0.55;
// Background: incompetech.com, "Deliberate Thought" by Kevin MacLeod -
// CC-BY (attribution required, unlike the CC0 SFX above). Kept quiet and
// constant rather than sidechain-ducked under narration - simpler to
// implement correctly and reason about than real ducking, and this
// project's own narration already has real silence gaps between beats
// (audioDrivenDuration's own +0.5s buffer, narrationPrefetch.js) where a
// low constant bed reads as natural background presence rather than
// needing to duck around anything.
const MUSIC_VOLUME = 0.1;

/**
 * Mixes the assembled narration track with real sound-effect cues
 * (beat.visual.soundCues, plus a "whoosh" synthesized here at every
 * beat's own pan-start) and a continuous low-volume music bed underneath
 * everything. Returns narrationPath UNCHANGED (not a copy) if there's
 * nothing to add or the music bed is missing, so a missing/corrupt asset
 * never blocks a real video from shipping with at least its narration.
 */
async function mixSoundDesign(narrationPath, sceneJSON, beats, workDir, jobId) {
  const cues = [];
  beats.forEach((beat, i) => {
    // Whoosh at every beat-to-beat pan (every beat but the first - see
    // renderEngine.js's own beatLocalT/panDuration mechanism, the same
    // "does this beat pan in" condition used there).
    if (i > 0) cues.push({ time: beat.start, sound: 'whoosh' });
    const beatCues = beat.scene && beat.scene.visual && Array.isArray(beat.scene.visual.soundCues)
      ? beat.scene.visual.soundCues : [];
    beatCues.forEach((cue) => {
      if (typeof cue.time === 'number' && typeof cue.sound === 'string') {
        cues.push({ time: beat.start + cue.time, sound: cue.sound });
      }
    });
  });

  const hasMusic = fs.existsSync(MUSIC_PATH);
  if (cues.length === 0 && !hasMusic) return narrationPath;

  const videoDuration = beats.length > 0 ? beats[beats.length - 1].end : 0;
  const inputs = ['-i', narrationPath];
  const filterParts = [];
  const mixLabels = ['[0:a]'];
  // Narration itself also gets the same format-normalize pass as every
  // other branch below - amix silently produces odd/quiet output when
  // its inputs don't already agree on sample rate/channel layout, and
  // Deepgram's own output format isn't guaranteed to match the SFX/music
  // assets' own (different source, different encode).
  filterParts.push('[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]');
  mixLabels[0] = '[a0]';

  let inputIndex = 1;
  for (const cue of cues) {
    const sfxPath = path.join(SFX_DIR, `${cue.sound}.mp3`);
    if (!fs.existsSync(sfxPath)) continue;
    inputs.push('-i', sfxPath);
    const delayMs = Math.max(0, Math.round(cue.time * 1000));
    const label = `sfx${inputIndex}`;
    filterParts.push(`[${inputIndex}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delayMs}|${delayMs},volume=${SFX_VOLUME}[${label}]`);
    mixLabels.push(`[${label}]`);
    inputIndex++;
  }

  if (hasMusic) {
    inputs.push('-i', MUSIC_PATH);
    const label = `music${inputIndex}`;
    // atrim to the real video length - the source track (2:57) is
    // already far longer than this project's own 45s hard cap
    // (narrationPrefetch.js's MAX_TOTAL_DURATION_SECONDS), so no loop is
    // needed, just a trim.
    filterParts.push(`[${inputIndex}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${videoDuration.toFixed(2)},volume=${MUSIC_VOLUME}[${label}]`);
    mixLabels.push(`[${label}]`);
    inputIndex++;
  }

  filterParts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[aout]`);

  const outPath = path.join(workDir, `${jobId}-sound-design.mp3`);
  await run([
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-c:a', 'libmp3lame', '-q:a', '4',
    outPath,
  ]);
  return outPath;
}

// Direct user request: every finished video is sped up before it's
// ever uploaded/shown to anyone - both streams together, so they stay
// in sync, not just the video track alone. ffmpeg's atempo filter
// supports 0.5-2.0 directly in one pass (1.2 doesn't need chaining
// multiple atempo calls the way a >2.0 factor would). setpts speeds up
// the video stream to match. This is a genuine, real re-encode of
// BOTH streams (changing PTS can't be done with a stream copy the way
// the final mux above manages to for video), so it adds real
// processing time on top of everything else in the pipeline - not
// free, but that's what was asked for. Matches the SAME encode
// settings (libx264 ultrafast/yuv420p, aac 128k) the rest of this file
// already uses, for consistent output characteristics. Kept in sync
// with ../render-worker/audioMux.js's own copy - this is the local-
// render fallback path's version, used only when no render worker was
// available to dispatch to.
// Speed-up REMOVED (1.0 = no-op) per direct user request, based on a
// real staged A/B listening test isolating the exact 1.1x atempo pass -
// it read as fine in complete isolation (raw clip + atempo only), but
// contributed to the "unnatural" quality once combined with the rest
// of the real pipeline. Went 1.2 -> 1.1 -> 1.0 across this project's
// own history; kept as a named constant (not deleted) rather than
// ripping the feature out, in case it's revisited later.
const SPEED_FACTOR = 1.0;

/**
 * At SPEED_FACTOR=1.0 this would be a mathematically-inert setpts/
 * atempo pass - but ffmpeg would still burn real time on a full video+
 * audio re-encode to produce byte-different output that's functionally
 * identical to the input. Short-circuits to a plain file copy instead,
 * so "no speed-up" genuinely costs nothing rather than a wasted pass.
 */
function speedUpVideo(inputPath, outputPath) {
  if (SPEED_FACTOR === 1.0) {
    fs.copyFileSync(inputPath, outputPath);
    return Promise.resolve();
  }
  return run([
    '-y', '-i', inputPath,
    '-filter_complex', `[0:v]setpts=PTS/${SPEED_FACTOR}[v];[0:a]atempo=${SPEED_FACTOR}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    outputPath,
  ]);
}

module.exports = { muxNarrationOntoVideo, speedUpVideo, applyLoudnessNormalization };
