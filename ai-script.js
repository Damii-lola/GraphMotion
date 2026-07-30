// ---------- Supabase config ----------
const supabaseUrl = 'https://xbmbmkxpgcijvxpdircg.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibWJta3hwZ2NpanZ4cGRpcmNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxODk3ODAsImV4cCI6MjEwMDc2NTc4MH0.yF4E8OM0diU6jpKymVGQUb-Ve3212avCOUeH2YjcdIE';
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

// ---------- DOM refs ----------
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
const progressArea = document.getElementById('progressArea');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const clipSelection = document.getElementById('clipSelection');
const clipList = document.getElementById('clipList');

const BACKEND_URL = 'https://graphmotion.onrender.com'; // Update with your actual Render URL

let currentSignedUrl = null;
let currentFileName = null;
let currentClips = [];

// ---------- UI helpers ----------
function showLoading(msg = 'Processing...') {
  preview.classList.add('hidden');
  processArea.classList.add('hidden');
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
  const size = (file.size / (1024 * 1024)).toFixed(2);
  fileSize.textContent = `${size} MB`;
  fileInfo.classList.remove('hidden');
  dropMessage.innerHTML = `<p>✅ ${file.name}</p><span>Drop another or click to change</span>`;
}

function resetDropZone() {
  fileInfo.classList.add('hidden');
  dropMessage.innerHTML = `<p>📁 Drop your video here</p><span>or click to select (max 1GB)</span>`;
}

// ---------- Upload with Supabase client ----------
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

  progressArea.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';

  try {
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'mp4';
    const fileName = `${Date.now()}_${file.name.replace(/\s/g, '_')}`;
    const filePath = `temp_videos/${fileName}`;

    // Upload with progress
    const { data, error } = await supabaseClient.storage
      .from('temp_videos')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false,
        onProgress: (progress) => {
          const percent = Math.round((progress.loaded / progress.total) * 100);
          progressFill.style.width = `${percent}%`;
          progressText.textContent = `${percent}%`;
        },
      });

    if (error) throw error;

    // Get signed URL for playback
    const { data: signedData, error: signedErr } = await supabaseClient.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    currentSignedUrl = signedData.signedUrl;
    currentFileName = file.name;

    progressArea.classList.add('hidden');
    preview.innerHTML = `
      <div class="video-wrapper">
        <video controls autoplay>
          <source src="${signedData.signedUrl}" type="${file.type}" />
        </video>
        <div class="video-info">
          <h2>${file.name}</h2>
          <p>✅ Video ready – valid for 1 hour</p>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
    processArea.classList.remove('hidden');
    resetDropZone();

  } catch (err) {
    progressArea.classList.add('hidden');
    alert('Upload error: ' + err.message);
  }
}

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
      alert('Could not find any interesting moments in this video.');
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

// ---------- File input ----------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
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
    showFileInfo(file);
    uploadFile(file);
  }
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});
