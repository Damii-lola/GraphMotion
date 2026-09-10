// Forked ONCE PER JOB by renderWorker.js, the same isolation pattern
// renderChunkWorker.js already uses for the render step itself (see its
// own doc comment). Real, directly measured reason this exists:
// prefetchIcons (iconFetch.js) loads @resvg/resvg-js, a native SVG
// rasterizer, to turn Iconify SVGs into real PNGs before rendering -
// a real, one-time ~26MB jump in the PARENT process's own RSS (85MB ->
// 111MB, confirmed via renderWorker.js's own in-process
// process.memoryUsage() logging), that then sits there completely
// unused for the rest of that job's entire lifetime (rendering and
// muxing never touch resvg-js again once icons are already rasterized
// to disk). A native addon can't be unloaded from a running process
// once required - the only way to actually reclaim that memory is for
// the process that loaded it to exit, which is exactly what isolating
// this one step into its own disposable fork buys back, the same way
// chunk workers already reclaim @napi-rs/canvas's own native memory.

const { prefetchIcons, embedIconDataInScene } = require('./iconFetch');

// mode: 'embed' (2026-09-10, new) runs embedIconDataInScene - resolves
// every distinct icon ONCE per job and returns a sceneJSON with the PNG
// bytes embedded (no jobId, no local file writes - see that function's
// own doc comment for the real Iconify-rate-limit bug this exists to
// fix). Any other/missing mode keeps the ORIGINAL behavior: prefetchIcons
// writes resolved icons to jobId's own local disk directory.
process.on('message', async ({ sceneJSON, jobId, mode }) => {
  try {
    const renderSceneJSON = mode === 'embed' ? await embedIconDataInScene(sceneJSON) : await prefetchIcons(sceneJSON, jobId);
    if (process.send) process.send({ ok: true, renderSceneJSON });
  } catch (err) {
    if (process.send) process.send({ ok: false, error: String((err && err.message) || err) });
  } finally {
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  if (process.send) process.send({ ok: false, error: String((err && err.message) || err) });
  process.exit(1);
});
