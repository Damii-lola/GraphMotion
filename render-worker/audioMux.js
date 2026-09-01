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
// once per clip on the coordinator, once on the whole assembled track
// here on the worker) were stripping real high-frequency content
// Deepgram's own output actually had, correlating with a user
// complaint of narration sounding "like an auditorium." Deepgram's
// output is used PLAIN now, all the way through.

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

  // Whole-track mastering pass REMOVED per direct user request - see
  // the constant's own doc comment above for the full reasoning.
  // assembledPath goes straight into the final mux now.
  const outputPath = videoPath.replace(/\.mp4$/, '-narrated.mp4');
  await run(['-y', '-i', videoPath, '-i', assembledPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', outputPath]);

  fs.unlink(listPath, () => {});
  fs.unlink(assembledPath, () => {});
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
// already uses, for consistent output characteristics.
// Lowered from 1.2 to 1.1 per direct user request. Note this also
// slightly changes the real inter-beat pause length: the 0.65s buffer
// in narrationPrefetch.js was sized against 1.2x compression (landing
// ~0.54s post-speedup) - at 1.1x the same buffer lands closer to
// ~0.59s, a bit longer, not shorter.
const SPEED_FACTOR = 1.1;

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

module.exports = { muxNarrationOntoVideo, speedUpVideo };
