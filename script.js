const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');

// Your Render backend URL (change to your actual deployed URL)
const BACKEND_URL = 'https://graphmotion.onrender.com';

async function loadVideo(url) {
  try {
    const response = await fetch(`${BACKEND_URL}/download-youtube`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Download failed');

    // Show the video
    preview.innerHTML = `
      <div class="video-wrapper">
        <video controls autoplay>
          <source src="${data.signedUrl}" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
        <div class="video-info">
          <h2>${data.title}</h2>
          <p>${data.author}</p>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (url) loadVideo(url);
  }
});
