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

const BACKEND_URL = 'https://graphmotion.onrender.com';

let currentSignedUrl = null;
let currentFileName = null;

// ---------- UI helpers ----------
function showLoading(msg = 'Uploading and processing your video...') {
  preview.classList.add('hidden');
  aiResult.classList.add('hidden');
  processArea.classList.add('hidden');
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
  const size = (file.size / (1024 * 1024)).toFixed(2);
  fileSize.textContent = `${size} MB`;
  fileInfo.classList.remove('hidden');
  dropMessage.innerHTML = `<p>✅ ${file.name}</p><span>Drop another or click to change</span>`;
}

function resetDropZone() {
  fileInfo.classList.add('hidden');
  dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select (max 1GB)</span>`;
}

// ---------- Upload logic ----------
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

  showLoading('Uploading video...');
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

    // Save for later use
    currentSignedUrl = data.signedUrl;
    currentFileName = data.fileName;

    // Show video player
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

    // Show process button
    processArea.classList.remove('hidden');

    // Reset drop zone
    resetDropZone();
    selectedFile = null;

  } catch (err) {
    hideLoading();
    alert('Upload error: ' + err.message);
  }
}

// ---------- Process with Mistral AI ----------
processBtn.addEventListener('click', async () => {
  if (!currentSignedUrl || !currentFileName) {
    alert('Please upload a video first.');
    return;
  }

  showLoading('Contacting Mistral AI...');
  try {
    const response = await fetch(`${BACKEND_URL}/process-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signedUrl: currentSignedUrl,
        fileName: currentFileName,
        // Optionally add a user prompt input field later
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI processing failed');

    hideLoading();
    aiResult.classList.remove('hidden');
    scriptOutput.textContent = data.script;

  } catch (err) {
    hideLoading();
    alert('AI error: ' + err.message);
  }
});

// ---------- File input change ----------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    selectedFile = file;
    showFileInfo(file);
    uploadFile(file);
  }
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
    selectedFile = file;
    showFileInfo(file);
    uploadFile(file);
  }
});

// Click on drop zone triggers input
dropZone.addEventListener('click', () => {
  fileInput.click();
});
