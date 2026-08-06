const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[supabaseClient] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'rendered-videos';

/**
 * Create a new render job row. Status flows:
 * queued -> writing_scenes -> rendering -> uploading -> done | failed
 */
async function createJob({ userId, prompt }) {
  const { data, error } = await supabase
    .from('render_jobs')
    .insert({ user_id: userId || null, prompt, status: 'queued' })
    .select()
    .single();

  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data;
}

async function updateJob(jobId, fields) {
  const { data, error } = await supabase
    .from('render_jobs')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .select()
    .single();

  if (error) throw new Error(`updateJob failed: ${error.message}`);
  return data;
}

async function getJob(jobId) {
  const { data, error } = await supabase
    .from('render_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) throw new Error(`getJob failed: ${error.message}`);
  return data;
}

/**
 * Counts jobs created by this identifier (user id or IP) since midnight UTC,
 * used to enforce the free tier daily limit.
 */
async function countJobsToday(identifier) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('render_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', identifier)
    .gte('created_at', startOfDay.toISOString());

  if (error) throw new Error(`countJobsToday failed: ${error.message}`);
  return count || 0;
}

async function uploadRenderedVideo(jobId, localFilePath, buffer) {
  const filename = `${jobId}.mp4`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filename, buffer, { contentType: 'video/mp4', upsert: true });

  if (error) throw new Error(`uploadRenderedVideo failed: ${error.message}`);

  const { data: publicUrlData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(filename);

  return publicUrlData.publicUrl;
}

module.exports = {
  supabase,
  createJob,
  updateJob,
  getJob,
  countJobsToday,
  uploadRenderedVideo,
};
