const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const summaryBtn = document.getElementById('summaryBtn');
const BACKEND_URL = 'https://graphmotion.onrender.com';

async function loadVideo(url, isSummary = false) {
  const endpoint = isSummary ? '/create-summary' : '/get-video-info';
  try {
    const response = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, frameInterval: 5 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed');

    if (isSummary) {
      // Show video with the summary
      preview.innerHTML = `
        <div class="video-wrapper">
          <video controls autoplay>
            <source src="${data.signedUrl}" type="video/mp4" />
          </video>
          <div class="video-info">
            <p>Summary created with ${data.frameCount} frames</p>
          </div>
        </div>
      `;
    } else {
      // embed
      preview.innerHTML = `
        <div class="video-wrapper">
          <iframe src="${data.embedUrl}" ...></iframe>
          <div class="video-info"><h2>${data.title}</h2><p>${data.author}</p></div>
        </div>
      `;
    }
    preview.classList.remove('hidden');
  } catch (err) {
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
  if (url) loadVideo(url, true);
});
