const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const BACKEND_URL = 'https://graphmotion.onrender.com';

async function loadVideo(url) {
  try {
    const response = await fetch(`${BACKEND_URL}/get-video-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load video');

    // Show embed
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
