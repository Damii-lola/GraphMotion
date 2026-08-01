// =============================================
//  GraphMotion AI – Frontend Upload & Processing
//  (Direct multipart uploads to S3, no backend proxy)
// =============================================

const BACKEND_URL = 'https://graphmotion.onrender.com'; // Your Render backend
const CHUNK_SIZE = 100 * 1024 * 1024;                     // 100 MB per part (faster)
const MAX_CONCURRENT_UPLOADS = 50;                      // More parallelism

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

// ---------- UI helpers ----------
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
  dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select (max 5GB)</span>`;
  currentSignedUrl = null;
  currentFileName = null;
  currentClips = [];
}

// ---------- Direct Multipart Upload to S3 ----------
// Upload chunks directly to S3 using presigned URLs
async function uploadPartDirect(partNumber, blob, uploadId, filePath) {
  const { data: { url } } = await axios.get(`${BACKEND_URL}/get-part-url`, {
    params: { uploadId, partNumber, filePath },
  });

  const response = await axios.put(url, blob, {
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return { PartNumber: partNumber, ETag: response.headers.etag.replace(/"/g, '') };
}

// Retry failed chunks (3 attempts)
async function uploadPartWithRetry(partNumber, blob, uploadId, filePath, retries = 3) {
  try {
    return await uploadPartDirect(partNumber, blob, uploadId, filePath);
  } catch (err) {
    if (retries <= 0) throw err;
    console.log(`Retrying part ${partNumber}... (${retries} left)`);
    return uploadPartWithRetry(partNumber, blob, uploadId, filePath, retries - 1);
  }
}

// Upload file using direct multipart to S3
async function uploadFileMultipart(file) {
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
    for (let i = 0; i < totalChunks; i++) {
      const bar = document.createElement('div');
      bar.className = 'chunk-bar';
      bar.dataset.index = i;
      chunkGrid.appendChild(bar);
    }

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

    // Use a queue for controlled parallelism (50 concurrent uploads)
    const queue = [];
    for (let i = 1; i <= totalChunks; i++) {
      queue.push(i);
    }

    async function worker() {
      while (queue.length > 0 && !uploadAbortController.signal.aborted) {
        const partNumber = queue.shift();
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);

        const bar = chunkGrid.children[partNumber - 1];
        bar.classList.add('uploading');

        try {
          const part = await uploadPartWithRetry(partNumber, blob, uploadId, filePath);
          uploadParts[partNumber - 1] = part;
          completedChunks++;
          totalUploaded += blob.size;
          bar.classList.remove('uploading');
          bar.classList.add('completed');
          updateProgress();
        } catch (err) {
          console.error(`Part ${partNumber} failed after retries:`, err);
          queue.push(partNumber); // Re-queue failed part
          bar.classList.remove('uploading');
        }
      }
    }

    // Run 50 workers in parallel
    const workers = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT_UPLOADS, totalChunks); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

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
      console.log('Upload cancelled');
    } else {
      console.warn('Multipart failed, falling back to single upload.');
      await uploadFileSingle(file);
    }
    cleanUploadUI();
    if (uploadId) {
      axios.post(`${BACKEND_URL}/abort-multipart`, { uploadId, filePath }).catch(() => {});
    }
  }
}

// Fallback single PUT upload (if multipart fails)
async function uploadFileSingle(file) {
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  cancelUploadBtn.classList.remove('hidden');
  uploadAbortController = new AbortController();

  try {
    const getUrlRes = await axios.post(`${BACKEND_URL}/get-upload-url`, {
      originalName: file.name,
    });
    const { signedUrl, filePath, fileName: name } = getUrlRes.data;
    currentFileName = name;

    const startTime = Date.now();
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

// ---------- Cancel upload ----------
cancelUploadBtn.addEventListener('click', () => {
  if (uploadAbortController) uploadAbortController.abort();
});

// ---------- Process video (AI) ----------
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

// ---------- File selection & drag/drop ----------
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  currentFile = file;
  resetForNewUpload();
  showFileInfo(file);
  uploadFileMultipart(file);
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
    uploadFileMultipart(file);
  }
});

dropZone.addEventListener('click', () => fileInput.click());
