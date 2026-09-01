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
function loadWorkerUrls() {
  const urls = [];
  for (let i = 1; i <= 20; i++) {
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

/** Periodic ping to every configured worker's /health - the only thing that actually keeps a Render free-tier worker instance awake (Render sleeps on inbound-traffic idleness; nothing internal to the worker can substitute for real inbound requests). Also doubles as a lightweight liveness log. */
function startWorkerKeepAlive(intervalMs = 10 * 60 * 1000) {
  if (WORKER_URLS.length === 0) return;
  setInterval(() => {
    WORKER_URLS.forEach(async (url) => {
      try {
        const res = await fetchWithTimeout(`${url}/health`, {}, CAPACITY_CHECK_TIMEOUT_MS);
        if (!res.ok) console.warn(`[renderDispatch] keep-alive ping to ${url} returned HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[renderDispatch] keep-alive ping to ${url} failed: ${err.message}`);
      }
    });
  }, intervalMs);
}

module.exports = { dispatchToWorker, cancelJobOnWorker, startWorkerKeepAlive, WORKER_URLS };
