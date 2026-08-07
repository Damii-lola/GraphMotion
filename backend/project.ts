import { makeProject } from '@revideo/core';
import { mainScene } from './mainScene';

// Single dynamic scene. The actual content is driven entirely by the
// `sceneJSON` variable passed in at render time (see renderService.js).
// This keeps the project itself static/reviewable while the content
// is fully data-driven from Mistral's output.
//
// Resolution/fps set explicitly and DELIBERATELY LOWER than a typical
// full-HD short-form export (1080x1920 @ 30fps). Frame buffer memory
// scales with width x height, so 720x1280 vs 1080x1920 is a ~55% cut
// in raw pixel memory per frame - a direct, meaningful lever against
// the memory ceiling on a constrained instance, not a cosmetic change.
// Still fully watchable quality for TikTok/Reels/Shorts (platforms
// recompress on upload regardless). Revert to 1080x1920 once running
// on an instance with real headroom.
export default makeProject({
  scenes: [mainScene],
  settings: {
    shared: {
      size: { x: 720, y: 1280 },
    },
    rendering: {
      fps: 24,
    },
  },
});
