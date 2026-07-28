require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500'],
  credentials: true,
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Ensure bucket exists ----------
async function ensureBucket() {
  const bucketName = 'temp_videos';
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error('[Startup] Failed to list buckets:', error.message);
    return;
  }
  const exists = buckets.some(b => b.name === bucketName);
  if (!exists) {
    console.log(`[Startup] Creating bucket "${bucketName}"...`);
    await supabase.storage.createBucket(bucketName, { public: false });
  } else {
    console.log(`[Startup] Bucket "${bucketName}" exists.`);
  }
}
ensureBucket();

// ---------- Helpers ----------
function isTikTokUrl(url) {
  return url.includes('tiktok.com');
}

// ---------- Get TikTok video info (raw download URL) ----------
async function getTikTokVideoInfo(url) {
  const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`TikTok API error ${response.status}`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.msg || 'TikTok API error');
  const videoUrl = data.data.hdplay || data.data.play || data.data.wmplay;
  if (!videoUrl) throw new Error('No video URL found');
  return {
    videoUrl,
    title: data.data.title || 'TikTok Video',
    author: data.data.author?.unique_id || 'Unknown',
  };
}

// ---------- Endpoint: preview (embed) ----------
app.post('/get-video-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!isTikTokUrl(url)) {
    return res.status(400).json({ error: 'Only TikTok URLs are supported' });
  }
  try {
    const info = await getTikTokVideoInfo(url);
    res.json({
      success: true,
      videoUrl: info.videoUrl,
      title: info.title,
      author: info.author,
    });
  } catch (err) {
    console.error('[get-video-info] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Download full video and upload to Supabase ----------
app.post('/download-video', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!isTikTokUrl(url)) {
    return res.status(400).json({ error: 'Only TikTok URLs are supported' });
  }

  const tempDir = path.join('/tmp', uuidv4());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const info = await getTikTokVideoInfo(url);
    console.log('[download-video] Downloading from:', info.videoUrl);

    const videoFilePath = path.join(tempDir, 'video.mp4');
    const response = await fetch(info.videoUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(videoFilePath, buffer);
    console.log('[download-video] Download complete.');

    const fileName = `video_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, buffer, { contentType: 'video/mp4', cacheControl: '3600' });
    if (uploadError) throw uploadError;

    const { data: signedData, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    await supabase.from('video_downloads').insert([{
      video_id: Date.now().toString(),
      title: info.title,
      file_path: filePath,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }]).catch(() => {});

    fs.rmSync(tempDir, { recursive: true, force: true });

    res.json({
      success: true,
      signedUrl: signedData.signedUrl,
      title: info.title,
      author: info.author,
    });

  } catch (err) {
    console.error('[download-video] ERROR:', err);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup ----------
async function cleanupExpiredVideos() {
  try {
    const { data: expired, error } = await supabase
      .from('video_downloads')
      .select('id, file_path')
      .lt('expires_at', new Date().toISOString());
    if (error) throw error;
    if (!expired || expired.length === 0) return;
    const filePaths = expired.map(r => r.file_path);
    await supabase.storage.from('temp_videos').remove(filePaths);
    const ids = expired.map(r => r.id);
    await supabase.from('video_downloads').delete().in('id', ids);
  } catch (err) { console.error('[Cleanup]', err); }
}
cron.schedule('0 * * * *', cleanupExpiredVideos);

app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
