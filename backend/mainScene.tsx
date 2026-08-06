import { makeScene2D, Rect } from '@revideo/2d';
import { createRef, waitFor } from '@revideo/core';
import { renderTemplate } from './templateRenderers';
import { playTransition } from './transitionRenderers';

/**
 * This is the ONLY scene in the project. It never contains hardcoded
 * content - it reads `sceneJSON` (validated by sceneTemplates.js on the
 * backend before render time) and plays each scene block in order,
 * running the matching transition between them.
 *
 * Mistral / the backend never touch this file. It is the fixed
 * choreography engine - content flows in as data only.
 */
export const mainScene = makeScene2D('main', function* (view) {
  const sceneJSON = view.variables.get('sceneJSON', { scenes: [] })();

  // Root container all templates render into. Kept as a ref so
  // transitions can grab/animate the whole current scene as one unit.
  const stage = createRef<Rect>();
  view.add(
    <Rect ref={stage} width={'100%'} height={'100%'} fill={'#0A0A0B'} clip />
  );

  // Ambient atmosphere layer - subtle grain/particle drift that runs
  // for the entire video underneath every scene, per the "constant
  // secondary motion" rule. Implemented once here, not per-template.
  yield* ambientAtmosphere(stage());

  for (let i = 0; i < sceneJSON.scenes.length; i++) {
    const block = sceneJSON.scenes[i];

    if (i > 0 && block.transition) {
      yield* playTransition(block.transition, stage());
    }

    yield* renderTemplate(block.template, block.params, stage());
  }
});

function* ambientAtmosphere(stage: Rect) {
  // Intentionally a no-op yield placeholder here - actual grain/particle
  // nodes are added once to `stage` as background children with looping
  // tweens in a real build. Kept minimal in this scaffold so the file
  // stays readable; see templateRenderers.tsx for the pattern to extend.
  yield* waitFor(0);
}
