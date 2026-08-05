// Remotion entry point for the (future) paid export pipeline.
// The free preview never touches this file or this pipeline at all —
// that's rendered live in the browser instead. This is only used by
// /api/export in server.js, via @remotion/bundler + @remotion/renderer.
import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';

registerRoot(RemotionRoot);
