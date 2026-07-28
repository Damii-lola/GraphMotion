require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ytdl = require('ytdl-core');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ----- CORS: allow your GitHub Pages domain -----
app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors()); // handle preflight

app.use(express.json());

// Supabase client (service role)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ----- Cookie parser (Netscape format) -----
function parseNetscapeCookieFile(fileContent) {
  const lines = fileContent.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#');
  });
  const cookies = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts[6];
    if (name && value) cookies.push(`${name}=${value}`);
  }
  return cookies.join('; ');
}

// ----- Cleanup (unchanged) -----
async function cleanupExpiredVideos() {
  console.log('[Cleanup] Starting...');
  try {
    const { data: expired, error } = await supabase
      .from('video_downloads')
      .select('id, file_path')
      .lt('expires_at', new Date().toISOString());
    if (error) throw error;
    if (!expired || expired.length === 0) {
      console.log('[Cleanup] No expired videos.');
      return;
    }
    const filePaths = expired.map(r => r.file_path);
    const { error: storageErr } = await supabase.storage
      .from('temp_videos')
      .remove(filePaths);
    if (storageErr) console.error('[Cleanup] Storage delete error:', storageErr.message);
    const ids = expired.map(r => r.id);
    const { error: delErr } = await supabase
      .from('video_downloads')
      .delete()
      .in('id', ids);
    if (delErr) console.error('[Cleanup] DB delete error:', delErr.message);
    console.log(`[Cleanup] Removed ${expired.length} records.`);
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }
}

cron.schedule('0 * * * *', cleanupExpiredVideos);
console.log('[Cron] Cleanup scheduled every hour.');

app.get('/cleanup', async (req, res) => {
  await cleanupExpiredVideos();
  res.json({ success: true });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// ----- MAIN DOWNLOAD ENDPOINT (streaming) -----
app.post('/download-youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

  // Build headers
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  // Parse cookie if provided
  let cookieString = null;
  if (process.env.YOUTUBE_COOKIE_FILE) {
    try {
      cookieString = parseNetscapeCookieFile(process.env.YOUTUBE_COOKIE_FILE);
      if (cookieString) headers.Cookie = cookieString;
    } catch (e) { console.error('Cookie parse error:', e.message); }
  } else if (process.env.YOUTUBE_COOKIE) {
    headers.Cookie = process.env.YOUTUBE_COOKIE;
  }

  try {
    // 1. Get info (to get title, etc.)
    let info;
    try {
      info = await ytdl.getInfo(url, { requestOptions: { headers } });
    } catch (err) {
      // fallback without custom headers
      info = await ytdl.getInfo(url);
    }

    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 ]/g, '_');
    const videoId = info.videoDetails.videoId;

    // 2. Create a stream – we use 'lowest' for speed and reliability
    const stream = ytdl(url, {
      quality: 'lowest', // 360p mp4 – fast and small
      requestOptions: { headers },
    });

    // 3. Generate a unique filename
    const fileName = `${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    // 4. Upload to Supabase using the Storage REST API (streaming)
    const supabaseUploadUrl = `${process.env.SUPABASE_URL}/storage/v1/object/temp_videos/${fileName}`;
    const uploadResponse = await fetch(supabaseUploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'video/mp4',
      },
      body: stream, // pipe the YouTube stream directly
      duplex: 'half', // required for stream in fetch
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      throw new Error(`Supabase upload failed: ${uploadResponse.status} - ${errText}`);
    }

    // 5. Generate signed URL (expires in 1 hour)
    const { data: signedData, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    // 6. Insert DB record
    const { error: dbErr } = await supabase
      .from('video_downloads')
      .insert([{
        video_id: videoId,
        title: title,
        file_path: filePath,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }]);
    if (dbErr) console.warn('DB insert error:', dbErr.message);

    // 7. Respond
    res.json({
      success: true,
      signedUrl: signedData.signedUrl,
      title: info.videoDetails.title,
      author: info.videoDetails.author.name,
    });

  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed: ' + err.message });
  }
});

// Optional delete endpoint (unchanged)
app.delete('/delete-video', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const { error } = await supabase.storage.from('temp_videos').remove([filePath]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
