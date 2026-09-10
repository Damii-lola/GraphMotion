const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
const { Resvg } = require('@resvg/resvg-js');

/**
 * Resolves every `type:'image'` layer's optional `icon` (an Iconify
 * name like "mdi:rocket-launch") into a real local `src` PNG path,
 * mirroring exactly how imagePrefetch.js resolves a beat's own
 * `imagePrompt` into an `imagePath` - the AI writes a semantic
 * REQUEST, never a literal file path, and this step is what turns it
 * into one right before rendering.
 *
 * Iconify (api.iconify.design) is free, keyless, and unauthenticated -
 * ~200,000 real icons across ~150 open-source icon sets (Material
 * Design Icons, Font Awesome, Simple Icons for real brand/product
 * logos, etc.), served as SVG. @napi-rs/canvas's OWN built-in SVG
 * decoder was measured directly to be broken for actual path content
 * (loads correct dimensions but rasterizes to fully transparent - 0
 * non-transparent pixels on a real test icon), so every icon is
 * rasterized here via resvg-js (a real, accurate, dependency-free SVG
 * renderer) BEFORE ever reaching the render engine's normal image-
 * loading path, which only ever needs to handle real raster PNGs.
 *
 * Every distinct icon+color pairing used anywhere in the whole video
 * is fetched/rasterized exactly ONCE (deduped by cache key) even if
 * referenced by many layers across many beats - a real, common case
 * (e.g. the same brand logo reused as a recurring motif).
 */

function iconsDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-icons`);
}

/**
 * Finds the largest scale value a layer's own "scale" track ever
 * reaches, across every shape that field can take in this schema - a
 * plain [x,y] array (never animated), a {keyframes:[...]} track (each
 * keyframe's own value inspected, not just the first/last), or a
 * {expression, base} wiggle wrapper (recurses into "base", then adds a
 * fixed safety margin for the wiggle's own additive contribution -
 * every wiggle amplitude actually used across this codebase's mograph
 * templates is small, 0.05-0.15, so a flat 15% margin comfortably
 * covers it without needing a real expression evaluator here). Falls
 * back to 1 (no upscale headroom needed) for anything unparseable.
 */
function getMaxScaleFactor(layer) {
  const track = layer && layer.scale;
  if (!track) return 1;
  if (Array.isArray(track)) return Math.max(1, ...track.filter((v) => typeof v === 'number'));
  if (typeof track !== 'object') return 1;
  if (Array.isArray(track.keyframes)) {
    let max = 1;
    for (const kf of track.keyframes) {
      if (!kf) continue;
      if (Array.isArray(kf.value)) max = Math.max(max, ...kf.value.filter((v) => typeof v === 'number'));
      else if (typeof kf.value === 'number') max = Math.max(max, kf.value);
    }
    return max;
  }
  if (typeof track.expression === 'string') return getMaxScaleFactor({ scale: track.base }) * 1.15;
  return 1;
}

/** Recursively collects every layer (including inside precomps) still needing a real Iconify fetch. */
function collectIconLayers(layers, out) {
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    if (layer.type === 'image' && typeof layer.icon === 'string' && layer.icon.trim()) out.push(layer);
    if (layer.type === 'precomp') collectIconLayers(layer.layers, out);
  }
}

/** Recursively collects layers that already carry pre-resolved icon bytes (embedIconDataInScene's own output) - these need only a local decode+write, never a network call. */
function collectEmbeddedIconLayers(layers, out) {
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    if (layer.type === 'image' && typeof layer.iconDataBase64 === 'string' && layer.iconDataBase64) out.push(layer);
    if (layer.type === 'precomp') collectEmbeddedIconLayers(layer.layers, out);
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Real, confirmed-live finding (2026-09-10): the work-stealing render
// pool (server.js's renderWithPossibleHelp) fires many independent
// icon-prefetch passes for one job in quick succession, from several
// different worker IPs - Iconify's own rate limiting (HTTP 429) showed
// up across the majority of icons in a real production run once that
// shipped (see embedIconDataInScene's own doc comment for the actual
// fix - this retry is a second, independent safety net, not the primary
// fix, since the real solution is fetching each icon far less often in
// the first place). Exponential backoff with jitter so several workers
// retrying around the same moment don't all collide on the same retry
// schedule.
const ICONIFY_429_MAX_ATTEMPTS = 4;
async function fetchAndRasterizeIcon(iconName, color, sizePx) {
  const [prefix, ...nameParts] = iconName.split(':');
  const name = nameParts.join(':');
  if (!prefix || !name) throw new Error(`icon "${iconName}" must be "prefix:name" (e.g. "mdi:rocket-launch")`);
  const url = `https://api.iconify.design/${encodeURIComponent(prefix)}/${encodeURIComponent(name)}.svg${color ? `?color=${encodeURIComponent(color)}` : ''}`;

  for (let attempt = 1; attempt <= ICONIFY_429_MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, { timeout: 10000 });
    if (response.status === 429) {
      if (attempt < ICONIFY_429_MAX_ATTEMPTS) {
        await sleep(400 * 2 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      throw new Error(`Iconify returned 429 for "${iconName}" after ${attempt} attempt(s)`);
    }
    if (!response.ok) throw new Error(`Iconify returned ${response.status} for "${iconName}"`);
    const svgText = await response.text();
    if (!svgText.trim().startsWith('<svg')) throw new Error(`Iconify did not return an SVG for "${iconName}" (unknown icon name)`);
    const resvg = new Resvg(svgText, { fitTo: { mode: 'width', value: Math.max(32, Math.round(sizePx)) } });
    return resvg.render().asPng();
  }
  throw new Error(`Iconify returned 429 for "${iconName}" after ${ICONIFY_429_MAX_ATTEMPTS} attempts`); // unreachable, satisfies linters expecting a return/throw on every path
}

