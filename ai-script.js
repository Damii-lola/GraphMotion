const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const preview = document.getElementById('preview');
const loading = document.getElementById('loading');
const BACKEND_URL = 'https://graphmotion.onrender.com';

function showLoading() {
  preview.classList.add('hidden');
  loading.classList.remove('hidden');
  fileInput.disabled = true;
  uploadBtn.disabled = true;
}

function hideLoading() {
  loading.classList.add('hidden');
  fileInput.disabled = false;
  uploadBtn.disabled = false;
}

uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) {
    alert('Please select a video file first.');
    return;
  }

  // Validate file size (e.g., 200 MB limit)
  if (file.size > 200 * 1024 * 1024) {
    alert('File too large. Please select a video under 200 MB.');
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
  } catch (err) {
    hideLoading();
    alert('Upload error: ' + err.message);
  }
});

// Also allow drag & drop if you want, but it's optional.
