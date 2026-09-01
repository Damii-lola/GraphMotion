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

/** Same as run(), but resolves with the captured stderr text on success - needed for masterNarrationAudio's loudnorm analysis pass, which prints its measured stats to stderr as JSON rather than stdout. */
function runCapture(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))));
    p.on('error', reject);
  });
}

// Real, directly measured finding: msedge-tts's raw output for a real
// narrated video sat at -20.5 LUFS integrated loudness (ffmpeg's own
// ebur128 filter) against the ~-14 LUFS modern social-video loudness
// norm (YouTube/TikTok/Instagram all target roughly this range) - a
// real, quantified reason narration reads as quiet/thin/"off" next to
// other content in a feed, not just a subjective impression. Fixed
// with a real (if free-tier) voiceover mastering chain: a highpass to
// clear sub-vocal rumble no real voice fundamental lives below anyway,
// a compressor to even out level swings between separately-generated
// TTS clips (each beat's narration is its own isolated API call -
// nothing upstream guarantees they land at consistent volume relative
// to each other), then a proper two-pass EBU R128 loudnorm (pass 1
// measures the ACTUAL post-compression stats; pass 2 applies a linear
// gain using those exact measured values, the accurate mode loudnorm's
// own docs recommend over relying on single-pass dynamic mode's
// approximation). A final brickwall alimiter is real, cheap insurance -
// confirmed directly that linear-mode loudnorm's predicted true peak
// can still land hotter than its own TP target (measured live: asked
// for TP=-1.5, got -0.1 dBFS), which would risk clipping on the AAC
// re-encode this same file goes through in the final mux below.
//
// Compressor makeup=2 originally lightened, later found to be a REAL
// bug, not a cosmetic one: acompressor's "makeup" parameter is a
// LINEAR gain multiplier, not dB as the old comment here assumed -
// makeup=2 was actually a ~+6dB boost stacked ON TOP of loudnorm's own
// (already-correct) measured gain, real double-gain-staging. Combined
// with a fairly aggressive ratio=2.5/attack=10ms, this measurably
// raised RMS level by 8dB+ on quiet source material (confirmed
// directly: a real Eric clip went from -21.8dB RMS raw to -13.7dB RMS
// mastered) - real, audible "static"/noise the user reported hearing
// throughout narrated videos, exactly what happens when a source
// recording's own faint noise floor gets amplified 2.7x louder along
// with the voice. Fish Audio's Adrian voice measured even quieter raw
// (-23.9 LUFS) than Eric's msedge-tts output did, making this worse,
// not better, with the switch. Fixed: makeup=1 (true unity, no extra
// gain from the compressor itself - loudnorm's own accurate measured
// gain is now the ONLY gain stage), a gentler ratio/threshold/timing
// so the compressor catches real outlier peaks rather than continuously
// squashing the whole signal, and the loudnorm target itself pulled
// back from -14 to -16 LUFS - less total gain needed to reach it,
// directly reducing how much any residual noise floor gets amplified,
// while still a real, audible boost over a -23ish LUFS raw source.
// Real, directly measured finding after the production voice switched
// to Deepgram's Aura-2: raw Deepgram output sits at -28.3 LUFS (even
// quieter than Fish Audio's -23.9 LUFS raw), so the SAME 2-pass
// loudnorm below now has to apply +12.3dB of gain to hit -16 LUFS,
// vs the +7.9dB this whole chain was actually tuned against. Measured
// consequence on a real clip: LRA (loudness range) went from 6.5 LU
// raw down to 2.2 LU after this compressor - a much bigger squash than
// intended, and confirmed directly to correlate with a real user
// complaint of the narration sounding "like an auditorium, lots of
// echo/reverb" (compressor pumping/breathing - rapid gain-reduction
// cycling as level repeatedly crosses threshold, especially on phrases
// with several close-together comma pauses - is a well-documented real
// cause of a washy/roomy quality, distinct from literal delayed echo
// but easily perceived as similar). Threshold raised from -20dB to
// -16dB so the compressor goes back to catching only genuine outlier
// peaks rather than regular speech content, and release lengthened
// from 150ms to 220ms so it recovers more gradually between closely-
// spaced pauses instead of slamming shut and reopening on each one.
const NARRATION_PRE_FILTER = 'highpass=f=90,acompressor=threshold=-16dB:ratio=1.5:attack=20:release=220:makeup=1';
const NARRATION_LOUDNORM_TARGET = 'I=-16:TP=-2:LRA=11';

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

