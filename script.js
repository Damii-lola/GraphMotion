const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const summaryBtn = document.getElementById('summaryBtn');
const loading = document.getElementById('loading');
const BACKEND_URL = 'https://graphmotion.onrender.com';

function showLoading() {
  preview.classList.add('hidden');
  loading.classList.remove('hidden');
  input.disabled = true;
  summaryBtn.disabled = true;
}

function hideLoading() {
  loading.classList.add('hidden');
  input.disabled = false;
  summaryBtn.disabled = false;
}

async function loadVideo(url, isSummary = false) {
  // Validate it's a TikTok URL (simple)
  if (!url.includes('tiktok.com')) {
    alert('Please enter a TikTok URL');
    return;
  }

  const endpoint = isSummary ? '/create-summary' : '/get-video-info';
  showLoading();

  try {
    const response = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, frameInterval: 5 }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed');

    hideLoading();

    if (isSummary) {
      // Show summary video
      preview.innerHTML = `
        <div class="video-wrapper">
          <video controls autoplay>
            <source src="${data.signedUrl}" type="video/mp4" />
          </video>
          <div class="video-info">
            <p>✅ Summary created with ${data.frameCount} frames</p>
          </div>
        </div>
      `;
    } else {
      // Preview: embed TikTok video (use video element)
      preview.innerHTML = `
        <div class="video-wrapper">
          <video controls autoplay>
            <source src="${data.videoUrl}" type="video/mp4" />
          </video>
          <div class="video-info">
            <h2>${data.title || 'TikTok Video'}</h2>
            <p>${data.author || 'Unknown'}</p>
          </div>
        </div>
      `;
    }
    preview.classList.remove('hidden');
  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (url) loadVideo(url, false);
  }
});

summaryBtn.addEventListener('click', () => {
  const url = input.value.trim();
  if (!url) {
    alert('Please enter a TikTok URL first.');
    return;
  }
  loadVideo(url, true);
});
