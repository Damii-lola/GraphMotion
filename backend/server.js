require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

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

// ---------- Get signed upload URL ----------
app.post('/get-upload-url', async (req, res) => {
  try {
    const { originalName } = req.body;
    if (!originalName) return res.status(400).json({ error: 'Missing originalName' });

    const ext = originalName.includes('.') ? originalName.split('.').pop() : 'mp4';
    const fileName = `${uuidv4()}.${ext}`;
    const filePath = `temp_videos/${fileName}`;

    const { data, error } = await supabase.storage
      .from('temp_videos')
      .createSignedUploadUrl(filePath);
    if (error) throw error;

    await supabase.from('video_uploads').insert([{
      file_name: fileName,
      original_name: originalName,
      file_path: filePath,
      upload_status: 'pending',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }]);

    res.json({ success: true, signedUrl: data.signedUrl, filePath, fileName: originalName });
  } catch (err) {
    console.error('[get-upload-url] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Confirm upload ----------
app.post('/confirm-upload', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' });

  try {
    await supabase.from('video_uploads').update({ upload_status: 'completed' }).eq('file_path', filePath);
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

// ---------- Main processing (no transcription) ----------
app.post('/process-video', async (req, res) => {
  const { signedUrl, fileName } = req.body;
  if (!signedUrl || !fileName) {
    return res.status(400).json({ error: 'Missing video info' });
  }

  const workDir = path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const videoPath = path.join(workDir, 'input.mp4');

  try {
    // 1. Download video
    console.log('[process] Downloading video...');
    const videoRes = await axios.get(signedUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(videoPath, videoRes.data);

    // 2. Get video duration
    const duration = await getVideoDuration(videoPath);

    // 3. Extract audio and compute RMS (volume) per second
    const audioPath = path.join(workDir, 'audio.wav');
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .output(audioPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const audioData = fs.readFileSync(audioPath);
    const sampleRate = 16000;
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

    // 4. Detect scene changes using ffmpeg (via stderr capture)
    const sceneTimes = [];
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .videoFilters('select=gt(scene\\,0.4)')
        .outputOptions(['-vsync vfr'])
        .output('/dev/null')  // output to null (Linux)
        .on('stderr', (line) => {
          // Parse scene change lines like: [Parsed_metadata_1 @ ...] pts_time:12.345
          if (line.includes('pts_time:')) {
            const match = line.match(/pts_time:([\d.]+)/);
            if (match) {
              const t = parseFloat(match[1]);
              if (t < duration) sceneTimes.push(t);
            }
          }
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[process] Detected ${sceneTimes.length} scene changes`);

    // 5. Find interesting segments based on audio energy + scene changes
    const mean = rmsPerSecond.reduce((a, b) => a + b, 0) / rmsPerSecond.length;
    const std = Math.sqrt(rmsPerSecond.reduce((a, b) => a + (b - mean) ** 2, 0) / rmsPerSecond.length);
    const threshold = mean + 1.5 * std;

    const interestingSeconds = [];
    for (let i = 0; i < rmsPerSecond.length; i++) {
      if (rmsPerSecond[i] > threshold) {
        interestingSeconds.push(i);
      }
    }

    let segments = [];
    // Cluster interesting seconds
    let clusterStart = null;
    for (let i = 0; i < interestingSeconds.length; i++) {
      const sec = interestingSeconds[i];
      if (clusterStart === null) {
        clusterStart = sec;
      } else if (sec - interestingSeconds[i-1] > 5) {
        const end = interestingSeconds[i-1] + 1;
        segments.push({ start: clusterStart, end: Math.min(end, duration) });
        clusterStart = sec;
      }
    }
    if (clusterStart !== null) {
      const end = interestingSeconds[interestingSeconds.length-1] + 1;
      segments.push({ start: clusterStart, end: Math.min(end, duration) });
    }

    // Add segments around scene changes if they have some energy
    for (const sceneTime of sceneTimes) {
      const sec = Math.floor(sceneTime);
      const window = 2;
      let hasEnergy = false;
      for (let i = Math.max(0, sec - window); i < Math.min(rmsPerSecond.length, sec + window); i++) {
        if (rmsPerSecond[i] > mean + 0.8 * std) {
          hasEnergy = true;
          break;
        }
      }
      if (hasEnergy) {
        const start = Math.max(0, sec - 1);
        const end = Math.min(duration, sec + 3);
        segments.push({ start, end });
      }
    }

    if (segments.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({ success: true, found: false, message: 'No interesting moments detected.' });
    }

    // Merge overlapping segments
    segments.sort((a, b) => a.start - b.start);
    const merged = [];
    let current = segments[0];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].start <= current.end + 1) {
        current.end = Math.max(current.end, segments[i].end);
      } else {
        merged.push(current);
        current = segments[i];
      }
    }
    merged.push(current);

    // Filter segments that are too short
    const finalSegments = merged.filter(s => s.end - s.start >= 1.5);
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
      const { error: uploadErr } = await supabase.storage
        .from('temp_videos')
        .upload(clipFilePath, clipBuffer, { contentType: 'video/mp4' });
      if (uploadErr) throw uploadErr;
      const { data: signedClip, error: signedErr } = await supabase.storage
        .from('temp_videos')
        .createSignedUrl(clipFilePath, 3600);
      if (signedErr) throw signedErr;
      clips.push({
        start: seg.start,
        end: seg.end,
        signedUrl: signedClip.signedUrl,
      });
    }

    fs.rmSync(workDir, { recursive: true, force: true });

    res.json({
      success: true,
      found: true,
      clips: clips,
    });

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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
