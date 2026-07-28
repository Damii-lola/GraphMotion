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

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===================== CLEANUP FUNCTION =====================
async function cleanupExpiredVideos() {
  console.log('[Cleanup] Starting cleanup job...');
  try {
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
    const filePaths = expiredRecords.map(record => record.file_path);

    const { error: storageError } = await supabase.storage
      .from('temp_videos')
      .remove(filePaths);

    if (storageError) {
      console.error('[Cleanup] Storage delete error:', storageError.message);
    } else {
      console.log(`[Cleanup] Deleted ${filePaths.length} files from storage.`);
    }

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

cron.schedule('0 * * * *', () => {
  cleanupExpiredVideos();
});
console.log('[Cron] Cleanup job scheduled every hour.');

app.get('/cleanup', async (req, res) => {
  await cleanupExpiredVideos();
  res.json({ success: true, message: 'Cleanup completed.' });
});

app.get('/', (req, res) => {
  res.send('Backend is running! 🚀');
});

// ===================== DOWNLOAD ENDPOINT with better request handling =====================
app.post('/download-youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  // ---- Custom headers to mimic a real browser ----
  const requestOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  };

  try {
    // 1. Get info with our custom headers
    let info;
    try {
      info = await ytdl.getInfo(url, { requestOptions });
    } catch (infoErr) {
      console.error('getInfo error:', infoErr);
      // If the video is blocked, try again with a different approach (no custom headers?)
      // Or try using the default request options
      try {
        info = await ytdl.getInfo(url);
      } catch (fallbackErr) {
        console.error('Fallback getInfo also failed:', fallbackErr);
        return res.status(400).json({
          error: 'Video not found or unavailable. It might be region‑blocked or require a login.'
        });
      }
    }

    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 ]/g, '_');
    const videoId = info.videoDetails.videoId;

    // 2. Try to download with a quality that works (try 'highest' first, fallback to 'lowest')
    let videoStream;
    let streamError = null;

    try {
      // First attempt: highest quality
      videoStream = ytdl(url, {
        quality: 'highest',
        requestOptions,
      });
    } catch (streamErr) {
      console.warn('Highest quality stream failed, trying lowest:', streamErr.message);
      try {
        // Fallback: lowest quality (usually format 18 – 360p mp4)
        videoStream = ytdl(url, {
          quality: 'lowest',
          requestOptions,
        });
      } catch (fallbackStreamErr) {
        throw new Error('Both highest and lowest quality streams failed: ' + fallbackStreamErr.message);
      }
    }

    // 3. Collect chunks
    const chunks = [];
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

    // 4. Upload to Supabase
    const fileName = `${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    const { data, error: uploadError } = await supabase.storage
      .from('temp_videos')
      .upload(filePath, buffer, {
        contentType: 'video/mp4',
        cacheControl: '3600',
      });

    if (uploadError) throw uploadError;

    // 5. Generate signed URL
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

app.delete('/delete-video', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });

  const { error } = await supabase.storage.from('temp_videos').remove([filePath]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
