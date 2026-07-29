const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const loading = document.getElementById('loading');
const BACKEND_URL = 'https://graphmotion.onrender.com';

function showLoading() {
  preview.classList.add('hidden');
  loading.classList.remove('hidden');
  input.disabled = true;
  downloadBtn.disabled = true;
}

function hideLoading() {
  loading.classList.add('hidden');
  input.disabled = false;
  downloadBtn.disabled = false;
}

function isTikTokUrl(url) {
  return url.includes('tiktok.com');
}

// Preview on Enter
input.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (!url) return;
    if (!isTikTokUrl(url)) {
      alert('Only TikTok URLs are supported.');
      return;
    }
    showLoading();
    try {
      const res = await fetch(`${BACKEND_URL}/get-video-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview failed');
      hideLoading();
      preview.innerHTML = `
        <div class="video-wrapper">
          <video controls autoplay>
            <source src="${data.videoUrl}" type="video/mp4" />
          </video>
          <div class="video-info">
            <h2>${data.title}</h2>
            <p>${data.author}</p>
          </div>
        </div>
      `;
      preview.classList.remove('hidden');
    } catch (err) {
      hideLoading();
      alert('Preview error: ' + err.message);
    }
  }
});

// Download full video – shows the downloaded video in the same page
downloadBtn.addEventListener('click', async () => {
  const url = input.value.trim();
  if (!url) {
    alert('Please enter a TikTok URL first.');
    return;
  }
  if (!isTikTokUrl(url)) {
    alert('Only TikTok URLs are supported.');
    return;
  }
  showLoading();
  try {
    const res = await fetch(`${BACKEND_URL}/download-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Download failed');
    hideLoading();
    // Show the downloaded video without a separate download link
    preview.innerHTML = `
      <div class="video-wrapper">
        <video controls autoplay>
          <source src="${data.signedUrl}" type="video/mp4" />
        </video>
        <div class="video-info">
          <h2>${data.title}</h2>
          <p>${data.author}</p>
          <p style="font-size:0.9rem;color:#64748b;">✅ Video ready – saved in your Supabase storage (valid for 1 hour)</p>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
  } catch (err) {
    hideLoading();
    alert('Download error: ' + err.message);
  }
});
