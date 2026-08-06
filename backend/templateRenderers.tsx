import { Rect, Txt, Circle, Line, Layout } from '@revideo/2d';
import {
  createRef,
  all,
  waitFor,
  easeOutBack,
  easeOutCubic,
  easeInOutCubic,
  easeOutExpo,
} from '@revideo/core';

/**
 * ---------------------------------------------------------------
 * FLAIR RULES (apply to every template below, never optional):
 *   1. Multi-property choreography, never a single opacity fade.
 *   2. Overshoot/spring easing on entrances, never linear.
 *   3. A secondary "settle" motion after the primary motion lands.
 *   4. Something is always still moving (glow pulse, drift) while
 *      text/shape is "static" on screen.
 * ---------------------------------------------------------------
 */

export function* renderTemplate(name: string, params: any, stage: Rect) {
  switch (name) {
    case 'kineticTextReveal':
      yield* kineticTextReveal(params, stage);
      break;
    case 'shapeReveal':
      yield* shapeReveal(params, stage);
      break;
    case 'statCounter':
      yield* statCounter(params, stage);
      break;
    // splitCompare, iconCallout, imageRevealZoom follow the exact same
    // structure as the three below (createRef -> add with initial
    // "pre-motion" props -> all() choreographed tween -> settle -> hold
    // -> cleanup). Build these the same way when you extend the set.
    default:
      throw new Error(`No renderer implemented for template "${name}"`);
  }
}

function* kineticTextReveal(params: any, stage: Rect) {
  const { text, style, duration } = params;
  const txt = createRef<Txt>();

  const glowColor = style === 'glitch' ? '#FF2E6C' : '#FF5C1A';

  stage.add(
    <Txt
      ref={txt}
      text={text}
      fontSize={72}
      fontWeight={800}
      fill={'#F5F5F5'}
      textAlign={'center'}
      width={'80%'}
      x={0}
      y={0}
      opacity={0}
      scale={1.35}
      filters={[]} // blur handled via built-in blur filter helper in a full build
      shadowColor={glowColor}
      shadowBlur={0}
    />
  );

  // Entrance: blur->sharp (approximated here via scale+opacity since blur
  // filter wiring depends on your @revideo/2d version's filter API),
  // scale overshoot, glow ramps in slightly AFTER text lands (secondary motion).
  yield* all(
    txt().opacity(1, duration * 0.35, easeOutCubic),
    txt().scale(1, duration * 0.45, easeOutBack),
  );

  yield* txt().shadowBlur(28, duration * 0.25, easeOutExpo);

  // Idle hold with a slow continuous glow pulse so the frame never
  // goes fully static while the text sits on screen.
  const holdTime = Math.max(0, duration - duration * 0.6);
  yield* all(
    txt().shadowBlur(40, holdTime / 2, easeInOutCubic),
    waitFor(holdTime / 2),
  );

  txt().remove();
}

function* shapeReveal(params: any, stage: Rect) {
  const { shape, motion, color, duration } = params;
  const node = createRef<Circle | Rect | Line>();

  const commonProps = {
    ref: node as any,
    fill: color,
    opacity: 0,
    scale: 0.2,
    x: 0,
    y: 0,
  };

  if (shape === 'circle' || shape === 'blob') {
    stage.add(<Circle {...commonProps} size={260} />);
  } else if (shape === 'square') {
    stage.add(<Rect {...commonProps} size={220} radius={24} />);
  } else {
    stage.add(<Line {...commonProps} points={[[-200, 0], [200, 0]]} lineWidth={10} />);
  }

  // Entrance: pop with overshoot, never a plain scale-to-1.
  yield* all(
    (node() as any).opacity(1, duration * 0.3, easeOutCubic),
    (node() as any).scale(1.15, duration * 0.35, easeOutBack),
  );
  yield* (node() as any).scale(1, duration * 0.15, easeOutCubic);

  // Motion variant drives the "hold" behavior - this is where the
  // literal user request ("dynamic circle") gets its personality.
  const holdTime = duration * 0.5;
  if (motion === 'pulse') {
    yield* all(
      (node() as any).scale(1.08, holdTime / 2, easeInOutCubic),
      (node() as any).scale(1, holdTime / 2, easeInOutCubic),
    );
  } else if (motion === 'orbit') {
    yield* (node() as any).rotation(360, holdTime, easeInOutCubic);
  } else if (motion === 'grow') {
    yield* (node() as any).scale(1.6, holdTime, easeOutExpo);
  } else if (motion === 'morph') {
    yield* all(
      (node() as any).scale(1.3, holdTime / 2, easeInOutCubic),
      (node() as any).scale(0.9, holdTime / 2, easeInOutCubic),
    );
  }

  (node() as any).remove();
}

function* statCounter(params: any, stage: Rect) {
  const { label, fromValue, toValue, suffix, duration } = params;
  const numTxt = createRef<Txt>();
  const labelTxt = createRef<Txt>();
  const wrap = createRef<Layout>();

  stage.add(
    <Layout ref={wrap} direction={'column'} alignItems={'center'} gap={12} opacity={0} y={20}>
      <Txt ref={numTxt} text={`${fromValue}${suffix}`} fontSize={96} fontWeight={900} fill={'#F5F5F5'} shadowColor={'#FF5C1A'} shadowBlur={0} />
      <Txt ref={labelTxt} text={label} fontSize={32} fontWeight={500} fill={'#B5B5B8'} />
    </Layout>
  );

  yield* all(
    wrap().opacity(1, duration * 0.25, easeOutCubic),
    wrap().y(0, duration * 0.3, easeOutBack),
  );

  // Count-up drives the number itself, not just a fade - this is the
  // template's built-in "content is the animation" flair.
  const steps = 24;
  const stepTime = (duration * 0.45) / steps;
  for (let s = 1; s <= steps; s++) {
    const eased = easeOutExpo(s / steps);
    const current = Math.round(fromValue + (toValue - fromValue) * eased);
    numTxt().text(`${current}${suffix}`);
    yield* waitFor(stepTime);
  }
  numTxt().text(`${toValue}${suffix}`);

  yield* numTxt().shadowBlur(30, duration * 0.15, easeOutExpo);
  yield* waitFor(duration * 0.15);

  wrap().remove();
}
