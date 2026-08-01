// =============================================
//  GraphMotion AI – Frontend Upload (Direct Supabase Storage Uploads)
// =============================================

const BACKEND_URL = 'https://graphmotion.onrender.com'; // Your Render backend

// ---------- Global state ----------
let currentFile = null;
let currentSignedUrl = null;
let currentFileName = null;
let currentClips = [];
let uploadAbortController = null;

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
}

// ---------- Direct Upload to Supabase Storage ----------
async function uploadFileDirect(file) {
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  progressSpeed.textContent = '';
  cancelUploadBtn.classList.remove('hidden');
  uploadAbortController = new AbortController();

  try {
    // 1. Get a signed URL from the backend
    const getUrlRes = await axios.post(`${BACKEND_URL}/get-upload-url`, {
      originalName: file.name,
    }, { signal: uploadAbortController.signal });

    const { signedUrl, filePath, fileName: name } = getUrlRes.data;
    currentFileName = name;

    // 2. Upload directly to Supabase Storage with progress tracking
    const startTime = Date.now();
    await axios.put(signedUrl, file, {
      headers: {
        'Content-Type': file.type,
        'x-upsert': 'false', // Prevent overwriting existing files
      },
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

    // 3. Confirm upload completion
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
  uploadFileDirect(file);
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
    uploadFileDirect(file);
  }
});

dropZone.addEventListener('click', () => fileInput.click());
