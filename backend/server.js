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

// Mistral API config
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// In-memory store for active conversations (use Supabase for persistence in production)
const activeConversations = new Map();

// --- AI Chat Endpoint ---
// Start or continue a conversation with the AI
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, conversationId } = req.body;
    
    // Initialize or retrieve conversation history
    let messages = [];
    if (conversationId && activeConversations.has(conversationId)) {
      messages = activeConversations.get(conversationId);
    } else {
      // Start new conversation with system prompt
      const newConversationId = `conv_${Date.now()}`;
      messages = [
        {
          role: 'system',
          content: 'You are an AI assistant specialized in generating MotionCanvas code for animated videos. Respond conversationally and generate code when requested.',
        },
      ];
      activeConversations.set(newConversationId, messages);
      res.json({
        conversationId: newConversationId,
        message: 'New conversation started. Describe the video or animation you want to create.',
        code: null,
      });
      return;
    }

    // Add user message
    messages.push({ role: 'user', content: prompt });

    // Call Mistral API
    const mistralResponse = await axios.post(
      MISTRAL_API_URL,
      {
        model: 'mistral-medium',
        messages: messages,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const aiMessage = mistralResponse.data.choices[0].message.content;
    messages.push({ role: 'assistant', content: aiMessage });
    activeConversations.set(conversationId, messages);

    // Save to Supabase
    const { error } = await supabase
      .from('conversations')
      .insert([
        {
          conversation_id: conversationId,
          prompt,
          response: aiMessage,
          created_at: new Date().toISOString(),
        },
      ]);

    if (error) console.error('Supabase error:', error);

    res.json({
      conversationId,
      message: aiMessage,
    });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Motion Graphics Endpoint ---
// Generate MotionCanvas code from a prompt
app.post('/api/generate-motion', async (req, res) => {
  try {
    const { prompt, conversationId } = req.body;

    // Call Mistral API to generate MotionCanvas code
    const mistralResponse = await axios.post(
      MISTRAL_API_URL,
      {
        model: 'mistral-medium',
        messages: [
          {
            role: 'system',
            content: `You are a MotionCanvas code generator. 
              Return ONLY valid MotionCanvas JavaScript code for animations based on the user's prompt. 
              Do NOT include explanations, markdown, or any text other than the code. 
              Use the @motion-canvas/2d library. 
              Example format: 
              import {makeScene2D, makeRectangle} from '@motion-canvas/2d';
              export default makeScene2D(function* (view) { ... })`,
          },
          { role: 'user', content: `Generate MotionCanvas code for: ${prompt}` },
        ],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    let motionCode = mistralResponse.data.choices[0].message.content;

    // Clean up the code (remove markdown or extra text if any)
    motionCode = motionCode.replace(/```javascript|```js|```/g, '').trim();

    // Save to Supabase
    const { data, error } = await supabase
      .from('motion_videos')
      .insert([
        {
          conversation_id: conversationId || null,
          prompt,
          motion_code: motionCode,
          created_at: new Date().toISOString(),
        },
      ])
      .select();

    if (error) throw error;

    res.json({
      success: true,
      motionCode,
      videoId: data[0].id,
    });
  } catch (error) {
    console.error('Motion generation error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Fetch Motion Videos ---
app.get('/api/motion-videos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('motion_videos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching motion videos:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Fetch Conversations ---
app.get('/api/conversations/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching conversations:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
