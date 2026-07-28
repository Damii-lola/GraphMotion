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
  const lines = fileContent.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#'); // skip comments
  });

  const cookies = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    // parts: domain, flag, path, secure, expiration, name, value
    const name = parts[5];
    const value = parts[6];
    if (name && value) {
      cookies.push(`${name}=${value}`);
    }
  }
  return cookies.join('; ');
}

// ---------- Validate that we have essential cookies ----------
function hasEssentialCookies(cookieString) {
  const required = ['__Secure-3PSID', 'LOGIN_INFO', '__Secure-1PSID'];
  const present = required.filter(r => cookieString.includes(r + '='));
  const missing = required.filter(r => !cookieString.includes(r + '='));
  if (missing.length > 0) {
    console.warn('[Cookie] Missing essential cookies:', missing.join(', '));
    return false;
  }
  return true;
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

// ---------- Test FFmpeg ----------
app.get('/test-ffmpeg', (req, res) => {
  ffmpeg.ffprobe(ffmpegPath, (err, info) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ version: info.version, path: ffmpegPath });
  });
});

// ---------- /get-video-info ----------
app.post('/get-video-info', async (req, res) => {
  console.log('[get-video-info] Request:', req.body);
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
    } catch (dbErr) {
      console.warn('[DB] Insert skipped:', dbErr.message);
    }

    res.json({
      success: true,
      videoId,
      title: data.title,
      author: data.author_name,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      thumbnail: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    });
  } catch (err) {
    console.error('[get-video-info] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- /create-summary ----------
app.post('/create-summary', async (req, res) => {
  console.log('[create-summary] Request:', req.body);
  const { url, frameInterval = 5 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  // Build headers with a real browser UA
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  };

  // ----- Handle cookies -----
  let cookieString = null;
  let usingCookies = false;
  if (process.env.YOUTUBE_COOKIE_FILE) {
    try {
      cookieString = parseNetscapeCookieFile(process.env.YOUTUBE_COOKIE_FILE);
      if (cookieString && cookieString.length > 0) {
        // Validate essential cookies
        if (hasEssentialCookies(cookieString)) {
          headers.Cookie = cookieString;
          usingCookies = true;
          console.log('[create-summary] Using cookies (all essential tokens present)');
        } else {
          console.warn('[create-summary] Essential cookies missing – will try without cookies.');
        }
      } else {
        console.warn('[create-summary] Parsed cookie string is empty – will try without cookies.');
      }
    } catch (e) {
      console.warn('[create-summary] Failed to parse cookie file:', e.message);
    }
  } else if (process.env.YOUTUBE_COOKIE) {
    cookieString = process.env.YOUTUBE_COOKIE;
    if (cookieString && cookieString.length > 0) {
      if (hasEssentialCookies(cookieString)) {
        headers.Cookie = cookieString;
        usingCookies = true;
        console.log('[create-summary] Using YOUTUBE_COOKIE env var');
      } else {
        console.warn('[create-summary] Essential cookies missing in YOUTUBE_COOKIE – will try without.');
      }
    }
  }

  if (!usingCookies) {
    console.warn('[create-summary] No valid cookies provided – downloads may fail with 410.');
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

    // Extract frames...
    const framesDir = path.join(workDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    console.log('[create-summary] Extracting frames...');
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
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)[0], 10);
        const numB = parseInt(b.match(/\d+/)[0], 10);
        return numA - numB;
      });

    if (frameFiles.length === 0) throw new Error('No frames extracted');
    console.log(`[create-summary] Found ${frameFiles.length} frames.`);

    const listFile = path.join(workDir, 'list.txt');
    const listContent = frameFiles.map(f => `file '${path.join(framesDir, f)}'\nduration 1`).join('\n');
    fs.writeFileSync(listFile, listContent);

    const outputVideo = path.join(workDir, 'summary.mp4');
    console.log('[create-summary] Generating summary video...');
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

    // Upload to Supabase...
    const fileBuffer = fs.readFileSync(outputVideo);
    const fileName = `summary_${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    console.log('[create-summary] Uploading to Supabase...');
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
    } catch (dbErr) {
      console.warn('[DB] Insert skipped:', dbErr.message);
    }

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

    // Specific error messages
    if (err.message && err.message.includes('Cookie header')) {
      return res.status(500).json({
        error: 'The provided cookies are incomplete or expired. Please re‑export your YouTube cookies (Netscape format) and set YOUTUBE_COOKIE_FILE on Render. Make sure you are logged into YouTube and the cookies contain __Secure-3PSID and LOGIN_INFO.',
      });
    }
    if (err.statusCode === 410 || err.message.includes('410')) {
      return res.status(500).json({
        error: 'YouTube returned 410. This video may be region‑locked or requires login. Try setting YOUTUBE_COOKIE_FILE with fresh cookies.',
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup ----------
async function cleanupExpiredVideos() {
  console.log('[Cleanup] Starting...');
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
  } catch (err) { console.error('[Cleanup] Error:', err); }
}
cron.schedule('0 * * * *', cleanupExpiredVideos);

app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
