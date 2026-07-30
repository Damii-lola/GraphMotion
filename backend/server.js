require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

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

    // Generate a signed upload URL (valid for 10 minutes)
    const { data, error } = await supabase.storage
      .from('temp_videos')
      .createSignedUploadUrl(filePath);

    if (error) throw error;

    // Store metadata in DB (pending)
    await supabase.from('video_uploads').insert([{
      file_name: fileName,
      original_name: originalName,
      file_path: filePath,
      upload_status: 'pending',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }]);

    res.json({
      success: true,
      signedUrl: data.signedUrl,
      filePath: filePath,
      fileName: originalName,
    });
  } catch (err) {
    console.error('[get-upload-url] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Confirm upload (client notifies when done) ----------
app.post('/confirm-upload', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' });

  try {
    // Update status to 'completed'
    const { error } = await supabase
      .from('video_uploads')
      .update({ upload_status: 'completed' })
      .eq('file_path', filePath);

    if (error) throw error;

    // Get a signed URL for playback
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

// ---------- Process with Mistral AI (using REST API) ----------
app.post('/process-video', async (req, res) => {
  const { signedUrl, fileName } = req.body;
  if (!signedUrl || !fileName) {
    return res.status(400).json({ error: 'Missing video info' });
  }

  try {
    const prompt = `Write a creative and detailed script for a motion graphics animation that replicates and enhances the content of a video titled "${fileName}". The script should describe visual scenes, motion effects, transitions, and overall style. Make it engaging and suitable for a professional motion design project.`;

    // Use Mistral REST API directly
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          { role: 'system', content: 'You are an expert motion graphics scriptwriter. Generate detailed, visual scripts for motion design projects.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mistral API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const script = data.choices[0].message.content;

    res.json({ success: true, script });
  } catch (err) {
    console.error('[process-video] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cleanup expired (and failed pending) ----------
async function cleanupExpiredVideos() {
  try {
    // Delete expired files + pending older than 10 minutes
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: toDelete, error } = await supabase
      .from('video_uploads')
      .select('id, file_path')
      .or(`expires_at.lt.${new Date().toISOString()},and(upload_status.eq.pending,created_at.lt.${cutoff})`);

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
cron.schedule('*/5 * * * *', cleanupExpiredVideos); // every 5 minutes

app.get('/ping', (req, res) => res.send('pong'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
