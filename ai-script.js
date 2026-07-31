// =============================================
//  GraphMotion AI – Frontend Upload & Processing
//  (with multipart + compression + fallback)
// =============================================

const BACKEND_URL = 'https://graphmotion.onrender.com'; // ← your Render backend
const CHUNK_SIZE = 5 * 1024 * 1024;                     // 5 MB per part
const MAX_CONCURRENT_UPLOADS = 6;

// ---------- Global state ----------
let currentFile = null;
let currentSignedUrl = null;
let currentFileName = null;
let currentClips = [];
let uploadAbortController = null;
let uploadId = null;
let uploadParts = [];
let multipartMeta = null;

// ---------- DOM references ----------
const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const dropMessage = $('dropMessage');
const fileInfo = $('fileInfo');
const fileName = $('fileName');
const fileSize = $('fileSize');
const preview = $('preview');
const loading = $('loading');
const loadingMessage = $('loadingMessage');
const processArea = $('processArea');
const processBtn = $('processBtn');
const progressArea = $('progressArea');
const progressFill = $('progressFill');
const progressText = $('progressText');
const progressSpeed = $('progressSpeed');
const chunkGrid = $('chunkGrid');
const cancelUploadBtn = $('cancelUploadBtn');
const clipSelection = $('clipSelection');
const clipList = $('clipList');
const compressToggle = $('compressToggle');
const useCompression = $('useCompression');

if (!fileInput || !dropZone || !preview || !loading || !processBtn) {
  console.error('Missing required DOM elements');
}

