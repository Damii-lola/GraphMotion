import { makeProject } from '@revideo/core';
import { mainScene } from './mainScene';

// Single dynamic scene. The actual content is driven entirely by the
// `sceneJSON` variable passed in at render time (see renderService.js).
// This keeps the project itself static/reviewable while the content
// is fully data-driven from Mistral's output.
export default makeProject({
  scenes: [mainScene],
});
