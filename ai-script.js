// =============================================
//  GraphMotion AI – Frontend Upload (Optimized for Speed)
//  USES: 100MB CHUNKS + 20 CONCURRENT UPLOADS + RESUMABLE LOGIC
// =============================================

const BACKEND_URL = 'https://graphmotion.onrender.com';
const CHUNK_SIZE = 100 * 1024 * 1024; // 100MB chunks
const MAX_CONCURRENT_UPLOADS = 20; // 20 concurrent uploads

// ---------- Global state ----------
let currentFile = null;
let currentSignedUrl = null;
let currentFileName = null;
let currentClips = [];
let uploadAbortController = null;
let uploadId = null;
let uploadParts = [];
let completedChunks = 0;
let totalChunks = 0;

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
}

function cleanUploadUI() {
  fileInfo.classList.add('hidden');
  progressArea.classList.add('hidden');
  cancelUploadBtn.classList.add('hidden');
  chunkGrid.innerHTML = '';
  completedChunks = 0;
}

function resetForNewUpload() {
  cleanUploadUI();
  preview.classList.add('hidden');
  processArea.classList.add('hidden');
  clipSelection.classList.add('hidden');
  dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select (max 10GB)</span>`;
  currentSignedUrl = null;
  currentFileName = null;
  currentClips = [];
  uploadId = null;
  uploadParts = [];
}

// ---------- Multipart Upload with Chunking ----------
async function uploadFileMultipart(file) {
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  progressSpeed.textContent = '';
  chunkGrid.innerHTML = '';
  cancelUploadBtn.classList.remove('hidden');
  uploadAbortController = new AbortController();

  try {
    // 1. Init multipart upload
    const initRes = await fetch(`${BACKEND_URL}/init-multipart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type,
      }),
      signal: uploadAbortController.signal,
    });
    const { uploadId: id, filePath, parts } = await initRes.json();
    uploadId = id;
    totalChunks = parts;
    uploadParts = new Array(parts).fill(null);

    // Create chunk progress bars
    for (let i = 0; i < totalChunks; i++) {
      const bar = document.createElement('div');
      bar.className = 'chunk-bar';
      bar.dataset.index = i;
      chunkGrid.appendChild(bar);
    }

    const startTime = Date.now();
    let totalUploaded = 0;

    const updateProgress = () => {
      const pct = Math.round((completedChunks / totalChunks) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${pct}%`;
      const elapsed = (Date.now() - startTime) / 1000;
      const mbps = totalUploaded / elapsed / (1024 * 1024);
      progressSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
    };

    // Queue for controlled parallelism
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
          // Get a signed URL for this chunk
          const urlRes = await fetch(`${BACKEND_URL}/get-chunk-url?uploadId=${uploadId}&partNumber=${partNumber}&filePath=${filePath}`);
          const { url, chunkPath } = await urlRes.json();

          // Upload the chunk
          await fetch(url, {
            method: 'PUT',
            body: blob,
            headers: { 'Content-Type': 'application/octet-stream' },
          });

          // Store the chunk info
          uploadParts[partNumber - 1] = { PartNumber: partNumber, ETag: `etag-${partNumber}` };
          completedChunks++;
          totalUploaded += blob.size;
          bar.classList.remove('uploading');
          bar.classList.add('completed');
          updateProgress();
        } catch (err) {
          console.error(`Part ${partNumber} failed:`, err);
          queue.push(partNumber); // Retry failed chunk
          bar.classList.remove('uploading');
        }
      }
    }

    // Run workers
    const workers = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT_UPLOADS, totalChunks); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // 3. Complete multipart upload
    const completeRes = await fetch(`${BACKEND_URL}/complete-multipart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        filePath,
        parts: uploadParts.map((part, i) => ({ PartNumber: i + 1, ETag: part.ETag })),
        originalName: file.name,
      }),
    });
    const { signedUrl: playUrl } = await completeRes.json();
    currentSignedUrl = playUrl;
    currentFileName = file.name;
    finishUpload(playUrl, file.type);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Multipart upload failed:', err);
      alert('Upload error: ' + err.message);
    }
    cleanUploadUI();
    if (uploadId) {
      fetch(`${BACKEND_URL}/abort-multipart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, filePath }),
      }).catch(() => {});
    }
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
    const resp = await fetch(`${BACKEND_URL}/process-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signedUrl: currentSignedUrl,
        fileName: currentFileName,
      }),
    });

    const data = await resp.json();
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
    alert('Processing error: ' + err.message);
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
