require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Increase server timeout
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.timeout = 600000;

// ---------- Middleware ----------
app.use(cors({
  origin: ['https://damii-lola.github.io', 'http://localhost:5500'],
  credentials: true,
}));

// Normal JSON parsing for all routes EXCEPT /upload-part
app.use((req, res, next) => {
  if (req.path === '/upload-part' && req.method === 'POST') {
    // Skip json parser, we'll handle raw body later
    next();
  } else {
    express.json({ limit: '1gb' })(req, res, next);
  }
});

// ---------- Supabase + S3 clients ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.SUPABASE_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY,
    secretAccessKey: process.env.SUPABASE_S3_SECRET_KEY,
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const BUCKET_NAME = 'temp_videos';

// ---------- Ensure bucket ----------
async function ensureBucket() {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) throw error;
    const exists = buckets.some(b => b.name === BUCKET_NAME);
    if (!exists) {
      await supabase.storage.createBucket(BUCKET_NAME, {
        public: false,
        fileSizeLimit: '5GB',
        allowedMimeTypes: ['video/*']
      });
      console.log('[Startup] Created bucket:', BUCKET_NAME);
    } else {
      console.log('[Startup] Bucket exists:', BUCKET_NAME);
    }
  } catch (err) {
    console.error('[Startup] Bucket error:', err.message);
  }
}
ensureBucket();

