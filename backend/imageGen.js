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
      if (!res.ok) throw new Error(`Pollinations returned ${res.status}`);
      const buf = await res.buffer();
      if (!buf || buf.length < 500) throw new Error('Pollinations returned a suspiciously small response');
      return buf;
    })
    .finally(() => clearTimeout(timeout));
}

/**
 * Generates one image, with a single retry - mirrors the retry shape
 * mistralClient.js already uses for its own external-API call, for
 * consistency. Throws on total failure; imagePrefetch.js is the layer
 * that turns that into a silent per-beat fallback, not this one.
 */
// The composited photo card (imageComposite.js) only ever displays at
// ~605x563px (0.84*WIDTH x 0.44*HEIGHT of a 720x1280 frame) - requesting
// the full 720x1280 frame size decoded roughly 3x more pixel data than
// ever gets drawn. On a memory-constrained host (confirmed: the
// production deploy is capped at 512MB) that's real, avoidable decoded-
// buffer weight held for a whole chunk's render, not a rounding error.
// 640x800 comfortably covers the display box without upscaling while
// cutting decode memory by roughly half.
async function generateImage(prompt, { width = 640, height = 800 } = {}) {
  try {
    return await fetchOnce(prompt, { width, height });
  } catch (err) {
    return await fetchOnce(prompt, { width, height });
  }
}

module.exports = { generateImage };
