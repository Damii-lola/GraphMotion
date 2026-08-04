// Revideo project entry point.
// renderVideo() in server.js points at this file via `projectFile`.
//
// Docs: https://docs.re.video/project-structure/
import {makeProject} from '@revideo/core';

import generated from './scenes/generated';

export default makeProject({
  scenes: [generated],
});
