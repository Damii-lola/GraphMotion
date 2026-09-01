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

const crypto = require('crypto');

async function createJob({ userId, prompt, parentJobId, parentThreadId }) {
  // Generated client-side (not left to the database's own default)
  // specifically so a FRESH prompt (no parent) can set thread_id to
  // its own id in the same insert - every job in an edit chain shares
  // one thread_id (the root's id), so grouping them for the sidebar
  // is a single equality check, never a chain walk. An edit inherits
  // its parent's thread_id directly (passed in by the caller, which
  // already has the parent job loaded for its own authorization
  // check - no extra query needed here).
  const id = crypto.randomUUID();
  const threadId = parentThreadId || id;

  const { data, error } = await supabase
    .from('render_jobs')
    .insert({
      id,
      user_id: userId || null,
      prompt,
      status: 'queued',
      parent_job_id: parentJobId || null,
      thread_id: threadId,
    })
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
 * Powers the history sidebar - a lightweight list of a user's past
 * jobs (not the full scene_json for each, which could be large -
 * that's only fetched via getJob when a specific one is opened).
 * Newest first, capped so one prolific user can't pull an unbounded
 * result set.
 */
async function listJobsForUser(userId, limit = 50) {
  const { data, error } = await supabase
    .from('render_jobs')
    .select('id, prompt, status, created_at, video_url, parent_job_id, thread_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));

  if (error) throw new Error(`listJobsForUser failed: ${error.message}`);
  return data || [];
}

/**
 * Powers the sidebar's delete button. Verifies the job actually
 * belongs to the requesting user before deleting anything - this app
 * has no real auth, just per-user identifiers, so without this check
 * anyone who learned another user's job id could delete their history.
 * Best-effort cleanup of the rendered video file too, so deleted jobs
 * don't leave orphaned files sitting in storage forever - but a
 * storage-delete failure (e.g. the file was already gone) doesn't
 * block deleting the row itself, since the row is the part that
 * actually matters to the user.
 */
async function deleteJob(jobId, userId) {
  const { data: existing, error: fetchError } = await supabase
    .from('render_jobs')
    .select('id, user_id')
    .eq('id', jobId)
    .single();

  if (fetchError) throw new Error(`deleteJob lookup failed: ${fetchError.message}`);
  if (!existing) return { deleted: false, reason: 'not_found' };
  if (existing.user_id !== userId) return { deleted: false, reason: 'forbidden' };

  const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove([`${jobId}.mp4`]);
  if (storageError) {
    // Doesn't block deleting the row itself - a failed cleanup (e.g.
    // the file was already gone) shouldn't stop the user from
    // clearing this out of their history, since the row is the part
    // that actually matters to them.
    console.warn(`[deleteJob] storage cleanup failed for ${jobId}, deleting row anyway:`, storageError.message);
  }

  const { error: deleteError } = await supabase
    .from('render_jobs')
    .delete()
    .eq('id', jobId);

  if (deleteError) throw new Error(`deleteJob failed: ${deleteError.message}`);
  return { deleted: true };
}

async function countJobsToday(identifier) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  // A job that later failed to render shouldn't cost the user one of
  // their daily uses - they didn't get a video out of it. Only jobs
  // that are still in progress or actually succeeded count against
  // the limit.
  const { count, error } = await supabase
    .from('render_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', identifier)
    .neq('status', 'failed')
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
  listJobsForUser,
  deleteJob,
  countJobsToday,
  uploadRenderedVideo,
};