// ======================
//   UI helpers
// ======================
function showLoading(msg = 'Processing...') {
  preview.classList.add('hidden');
  processArea.classList.add('hidden');
  progressArea.classList.add('hidden');
  clipSelection.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingMessage.textContent = msg;
  fileInput.disabled = true;
  dropZone.style.pointerEvents = 'none';
}
function hideLoading() {
  loading.classList.add('hidden');
  fileInput.disabled = false;
  dropZone.style.pointerEvents = 'auto';
}
function showFileInfo(file) {
  fileName.textContent = file.name;
  fileSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
  fileInfo.classList.remove('hidden');
  compressToggle.classList.remove('hidden');
}
function cleanUploadUI() {
  fileInfo.classList.add('hidden');
  compressToggle.classList.add('hidden');
  progressArea.classList.add('hidden');
  cancelUploadBtn.classList.add('hidden');
  chunkGrid.innerHTML = '';
}
function resetForNewUpload() {
  cleanUploadUI();
  preview.classList.add('hidden');
  processArea.classList.add('hidden');
  clipSelection.classList.add('hidden');
  dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select (max 1GB)</span>`;
  currentSignedUrl = null;
  currentFileName = null;
  currentClips = [];
}

// ======================
//   FFmpeg.wasm compression
// ======================
async function compressVideo(file) {
  if (!useCompression.checked) return file;                 // user turned off

  if (typeof FFmpeg === 'undefined') {
    console.warn('FFmpeg.wasm not loaded – skipping compression.');
    return file;
  }

  showLoading('Compressing video (this may take a moment)...');
  try {
    const { createFFmpeg, fetchFile } = FFmpeg;
    const ffmpeg = createFFmpeg({
      log: false,
      corePath: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js',
    });
    await ffmpeg.load();

    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(file));
    await ffmpeg.run(
      '-i', 'input.mp4',
      '-c:v', 'libx264',
      '-crf', '28',
      '-preset', 'fast',
      '-c:a', 'aac',
      'output.mp4'
    );

    const data = ffmpeg.FS('readFile', 'output.mp4');
    const compressedBlob = new Blob([data.buffer], { type: 'video/mp4' });
    const compressedFile = new File(
      [compressedBlob],
      file.name.replace(/\.[^.]+$/, '.mp4'),
      { type: 'video/mp4' }
    );

    hideLoading();
    return compressedFile;
  } catch (err) {
    console.error('Compression failed, using original:', err);
    hideLoading();
    return file;   // fallback to original
  }
}

// ======================
//   Multipart upload (with fallback)
// ======================
async function uploadFileMultipart(file) {
  // --- prepare progress UI ---
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  progressSpeed.textContent = '';
  chunkGrid.innerHTML = '';
  cancelUploadBtn.classList.remove('hidden');
  uploadAbortController = new AbortController();

  try {
    // 1. Init multipart on backend
    const initRes = await axios.post(`${BACKEND_URL}/init-multipart`, {
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type,
    }, { signal: uploadAbortController.signal });

    const { uploadId, filePath, parts } = initRes.data;
    multipartMeta = { uploadId, filePath, parts };
    uploadParts = new Array(parts).fill(null);

    const totalChunks = parts;
    // draw chunk bars
    for (let i = 0; i < totalChunks; i++) {
      const bar = document.createElement('div');
      bar.className = 'chunk-bar';
      bar.dataset.index = i;
      chunkGrid.appendChild(bar);
    }

    // 2. Upload parts in parallel
    let completedChunks = 0;
    let totalUploaded = 0;
    const startTime = Date.now();

    const updateProgress = () => {
      const pct = Math.round((completedChunks / totalChunks) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${pct}%`;
      const elapsed = (Date.now() - startTime) / 1000;
      const mbps = totalUploaded / elapsed / (1024 * 1024);
      progressSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    };

    const uploadPart = async (partNumber) => {
      const start = (partNumber - 1) * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      const urlRes = await axios.post(`${BACKEND_URL}/get-part-url`, {
        uploadId,
        partNumber,
        filePath,
      }, { signal: uploadAbortController.signal });

      const { signedUrl } = urlRes.data;
      const bar = chunkGrid.children[partNumber - 1];
      bar.classList.add('uploading');

      const putRes = await axios.put(signedUrl, blob, {
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: uploadAbortController.signal,
      });

      if (putRes.status !== 200) throw new Error(`Part ${partNumber} failed`);

      const etag = putRes.headers.etag || putRes.headers['ETag'] || '';
      uploadParts[partNumber - 1] = { PartNumber: partNumber, ETag: etag.replace(/"/g, '') };

      completedChunks++;
      totalUploaded += blob.size;
      bar.classList.remove('uploading');
      bar.classList.add('completed');
      updateProgress();
    };

    // concurrency limiter
    let idx = 1;
    const tasks = [];
    const enqueue = async () => {
      while (idx <= totalChunks) {
        const partNum = idx++;
        const p = uploadPart(partNum).catch(e => {
          if (axios.isCancel(e)) throw e;
          console.error(`Part ${partNum} error:`, e);
          throw e;
        });
        tasks.push(p);
        if (tasks.length >= MAX_CONCURRENT_UPLOADS) {
          await Promise.race(tasks);
        }
      }
    };
    await enqueue();
    await Promise.all(tasks);

    // 3. Complete multipart
    const completeRes = await axios.post(`${BACKEND_URL}/complete-multipart`, {
      uploadId,
      filePath,
      parts: uploadParts,
      originalName: file.name,
    }, { signal: uploadAbortController.signal });

    const { signedUrl: playUrl } = completeRes.data;
    currentSignedUrl = playUrl;
    currentFileName = file.name;
    finishUpload(playUrl, file.type);

  } catch (err) {
    if (axios.isCancel(err)) {
      console.log('Upload cancelled by user');
    } else if (err.response?.status === 404 || err.response?.data?.error?.includes('not found')) {
      // Fallback to old single PUT if multipart not available
      console.warn('Multipart not supported by backend, falling back to single upload.');
      await uploadFileSingle(file);
    } else {
      alert('Upload error: ' + (err.response?.data?.error || err.message));
    }
    cleanUploadUI();
    if (uploadId) {
      axios.post(`${BACKEND_URL}/abort-multipart`, { uploadId, filePath }).catch(() => {});
    }
  }
}

