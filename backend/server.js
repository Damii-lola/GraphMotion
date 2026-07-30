require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.timeout = 600000; // 10 minutes

app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500'],
  credentials: true,
}));
app.use(express.json({ limit: '1gb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Ensure bucket ----------
async function ensureBucket() {
  const bucketName = 'temp_videos';
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) throw error;
    const exists = buckets.some(b => b.name === bucketName);
    if (!exists) {
      await supabase.storage.createBucket(bucketName, { public: false });
      console.log('[Startup] Created bucket:', bucketName);
    } else {
      console.log('[Startup] Bucket exists:', bucketName);
    }
  } catch (err) {
    console.error('[Startup] Bucket error:', err.message);
  }
}
ensureBucket();

// ---------- (Optional) Keep the old endpoints for compatibility ----------
// We'll use the frontend direct‑to‑Supabase upload, so these are just for reference.
// But we keep them for the /confirm-upload if needed.
app.post('/get-upload-url', async (req, res) => {
  // Not used anymore – but kept for fallback
  res.status(501).json({ error: 'Use direct upload with Supabase client.' });
});

app.post('/confirm-upload', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' });
  try {
    const { data, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;
    res.json({ success: true, signedUrl: data.signedUrl });
  } catch (err) {
    console.error('[confirm-upload] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Helper: get video duration ----------
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data.format.duration);
    });
  });
}

