require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

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

// ---------- Multer config (memory storage) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});

// ---------- Upload endpoint ----------
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const file = req.file;
    const originalName = file.originalname || 'video.mp4';
    const ext = path.extname(originalName) || '.mp4';
    const fileName = `upload_${uuidv4()}${ext}`;
    const filePath = `temp_videos/${fileName}`;

    console.log('[upload] Storing:', fileName, 'size:', file.size);

    // Upload to Supabase
    const { error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
      });
    if (uploadError) throw uploadError;

    // Generate signed URL (1 hour)
    const { data: signedData, error: signedErr } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);
    if (signedErr) throw signedErr;

    // Optionally store metadata in DB
    try {
      await supabase.from('video_uploads').insert([{
        file_name: fileName,
        original_name: originalName,
        file_path: filePath,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }]);
    } catch (dbErr) {
      console.warn('[DB] Insert skipped:', dbErr.message);
    }

    res.json({
      success: true,
      signedUrl: signedData.signedUrl,
      fileName: originalName,
    });

  } catch (err) {
    console.error('[upload] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup ----------
async function cleanupExpiredVideos() {
  try {
    const { data: expired, error } = await supabase
      .from('video_uploads')
      .select('id, file_path')
      .lt('expires_at', new Date().toISOString());
    if (error) throw error;
    if (!expired || expired.length === 0) return;
    const filePaths = expired.map(r => r.file_path);
    await supabase.storage.from('temp_videos').remove(filePaths);
    const ids = expired.map(r => r.id);
    await supabase.from('video_uploads').delete().in('id', ids);
    console.log(`[Cleanup] Removed ${expired.length} expired files.`);
  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}
cron.schedule('0 * * * *', cleanupExpiredVideos);

app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