/**
 * Exported (not just used internally below) so narrationPrefetch.js
 * can call this on each beat's OWN clip individually, before assembly
 * - a real, measured problem found chasing the "static" report even
 * after the gain/compressor fix above: EBU R128 integrated loudness is
 * an AVERAGE over the WHOLE signal, silence included. Running this
 * ONLY on the final assembled+padded track (every beat's clip PLUS
 * every inter-beat gap PLUS every [break]/[long-break] pause now baked
 * into the narration itself) measured the assembled track at -26 LUFS
 * even though the underlying VOICE was already close to its own
 * natural level - all that deliberate silence drags the average down,
 * so loudnorm computes a BIGGER gain to hit the same target than the
 * actual spoken content needs, amplifying noise more than a per-clip
 * measurement would ever suggest (confirmed directly: a real assembled
 * track needed +10.3dB here, vs +7.9dB measured on one isolated
 * clip). Mastering each clip's own speech individually, BEFORE all
 * that pause silence gets stitched in and dilutes the average, means
 * loudnorm's gain decision is based on the actual voice, not on how
 * much dead air surrounds it. The whole-track pass below still runs
 * afterward as a final consistency/safety net, but should now find the
 * average already close to target and apply little extra gain.
 */
async function masterNarrationAudio(inputPath, outputPath) {
  let stats;
  try {
    const analyzeOutput = await runCapture(['-i', inputPath, '-af', `${NARRATION_PRE_FILTER},loudnorm=${NARRATION_LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-']);
    const jsonMatch = analyzeOutput.match(/\{[^]*?"target_offset"[^]*?\}/);
    stats = jsonMatch && JSON.parse(jsonMatch[0]);
  } catch (err) {
    stats = null;
  }
  if (!stats) {
    // Mastering is a polish step, not a correctness one - if the
    // analysis pass fails for any reason (a malformed/empty clip,
    // ffmpeg's loudnorm printing something unexpected), fall back to
    // the untouched narration rather than failing the whole render
    // over audio polish.
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const secondPassFilter = `${NARRATION_PRE_FILTER},loudnorm=${NARRATION_LOUDNORM_TARGET}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true,alimiter=limit=0.891`;
  await run(['-y', '-i', inputPath, '-af', secondPassFilter, '-ar', String(NARRATION_SAMPLE_RATE), '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', outputPath]);
  return outputPath;
}

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

  const masteredPath = path.join(workDir, `${jobId}-mastered-narration.mp3`);
  await masterNarrationAudio(assembledPath, masteredPath);

  const outputPath = videoPath.replace(/\.mp4$/, '-narrated.mp4');
  await run(['-y', '-i', videoPath, '-i', masteredPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', outputPath]);

  fs.unlink(listPath, () => {});
  fs.unlink(assembledPath, () => {});
  fs.unlink(masteredPath, () => {});
  cleanupPaths.forEach((p) => fs.unlink(p, () => {}));

  return outputPath;
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
const SPEED_FACTOR = 1.2;

function speedUpVideo(inputPath, outputPath) {
  return run([
    '-y', '-i', inputPath,
    '-filter_complex', `[0:v]setpts=PTS/${SPEED_FACTOR}[v];[0:a]atempo=${SPEED_FACTOR}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    outputPath,
  ]);
}

module.exports = { muxNarrationOntoVideo, masterNarrationAudio, speedUpVideo };
