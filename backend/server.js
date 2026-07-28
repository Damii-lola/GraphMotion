require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[FFmpeg] Path set to:', ffmpegPath);

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

// ---------- Helpers ----------
function extractTikTokId(url) {
  // Simple: just check if it's a valid TikTok URL
  if (url.includes('tiktok.com')) return true; // we'll fetch via API
  return false;
}

// ---------- Get TikTok video info ----------
async function getTikTokVideoInfo(url) {
  // Use tikwm.com API (free, no auth)
  const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error('Failed to fetch TikTok video');
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.msg || 'TikTok API error');
  // Extract download URL (HD or no watermark)
  const videoUrl = data.data.play || data.data.wmplay || data.data.hdplay;
  if (!videoUrl) throw new Error('No video URL found');
  return {
    videoUrl,
    title: data.data.title || 'TikTok Video',
    author: data.data.author?.unique_id || 'Unknown',
  };
}

// ---------- Endpoint: get video info (for preview) ----------
app.post('/get-video-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  // If it's TikTok, return a preview info (we can embed the video)
  if (url.includes('tiktok.com')) {
    try {
      const info = await getTikTokVideoInfo(url);
      // For TikTok we return a direct video URL (the download link) – we'll embed a video element
      res.json({
        success: true,
        isTikTok: true,
        videoUrl: info.videoUrl,
        title: info.title,
        author: info.author,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // (Optional: handle YouTube if you still want)
  res.status(400).json({ error: 'Only TikTok URLs are supported now' });
});

// ---------- /create-summary (now works for TikTok) ----------
app.post('/create-summary', async (req, res) => {
  const { url, frameInterval = 5 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  if (!url.includes('tiktok.com')) {
    return res.status(400).json({ error: 'Only TikTok URLs are supported' });
  }

  const workDir = path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Get video download URL
    const info = await getTikTokVideoInfo(url);
    const videoUrl = info.videoUrl;
    console.log('[create-summary] Downloading from:', videoUrl);

    // 2. Download the video
    const videoFilePath = path.join(workDir, 'input.mp4');
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error('Failed to download video');
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(videoFilePath, buffer);
    console.log('[create-summary] Download complete.');

    // 3. Extract frames
    const framesDir = path.join(workDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    await new Promise((resolve, reject) => {
      ffmpeg(videoFilePath)
        .on('end', resolve)
        .on('error', reject)
        .outputOptions([`-vf fps=1/${frameInterval}`, '-frame_pts 1', '-start_number 0'])
        .output(path.join(framesDir, 'frame-%d.jpg'))
        .run();
    });
    console.log('[create-summary] Frames extracted.');

    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    if (frameFiles.length === 0) throw new Error('No frames extracted');

    // 4. Create summary video
    const listFile = path.join(workDir, 'list.txt');
    const listContent = frameFiles.map(f => `file '${path.join(framesDir, f)}'\nduration 1`).join('\n');
    fs.writeFileSync(listFile, listContent);

    const outputVideo = path.join(workDir, 'summary.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c:v libx264', '-pix_fmt yuv420p'])
        .on('end', resolve)
        .on('error', reject)
        .output(outputVideo)
        .run();
    });
    console.log('[create-summary] Summary video generated.');

    // 5. Upload to Supabase
    const fileBuffer = fs.readFileSync(outputVideo);
    const fileName = `summary_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, fileBuffer, { contentType: 'video/mp4', cacheControl: '3600' });
    if (uploadError) throw uploadError;

    const { data: signedData, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    // 6. Clean up
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('[create-summary] Success!');

    res.json({
      success: true,
      signedUrl: signedData.signedUrl,
      frameCount: frameFiles.length,
      message: `Summary created with ${frameFiles.length} frames.`,
    });

  } catch (err) {
    console.error('[create-summary] ERROR:', err);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
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
