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

// CORS
app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500'],
  credentials: true,
}));
app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Ensure bucket exists ----------
async function ensureBucket() {
  const bucketName = 'temp_videos';
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) throw error;
    const exists = buckets.some(b => b.name === bucketName);
    if (!exists) {
      console.log(`[Startup] Creating bucket "${bucketName}"...`);
      await supabase.storage.createBucket(bucketName, { public: false });
      console.log(`[Startup] Bucket created.`);
    } else {
      console.log(`[Startup] Bucket "${bucketName}" exists.`);
    }
  } catch (err) {
    console.error('[Startup] Bucket error:', err.message);
  }
}
ensureBucket();

// ---------- Helpers ----------
function isTikTokUrl(url) {
  return url.includes('tiktok.com');
}

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

// ---------- /get-video-info (preview) ----------
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

// ---------- /download-video ----------
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

    // Insert metadata – skip if table missing
    try {
      await supabase.from('video_downloads').insert([{
        video_id: Date.now().toString(),
        title: info.title,
        file_path: filePath,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }]);
    } catch (dbErr) {
      console.warn('[DB] Insert skipped:', dbErr.message);
    }

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

// ---------- /generate-script (Mistral AI) ----------
app.post('/generate-script', async (req, res) => {
  const { title, author } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  try {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [
          {
            role: 'system',
            content: `You are an animation director. Given a video title, generate a JSON script for Motion Canvas.
Return a JSON array of scenes. Each scene has: shape (circle, rect, triangle), color (CSS color), x (0-800), y (0-600), duration (seconds). Make it simple (max 5 scenes). Only return valid JSON, no other text.`
          },
          {
            role: 'user',
            content: `Video title: "${title}" by ${author || 'Unknown'}. Generate animation script.`
          }
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Mistral API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const scriptText = data.choices[0].message.content;

    // Parse JSON (handles Markdown code blocks)
    let script;
    try {
      script = JSON.parse(scriptText);
    } catch (e) {
      const match = scriptText.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) script = JSON.parse(match[1]);
      else throw new Error('Failed to parse Mistral response as JSON');
    }

    res.json({ success: true, script });
  } catch (err) {
    console.error('[generate-script] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup (cron) ----------
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
    console.log(`[Cleanup] Removed ${expired.length} expired files.`);
  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}
cron.schedule('0 * * * *', cleanupExpiredVideos);

// ---------- Ping ----------
app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
