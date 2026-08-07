import { Rect, Circle } from '@revideo/2d';
import { createRef, all, easeInOutCubic, easeOutCubic, easeOutExpo, easeInExpo } from '@revideo/core';

export function* playTransition(name: string, stage: Rect) {
  switch (name) {
    case 'glitchWipe':
      yield* glitchWipe(stage);
      break;
    case 'lightStreakDrag':
      yield* lightStreakDrag(stage);
      break;
    case 'morphCut':
      yield* morphCut(stage);
      break;
    case 'whipPanBlur':
      yield* whipPanBlur(stage);
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

function* lightStreakDrag(stage: Rect) {
  const streak = createRef<Rect>();
  const cover = createRef<Rect>();

  // A bright, elongated streak drags across - distinct from glitchWipe
  // via a single warm-white bar with a stretched "motion trail" shape
  // (scale.x pulled long during travel, snapping back to normal at rest)
  // instead of a flat colored wipe.
  stage.add(<Rect ref={streak} fill={'#FFFFFF'} width={40} height={'140%'} x={-1100} y={0} opacity={0} scale={1} />);
  stage.add(<Rect ref={cover} fill={'#0A0A0B'} width={'120%'} height={'100%'} x={-1200} opacity={1} />);

  yield* all(
    streak().opacity(0.9, 0.08, easeOutExpo),
    streak().scale.x(6, 0.08, easeOutExpo),
  );
  yield* all(
    streak().x(0, 0.22, easeInExpo),
    streak().scale.x(14, 0.22, easeInExpo),
    cover().x(-60, 0.22, easeInExpo),
  );
  yield* all(
    cover().x(0, 0.05, easeOutCubic),
    streak().opacity(0, 0.12, easeOutCubic),
    streak().x(300, 0.18, easeOutExpo),
  );
  yield* cover().x(1200, 0.2, easeInOutCubic);

  streak().remove();
  cover().remove();
}

function* morphCut(stage: Rect) {
  const iris = createRef<Circle>();

  // Iris/morph wipe: a shape expands from a point to swallow the whole
  // frame, holds briefly at full coverage (the actual "cut" point where
  // the incoming scene's first frame is technically already underneath),
  // then contracts away - distinct silhouette-based transition rather
  // than a directional bar.
  stage.add(<Circle ref={iris} fill={'#0A0A0B'} size={0} x={0} y={0} opacity={1} />);

  yield* iris().size(2600, 0.32, easeInExpo);
  yield* iris().opacity(1, 0.06); // hold frame at full coverage
  yield* all(
    iris().size(0, 0.3, easeOutExpo),
    iris().opacity(1, 0.3),
  );

  iris().remove();
}

function* whipPanBlur(stage: Rect) {
  const bandA = createRef<Rect>();
  const bandB = createRef<Rect>();

  // Fast directional streaks stretched heavily on x to mimic motion-blur
  // pan, two staggered bands rather than one solid wipe so it reads as
  // "camera whip" instead of "curtain closing".
  stage.add(<Rect ref={bandA} fill={'#0A0A0B'} width={'10%'} height={'100%'} x={-1000} opacity={0.9} scale={1} />);
  stage.add(<Rect ref={bandB} fill={'#1a1a1c'} width={'10%'} height={'100%'} x={-1300} opacity={0.7} scale={1} />);

  yield* all(
    bandA().x(0, 0.14, easeInExpo),
    bandA().scale.x(12, 0.14, easeInExpo),
    bandB().x(0, 0.18, easeInExpo),
    bandB().scale.x(16, 0.18, easeInExpo),
  );
  yield* all(
    bandA().x(1000, 0.16, easeOutExpo),
    bandA().scale.x(1, 0.16, easeOutExpo),
    bandB().x(1300, 0.2, easeOutExpo),
    bandB().scale.x(1, 0.2, easeOutExpo),
  );

  bandA().remove();
  bandB().remove();
}
