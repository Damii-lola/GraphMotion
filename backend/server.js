require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ytdl = require('ytdl-core');
const { Readable } = require('stream');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Supabase client (service role for admin access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.send('Backend is running! 🚀');
});

// Endpoint to download YouTube video and store in Supabase
app.post('/download-youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate YouTube URL
  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    // 1. Get video info (title, etc.)
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9]/g, '_');
    const videoId = info.videoDetails.videoId;

    // 2. Download the video as a stream (choose best quality)
    const videoStream = ytdl(url, { quality: 'highestvideo', filter: 'videoandaudio' });

    // 3. Generate a unique filename
    const fileName = `${videoId}_${Date.now()}.mp4`;
    const filePath = `temp_videos/${fileName}`;

    // 4. Convert stream to buffer (we'll collect chunks)
    const chunks = [];
    for await (const chunk of videoStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // 5. Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from('temp_videos') // make sure this bucket exists
      .upload(filePath, buffer, {
        contentType: 'video/mp4',
        cacheControl: '3600',
      });

    if (error) throw error;

    // 6. Generate a signed URL that expires in 1 hour (3600 seconds)
    const { data: signedUrlData, error: signedError } = await supabase.storage
      .from('temp_videos')
      .createSignedUrl(filePath, 3600); // 1 hour

    if (signedError) throw signedError;

    // 7. (Optional) Save metadata to a DB table for tracking
    const { error: dbError } = await supabase
      .from('video_downloads') // create this table if needed
      .insert([{
        video_id: videoId,
        title: title,
        file_path: filePath,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      }]);

    if (dbError) console.warn('DB insert failed:', dbError.message);

    // 8. Return the signed URL to the frontend
    res.json({
      success: true,
      signedUrl: signedUrlData.signedUrl,
      title: info.videoDetails.title,
      author: info.videoDetails.author.name,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Download failed: ' + err.message });
  }
});

// (Optional) Endpoint to manually delete a file by path
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
