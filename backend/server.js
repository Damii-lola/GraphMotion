require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ytdl = require('ytdl-core');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Supabase client (service role for admin access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===================== CLEANUP FUNCTION =====================
async function cleanupExpiredVideos() {
  console.log('[Cleanup] Starting cleanup job...');
  try {
    // 1. Find expired records (expires_at < now)
    const { data: expiredRecords, error: fetchError } = await supabase
      .from('video_downloads')
      .select('id, file_path')
      .lt('expires_at', new Date().toISOString());

    if (fetchError) {
      console.error('[Cleanup] DB fetch error:', fetchError.message);
      return;
    }

    if (!expiredRecords || expiredRecords.length === 0) {
      console.log('[Cleanup] No expired videos to delete.');
      return;
    }

    console.log(`[Cleanup] Found ${expiredRecords.length} expired records.`);

    // 2. Collect file paths to delete from storage
    const filePaths = expiredRecords.map(record => record.file_path);

    // 3. Delete files from Supabase Storage
    const { error: storageError } = await supabase.storage
      .from('temp_videos')
      .remove(filePaths);

    if (storageError) {
      console.error('[Cleanup] Storage delete error:', storageError.message);
    } else {
      console.log(`[Cleanup] Deleted ${filePaths.length} files from storage.`);
    }

    // 4. Delete records from DB (regardless of storage success)
    const recordIds = expiredRecords.map(record => record.id);
    const { error: deleteError } = await supabase
      .from('video_downloads')
      .delete()
      .in('id', recordIds);

    if (deleteError) {
      console.error('[Cleanup] DB delete error:', deleteError.message);
    } else {
      console.log(`[Cleanup] Removed ${recordIds.length} records from DB.`);
    }

  } catch (err) {
    console.error('[Cleanup] Unexpected error:', err.message);
  }
}

// ===================== SCHEDULED CLEANUP (every hour) =====================
cron.schedule('0 * * * *', () => {
  cleanupExpiredVideos();
});
console.log('[Cron] Cleanup job scheduled to run every hour.');

// Optionally run once on startup (uncomment if desired)
// cleanupExpiredVideos();

// ===================== MANUAL CLEANUP ENDPOINT =====================
app.get('/cleanup', async (req, res) => {
  await cleanupExpiredVideos();
  res.json({ success: true, message: 'Cleanup completed.' });
});

// ===================== HEALTH CHECK =====================
app.get('/', (req, res) => {
  res.send('Backend is running! 🚀');
});

// ===================== YOUTUBE DOWNLOAD ENDPOINT =====================
app.post('/download-youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL format
  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    // 1. Get video info FIRST – this will fail if video is unavailable
    let info;
    try {
      info = await ytdl.getInfo(url);
    } catch (infoErr) {
      // If getInfo fails, it's likely a 410 or 404
      return res.status(400).json({
        error: 'Video not found or unavailable. It may be private, age‑restricted, or deleted.'
      });
    }

    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 ]/g, '_');
    const videoId = info.videoDetails.videoId;

    // 2. Download the video – use default quality (highest with audio+video)
    const videoStream = ytdl(url, { quality: 'highest' }); // no filter

    // 3. Collect chunks
    const chunks = [];
    let streamError = null;

    videoStream.on('error', (err) => {
      streamError = err;
    });

    for await (const chunk of videoStream) {
      if (streamError) break;
      chunks.push(chunk);
    }

    if (streamError) {
      throw new Error('Download stream error: ' + streamError.message);
    }

    if (chunks.length === 0) {
      throw new Error('No data received – video may be empty or unsupported format.');
    }

    const buffer = Buffer.concat(chunks);

    // 4. Upload to Supabase Storage
    const fileName = `${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    const { data, error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, buffer, {
        contentType: 'video/mp4',
        cacheControl: '3600',
      });

    if (uploadError) throw uploadError;

    // 5. Generate signed URL (1 hour)
    const { data: signedUrlData, error: signedError } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600);

    if (signedError) throw signedError;

    // 6. Insert record with expiry
    const { error: dbError } = await supabase
      .from('video_downloads')
      .insert([{
        video_id: videoId,
        title: title,
        file_path: filePath,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }]);

    if (dbError) console.warn('DB insert failed:', dbError.message);

    // 7. Return signed URL
    res.json({
      success: true,
      signedUrl: signedUrlData.signedUrl,
      title: info.videoDetails.title,
      author: info.videoDetails.author.name,
    });

  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({
      error: 'Download failed: ' + err.message
    });
  }
});

// ===================== MANUAL DELETE ENDPOINT (optional) =====================
app.delete('/delete-video', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });

  const { error } = await supabase.storage.from('temp_videos').remove([filePath]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ===================== START SERVER =====================
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
