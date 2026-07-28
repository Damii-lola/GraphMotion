require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ----- CORS: allow your GitHub Pages domain -----
app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true,
}));
app.use(express.json());

// Supabase client (service role)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ----- Ping test -----
app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => res.send('Backend is running! 🚀'));

// ----- Main endpoint: get YouTube video info via oEmbed -----
app.post('/get-video-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Validate YouTube URL (simple)
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    // Fetch metadata from YouTube oEmbed (public, no auth)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) throw new Error('Video not found or unavailable');
    const data = await response.json();

    // (Optional) Save to Supabase for history
    try {
      await supabase
        .from('video_views') // optional table
        .insert([{
          video_id: videoId,
          title: data.title,
          author: data.author_name,
          viewed_at: new Date().toISOString(),
        }]);
    } catch (dbErr) {
      console.warn('DB insert skipped:', dbErr.message);
    }

    // Return metadata + embed URL
    res.json({
      success: true,
      videoId: videoId,
      title: data.title,
      author: data.author_name,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      thumbnail: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    });

  } catch (err) {
    console.error('oEmbed error:', err);
    res.status(500).json({ error: 'Failed to fetch video info: ' + err.message });
  }
});

// Helper to extract video ID
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
