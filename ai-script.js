// ---------- Configuration ----------
const BACKEND_URL = 'https://graphmotion.onrender.com'; // Update with your Render URL
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per part
const MAX_CONCURRENT_UPLOADS = 6;

// ---------- Global state ----------
let currentFile = null;
let currentSignedUrl = null;
let currentFileName = null;
let currentClips = [];
let uploadAbortController = null;
let uploadId = null;
let uploadParts = [];
let multipartUploadMeta = null;

// ---------- DOM elements ----------
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

// Clean up upload UI elements only (not preview/process)
function cleanUploadUI() {
  fileInfo.classList.add('hidden');
  compressToggle.classList.add('hidden');
  progressArea.classList.add('hidden');
  cancelUploadBtn.classList.add('hidden');
  chunkGrid.innerHTML = '';
}

// Full reset for new uploads (when user selects a new file)
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

// ---------- Video compression (client-side, optional) ----------
async function compressVideo(file) {
  if (!useCompression.checked) return file;
  showLoading('Compressing video (this may take a moment)...');
  try {
    const { createFFmpeg, fetchFile } = FFmpeg; // Assume FFmpeg.wasm is loaded
    const ffmpeg = createFFmpeg({ log: false });
    await ffmpeg.load();
    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(file));
    await ffmpeg.run('-i', 'input.mp4', '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-c:a', 'aac', 'output.mp4');
    const data = ffmpeg.FS('readFile', 'output.mp4');
    const compressedBlob = new Blob([data.buffer], { type: 'video/mp4' });
    const compressedFile = new File([compressedBlob], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' });
    hideLoading();
    return compressedFile;
  } catch (err) {
    console.error('Compression failed, using original:', err);
    hideLoading();
    return file;
  }
}

