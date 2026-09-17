const fs = require('fs');
const fetch = require('node-fetch');

/**
 * Coordinator side of the coordinator/worker rendering split (see
 * ../render-worker/server.js for the worker side and its own doc
 * comment for the full picture). This backend does prompt -> Gemini
 * scene JSON -> narration (TTS + the audio QA judge) same as always;
 * once a job is narrated, THIS module tries to hand the actual
 * rendering off to one of the configured render-worker services
 * instead of doing it locally - direct user request, to work around a
 * real memory ceiling on a single process handling both AI-call-heavy
 * narration and memory-heavy Skia rendering at once.
 *
 * Deliberately fails soft everywhere: no workers configured, none with
 * a free slot, or the dispatch call itself errors all just resolve to
 * `null` rather than throwing - renderWorker.js falls back to
 * rendering the job locally exactly as it always has whenever this
 * returns null, so a worker outage never blocks a video from finishing,
 * it just loses the memory-offloading benefit for that one job.
 */

// Same numbered-env-var convention as geminiClient.js's loadKeys() -
// RENDER_WORKER_URL_1, _2, ... - for consistency with how this codebase
// already configures a variable-length list of credentials/endpoints.
// 20 -> 100 (2026-09-17, direct user report: the fleet already grew past
// the old hardcoded ceiling, 22 real workers silently losing the last 2).
// Checking an env var that isn't set is a free no-op, so this is set
// with real headroom rather than just bumped to match today's count -
// no reason to hit this same silent ceiling again next time the fleet
// grows.
function loadWorkerUrls() {
  const urls = [];
  for (let i = 1; i <= 100; i++) {
    const v = process.env[`RENDER_WORKER_URL_${i}`];
    if (v && v.trim()) urls.push(v.trim().replace(/\/$/, ''));
  }
  return urls;
}

const WORKER_URLS = loadWorkerUrls();
if (WORKER_URLS.length > 0) {
  console.log(`[renderDispatch] ${WORKER_URLS.length} render worker(s) configured`);
}

