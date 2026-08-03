import {defineConfig} from 'vite';
import motionCanvas from '@revideo/vite-plugin';

// If your installed @revideo version renamed this package, check
// https://docs.re.video for the current plugin import — Revideo tracks
// Motion Canvas's plugin API closely but package names have moved before.
export default defineConfig({
  plugins: [motionCanvas()],
});
