const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { buildTimeline } = require('./renderEngine');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))));
    p.on('error', reject);
  });
}

async function generateSilence(outPath, seconds) {
  await run(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(Math.max(0.05, seconds)), '-q:a', '4', outPath]);
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

  const { beats } = buildTimeline(sceneJSON);
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

  const outputPath = videoPath.replace(/\.mp4$/, '-narrated.mp4');
  await run(['-y', '-i', videoPath, '-i', assembledPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', outputPath]);

  fs.unlink(listPath, () => {});
  fs.unlink(assembledPath, () => {});
  cleanupPaths.forEach((p) => fs.unlink(p, () => {}));

  return outputPath;
}

module.exports = { muxNarrationOntoVideo };
