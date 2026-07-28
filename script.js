const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');

// Extract video ID from any YouTube URL
function getVideoId(url) {
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

async function loadPreview(url) {
  const videoId = getVideoId(url);
  if (!videoId) {
    alert('Invalid YouTube URL');
    return;
  }

  try {
    // Fetch metadata via oEmbed (no API key)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) throw new Error('Video not found');
    const data = await res.json();

    // Build preview HTML
    preview.innerHTML = `
      <div class="video-wrapper">
        <iframe
          src="https://www.youtube.com/embed/${videoId}"
          title="${data.title}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>
        <div class="video-info">
          <h2>${data.title}</h2>
          <p>${data.author_name}</p>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
  } catch (err) {
    alert('Could not load video: ' + err.message);
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (url) loadPreview(url);
  }
});
