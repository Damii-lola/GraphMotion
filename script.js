const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const summaryBtn = document.getElementById('summaryBtn');
const loading = document.getElementById('loading');
const BACKEND_URL = 'https://graphmotion.onrender.com'; // change if needed

// Helper: extract video ID (for validation)
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?#]+)/,
    /youtube\.com\/embed\/([^?]+)/,
    /youtube\.com\/v\/([^?]+)/
  ];
  for (let p of patterns) {
    const match = url.match(p);
    if (match) return match[1];
  }
  return null;
}

// Show loading overlay, disable input/button
function showLoading() {
  preview.classList.add('hidden');
  loading.classList.remove('hidden');
  input.disabled = true;
  summaryBtn.disabled = true;
}

// Hide loading, re-enable
function hideLoading() {
  loading.classList.add('hidden');
  input.disabled = false;
  summaryBtn.disabled = false;
}

// Load video: preview (embed) or summary (processed video)
async function loadVideo(url, isSummary = false) {
  const endpoint = isSummary ? '/create-summary' : '/get-video-info';
  
  // Validate URL before sending
  if (!extractVideoId(url)) {
    alert('Invalid YouTube URL');
    return;
  }

  showLoading();

  try {
    const response = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, frameInterval: 5 }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load');

    hideLoading();

    if (isSummary) {
      // Show summary video
      preview.innerHTML = `
        <div class="video-wrapper">
          <video controls autoplay>
            <source src="${data.signedUrl}" type="video/mp4" />
            Your browser does not support the video tag.
          </video>
          <div class="video-info">
            <p>✅ Summary created with ${data.frameCount} frames (each shown for 1 second)</p>
          </div>
        </div>
      `;
    } else {
      // Show YouTube embed
      preview.innerHTML = `
        <div class="video-wrapper">
          <iframe
            src="${data.embedUrl}"
            title="${data.title}"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
          <div class="video-info">
            <h2>${data.title}</h2>
            <p>${data.author}</p>
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

// --- Event Listeners ---
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (url) loadVideo(url, false);
  }
});

summaryBtn.addEventListener('click', () => {
  const url = input.value.trim();
  if (!url) {
    alert('Please enter a YouTube URL first.');
    return;
  }
  loadVideo(url, true);
});
