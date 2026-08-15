const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { buildTimeline, renderJobToFile } = require('./renderEngine');

// Below this, render directly in this process - the common case
// (most videos are short), no chunking overhead/complexity at all.
// Above it, split into CHUNK_SIZE_SECONDS pieces, each rendered by a
// FRESH forked process - measured, verified necessary: this Skia
// binding accumulates native memory under long sustained renders in
// a way that survives canvas recycling and per-frame yielding within
// one process, but is fully reclaimed when that process exits.
// The PNG-based frame pipeline (renderEngine.js) resolved the actual
// memory issue directly - the old raw-pixel-piping approach leaked
// catastrophically under sustained rendering regardless of chunk size;
// this doesn't. These no longer need to be pushed to their previous
// safety-margin extremes (5s/6s) - restored to more reasonable values
// that reduce per-chunk process-spawn overhead, now that the
// underlying cause is actually fixed rather than worked around.
//
// Pulled back down from 20s/15s after the loadImage-timeout and
// chunk-scoped-image fixes still weren't enough on the real 512MB
// production host - each chunk's own peak (frame buffers + Skia
// native growth + decoded hero images) scales with how much work one
// forked process does before it exits and gets reclaimed. Smaller
// chunks mean more frequent full reclamation and a lower per-process
// ceiling, at the cost of more fork/spawn overhead - worth it when
// the alternative is an OOM-flavored timeout.
//
// Pulled down AGAIN (8 -> 5) after this exact scenario played out for
// real: 8s (192 frames) reliably hit the per-chunk timeout on
// production once frames started rendering genuinely real content
// (real per-frame throughput on Render's actual - meaningfully slower/
// shared - CPU turned out to be ~1.4s/frame even after the memory
// fixes, so 192 frames needed ~270s against a 3-minute timeout). This
// number was calibrated back when a frame was a trivial flat-fill
// placeholder and is stale now that frames do real, heavier
// rendering - smaller chunks are the direct lever for "one chunk's
// total work fits comfortably inside its own timeout" regardless of
// exactly how much slower Render's CPU is than local dev, which isn't
// something measurable from here.
const CHUNK_THRESHOLD_SECONDS = 10;
const CHUNK_SIZE_SECONDS = 5;

/**
 * Renders sceneJSON to outputPath, transparently chunking if the
 * video is long enough to need it. onProgress receives 0-100 across
 * the WHOLE video regardless of how many chunks it took internally.
 */
