const fetch = require('node-fetch');

/**
 * Worker-to-worker help requests - a "primary" worker (whichever one
 * the coordinator's own renderDispatch.js happened to pick for a job)
 * can hand OFF a subset of that job's video chunks to a SIBLING worker
 * to render in parallel, instead of rendering every chunk itself in
 * sequence. Direct user request after real production logs showed
 * rendering (not narration) is the dominant cost of a generation -
 * ~0.57s/frame on Render's actual host, chunks strictly sequential
 * within one worker (see longVideoOrchestrator.js's own reasoning for
 * why - peak memory, not just speed) - and there are already 2 worker
 * services deployed sitting mostly idle relative to each other. Since
 * chunks don't depend on each other at all, splitting them across 2
 * workers cuts wall-clock render time roughly in half for anything
 * long enough to chunk in the first place.
 *
 * Same numbered-env-var convention as ../backend/renderDispatch.js's
 * own RENDER_WORKER_URL_N, but configured on EACH WORKER'S OWN
 * environment this time, pointing at its sibling(s) - not itself. A
 * worker doesn't know its own public URL, so there's no way to
 * automatically exclude "myself" from this list; whoever deploys these
 * services is responsible for pointing each worker at the OTHER
 * worker(s), not its own URL.
 */
function loadSiblingUrls() {
  const urls = [];
  for (let i = 1; i <= 20; i++) {
    const v = process.env[`RENDER_WORKER_URL_${i}`];
    if (v && v.trim()) urls.push(v.trim().replace(/\/$/, ''));
  }
  return urls;
}

const SIBLING_URLS = loadSiblingUrls();
if (SIBLING_URLS.length > 0) {
  console.log(`[chunkDispatch] ${SIBLING_URLS.length} sibling worker(s) configured for cross-worker chunk splitting`);
}

const CAPACITY_CHECK_TIMEOUT_MS = 5000;
// Chunk rendering for a real subset of chunks (real numbers: ~35s per
// 3-second chunk on Render's actual host) can legitimately run several
// minutes for a longer video's back half - this has to comfortably
// outlast that, not just a normal request/response.
const HELP_REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Finds ONE available sibling (random among any reporting a free slot) to help with this job - mirrors ../backend/renderDispatch.js's own selection logic, just scoped to this worker's configured siblings instead of the whole pool. Returns null (never throws) if none are configured or none have room - the caller falls back to rendering solo either way. */
async function getAvailableSibling() {
  if (SIBLING_URLS.length === 0) return null;
  const results = await Promise.all(SIBLING_URLS.map(async (url) => {
    try {
      const res = await fetchWithTimeout(`${url}/capacity`, {}, CAPACITY_CHECK_TIMEOUT_MS);
      if (!res.ok) return null;
      const data = await res.json();
      return data.available ? url : null;
    } catch {
      return null;
    }
  }));
  const available = results.filter(Boolean);
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Asks a specific sibling to render a specific subset of chunks (each
 * `{start, end, index}`, `index` being the GLOBAL position in the
 * whole video - the sibling doesn't know or care about the primary's
 * own chunks, it just renders exactly what it's told and hands the
 * bytes back) and returns `[{index, base64}, ...]`. Holds the
 * connection open for as long as that actually takes - see
 * HELP_REQUEST_TIMEOUT_MS above. Throws on any failure (bad response,
 * timeout, network error); the caller decides how to fall back
 * (render-worker/server.js falls back to rendering that same subset
 * itself, slower but correct, rather than losing those chunks).
 */
async function requestHelp(workerUrl, jobId, sceneJSON, chunkRanges) {
  const res = await fetchWithTimeout(`${workerUrl}/render-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, sceneJSON, chunkRanges }),
  }, HELP_REQUEST_TIMEOUT_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sibling ${workerUrl} returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.chunks || !Array.isArray(data.chunks)) {
    throw new Error(`sibling ${workerUrl} returned an unexpected response shape`);
  }
  return data.chunks;
}

module.exports = { getAvailableSibling, requestHelp, SIBLING_URLS };
