require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ytdl = require('ytdl-core');
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

// ---------- Cookie parser (Netscape format) ----------
function parseNetscapeCookieFile(fileContent) {
  // Trim and split
  const lines = fileContent.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const cookies = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts[6];
    if (name && value) {
      cookies.push(`${name}=${value}`);
    }
  }
  return cookies.join('; ');
}

// ---------- Validate essential cookies ----------
function validateCookieString(cookieStr) {
  const required = ['__Secure-3PSID', 'LOGIN_INFO', '__Secure-1PSID'];
  const missing = required.filter(r => !cookieStr.includes(r + '='));
  if (missing.length > 0) {
    return { valid: false, missing };
  }
  return { valid: true };
}

// ---------- Helpers ----------
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

// ---------- Test endpoint ----------
app.get('/test-ffmpeg', (req, res) => {
  ffmpeg.ffprobe(ffmpegPath, (err, info) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ version: info.version, path: ffmpegPath });
  });
});

// ---------- /get-video-info ----------
app.post('/get-video-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) throw new Error('Video not found');
    const data = await response.json();

    try {
      await supabase.from('video_views').insert([{
        video_id: videoId,
        title: data.title,
        author: data.author_name,
        viewed_at: new Date().toISOString(),
      }]);
    } catch (dbErr) { /* ignore */ }

    res.json({
      success: true,
      videoId,
      title: data.title,
      author: data.author_name,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      thumbnail: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- /create-summary ----------
app.post('/create-summary', async (req, res) => {
  const { url, frameInterval = 5 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  // Build headers
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  let cookieString = null;
  if (process.env.YOUTUBE_COOKIE_FILE) {
    try {
      const raw = process.env.YOUTUBE_COOKIE_FILE;
      cookieString = parseNetscapeCookieFile(raw);
      console.log('[DEBUG] Parsed cookie length:', cookieString?.length);
      // Log first 200 chars for debugging
      console.log('[DEBUG] Cookie (first 200):', cookieString?.substring(0, 200));
      
      const validation = validateCookieString(cookieString);
      if (validation.valid) {
        headers.Cookie = cookieString;
        console.log('[create-summary] ✅ Valid cookies found – using them.');
      } else {
        console.warn('[create-summary] ❌ Missing cookies:', validation.missing.join(', '));
        // Still try, but likely to fail
        headers.Cookie = cookieString;
      }
    } catch (e) {
      console.warn('[create-summary] Cookie parsing error:', e.message);
    }
  } else if (process.env.YOUTUBE_COOKIE) {
    cookieString = process.env.YOUTUBE_COOKIE;
    const validation = validateCookieString(cookieString);
    if (validation.valid) {
      headers.Cookie = cookieString;
      console.log('[create-summary] ✅ Using direct YOUTUBE_COOKIE');
    } else {
      console.warn('[create-summary] ❌ YOUTUBE_COOKIE missing:', validation.missing.join(', '));
    }
  } else {
    console.warn('[create-summary] No cookies set.');
  }

  const requestOptions = { headers };

  const workDir = path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });

  try {
    console.log('[create-summary] Downloading video with quality 18...');
    const videoStream = ytdl(url, {
      quality: '18',
      requestOptions,
    });

    const videoFilePath = path.join(workDir, 'input.mp4');
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(videoFilePath);
      videoStream.pipe(writeStream);
      videoStream.on('error', reject);
      writeStream.on('finish', resolve);
    });
    console.log('[create-summary] Download complete.');

    // -- rest of processing (frames, etc.) – same as before --
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

    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    if (frameFiles.length === 0) throw new Error('No frames extracted');

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

    const fileBuffer = fs.readFileSync(outputVideo);
    const fileName = `summary_${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, fileBuffer, { contentType: 'video/mp4', cacheControl: '3600' });
    if (uploadError) throw uploadError;

    const { data: signedData, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    try {
      await supabase.from('video_summaries').insert([{
        video_id: videoId,
        original_url: url,
        summary_file_path: filePath,
        frame_interval: frameInterval,
        total_frames: frameFiles.length,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }]);
    } catch (dbErr) { /* ignore */ }

    fs.rmSync(workDir, { recursive: true, force: true });
    res.json({
      success: true,
      signedUrl: signedData.signedUrl,
      frameCount: frameFiles.length,
    });

  } catch (err) {
    console.error('[create-summary] ERROR:', err);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });

    // Provide actionable feedback
    let userMsg = err.message;
    if (err.message.includes('Cookie header') || err.message.includes('identity token')) {
      userMsg = 'The provided cookies are invalid or expired. Please re‑export fresh cookies from a logged‑in YouTube session and set YOUTUBE_COOKIE_FILE on Render. Make sure you are logged into YouTube in your browser before exporting.';
    } else if (err.statusCode === 410 || err.message.includes('410')) {
      userMsg = 'YouTube returned 410 (Gone). This video may be region‑locked or requires a login. Try a different public video or refresh your cookies.';
    }
    res.status(500).json({ error: userMsg });
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
