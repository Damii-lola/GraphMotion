// This file is overwritten at request time by /api/render in server.js.
// It ships with a placeholder scene so the project renders correctly
// out of the box, before any AI generation happens.
//
// Scene syntax follows Motion Canvas conventions (generator functions,
// makeScene2D, createRef, tweening) — Revideo is a compatible fork,
// so this is also what GraphMotion asks Mistral to generate.
import {makeScene2D, Txt} from '@revideo/2d';
import {createRef, waitFor} from '@revideo/core';

export default makeScene2D('generated', function* (view) {
  view.fill('#0B0C10');

  const title = createRef<Txt>();
  view.add(
    <Txt
      ref={title}
      fill={'#F2F1EC'}
      fontSize={72}
      fontFamily={'Space Grotesk, sans-serif'}
      opacity={0}
    >
      GraphMotion
    </Txt>,
  );

  yield* title().opacity(1, 0.8);
  yield* waitFor(1);
});
