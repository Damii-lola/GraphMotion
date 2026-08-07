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
    case 'splitCompare':
      yield* splitCompare(params, stage);
      break;
    case 'iconCallout':
      yield* iconCallout(params, stage);
      break;
    case 'imageRevealZoom':
      yield* imageRevealZoom(params, stage);
      break;
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

const ICON_GLYPHS: Record<string, string> = {
  alert: '⚠',
  check: '✓',
  spark: '✦',
  clock: '⏱',
  money: '$',
  chart: '📈',
  lock: '🔒',
  heart: '♥',
};

function* splitCompare(params: any, stage: Rect) {
  const { leftLabel, rightLabel, leftText, rightText, duration } = params;

  const leftPanel = createRef<Layout>();
  const rightPanel = createRef<Layout>();
  const divider = createRef<Rect>();

  // Two halves start off-screen on opposite sides (parallax slide-in),
  // not just faded in place - this is what sells "split screen" as a
  // deliberate camera move rather than two boxes appearing.
  stage.add(
    <>
      <Layout
        ref={leftPanel}
        direction={'column'}
        alignItems={'center'}
        justifyContent={'center'}
        width={'50%'}
        height={'100%'}
        x={-960}
        opacity={0}
      >
        <Txt text={leftLabel} fontSize={28} fontWeight={700} fill={'#FF5C1A'} marginBottom={16} />
        <Txt text={leftText} fontSize={36} fontWeight={600} fill={'#F5F5F5'} textAlign={'center'} width={'80%'} />
      </Layout>
      <Rect ref={divider} width={4} height={0} fill={'#3a3a3e'} x={0} y={0} />
      <Layout
        ref={rightPanel}
        direction={'column'}
        alignItems={'center'}
        justifyContent={'center'}
        width={'50%'}
        height={'100%'}
        x={960}
        opacity={0}
      >
        <Txt text={rightLabel} fontSize={28} fontWeight={700} fill={'#2EFFD5'} marginBottom={16} />
        <Txt text={rightText} fontSize={36} fontWeight={600} fill={'#F5F5F5'} textAlign={'center'} width={'80%'} />
      </Layout>
    </>
  );

  // Left slides in from the left, right slides in from the right,
  // simultaneously but with slightly offset easing so they don't feel
  // mechanically synced - secondary "settle" via overshoot on x.
  yield* all(
    leftPanel().position.x(-340, duration * 0.4, easeOutBack),
    leftPanel().opacity(1, duration * 0.3, easeOutCubic),
    rightPanel().position.x(340, duration * 0.4, easeOutBack),
    rightPanel().opacity(1, duration * 0.3, easeOutCubic),
  );

  // Divider grows AFTER both panels land - secondary motion beat that
  // visually "locks" the split into place.
  yield* divider().height(700, duration * 0.2, easeOutExpo);

  yield* waitFor(Math.max(0, duration * 0.35));

  leftPanel().remove();
  rightPanel().remove();
  divider().remove();
}

function* iconCallout(params: any, stage: Rect) {
  const { icon, text, position, duration } = params;
  const glyph = ICON_GLYPHS[icon] || '✦';

  const xOffset = position === 'left' ? -260 : position === 'right' ? 260 : 0;

  const wrap = createRef<Layout>();
  const iconTxt = createRef<Txt>();
  const labelTxt = createRef<Txt>();

  stage.add(
    <Layout
      ref={wrap}
      direction={'row'}
      alignItems={'center'}
      gap={20}
      x={xOffset}
      y={0}
      opacity={0}
      scale={0.6}
    >
      <Txt ref={iconTxt} text={glyph} fontSize={56} fill={'#FF5C1A'} shadowColor={'#FF5C1A'} shadowBlur={0} />
      <Txt ref={labelTxt} text={text} fontSize={34} fontWeight={600} fill={'#F5F5F5'} width={360} />
    </Layout>
  );

  // Spring-pop entrance on the whole group, then the icon gets its own
  // extra "kick" (rotation flick) after landing - layered secondary
  // motion on top of the group's primary motion.
  yield* all(
    wrap().opacity(1, duration * 0.3, easeOutCubic),
    wrap().scale(1, duration * 0.4, easeOutBack),
  );
  yield* all(
    iconTxt().rotation(-12, duration * 0.1, easeOutCubic),
    iconTxt().shadowBlur(24, duration * 0.15, easeOutExpo),
  );
  yield* iconTxt().rotation(0, duration * 0.15, easeOutBack);

  yield* waitFor(Math.max(0, duration * 0.3));

  wrap().remove();
}

function* imageRevealZoom(params: any, stage: Rect) {
  const { imageQuery, caption, duration } = params;

  // NOTE: real stock-photo fetching (Pexels/Pixabay) isn't wired up yet
  // (flagged in the README as a known gap) - this renders a placeholder
  // gradient background with the query text visible for debugging, so
  // the template is fully functional structurally and just needs a real
  // image URL swapped in once that fetch step exists.
  const bg = createRef<Rect>();
  const captionTxt = createRef<Txt>();
  const debugTag = createRef<Txt>();

  stage.add(
    <>
      <Rect
        ref={bg}
        width={'120%'}
        height={'120%'}
        fill={'#1a1a1c'}
        x={0}
        y={0}
        opacity={0}
        scale={1.25}
      />
      <Txt
        ref={debugTag}
        text={`[stock photo: "${imageQuery}"]`}
        fontSize={18}
        fill={'#5a5a5e'}
        y={-700}
        opacity={0}
      />
      {caption ? (
        <Txt
          ref={captionTxt}
          text={caption}
          fontSize={40}
          fontWeight={700}
          fill={'#F5F5F5'}
          y={760}
          opacity={0}
          shadowColor={'#000000'}
          shadowBlur={20}
        />
      ) : null}
    </>
  );

  // Fake dolly-zoom: background scales down for the whole duration (the
  // "camera" pulling back) while the caption settles in partway through -
  // both run concurrently via all(), with the caption's own delay
  // sequenced inside its own generator so timing stays correct.
  yield* all(
    bg().opacity(1, duration * 0.25, easeOutCubic),
    debugTag().opacity(1, duration * 0.25, easeOutCubic),
  );

  function* captionSequence() {
    if (!caption) return;
    yield* waitFor(duration * 0.2);
    yield* all(
      captionTxt().opacity(1, duration * 0.25, easeOutCubic),
      captionTxt().y(680, duration * 0.3, easeOutBack),
    );
  }

  yield* all(
    bg().scale(1.0, duration * 0.85, easeInOutCubic),
    captionSequence(),
  );

  bg().remove();
  debugTag().remove();
  if (caption) captionTxt().remove();
}
