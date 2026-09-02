const fetch = require('node-fetch');

/**
 * Free, no-API-key image generation via Pollinations.ai - the only
 * zero-cost path to real photographic content for a budget-constrained
 * project. Confirmed working directly (curl against the live endpoint
 * returned a real, on-prompt, well-lit JPEG in ~2s) before building
 * anything around it. Lower quality/reliability than a paid model and
 * genuinely unauthenticated (no SLA), so every caller of this module
 * MUST treat failure as a normal, expected outcome, not an error to
 * propagate - see imagePrefetch.js.
 */

const ENDPOINT = 'https://image.pollinations.ai/prompt';
const TIMEOUT_MS = 20000;

function fetchOnce(prompt, { width, height }) {
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const url = `${ENDPOINT}/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&nofeed=true&model=flux&seed=${seed}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  return fetch(url, { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) {
        const err = new Error(`Pollinations returned ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const buf = await res.buffer();
      if (!buf || buf.length < 500) throw new Error('Pollinations returned a suspiciously small response');
      return buf;
    })
    .finally(() => clearTimeout(timeout));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Generates one image, retrying up to 2 more times (3 attempts total)
 * specifically on a 429 - real, direct production evidence this
 * matters: a live job's own log ("beat 2 image failed, falling back
 * to procedural: Pollinations returned 429") and the resulting rendered
 * video confirmed missing its hero photo as a direct result (the
 * "src":"beatImage" layer was correctly paired with a real
 * "imagePrompt", it just had nothing to draw once the fetch failed).
 * The ORIGINAL single retry fired IMMEDIATELY with no delay - for a
 * 429 specifically (the server explicitly saying "you're going too
 * fast"), retrying at the exact same instant is close to useless, it
 * hits the same rate-limit window again. A short, real backoff (1.5s,
 * then 3s) gives the free, unauthenticated endpoint's own rate-limit
 * window an actual chance to clear before trying again. A non-429
 * failure (timeout, malformed response) still gets exactly one
 * immediate retry, same as before - no reason to slow those down with
 * a backoff a rate limit doesn't apply to.
 */
async function generateImage(prompt, { width = 640, height = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchOnce(prompt, { width, height });
    } catch (err) {
      lastErr = err;
      if (err.status === 429 && attempt < 2) {
        await sleep(attempt === 0 ? 1500 : 3000);
        continue;
      }
      if (attempt === 0) continue; // non-429: exactly one immediate retry, as before
      break;
    }
  }
  throw lastErr;
}

module.exports = { generateImage };
