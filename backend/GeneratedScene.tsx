// Overwritten at export time by /api/export in server.js with whatever
// code Mistral generated for that prompt — the exact same generated
// code the person already previewed live in the browser for free.
import {AbsoluteFill, useCurrentFrame, interpolate} from 'remotion';

export function GeneratedScene() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{backgroundColor: '#0A0A0A', justifyContent: 'center', alignItems: 'center'}}>
      <div style={{opacity, color: '#F5F1E8', fontSize: 64, fontFamily: 'sans-serif', fontWeight: 700}}>
        GraphMotion
      </div>
    </AbsoluteFill>
  );
}
