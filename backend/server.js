require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.timeout = 600000;

app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500'],
  credentials: true,
}));
app.use(express.json({ limit: '1gb' }));

// ---------- Supabase + S3 clients ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// S3 client pointing to Supabase (S3-compatible)
const s3 = new S3Client({
  region: 'us-east-1', // doesn't matter for Supabase
  endpoint: process.env.SUPABASE_S3_ENDPOINT, // e.g., https://<project>.supabase.co/storage/v1/s3
  credentials: {
    accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY,
    secretAccessKey: process.env.SUPABASE_S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

const BUCKET_NAME = 'temp_videos';

// ---------- Ensure bucket ----------
async function ensureBucket() {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) throw error;
    const exists = buckets.some(b => b.name === BUCKET_NAME);
    if (!exists) {
      await supabase.storage.createBucket(BUCKET_NAME, { public: false, fileSizeLimit: '5GB', allowedMimeTypes: ['video/*'] });
      console.log('[Startup] Created bucket:', BUCKET_NAME);
    } else {
      console.log('[Startup] Bucket exists:', BUCKET_NAME);
    }
  } catch (err) {
    console.error('[Startup] Bucket error:', err.message);
  }
}
ensureBucket();

// ---------- Multipart endpoints ----------

// Initiate multipart upload
app.post('/init-multipart', async (req, res) => {
  try {
    const { fileName, fileSize, contentType } = req.body;
    if (!fileName || !fileSize) return res.status(400).json({ error: 'Missing file info' });

    const ext = fileName.includes('.') ? fileName.split('.').pop() : 'mp4';
    const key = `temp_videos/${uuidv4()}.${ext}`;

    const command = new CreateMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'video/mp4',
    });

    const response = await s3.send(command);
    const uploadId = response.UploadId;

    // Store in DB
    const totalParts = Math.ceil(fileSize / (5 * 1024 * 1024)); // 5 MB
    await supabase.from('multipart_uploads').insert({
      id: uploadId,
      file_name: fileName,
      file_path: key,
      content_type: contentType,
      parts: totalParts,
      upload_id: uploadId,
    });

    res.json({
      success: true,
      uploadId,
      filePath: key,
      parts: totalParts,
    });
  } catch (err) {
    console.error('[init-multipart] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for a part
app.post('/get-part-url', async (req, res) => {
  try {
    const { uploadId, partNumber, filePath } = req.body;
    if (!uploadId || !partNumber || !filePath) return res.status(400).json({ error: 'Missing parameters' });

    const command = new UploadPartCommand({
      Bucket: BUCKET_NAME,
      Key: filePath,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ success: true, signedUrl: url });
  } catch (err) {
    console.error('[get-part-url] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Complete multipart upload
app.post('/complete-multipart', async (req, res) => {
  try {
    const { uploadId, filePath, parts, originalName } = req.body;
    if (!uploadId || !filePath || !parts) return res.status(400).json({ error: 'Missing data' });

    const command = new CompleteMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: filePath,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });

    await s3.send(command);

    // Update DB (move from multipart_uploads to video_uploads)
    const { data: mpu } = await supabase.from('multipart_uploads').select('file_name').eq('upload_id', uploadId).single();
    const fileName = mpu?.file_name || originalName;
    await supabase.from('video_uploads').insert({
      file_name: fileName,
      original_name: originalName,
      file_path: filePath,
      upload_status: 'completed',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    // Remove multipart record
    await supabase.from('multipart_uploads').delete().eq('upload_id', uploadId);

    // Generate a signed URL for playback
    const { data: signedUrlData, error: signedErr } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    res.json({ success: true, signedUrl: signedUrlData.signedUrl });
  } catch (err) {
    console.error('[complete-multipart] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Abort multipart upload
app.post('/abort-multipart', async (req, res) => {
  try {
    const { uploadId, filePath } = req.body;
    if (!uploadId || !filePath) return res.status(400).json({ error: 'Missing data' });

    const command = new AbortMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: filePath,
      UploadId: uploadId,
    });
    await s3.send(command);
    await supabase.from('multipart_uploads').delete().eq('upload_id', uploadId);
    res.json({ success: true });
  } catch (err) {
    console.error('[abort-multipart] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Video processing (optimised) ----------
app.post('/process-video', async (req, res) => {
  const { signedUrl, fileName } = req.body;
  if (!signedUrl || !fileName) {
    return res.status(400).json({ error: 'Missing video info' });
  }

  const workDir = fs.existsSync('/dev/shm') ? `/dev/shm/${uuidv4()}` : path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const videoPath = path.join(workDir, 'input.mp4');

  try {
    console.log('[process] Downloading...');
    const writer = fs.createWriteStream(videoPath);
    const response = await axios({ method: 'get', url: signedUrl, responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

    // Use ffprobe for duration
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, data) => {
        if (err) reject(err);
        else resolve(data.format.duration);
      });
    });
    console.log(`[process] Duration: ${duration}s`);

    // Extract audio at 4kHz mono (even faster)
    const audioPath = path.join(workDir, 'audio.wav');
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .output(audioPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(4000)
        .audioChannels(1)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const audioData = fs.readFileSync(audioPath);
    const sampleRate = 4000;
    const bytesPerSample = 2;
    const totalSeconds = Math.floor(audioData.length / (bytesPerSample * sampleRate));
    const rmsPerSecond = [];
    for (let i = 0; i < totalSeconds; i++) {
      const start = i * sampleRate * bytesPerSample;
      const end = start + sampleRate * bytesPerSample;
      const chunk = audioData.slice(start, end);
      let sum = 0;
      for (let j = 0; j < chunk.length; j += 2) {
        const sample = chunk.readInt16LE(j);
        sum += sample * sample;
      }
      rmsPerSecond.push(Math.sqrt(sum / (chunk.length / 2)));
    }

    // Scene detection (super fast, scale to 160px)
    const sceneFile = path.join(workDir, 'scenes.txt');
    const cmd = `"${ffmpegPath}" -threads 0 -i "${videoPath}" -vf "scale=160:-2,select=gt(scene\\,0.35),metadata=print:file=${sceneFile}" -vsync vfr -f null -`;
    console.log('[process] Detecting scenes...');
    try {
      await execAsync(cmd, { timeout: 120000 });
    } catch (e) {
      // Ignore errors, scene file may still exist
    }

    const sceneTimes = [];
    if (fs.existsSync(sceneFile)) {
      const data = fs.readFileSync(sceneFile, 'utf8');
      const lines = data.split('\n').filter(l => l.includes('pts_time:'));
      for (const line of lines) {
        const m = line.match(/pts_time:([\d.]+)/);
        if (m) {
          const t = parseFloat(m[1]);
          if (t < duration) sceneTimes.push(t);
        }
      }
    }
    console.log(`[process] Found ${sceneTimes.length} scene changes.`);

    // Combine audio energy + scene changes
    const mean = rmsPerSecond.reduce((a,b)=>a+b,0)/rmsPerSecond.length;
    const std = Math.sqrt(rmsPerSecond.reduce((a,b)=>a+(b-mean)**2,0)/rmsPerSecond.length);
    const audioThreshold = mean + 1.2 * std;
    const interestingSeconds = new Set();

    for (let i=0; i<rmsPerSecond.length; i++) {
      if (rmsPerSecond[i] > audioThreshold) interestingSeconds.add(i);
    }
    for (const sceneTime of sceneTimes) {
      const sec = Math.floor(sceneTime);
      for (let i=Math.max(0,sec-2); i<Math.min(rmsPerSecond.length,sec+4); i++) interestingSeconds.add(i);
    }

    if (interestingSeconds.size === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({ success: true, found: false });
    }

    // Cluster seconds into segments
    const sorted = Array.from(interestingSeconds).sort((a,b)=>a-b);
    const segments = [];
    let cStart = sorted[0], cEnd = sorted[0];
    for (let i=1; i<sorted.length; i++) {
      if (sorted[i] - sorted[i-1] <= 3) cEnd = sorted[i];
      else {
        segments.push({ start: cStart, end: Math.min(cEnd+1, duration) });
        cStart = sorted[i]; cEnd = sorted[i];
      }
    }
    segments.push({ start: cStart, end: Math.min(cEnd+1, duration) });

    const finalSegments = segments.filter(s => s.end - s.start >= 1.5);
    if (finalSegments.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({ success: true, found: false });
    }

    // Process clips in parallel
    const clipJobs = finalSegments.slice(0, 10).map(async (seg, i) => {
      const clipName = `clip_${i}_${uuidv4()}.mp4`;
      const clipPath = path.join(workDir, clipName);
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .setStartTime(seg.start)
          .setDuration(seg.end - seg.start)
          .outputOptions('-preset', 'ultrafast', '-threads', '0')
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      const clipBuffer = fs.readFileSync(clipPath);
      const clipFilePath = `temp_videos/clips/${clipName}`;
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(clipFilePath, clipBuffer, { contentType: 'video/mp4' });
      if (uploadErr) throw uploadErr;
      const { data: signedClip } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(clipFilePath, 3600);
      return { start: seg.start, end: seg.end, signedUrl: signedClip.signedUrl };
    });

    const clips = await Promise.all(clipJobs);
    fs.rmSync(workDir, { recursive: true, force: true });

    res.json({ success: true, found: true, clips });
  } catch (err) {
    console.error('[process] Error:', err);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup cron jobs ----------
async function cleanupExpired() {
  const now = new Date();
  const expiry = now.toISOString();
  const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  // Standard uploads
  const { data: old } = await supabase.from('video_uploads')
    .select('id, file_path')
    .or(`expires_at.lt.${expiry},and(upload_status.eq.pending,created_at.lt.${cutoff})`);
  if (old && old.length) {
    const paths = old.map(r => r.file_path);
    await supabase.storage.from(BUCKET_NAME).remove(paths);
    await supabase.from('video_uploads').delete().in('id', old.map(r => r.id));
    console.log(`[Cleanup] Removed ${old.length} expired videos.`);
  }

  // Stale multipart uploads
  const { data: mpus } = await supabase.from('multipart_uploads')
    .select('upload_id, file_path')
    .lt('expires_at', expiry);
  if (mpus && mpus.length) {
    for (const mpu of mpus) {
      try {
        await s3.send(new AbortMultipartUploadCommand({
          Bucket: BUCKET_NAME,
          Key: mpu.file_path,
          UploadId: mpu.upload_id,
        }));
      } catch (e) { /* ignore */ }
      await supabase.from('multipart_uploads').delete().eq('upload_id', mpu.upload_id);
    }
    console.log(`[Cleanup] Aborted ${mpus.length} stale multipart uploads.`);
  }
}
cron.schedule('*/5 * * * *', cleanupExpired);

app.get('/ping', (req, res) => res.send('pong'));