async function renderLongFormVideo(jobId, sceneJSON, onProgress) {
  const { totalDuration } = buildTimeline(sceneJSON);

  if (totalDuration <= CHUNK_THRESHOLD_SECONDS) {
    return renderJobToFile(jobId, sceneJSON, onProgress);
  }

  const chunkRanges = [];
  for (let t = 0; t < totalDuration; t += CHUNK_SIZE_SECONDS) {
    chunkRanges.push({ start: t, end: Math.min(t + CHUNK_SIZE_SECONDS, totalDuration) });
  }

  const workDir = path.join(os.tmpdir(), 'shortform-renders', `${jobId}-chunks`);
  fs.mkdirSync(workDir, { recursive: true });

  const chunkPaths = [];

  // Sequential, deliberately not Promise.all - running chunks
  // concurrently would multiply peak memory by however many run at
  // once, defeating the entire point of chunking. One at a time keeps
  // peak memory bounded to a single chunk regardless of total video
  // length.
  for (let i = 0; i < chunkRanges.length; i++) {
    const { start, end } = chunkRanges[i];
    const chunkPath = path.join(workDir, `chunk-${i}.mp4`);

    await renderSingleChunk(jobId, sceneJSON, start, end, chunkPath, i, (chunkPct) => {
      if (onProgress) {
        const overallPct = Math.round(((i + chunkPct / 100) / chunkRanges.length) * 100);
        onProgress(Math.min(99, overallPct)); // hold at 99 until concat actually finishes
      }
    });

    chunkPaths.push(chunkPath);

    // Small explicit buffer even after the child's exit event has
    // fired - Node's 'exit' event confirms the process has terminated,
    // but full OS-level memory reclamation can trail slightly behind
    // it under real memory pressure. Cheap insurance against the exact
    // failure mode just fixed above, given how severe it was (crashed
    // every long-video render reliably at the first chunk boundary).
    if (i < chunkRanges.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  const finalOutputPath = path.join(os.tmpdir(), 'shortform-renders', `${jobId}.mp4`);
  await concatChunks(chunkPaths, finalOutputPath);

  // Clean up the working chunk files now that the final file exists.
  for (const p of chunkPaths) fs.unlink(p, () => {});
  fs.rmdir(workDir, () => {});

  if (onProgress) onProgress(100);
  return finalOutputPath;
}

// V8's default old-space ceiling scales with total system memory, which
// on a capped container is a lie the process believes until it's too
// late. A cap here is meant as a distant safety net against a genuine
// runaway leak, not an operational ceiling - set too tight (220 was
// tried and made things WORSE: production started timing out on
// chunk 0, the very first and smallest slice of work, which a
// cross-chunk memory-accumulation theory can't explain since every
// chunk is a fresh process with nothing carried over). The likely
// mechanism: V8 doesn't crash the instant old-space fills, it fights
// for headroom with increasingly aggressive/frequent GC passes first -
// under real per-frame allocation churn (canvas paths, gradients,
// composite ops), a too-tight cap can make a process spend most of its
// time GC-thrashing instead of crashing OR progressing, which is
// indistinguishable from a hang to the outer fork-level timeout. This
// bounds the JS heap only - it never addressed native Skia memory
// anyway (the actual dominant cost per the original dev's comments) -
// so raised well above where it could plausibly constrain a healthy
// render, keeping only the "catch a truly runaway leak" purpose.
const CHUNK_WORKER_MAX_OLD_SPACE_MB = 400;

function renderSingleChunk(jobId, sceneJSON, timeStart, timeEnd, outputPath, chunkIndex, onProgress) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'renderChunkWorker.js'), {
      stdio: 'inherit',
      // --expose-gc: required for renderEngine.js's own periodic
      // global.gc() calls to actually run - see its doc comment at the
      // call site. Without this, native Skia canvas memory piles up
      // essentially unbounded within a single chunk (measured directly:
      // ~50MB/frame with no ceiling), which --max-old-space-size alone
      // never covered since it only bounds the JS heap.
      execArgv: [`--max-old-space-size=${CHUNK_WORKER_MAX_OLD_SPACE_MB}`, '--expose-gc'],
    });

    // Real bug fixed here: this used to resolve/reject the moment the
    // IPC message arrived, then the orchestrator's loop immediately
    // forked the NEXT chunk - but process.send() and process.exit()
    // are two independent async events, and the OS can still be
    // mid-teardown (reclaiming the previous chunk's Skia/ffmpeg
    // memory) when the next chunk's fork() already starts allocating
    // its own. That overlap window is a real memory spike, and it
    // explains exactly the reported symptom: a crash that reliably
    // hits at the first chunk boundary, not randomly mid-render. Now
    // BOTH the IPC result AND the actual 'exit' event must happen
    // before this promise settles, guaranteeing the previous
    // process's resources are actually reclaimed before the next
    // chunk is allowed to start.
    let settled = false;
    let ipcResult = null; // { ok: true, outputPath } | { ok: false, error }
    let hasExited = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Chunk ${chunkIndex} timed out`));
      }
    }, 4 * 60 * 1000); // 4 min per-chunk safety timeout (raised from 3min after
    // a real production timeout: an 8s/192-frame chunk hit 3 minutes
    // mid-render on Render's actual host, confirmed via the per-frame
    // logging this comment used to speculate about needing - real
    // throughput there measured at ~1.4s/frame even after the memory
    // fixes (~4x slower than local dev's per-frame cost with the same
    // fixes applied). CHUNK_SIZE_SECONDS was ALSO cut 8->5 above for the
    // same incident - the two changes together, not either alone, are
    // what actually bounds a real chunk's total time safely under this
    // limit. This margin stacks on top of that reduction rather than
    // substituting for it, since Render's exact throughput isn't
    // something reliably measurable from local dev.

    function maybeFinish() {
      if (settled || !hasExited) return;
      settled = true;
      clearTimeout(timeout);
      if (ipcResult && ipcResult.ok) {
        resolve(ipcResult.outputPath);
      } else if (ipcResult && !ipcResult.ok) {
        reject(new Error(`Chunk ${chunkIndex} failed: ${ipcResult.error}`));
      } else {
        reject(new Error(`Chunk ${chunkIndex} process exited without reporting a result (likely OOM-killed)`));
      }
    }

    child.on('message', (msg) => {
      if (!msg || msg.chunkIndex !== chunkIndex) return;
      if (msg.type === 'chunk_progress' && onProgress) {
        onProgress(msg.progress);
      } else if (msg.type === 'chunk_complete') {
        ipcResult = { ok: true, outputPath: msg.outputPath };
      } else if (msg.type === 'chunk_failed') {
        ipcResult = { ok: false, error: msg.error };
      }
    });

    child.on('exit', () => {
      hasExited = true;
      maybeFinish();
    });

    child.send({ jobId, sceneJSON, timeStart, timeEnd, outputPath, chunkIndex });
  });
}

/**
 * Stream-copy concat (no re-encode - all chunks share identical
 * codec/resolution/fps, so this is fast and lossless, not a second
 * full encode pass).
 */
function concatChunks(chunkPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + '.concat-list.txt';
    const listContent = chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
    ]);

    let err = '';
    ffmpeg.stderr.on('data', (d) => { err += d.toString(); });
    ffmpeg.on('close', (code) => {
      fs.unlink(listPath, () => {});
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg concat exited with code ${code}: ${err.slice(-500)}`));
    });
    ffmpeg.on('error', reject);
  });
}

module.exports = { renderLongFormVideo, CHUNK_THRESHOLD_SECONDS, CHUNK_SIZE_SECONDS };
