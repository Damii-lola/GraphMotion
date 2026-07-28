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

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[FFmpeg] Path set to:', ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS – allow your frontend
app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500'],
  credentials: true,
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------- Helper: extract video ID -------
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

// ------- TEST endpoint: check ffmpeg -------
app.get('/test-ffmpeg', (req, res) => {
  ffmpeg.ffprobe(ffmpegPath, (err, info) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ version: info.version, path: ffmpegPath });
  });
});

// ------- Endpoint: get embed info (unchanged) -------
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
    // optional DB insert
    await supabase.from('video_views').insert([{
      video_id: videoId,
      title: data.title,
      author: data.author_name,
      viewed_at: new Date().toISOString(),
    }]).catch(() => {});
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

// ------- ENDPOINT: create summary -------
app.post('/create-summary', async (req, res) => {
  console.log('[create-summary] Request:', req.body);
  const { url, frameInterval = 5 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const workDir = path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });

  try {
    console.log('[create-summary] Downloading video...');
    // 1. Download the video (use a specific format to avoid issues)
    const videoStream = ytdl(url, { quality: '18' }); // 360p mp4
    const videoFilePath = path.join(workDir, 'input.mp4');
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(videoFilePath);
      videoStream.pipe(writeStream);
      videoStream.on('error', reject);
      writeStream.on('finish', resolve);
    });
    console.log('[create-summary] Download complete.');

    // 2. Extract frames
    const framesDir = path.join(workDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    console.log('[create-summary] Extracting frames...');
    await new Promise((resolve, reject) => {
      ffmpeg(videoFilePath)
        .on('end', resolve)
        .on('error', (err) => {
          console.error('[FFmpeg] Frame extraction error:', err);
          reject(err);
        })
        .outputOptions([
          `-vf fps=1/${frameInterval}`,
          '-frame_pts 1',
          '-start_number 0',
        ])
        .output(path.join(framesDir, 'frame-%d.jpg'))
        .run();
    });
    console.log('[create-summary] Frames extracted.');

    // 3. Get list of frames
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)[0], 10);
        const numB = parseInt(b.match(/\d+/)[0], 10);
        return numA - numB;
      });

    if (frameFiles.length === 0) {
      throw new Error('No frames extracted');
    }
    console.log(`[create-summary] Found ${frameFiles.length} frames.`);

    // 4. Create video from frames
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
        .on('error', (err) => {
          console.error('[FFmpeg] Concatenation error:', err);
          reject(err);
        })
        .output(outputVideo)
        .run();
    });
    console.log('[create-summary] Summary video generated.');

    // 5. Upload to Supabase Storage
    const fileBuffer = fs.readFileSync(outputVideo);
    const fileName = `summary_${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    console.log('[create-summary] Uploading to Supabase...');
    const { error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, fileBuffer, {
        contentType: 'video/mp4',
        cacheControl: '3600',
      });
    if (uploadError) throw uploadError;

    // 6. Generate signed URL (1 hour)
    const { data: signedData, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    // 7. (Optional) store metadata in DB
    await supabase.from('video_summaries').insert([{
      video_id: videoId,
      original_url: url,
      summary_file_path: filePath,
      frame_interval: frameInterval,
      total_frames: frameFiles.length,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }]).catch(() => {});

    // 8. Clean up
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('[create-summary] Success!');

    res.json({
      success: true,
      signedUrl: signedData.signedUrl,
      frameCount: frameFiles.length,
      message: `Created summary with ${frameFiles.length} frames.`,
    });

  } catch (err) {
    console.error('[create-summary] ERROR:', err);
    // Clean up on error
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// ------- Cleanup (existing) -------
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