// ==============================================
//   ORIGINAL SINGLE-PUT UPLOAD (fallback)
// ==============================================
app.post('/get-upload-url', async (req, res) => {
  try {
    const { originalName } = req.body;
    if (!originalName) return res.status(400).json({ error: 'Missing originalName' });

    const ext = originalName.includes('.') ? originalName.split('.').pop() : 'mp4';
    const fileName = `${uuidv4()}.${ext}`;
    const filePath = `temp_videos/${fileName}`;

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUploadUrl(filePath);
    if (error) throw error;

    await supabase.from('video_uploads').insert({
      file_name: fileName,
      original_name: originalName,
      file_path: filePath,
      upload_status: 'pending',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    res.json({ success: true, signedUrl: data.signedUrl, filePath, fileName: originalName });
  } catch (err) {
    console.error('[get-upload-url] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/confirm-upload', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' });

  try {
    await supabase.from('video_uploads')
      .update({ upload_status: 'completed' })
      .eq('file_path', filePath);

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(filePath, 3600);
    if (error) throw error;

    res.json({ success: true, signedUrl: data.signedUrl });
  } catch (err) {
    console.error('[confirm-upload] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==============================================
//   MULTIPART UPLOAD (FAST – NO PRESIGNED URL)
// ==============================================
app.post('/init-multipart', async (req, res) => {
  try {
    const { fileName, fileSize, contentType } = req.body;
    if (!fileName || !fileSize) return res.status(400).json({ error: 'Missing file info' });

    const ext = fileName.includes('.') ? fileName.split('.').pop() : 'mp4';
    const key = `${uuidv4()}.${ext}`;   // no bucket prefix

    const command = new CreateMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'video/mp4',
    });
    const response = await s3.send(command);
    const uploadId = response.UploadId;

    const totalParts = Math.ceil(fileSize / (5 * 1024 * 1024)); // 5 MB parts
    await supabase.from('multipart_uploads').insert({
      id: uploadId,
      file_name: fileName,
      file_path: key,
      content_type: contentType,
      parts: totalParts,
      upload_id: uploadId,
    });

    res.json({ success: true, uploadId, filePath: key, parts: totalParts });
  } catch (err) {
    console.error('[init-multipart] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- UPLOAD PART (proxy – client sends raw chunk to backend) ----------
app.post('/upload-part', async (req, res) => {
  try {
    const uploadId = req.headers['x-upload-id'];
    const partNumber = parseInt(req.headers['x-part-number'], 10);
    const filePath = req.headers['x-file-path'];

    if (!uploadId || !partNumber || !filePath) {
      return res.status(400).json({ error: 'Missing upload parameters in headers' });
    }

    // Read raw body
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);

        const command = new UploadPartCommand({
          Bucket: BUCKET_NAME,
          Key: filePath,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
        });

        const result = await s3.send(command);
        res.setHeader('ETag', result.ETag);
        res.json({ success: true, ETag: result.ETag });
      } catch (err) {
        console.error('[upload-part] S3 error:', err);
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    console.error('[upload-part] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

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

    // Fetch file name from multipart_uploads record
    const { data: mpu } = await supabase.from('multipart_uploads')
      .select('file_name')
      .eq('upload_id', uploadId)
      .single();
    const finalName = mpu?.file_name || originalName;

    // Insert into video_uploads with the full path (for Supabase Storage API)
    await supabase.from('video_uploads').insert({
      file_name: finalName,
      original_name: originalName,
      file_path: `temp_videos/${filePath}`,
      upload_status: 'completed',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    await supabase.from('multipart_uploads').delete().eq('upload_id', uploadId);

    // Generate a signed URL for playback using Supabase Storage API
    const { data: signedUrlData, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(`temp_videos/${filePath}`, 3600);
    if (error) throw error;

    res.json({ success: true, signedUrl: signedUrlData.signedUrl });
  } catch (err) {
    console.error('[complete-multipart] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/abort-multipart', async (req, res) => {
  try {
    const { uploadId, filePath } = req.body;
    if (!uploadId || !filePath) return res.status(400).json({ error: 'Missing data' });

    await s3.send(new AbortMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: filePath,
      UploadId: uploadId,
    }));
    await supabase.from('multipart_uploads').delete().eq('upload_id', uploadId);
    res.json({ success: true });
  } catch (err) {
    console.error('[abort-multipart] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==============================================
//   VIDEO PROCESSING
// ==============================================
app.post('/process-video', async (req, res) => {
  const { signedUrl, fileName } = req.body;
  if (!signedUrl || !fileName) return res.status(400).json({ error: 'Missing video info' });

  // Use RAM disk if available
  const workDir = fs.existsSync('/dev/shm') ? `/dev/shm/${uuidv4()}` : path.join('/tmp', uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const videoPath = path.join(workDir, 'input.mp4');

  try {
    console.log('[process] Downloading video...');
    const writer = fs.createWriteStream(videoPath);
    const response = await axios({ method: 'get', url: signedUrl, responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, data) => {
        if (err) reject(err);
        else resolve(data.format.duration);
      });
    });
    console.log(`[process] Duration: ${duration}s`);

    // Audio extraction (4kHz mono for speed)
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

    // Scene detection
    const sceneFile = path.join(workDir, 'scenes.txt');
    const cmd = `"${ffmpegPath}" -threads 0 -i "${videoPath}" -vf "scale=160:-2,select=gt(scene\\,0.35),metadata=print:file=${sceneFile}" -vsync vfr -f null -`;
    console.log('[process] Detecting scene changes...');
    try {
      await execAsync(cmd, { timeout: 120000 });
    } catch (e) { /* ignore */ }

    const sceneTimes = [];
    if (fs.existsSync(sceneFile)) {
      const lines = fs.readFileSync(sceneFile, 'utf8').split('\n').filter(l => l.includes('pts_time:'));
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
      return res.json({ success: true, found: false });
    }

    // Cluster into segments
    const sorted = Array.from(interestingSeconds).sort((a, b) => a - b);
    const segments = [];
    let cStart = sorted[0], cEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] <= 3) cEnd = sorted[i];
      else {
        segments.push({ start: cStart, end: Math.min(cEnd + 1, duration) });
        cStart = sorted[i]; cEnd = sorted[i];
      }
    }
    segments.push({ start: cStart, end: Math.min(cEnd + 1, duration) });

    const finalSegments = segments.filter(s => s.end - s.start >= 1.5);
    if (finalSegments.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({ success: true, found: false });
    }

    // Extract clips in parallel
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

// ==============================================
//   CLEANUP CRON
// ==============================================
async function cleanupExpired() {
  const now = new Date();
  const expiry = now.toISOString();
  const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  // Standard video uploads
  const { data: old } = await supabase.from('video_uploads')
    .select('id, file_path')
    .or(`expires_at.lt.${expiry},and(upload_status.eq.pending,created_at.lt.${cutoff})`);
  if (old && old.length) {
    const paths = old.map(r => r.file_path);
    await supabase.storage.from(BUCKET_NAME).remove(paths);
    await supabase.from('video_uploads').delete().in('id', old.map(r => r.id));
    console.log(`[Cleanup] Removed ${old.length} expired/failed videos.`);
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
          Key: mpu.file_path,   // key is just the UUID
          UploadId: mpu.upload_id,
        }));
      } catch (e) { /* ignore */ }
      await supabase.from('multipart_uploads').delete().eq('upload_id', mpu.upload_id);
    }
    console.log(`[Cleanup] Aborted ${mpus.length} stale multipart uploads.`);
  }
}
cron.schedule('*/5 * * * *', cleanupExpired);

// Health check
app.get('/ping', (req, res) => res.send('pong'));