/**
 * Real, confirmed-live bug fixed here (2026-09-10, direct user report
 * with the actual video attached showing multiple beats' icons as
 * blank circles): the work-stealing render pool (server.js's
 * renderWithPossibleHelp) dispatches ONE chunk per HTTP request rather
 * than a whole job's worth at once, and each such request independently
 * ran the old prefetchIcons on the FULL scene JSON - every icon across
 * every beat, not just the ones that chunk's own 3-second time range
 * touches. A 7-chunk video with ~15 distinct icons meant up to 7x that
 * many Iconify requests, fired from up to 5 different worker IPs within
 * a few seconds of each other - confirmed directly via live production
 * logs to trigger Iconify's own rate limiting (HTTP 429) on the
 * majority of icons requested, which the existing "render without it"
 * fallback then turned into visibly blank icon circles across multiple
 * beats in the final video.
 *
 * Fixed by resolving every distinct icon EXACTLY ONCE per job, before
 * any chunk-level work begins (see server.js's own call site), and
 * embedding the resulting PNG bytes directly into the scene JSON
 * (`iconDataBase64`) - portable across every worker regardless of whose
 * disk originally fetched it, unlike the icon-raw-until-render design
 * this replaces for icons specifically. Same cache-key grouping/sizing
 * logic prefetchIcons below already used, just returning bytes for
 * embedding instead of writing to a job-specific local file.
 */
async function embedIconDataInScene(sceneJSON) {
  const iconLayers = [];
  const renderScenes = sceneJSON.scenes.map((scene) => JSON.parse(JSON.stringify(scene)));
  renderScenes.forEach((scene) => collectIconLayers(scene.visual?.layers, iconLayers));
  if (iconLayers.length === 0) return { ...sceneJSON, scenes: renderScenes };

  const groups = new Map();
  for (const layer of iconLayers) {
    const baseSizePx = Math.max(typeof layer.width === 'number' ? layer.width : 0, typeof layer.height === 'number' ? layer.height : 0) || 256;
    const sizePx = Math.min(800, Math.round(baseSizePx * getMaxScaleFactor(layer)));
    const cacheKey = `${layer.icon}|${layer.iconColor || ''}|${sizePx}`;
    if (!groups.has(cacheKey)) groups.set(cacheKey, { icon: layer.icon, iconColor: layer.iconColor, sizePx, layers: [] });
    groups.get(cacheKey).layers.push(layer);
  }

  await Promise.allSettled([...groups.values()].map(async (group) => {
    try {
      const png = await fetchAndRasterizeIcon(group.icon, group.iconColor, group.sizePx * 2);
      const base64 = png.toString('base64');
      for (const layer of group.layers) layer.iconDataBase64 = base64;
    } catch (err) {
      console.warn(`[iconFetch] icon "${group.icon}" failed, ${group.layers.length} layer(s) will render without it: ${err.message}`);
    }
  }));

  for (const layer of iconLayers) { delete layer.icon; delete layer.iconColor; }
  return { ...sceneJSON, scenes: renderScenes };
}