// ---------- Multipart upload (client) ----------
async function uploadFileWithMultipart(file) {
  if (!file.type.startsWith('video/')) {
    alert('Please select a video file.');
    return;
  }
  if (file.size > 1024 * 1024 * 1024) {
    alert('File too large. Max 1 GB.');
    return;
  }

  // Show progress UI
  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  progressSpeed.textContent = '';
  chunkGrid.innerHTML = '';
  cancelUploadBtn.classList.remove('hidden');
  uploadAbortController = new AbortController();

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  // Build chunk placeholder bars
  for (let i = 0; i < totalChunks; i++) {
    const div = document.createElement('div');
    div.className = 'chunk-bar';
    div.dataset.index = i;
    chunkGrid.appendChild(div);
  }

  try {
    // 1. Initiate multipart upload on backend
    const initRes = await axios.post(`${BACKEND_URL}/init-multipart`, {
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type,
    }, { signal: uploadAbortController.signal });
    
    const { uploadId, filePath, parts } = initRes.data;
    multipartUploadMeta = { uploadId, filePath, parts };
    uploadParts = new Array(parts).fill(null);

    // 2. Upload each part in parallel (limited concurrency)
    const concurrencyLimit = MAX_CONCURRENT_UPLOADS;
    let completedChunks = 0;
    let totalUploaded = 0;
    const startTime = Date.now();

    const updateProgress = () => {
      const percent = Math.round((completedChunks / parts) * 100);
      progressFill.style.width = `${percent}%`;
      progressText.textContent = `${percent}%`;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = totalUploaded / elapsed / (1024 * 1024);
      progressSpeed.textContent = `${speed.toFixed(1)} MB/s`;
    };

    const uploadPart = async (partNumber) => {
      const start = (partNumber - 1) * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      // Get presigned URL for this part
      const urlRes = await axios.post(`${BACKEND_URL}/get-part-url`, {
        uploadId,
        partNumber,
        filePath,
      }, { signal: uploadAbortController.signal });
      const { signedUrl } = urlRes.data;

      const chunkBar = chunkGrid.children[partNumber - 1];
      chunkBar.classList.add('uploading');

      const res = await axios.put(signedUrl, blob, {
        headers: { 'Content-Type': 'application/octet-stream' },
        onUploadProgress: (evt) => {
          // Part progress optional
        },
        signal: uploadAbortController.signal,
      });

      if (res.status !== 200) throw new Error(`Part ${partNumber} failed`);
      
      // Extract ETag from response headers (required for completion)
      const etag = res.headers.etag || res.headers['ETag'] || '';
      uploadParts[partNumber - 1] = { PartNumber: partNumber, ETag: etag.replace(/"/g, '') };
      
      completedChunks++;
      totalUploaded += blob.size;
      chunkBar.classList.remove('uploading');
      chunkBar.classList.add('completed');
      updateProgress();
    };

    // Execute with concurrency control
    let idx = 1;
    const workers = [];
    const runNext = async () => {
      while (idx <= parts) {
        const partNum = idx++;
        const task = uploadPart(partNum).then(() => {
          // automatically continue
        });
        workers.push(task);
        if (workers.length >= concurrencyLimit) {
          await Promise.race(workers);
        }
      }
    };
    await runNext();
    await Promise.all(workers); // wait for remaining

    // 3. Complete multipart upload
    const completeRes = await axios.post(`${BACKEND_URL}/complete-multipart`, {
      uploadId,
      filePath,
      parts: uploadParts,
      originalName: file.name,
    }, { signal: uploadAbortController.signal });

    const { signedUrl: playUrl } = completeRes.data;
    currentSignedUrl = playUrl;
    currentFileName = file.name;

    // *** FIX: Clean upload UI, but keep preview & process button visible ***
    cleanUploadUI(); // hides fileInfo, compressToggle, progress, cancel button
    
    // Show video preview
    preview.innerHTML = `
      <div class="video-wrapper">
        <video controls autoplay>
          <source src="${playUrl}" type="${file.type}" />
        </video>
        <div class="video-info">
          <h2>${currentFileName}</h2>
          <p>✅ Video ready – valid for 1 hour</p>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
    
    // Show process button
    processArea.classList.remove('hidden');
    
    // Reset drop zone message for possible new upload
    dropMessage.innerHTML = `<p>📁 Drop another video here</p><span>or click to select</span>`;

  } catch (err) {
    if (axios.isCancel(err)) {
      console.log('Upload cancelled');
    } else {
      alert('Upload error: ' + (err.response?.data?.error || err.message));
    }
    cleanUploadUI();
    // Attempt to abort multipart if started
    if (uploadId) {
      axios.post(`${BACKEND_URL}/abort-multipart`, { uploadId, filePath }).catch(() => {});
    }
  }
}

// ---------- Cancel upload ----------
cancelUploadBtn.addEventListener('click', () => {
  if (uploadAbortController) {
    uploadAbortController.abort();
  }
});

// ---------- Process video ----------
processBtn.addEventListener('click', async () => {
  if (!currentSignedUrl || !currentFileName) {
    alert('Please upload a video first.');
    return;
  }

  showLoading('Scanning video for interesting moments...');
  try {
    const response = await axios.post(`${BACKEND_URL}/process-video`, {
      signedUrl: currentSignedUrl,
      fileName: currentFileName,
    }, { timeout: 600000 });

    const data = response.data;
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
      currentClips.forEach((clip, index) => {
        const div = document.createElement('div');
        div.className = 'clip-item';
        div.innerHTML = `
          <video src="${clip.signedUrl}" muted preload="metadata"></video>
          <button data-index="${index}" class="btn-primary select-clip">Select</button>
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

// ---------- File selection ----------
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  currentFile = file;
  resetForNewUpload(); // clear any previous preview/process UI
  showFileInfo(file);
  const compressed = await compressVideo(file);
  uploadFileWithMultipart(compressed);
});

// ---------- Drag & Drop ----------
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
  if (files.length > 0) {
    const file = files[0];
    fileInput.files = e.dataTransfer.files;
    currentFile = file;
    resetForNewUpload();
    showFileInfo(file);
    compressVideo(file).then(compressed => uploadFileWithMultipart(compressed));
  }
});
dropZone.addEventListener('click', () => fileInput.click());