// ======================
//   Fallback: single PUT upload
// ======================
async function uploadFileSingle(file) {
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  progressSpeed.textContent = '';
  cancelUploadBtn.classList.remove('hidden');
  uploadAbortController = new AbortController();

  try {
    const getUrlRes = await axios.post(`${BACKEND_URL}/get-upload-url`, {
      originalName: file.name,
    });
    const { signedUrl, filePath, fileName: name } = getUrlRes.data;
    currentFileName = name;

    await axios.put(signedUrl, file, {
      headers: { 'Content-Type': file.type },
      onUploadProgress: (pe) => {
        const pct = Math.round((pe.loaded * 100) / pe.total);
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `${pct}%`;
        const elapsed = (Date.now() - startTime) / 1000;
        const mbps = pe.loaded / elapsed / (1024 * 1024);
        progressSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
      },
      signal: uploadAbortController.signal,
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const confirmRes = await axios.post(`${BACKEND_URL}/confirm-upload`, { filePath });
    const { signedUrl: playUrl } = confirmRes.data;
    currentSignedUrl = playUrl;
    finishUpload(playUrl, file.type);

  } catch (err) {
    if (!axios.isCancel(err)) {
      alert('Upload error: ' + (err.response?.data?.error || err.message));
    }
    cleanUploadUI();
  }
}

// ======================
//   After successful upload
// ======================
function finishUpload(playUrl, mimeType) {
  cleanUploadUI();
  preview.innerHTML = `
    <div class="video-wrapper">
      <video controls autoplay>
        <source src="${playUrl}" type="${mimeType}" />
      </video>
      <div class="video-info">
        <h2>${currentFileName}</h2>
        <p>✅ Video ready – valid for 1 hour</p>
      </div>
    </div>
  `;
  preview.classList.remove('hidden');
  processArea.classList.remove('hidden');
  dropMessage.innerHTML = `<p>📁 Drop another video here</p><span>or click to select</span>`;
}

// ======================
//   Cancel upload
// ======================
cancelUploadBtn.addEventListener('click', () => {
  if (uploadAbortController) uploadAbortController.abort();
});

// ======================
//   Process video (AI)
// ======================
processBtn.addEventListener('click', async () => {
  if (!currentSignedUrl || !currentFileName) {
    alert('Please upload a video first.');
    return;
  }

  showLoading('Scanning video for interesting moments...');
  try {
    const resp = await axios.post(`${BACKEND_URL}/process-video`, {
      signedUrl: currentSignedUrl,
      fileName: currentFileName,
    }, { timeout: 600000 });

    const data = resp.data;
    if (!data.success) throw new Error(data.error || 'Processing failed');
    hideLoading();

    if (!data.found) {
      alert('Could not find any funny or interesting moments in this video.');
      return;
    }

    currentClips = data.clips;
    if (currentClips.length === 1) {
      showClip(currentClips[0]);
    } else {
      clipList.innerHTML = '';
      currentClips.forEach((clip, i) => {
        const div = document.createElement('div');
        div.className = 'clip-item';
        div.innerHTML = `
          <video src="${clip.signedUrl}" muted preload="metadata"></video>
          <button data-index="${i}" class="btn-primary select-clip">Select</button>
        `;
        clipList.appendChild(div);
      });
      document.querySelectorAll('.select-clip').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(e.target.dataset.index);
          showClip(currentClips[idx]);
        });
      });
      clipSelection.classList.remove('hidden');
    }
  } catch (err) {
    hideLoading();
    alert('Processing error: ' + (err.response?.data?.error || err.message));
  }
});

function showClip(clip) {
  clipSelection.classList.add('hidden');
  preview.innerHTML = `
    <div class="video-wrapper">
      <video controls autoplay>
        <source src="${clip.signedUrl}" type="video/mp4" />
      </video>
      <div class="video-info">
        <h2>Selected Clip (${clip.start.toFixed(1)}s – ${clip.end.toFixed(1)}s)</h2>
        <a href="${clip.signedUrl}" download="clip.mp4" class="download-link">⬇️ Download Clip</a>
      </div>
    </div>
  `;
  preview.classList.remove('hidden');
  processArea.classList.add('hidden');
}

// ======================
//   File selection & drag/drop
// ======================
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  currentFile = file;
  resetForNewUpload();
  showFileInfo(file);
  const compressed = await compressVideo(file);
  uploadFileMultipart(compressed);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length) {
    const file = files[0];
    fileInput.files = e.dataTransfer.files;
    currentFile = file;
    resetForNewUpload();
    showFileInfo(file);
    compressVideo(file).then(comp => uploadFileMultipart(comp));
  }
});
dropZone.addEventListener('click', () => fileInput.click());