const CAPACITY_CHECK_TIMEOUT_MS = 5000;
const DISPATCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Queries every configured worker's /capacity concurrently - a worker that's down, slow, or errors is just treated as unavailable rather than failing the whole selection, so one bad worker never blocks routing to the others. */
async function getAvailableWorkers() {
  const results = await Promise.all(WORKER_URLS.map(async (url) => {
    try {
      const res = await fetchWithTimeout(`${url}/capacity`, {}, CAPACITY_CHECK_TIMEOUT_MS);
      if (!res.ok) return null;
      const data = await res.json();
      return data.available ? url : null;
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A few short retries rather than one shot - the common "all busy"
// case is transient (each worker only holds a slot for as long as its
// own render+mux takes, on the order of tens of seconds), so a brief
// wait-and-recheck genuinely helps before giving up and falling back
// to local rendering.
const SELECT_RETRIES = 3;
const SELECT_RETRY_DELAY_MS = 4000;

async function selectWorker() {
  if (WORKER_URLS.length === 0) return null;
  for (let attempt = 1; attempt <= SELECT_RETRIES; attempt++) {
    const available = await getAvailableWorkers();
    if (available.length > 0) return pickRandom(available);
    if (attempt < SELECT_RETRIES) await sleep(SELECT_RETRY_DELAY_MS);
  }
  return null;
}

/** Reads each beat's narration clip off disk and base64-encodes it for the JSON payload - these files are small (a few hundred KB for a whole video), so inlining them avoids a separate upload/download round trip through Supabase just to hand them to a worker. */
function encodeNarrationAudio(audioFiles) {
  const clips = [];
  for (const [index, { path: filePath, duration }] of audioFiles.entries()) {
    const base64 = fs.readFileSync(filePath).toString('base64');
    clips.push({ index, duration, base64 });
  }
  return clips;
}

/**
 * Tries to hand a narrated job off to an available render worker.
 * Returns true if a worker accepted it (the worker takes it from
 * there - render, mux, upload, and updating the job row are all its
 * own responsibility from this point on), or false if no worker could
 * be used for any reason, meaning the caller should render locally.
 * Returns `{ dispatched: false }` on any failure (caller falls back to
 * local rendering), or `{ dispatched: true, workerUrl }` on success -
 * the workerUrl is handed back so the caller (renderWorker.js, then
 * server.js via IPC) can remember which worker owns this job, which
 * cancelJobOnWorker below needs to actually cancel it later.
 */
async function dispatchToWorker(jobId, sceneJSON, audioFiles) {
  const workerUrl = await selectWorker();
  if (!workerUrl) return { dispatched: false };

  try {
    const narrationAudio = encodeNarrationAudio(audioFiles);
    const res = await fetchWithTimeout(`${workerUrl}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, sceneJSON, narrationAudio }),
    }, DISPATCH_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[renderDispatch] worker ${workerUrl} rejected job ${jobId}: HTTP ${res.status}`);
      return { dispatched: false };
    }
    console.log(`[renderDispatch] job ${jobId} dispatched to ${workerUrl}`);
    return { dispatched: true, workerUrl };
  } catch (err) {
    console.warn(`[renderDispatch] dispatch to ${workerUrl} failed for job ${jobId}, falling back to local render: ${err.message}`);
    return { dispatched: false };
  }
}

/** Best-effort - tells a specific worker to stop working on a job (see render-worker/server.js's own POST /cancel/:jobId). Never throws; a cancel request that fails to reach the worker (it already finished, or is briefly unreachable) isn't worth failing the user-facing cancel action over - the job row's status update is what the frontend actually reacts to either way. */
async function cancelJobOnWorker(workerUrl, jobId) {
  try {
    await fetchWithTimeout(`${workerUrl}/cancel/${encodeURIComponent(jobId)}`, { method: 'POST' }, CAPACITY_CHECK_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[renderDispatch] cancel request to ${workerUrl} for job ${jobId} failed (non-fatal): ${err.message}`);
  }
}

// Real, direct user report (2026-09-18): "some workers fell asleep [while
// rendering]... as rendering is going on, keep pinging the workers that
// are working on the rendering to keep them awake, and when there isn't
// any rendering to be done, it won't ping." A LONG chunked render's own
// inbound /render request apparently isn't enough by itself to keep a
// free-tier worker from sleeping mid-job (a real, observed gap, not
// theoretical) - real production evidence for exactly the case the
// blanket keep-alive removed earlier this session (2026-09-17, the
// runaway-hours incident) was over-solving: THAT one pinged every
// configured worker forever regardless of whether anything was running
// on it, which is what actually burned through the 750-hour free pool.
// This is the deliberately narrow middle ground - see server.js's own
// pingActivelyRenderingWorkers for how it decides WHICH worker URLs to
// pass in here (only ones with a real, still-in-progress dispatched job,
// checked against that job's own live Supabase status) - this function
// itself just does the actual pinging once handed that already-filtered
// list, same forgiving timeout the old keep-alive used (a sleeping
// worker's first response after waking routinely takes well past a
// normal request's own timeout).
const KEEP_ALIVE_TIMEOUT_MS = 30000;
async function pingBusyWorkers(workerUrls) {
  await Promise.all([...workerUrls].map(async (url) => {
    try {
      const res = await fetchWithTimeout(`${url}/health`, {}, KEEP_ALIVE_TIMEOUT_MS);
      if (!res.ok) console.warn(`[renderDispatch] keep-alive ping to ${url} (actively rendering) returned HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[renderDispatch] keep-alive ping to ${url} (actively rendering) failed: ${err.message}`);
    }
  }));
}

module.exports = {
  dispatchToWorker, cancelJobOnWorker, pingBusyWorkers, WORKER_URLS,
};
