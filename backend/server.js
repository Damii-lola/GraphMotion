require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Supabase client (using service role key for admin access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.send('Backend is running! 🚀');
});

// Test Supabase connection – try to fetch from a table (adjust table name!)
app.get('/test-supabase', async (req, res) => {
  try {
    // Replace 'your_table' with an actual table name in your Supabase DB
    const { data, error } = await supabase
      .from('your_table')
      .select('*')
      .limit(1);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Supabase connection successful',
      data: data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Supabase connection failed',
      error: err.message,
    });
  }
});

// Example endpoint to insert something (optional)
app.post('/add-user', async (req, res) => {
  const { name, email } = req.body;
  try {
    const { data, error } = await supabase
      .from('users') // change to your table
      .insert([{ name, email }])
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
