import {Composition} from 'remotion';
import {GeneratedScene} from './GeneratedScene';

// Same dimensions/duration budget as the client-side preview, so an
// exported video matches what the person already previewed for free.
export const RemotionRoot = () => {
  return (
    <Composition
      id="generated"
      component={GeneratedScene}
      durationInFrames={240}
      fps={30}
      width={1080}
      height={1920}
    />
  );
};