// ---------- Main processing (optimised) ----------
app.post('/process-video', async (req, res) => {
  const { signedUrl, fileName } = req.body;
  if (!signedUrl || !fileName) {
    return res.status(400).json({ error: 'Missing video info' });
  }

  const workDir = path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const videoPath = path.join(workDir, 'input.mp4');

  try {
    // 1. Download video via signed URL
    console.log('[process] Downloading video...');
    const writer = fs.createWriteStream(videoPath);
    const response = await axios({
      method: 'get',
      url: signedUrl,
      responseType: 'stream',
    });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const duration = await getVideoDuration(videoPath);
    console.log(`[process] Duration: ${duration}s`);

    // ---- Short video shortcut ----
    if (duration < 8) {
      const clipName = `clip_${uuidv4()}.mp4`;
      const clipPath = path.join(workDir, clipName);
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      const clipBuffer = fs.readFileSync(clipPath);
      const clipFilePath = `temp_videos/clips/${clipName}`;
      await supabase.storage.from('temp_videos').upload(clipFilePath, clipBuffer, { contentType: 'video/mp4' });
      const { data: signedClip } = await supabase.storage.from('temp_videos').createSignedUrl(clipFilePath, 3600);
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({
        success: true,
        found: true,
        clips: [{ start: 0, end: duration, signedUrl: signedClip.signedUrl }]
      });
    }

    // 2. Extract audio (8kHz mono)
    const audioPath = path.join(workDir, 'audio.wav');
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .output(audioPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(8000)
        .audioChannels(1)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const audioData = fs.readFileSync(audioPath);
    const sampleRate = 8000;
    const bytesPerSample = 2;
    const samplesPerSecond = sampleRate;
    const totalSeconds = Math.floor(audioData.length / (bytesPerSample * samplesPerSecond));
    const rmsPerSecond = [];
    for (let i = 0; i < totalSeconds; i++) {
      const start = i * samplesPerSecond * bytesPerSample;
      const end = start + samplesPerSecond * bytesPerSample;
      const chunk = audioData.slice(start, end);
      let sum = 0;
      for (let j = 0; j < chunk.length; j += 2) {
        const sample = chunk.readInt16LE(j);
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / (chunk.length / 2));
      rmsPerSecond.push(rms);
    }

    // 3. Scene detection (scaled down to 320px width)
    const sceneFile = path.join(workDir, 'scenes.txt');
    const ffmpegCmd = `"${ffmpegPath}" -i "${videoPath}" -vf "scale=320:-1,select=gt(scene\\\\,0.35),metadata=print:file=${sceneFile}" -vsync vfr -f null -`;
    console.log('[process] Detecting scene changes...');
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (fs.existsSync(sceneFile)) resolve();
        else if (error) reject(error);
        else resolve();
      });
    });

    const sceneTimes = [];
    if (fs.existsSync(sceneFile)) {
      const data = fs.readFileSync(sceneFile, 'utf8');
      const lines = data.split('\n').filter(l => l.includes('pts_time:'));
      for (const line of lines) {
        const match = line.match(/pts_time:([\d.]+)/);
        if (match) {
          const t = parseFloat(match[1]);
          if (t < duration) sceneTimes.push(t);
        }
      }
    }
    console.log(`[process] Found ${sceneTimes.length} scene changes.`);

    // 4. Combine audio energy + scene changes
    const mean = rmsPerSecond.reduce((a, b) => a + b, 0) / rmsPerSecond.length;
    const std = Math.sqrt(rmsPerSecond.reduce((a, b) => a + (b - mean) ** 2, 0) / rmsPerSecond.length);
    const audioThreshold = mean + 1.2 * std;

    const interestingSeconds = new Set();
    for (let i = 0; i < rmsPerSecond.length; i++) {
      if (rmsPerSecond[i] > audioThreshold) interestingSeconds.add(i);
    }
    for (const sceneTime of sceneTimes) {
      const sec = Math.floor(sceneTime);
      for (let i = Math.max(0, sec - 2); i < Math.min(rmsPerSecond.length, sec + 4); i++) {
        interestingSeconds.add(i);
      }
    }

    if (interestingSeconds.size === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({ success: true, found: false, message: 'No interesting moments detected.' });
    }

    // 5. Cluster interesting seconds into segments
    const sorted = Array.from(interestingSeconds).sort((a, b) => a - b);
    const segments = [];
    let clusterStart = sorted[0];
    let clusterEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i-1] <= 3) {
        clusterEnd = sorted[i];
      } else {
        segments.push({ start: clusterStart, end: Math.min(clusterEnd + 1, duration) });
        clusterStart = sorted[i];
        clusterEnd = sorted[i];
      }
    }
    if (clusterStart !== undefined) {
      segments.push({ start: clusterStart, end: Math.min(clusterEnd + 1, duration) });
    }

    const finalSegments = segments.filter(s => s.end - s.start >= 1.5);
    if (finalSegments.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({ success: true, found: false, message: 'Segments too short.' });
    }

    // 6. Crop each segment (max 10)
    const clips = [];
    for (let i = 0; i < Math.min(finalSegments.length, 10); i++) {
      const seg = finalSegments[i];
      const clipName = `clip_${i}_${uuidv4()}.mp4`;
      const clipPath = path.join(workDir, clipName);
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .setStartTime(seg.start)
          .setDuration(seg.end - seg.start)
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      const clipBuffer = fs.readFileSync(clipPath);
      const clipFilePath = `temp_videos/clips/${clipName}`;
      await supabase.storage.from('temp_videos').upload(clipFilePath, clipBuffer, { contentType: 'video/mp4' });
      const { data: signedClip, error: signedErr } = await supabase.storage.from('temp_videos').createSignedUrl(clipFilePath, 3600);
      if (signedErr) throw signedErr;
      clips.push({ start: seg.start, end: seg.end, signedUrl: signedClip.signedUrl });
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    res.json({ success: true, found: true, clips });

  } catch (err) {
    console.error('[process] Error:', err);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup ----------
async function cleanupExpiredVideos() {
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const expiry = now.toISOString();
    const { data: toDelete, error } = await supabase
      .from('video_uploads')
      .select('id, file_path')
      .or(`expires_at.lt.${expiry},and(upload_status.eq.pending,created_at.lt.${cutoff})`);
    if (error) throw error;
    if (!toDelete || toDelete.length === 0) return;
    const filePaths = toDelete.map(r => r.file_path);
    await supabase.storage.from('temp_videos').remove(filePaths);
    const ids = toDelete.map(r => r.id);
    await supabase.from('video_uploads').delete().in('id', ids);
    console.log(`[Cleanup] Removed ${toDelete.length} expired/failed files.`);
  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}
cron.schedule('*/5 * * * *', cleanupExpiredVideos);

app.get('/ping', (req, res) => res.send('pong'));
