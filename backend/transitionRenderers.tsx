import { Rect } from '@revideo/2d';
import { createRef, all, easeInOutCubic, easeOutExpo } from '@revideo/core';

export function* playTransition(name: string, stage: Rect) {
  switch (name) {
    case 'glitchWipe':
      yield* glitchWipe(stage);
      break;
    case 'lightStreakDrag':
    case 'morphCut':
    case 'whipPanBlur':
      // Same construction pattern as glitchWipe: add an overlay node,
      // animate it across the stage with a distinct signature motion
      // (drag/morph/blur-pan respectively), then remove it. Build these
      // the same way when you extend the transition set.
      yield* glitchWipe(stage);
      break;
    default:
      yield* glitchWipe(stage);
  }
}

function* glitchWipe(stage: Rect) {
  const barR = createRef<Rect>();
  const barG = createRef<Rect>();
  const barB = createRef<Rect>();

  // Three offset-colored bars sweep across for an RGB-split glitch feel,
  // matching the ThinkMaps/GraphMotion-era glitch aesthetic already in use.
  stage.add(<Rect ref={barR} fill={'#FF2E6C'} width={'120%'} height={'100%'} x={-1200} opacity={0.55} />);
  stage.add(<Rect ref={barG} fill={'#2EFFD5'} width={'120%'} height={'100%'} x={-1200} opacity={0.4} />);
  stage.add(<Rect ref={barB} fill={'#0A0A0B'} width={'120%'} height={'100%'} x={-1200} opacity={1} />);

  yield* all(
    barB().x(0, 0.28, easeOutExpo),
    barR().x(-20, 0.32, easeOutExpo),
    barG().x(20, 0.36, easeOutExpo),
  );
  yield* all(
    barB().x(1200, 0.22, easeInOutCubic),
    barR().x(1180, 0.24, easeInOutCubic),
    barG().x(1220, 0.24, easeInOutCubic),
  );

  barR().remove();
  barG().remove();
  barB().remove();
}