/**
 * Returns a NEW sceneJSON-shaped object, same non-mutating contract as
 * prefetchBeatImages - the original (with semantic "icon" fields
 * intact, no local paths) is what gets persisted/fed back as edit
 * context.
 *
 * Two paths, handled together so this stays a safe drop-in wherever it
 * was already called: layers already carrying `iconDataBase64` (see
 * embedIconDataInScene above) get a pure local decode+write, no network
 * call at all; any layer that STILL has a raw `icon` field (a caller
 * that never ran embedIconDataInScene first) falls back to fetching it
 * directly from Iconify, exactly as this function always has.
 */
async function prefetchIcons(sceneJSON, jobId) {
  const embeddedLayers = [];
  const iconLayers = [];
  const renderScenes = sceneJSON.scenes.map((scene) => JSON.parse(JSON.stringify(scene)));
  renderScenes.forEach((scene) => {
    collectEmbeddedIconLayers(scene.visual?.layers, embeddedLayers);
    collectIconLayers(scene.visual?.layers, iconLayers);
  });

  if (embeddedLayers.length === 0 && iconLayers.length === 0) return { ...sceneJSON, scenes: renderScenes };

  const dir = iconsDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });
  let counter = 0;

  if (embeddedLayers.length > 0) {
    // Dedup by the base64 payload itself - several layers commonly
    // share the exact same embedded icon (the "same icon reused across
    // layers" case this file's own dedup has always cared about).
    const byPayload = new Map();
    for (const layer of embeddedLayers) {
      if (!byPayload.has(layer.iconDataBase64)) byPayload.set(layer.iconDataBase64, []);
      byPayload.get(layer.iconDataBase64).push(layer);
    }
    for (const [base64, layers] of byPayload) {
      const filePath = path.join(dir, `icon-${counter++}.png`);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      for (const layer of layers) { layer.src = filePath; delete layer.iconDataBase64; }
    }
  }

  if (iconLayers.length > 0) {
    // Legacy/fallback path - see this function's own doc comment above.
    // Grouped by cache key BEFORE any fetch starts - real bug this
    // avoids: firing one fetch per LAYER (via a plain .map over
    // iconLayers) would race every layer sharing the same icon+color+
    // size against an empty cache simultaneously (Promise.allSettled
    // starts every entry before any has a chance to populate the cache),
    // so the "same icon reused across several layers" dedup this exists
    // for would silently never trigger. Grouping first means exactly
    // one fetch per DISTINCT key, applied to every layer that shares it.
    const groups = new Map(); // cacheKey -> { icon, iconColor, sizePx, layers: [...] }
    for (const layer of iconLayers) {
      const baseSizePx = Math.max(typeof layer.width === 'number' ? layer.width : 0, typeof layer.height === 'number' ? layer.height : 0) || 256;
      const sizePx = Math.min(800, Math.round(baseSizePx * getMaxScaleFactor(layer)));
      const cacheKey = `${layer.icon}|${layer.iconColor || ''}|${sizePx}`;
      if (!groups.has(cacheKey)) groups.set(cacheKey, { icon: layer.icon, iconColor: layer.iconColor, sizePx, layers: [] });
      groups.get(cacheKey).layers.push(layer);
    }

    await Promise.allSettled([...groups.values()].map(async (group) => {
      try {
        const png = await fetchAndRasterizeIcon(group.icon, group.iconColor, group.sizePx * 2); // 2x for crisp downscale
        const filePath = path.join(dir, `icon-${counter++}.png`);
        fs.writeFileSync(filePath, png);
        for (const layer of group.layers) layer.src = filePath;
      } catch (err) {
        console.warn(`[iconFetch] icon "${group.icon}" failed, ${group.layers.length} layer(s) will render without it: ${err.message}`);
      }
    }));

    for (const layer of iconLayers) { delete layer.icon; delete layer.iconColor; }
  }

  return { ...sceneJSON, scenes: renderScenes };
}

function cleanupIcons(jobId) {
  fs.rm(iconsDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchIcons, embedIconDataInScene, cleanupIcons };
