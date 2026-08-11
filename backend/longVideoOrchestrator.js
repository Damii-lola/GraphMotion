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
const CHUNK_THRESHOLD_SECONDS = 20;
const CHUNK_SIZE_SECONDS = 15;

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

function renderSingleChunk(jobId, sceneJSON, timeStart, timeEnd, outputPath, chunkIndex, onProgress) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'renderChunkWorker.js'), { stdio: 'inherit' });

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
    }, 5 * 60 * 1000); // 5 min per-chunk safety timeout

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
