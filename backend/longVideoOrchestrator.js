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
const CHUNK_THRESHOLD_SECONDS = 25;
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
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Chunk ${chunkIndex} timed out`));
      }
    }, 5 * 60 * 1000); // 5 min per-chunk safety timeout

    child.on('message', (msg) => {
      if (!msg || msg.chunkIndex !== chunkIndex) return;
      if (msg.type === 'chunk_progress' && onProgress) {
        onProgress(msg.progress);
      } else if (msg.type === 'chunk_complete') {
        settled = true;
        clearTimeout(timeout);
        resolve(msg.outputPath);
      } else if (msg.type === 'chunk_failed') {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Chunk ${chunkIndex} failed: ${msg.error}`));
      }
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Chunk ${chunkIndex} process exited unexpectedly (code ${code}, signal ${signal || 'none'})`));
      }
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
