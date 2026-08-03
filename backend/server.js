// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Mistral API endpoint and key
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// Example route: Generate animation code from a prompt
app.post('/api/generate-animation', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    // Call Mistral API to generate animation code
    const mistralResponse = await axios.post(
      MISTRAL_API_URL,
      {
        model: 'mistral-medium',
        messages: [
          {
            role: 'user',
            content: `Generate Motion Canvas code for a video based on this prompt: ${prompt}`,
          },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const animationCode = mistralResponse.data.choices[0].message.content;

    // Save to Supabase (example: save to a 'videos' table)
    const { data, error } = await supabase
      .from('videos')
      .insert([
        {
          prompt,
          animation_code: animationCode,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Example route: Fetch all videos
app.get('/api/videos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('videos').select('*');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
