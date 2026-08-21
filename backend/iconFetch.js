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

/** Recursively collects every layer (including inside precomps) needing icon resolution. */
function collectIconLayers(layers, out) {
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    if (layer.type === 'image' && typeof layer.icon === 'string' && layer.icon.trim()) out.push(layer);
    if (layer.type === 'precomp') collectIconLayers(layer.layers, out);
  }
}

async function fetchAndRasterizeIcon(iconName, color, sizePx) {
  const [prefix, ...nameParts] = iconName.split(':');
  const name = nameParts.join(':');
  if (!prefix || !name) throw new Error(`icon "${iconName}" must be "prefix:name" (e.g. "mdi:rocket-launch")`);
  const url = `https://api.iconify.design/${encodeURIComponent(prefix)}/${encodeURIComponent(name)}.svg${color ? `?color=${encodeURIComponent(color)}` : ''}`;
  const response = await fetch(url, { timeout: 10000 });
  if (!response.ok) throw new Error(`Iconify returned ${response.status} for "${iconName}"`);
  const svgText = await response.text();
  if (!svgText.trim().startsWith('<svg')) throw new Error(`Iconify did not return an SVG for "${iconName}" (unknown icon name)`);
  const resvg = new Resvg(svgText, { fitTo: { mode: 'width', value: Math.max(32, Math.round(sizePx)) } });
  return resvg.render().asPng();
}

/**
 * Returns a NEW sceneJSON-shaped object, same non-mutating contract as
 * prefetchBeatImages - the original (with semantic "icon" fields
 * intact, no local paths) is what gets persisted/fed back as edit
 * context.
 */
async function prefetchIcons(sceneJSON, jobId) {
  const iconLayers = [];
  const renderScenes = sceneJSON.scenes.map((scene) => JSON.parse(JSON.stringify(scene)));
  renderScenes.forEach((scene) => collectIconLayers(scene.visual?.layers, iconLayers));

  if (iconLayers.length === 0) return { ...sceneJSON, scenes: renderScenes };

  const dir = iconsDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });

  // Grouped by cache key BEFORE any fetch starts - real bug this
  // avoids: firing one fetch per LAYER (via a plain .map over
  // iconLayers) would race every layer sharing the same icon+color+
  // size against an empty cache simultaneously (Promise.allSettled
  // starts every entry before any has a chance to populate the cache),
  // so the "same icon reused across several layers" dedup this exists
  // for would silently never trigger. Grouping first means exactly one
  // fetch per DISTINCT key, applied to every layer that shares it.
  const groups = new Map(); // cacheKey -> { icon, iconColor, sizePx, layers: [...] }
  for (const layer of iconLayers) {
    const sizePx = Math.max(typeof layer.width === 'number' ? layer.width : 0, typeof layer.height === 'number' ? layer.height : 0) || 256;
    const cacheKey = `${layer.icon}|${layer.iconColor || ''}|${sizePx}`;
    if (!groups.has(cacheKey)) groups.set(cacheKey, { icon: layer.icon, iconColor: layer.iconColor, sizePx, layers: [] });
    groups.get(cacheKey).layers.push(layer);
  }

  let counter = 0;
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

  return { ...sceneJSON, scenes: renderScenes };
}

function cleanupIcons(jobId) {
  fs.rm(iconsDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchIcons, cleanupIcons };
