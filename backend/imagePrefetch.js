const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateImage } = require('./imageGen');

function imagesDirFor(jobId) {
  return path.join(os.tmpdir(), 'shortform-renders', `${jobId}-images`);
}

/**
 * Resolves every beat's optional `imagePrompt` into a local `imagePath`,
 * fetched in PARALLEL (bounds total added latency to roughly one
 * timeout window, not the sum of every image) via Pollinations.ai.
 *
 * Returns a NEW sceneJSON-shaped object - the caller's original is
 * never touched. This matters: the original is what gets persisted to
 * Supabase and fed back to Mistral as edit context, and neither of
 * those should ever see a local temp file path (meaningless once the
 * job's temp dir is cleaned up, and would just confuse a future edit
 * prompt).
 *
 * A failed/timed-out image is not an error here - that beat simply
 * ends up with no `imagePath`, and the renderer already knows to fall
 * back to the normal procedural hero visual for any beat without one.
 * Pollinations is free and unauthenticated; treating its failure as
 * routine, not exceptional, is the actual design, not a gap.
 */
// iconCallout/badgeUnlock always draw their own inline icon and never
// consult the resolved image map (see TEMPLATES_WITH_OWN_ICON in
// renderEngine.js) - skipping them here avoids burning a fetch against
// a free, rate-limit-sensitive service on an image that could never be
// shown, regardless of whether Mistral followed the schema's guidance.
const TEMPLATES_WITHOUT_IMAGE_SUPPORT = new Set(['iconCallout', 'badgeUnlock']);

async function prefetchBeatImages(sceneJSON, jobId) {
  const scenesWithPrompts = sceneJSON.scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => !TEMPLATES_WITHOUT_IMAGE_SUPPORT.has(scene.template)
      && typeof scene.params?.imagePrompt === 'string' && scene.params.imagePrompt.trim().length > 0);

  const renderScenes = sceneJSON.scenes.map((scene) => ({ ...scene, params: { ...scene.params } }));

  if (scenesWithPrompts.length === 0) {
    return { ...sceneJSON, scenes: renderScenes };
  }

  const dir = imagesDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });

  const results = await Promise.allSettled(
    scenesWithPrompts.map(({ scene }) => generateImage(scene.params.imagePrompt.trim())),
  );

  results.forEach((result, i) => {
    const { index } = scenesWithPrompts[i];
    if (result.status !== 'fulfilled') {
      console.warn(`[imagePrefetch] beat ${index} image failed, falling back to procedural: ${result.reason?.message || result.reason}`);
      return;
    }
    const filePath = path.join(dir, `${index}.jpg`);
    fs.writeFileSync(filePath, result.value);
    renderScenes[index].params.imagePath = filePath;
  });

  return { ...sceneJSON, scenes: renderScenes };
}

function cleanupBeatImages(jobId) {
  fs.rm(imagesDirFor(jobId), { recursive: true, force: true }, () => {});
}

module.exports = { prefetchBeatImages, cleanupBeatImages };
