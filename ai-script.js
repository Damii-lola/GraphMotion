const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const dropMessage = document.getElementById('dropMessage');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const preview = document.getElementById('preview');
const loading = document.getElementById('loading');
const BACKEND_URL = 'https://graphmotion.onrender.com';

let selectedFile = null;

// ---------- UI helpers ----------
function showLoading() {
  preview.classList.add('hidden');
  loading.classList.remove('hidden');
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
  const size = (file.size / (1024 * 1024)).toFixed(2);
  fileSize.textContent = `${size} MB`;
  fileInfo.classList.remove('hidden');
  dropMessage.innerHTML = `<p>✅ ${file.name}</p><span>Drop another or click to change</span>`;
}

function resetDropZone() {
  fileInfo.classList.add('hidden');
  dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select</span>`;
}

// ---------- Upload logic ----------
async function uploadFile(file) {
  if (!file) return;

  // Validate file type
  if (!file.type.startsWith('video/')) {
    alert('Please select a video file.');
    return;
  }
  if (file.size > 200 * 1024 * 1024) {
    alert('File too large. Max 200 MB.');
    return;
  }

  showLoading();
  const formData = new FormData();
  formData.append('video', file);

  try {
    const response = await fetch(`${BACKEND_URL}/upload-video`, {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed');

    hideLoading();
    // Show video
    preview.innerHTML = `
      <div class="video-wrapper">
        <video controls autoplay>
          <source src="${data.signedUrl}" type="${file.type}" />
        </video>
        <div class="video-info">
          <h2>${data.fileName}</h2>
          <p>✅ Video ready – valid for 1 hour</p>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
    // Reset drop zone after success (optional)
    resetDropZone();
    selectedFile = null;
  } catch (err) {
    hideLoading();
    alert('Upload error: ' + err.message);
  }
}

// ---------- Event: file input change ----------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    selectedFile = file;
    showFileInfo(file);
    // Auto‑upload after selection
    uploadFile(file);
  }
});

// ---------- Drag & Drop events ----------
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
    // Update the file input so that the change event fires
    fileInput.files = e.dataTransfer.files;
    // Manually trigger the change handler (browsers may not fire it automatically)
    // So we call our handler directly
    selectedFile = file;
    showFileInfo(file);
    uploadFile(file);
  }
});

// ---------- Click on drop zone triggers file input ----------
dropZone.addEventListener('click', () => {
  fileInput.click();
});
