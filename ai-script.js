// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', function() {

  // Get all elements – with fallback to avoid null errors
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');
  const dropMessage = document.getElementById('dropMessage');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileSize = document.getElementById('fileSize');
  const preview = document.getElementById('preview');
  const loading = document.getElementById('loading');
  const loadingMessage = document.getElementById('loadingMessage');
  const processArea = document.getElementById('processArea');
  const processBtn = document.getElementById('processBtn');
  const aiResult = document.getElementById('aiResult');
  const scriptOutput = document.getElementById('scriptOutput');
  const progressArea = document.getElementById('progressArea');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const clipSelection = document.getElementById('clipSelection');
  const clipList = document.getElementById('clipList');

  // Check essential elements exist
  if (!fileInput || !dropZone || !preview || !loading || !processBtn) {
    console.error('Missing required DOM elements. Check IDs.');
    return;
  }

  const BACKEND_URL = 'https://graphmotion.onrender.com'; // Update with your Render URL

  let currentSignedUrl = null;
  let currentFileName = null;
  let currentClips = [];

  // ---------- UI helpers with null checks ----------
  function showLoading(msg = 'Processing...') {
    if (preview) preview.classList.add('hidden');
    if (aiResult) aiResult.classList.add('hidden');
    if (processArea) processArea.classList.add('hidden');
    if (progressArea) progressArea.classList.add('hidden');
    if (clipSelection) clipSelection.classList.add('hidden');
    if (loading) {
      loading.classList.remove('hidden');
      if (loadingMessage) loadingMessage.textContent = msg;
    }
    if (fileInput) fileInput.disabled = true;
    if (dropZone) dropZone.style.pointerEvents = 'none';
  }

  function hideLoading() {
    if (loading) loading.classList.add('hidden');
    if (fileInput) fileInput.disabled = false;
    if (dropZone) dropZone.style.pointerEvents = 'auto';
  }

  function showFileInfo(file) {
    if (fileName) fileName.textContent = file.name;
    const size = (file.size / (1024 * 1024)).toFixed(2);
    if (fileSize) fileSize.textContent = `${size} MB`;
    if (fileInfo) fileInfo.classList.remove('hidden');
    if (dropMessage) {
      dropMessage.innerHTML = `<p>✅ ${file.name}</p><span>Drop another or click to change</span>`;
    }
  }

  function resetDropZone() {
    if (fileInfo) fileInfo.classList.add('hidden');
    if (dropMessage) {
      dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select (max 1GB)</span>`;
    }
  }

  // ---------- Upload using signed URL ----------
  async function uploadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file.');
      return;
    }
    if (file.size > 1024 * 1024 * 1024) {
      alert('File too large. Max 1 GB.');
      return;
    }

    if (progressArea) progressArea.classList.remove('hidden');
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = '0%';

    try {
      // 1. Get signed upload URL
      const getUrlRes = await axios.post(`${BACKEND_URL}/get-upload-url`, {
        originalName: file.name,
      });
      const { signedUrl, filePath, fileName: name } = getUrlRes.data;
      currentFileName = name;

      // 2. Upload directly to Supabase – no timeout
      const uploadRes = await axios.put(signedUrl, file, {
        headers: { 'Content-Type': file.type },
        onUploadProgress: (progressEvent) => {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          if (progressFill) progressFill.style.width = `${percent}%`;
          if (progressText) progressText.textContent = `${percent}%`;
        },
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      if (uploadRes.status !== 200) throw new Error('Upload to storage failed');

      // 3. Confirm upload
      const confirmRes = await axios.post(`${BACKEND_URL}/confirm-upload`, { filePath }, { timeout: 30000 });
      const { signedUrl: playUrl } = confirmRes.data;
      currentSignedUrl = playUrl;

      if (progressArea) progressArea.classList.add('hidden');
      if (preview) {
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
      }

      if (processArea) processArea.classList.remove('hidden');
      resetDropZone();

    } catch (err) {
      if (progressArea) progressArea.classList.add('hidden');
      let errorMsg = 'Upload error: ';
      if (err.code === 'ECONNABORTED') {
        errorMsg += 'The upload took too long. Please try again with a faster connection or a smaller file.';
      } else if (err.response && err.response.data && err.response.data.error) {
        errorMsg += err.response.data.error;
      } else if (err.message) {
        errorMsg += err.message;
      } else {
        errorMsg += 'Unknown error';
      }
      alert(errorMsg);
    }
  }

  // ---------- Process video ----------
  if (processBtn) {
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
          if (clipList) {
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
          }
          if (clipSelection) clipSelection.classList.remove('hidden');
        }
      } catch (err) {
        hideLoading();
        alert('Processing error: ' + (err.response?.data?.error || err.message));
      }
    });
  }

  // ---------- Show a single clip ----------
  function showClip(clip) {
    if (clipSelection) clipSelection.classList.add('hidden');
    if (preview) {
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
    }
    if (processArea) processArea.classList.add('hidden');
  }

  // ---------- File input change ----------
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        showFileInfo(file);
        uploadFile(file);
      }
    });
  }

  // ---------- Drag & Drop ----------
  if (dropZone) {
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
        if (fileInput) {
          fileInput.files = e.dataTransfer.files;
        }
        showFileInfo(file);
        uploadFile(file);
      }
    });

    // Click on drop zone triggers input
    dropZone.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });
  }

}); // end DOMContentLoaded
