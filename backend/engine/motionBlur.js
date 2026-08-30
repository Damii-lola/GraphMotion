const { createCanvas } = require('@napi-rs/canvas');
const { clamp01 } = require('./mathUtils');

/**
 * Real sub-frame accumulation motion blur - not a directional-streak
 * approximation. This directly reuses the SAME timeline every other
 * animated thing in the engine already samples (a Node's transform, a
 * Property's keyframes): motion blur here is just "render this exact
 * content at N nearby moments in time and average the results," which
 * needs no separate velocity-tracking machinery because Property/Node
 * can already be evaluated at any t for free.
 *
 * shutterAngle/shutterPhase/samples match After Effects' own controls
 * directly: shutterAngle is how much of the frame's own duration the
 * "shutter" stays open (360deg = the full frame duration, maximum
 * blur; 180deg = half, the classic film-camera default; 0deg = none).
 * shutterPhase offsets WHERE in the frame that window sits - AE's own
 * default of -90deg centers the exposure window on the frame's
 * nominal time, rather than trailing entirely behind it.
 *
 * Each sub-sample renders to its OWN fresh offscreen canvas (not
 * shared global alpha state) specifically so drawFn is free to set its
 * own internal opacity/compositing without an outer "blur alpha"
 * silently getting clobbered - the two concerns (this sample's own
 * true rendered appearance vs. how much this sample contributes to
 * the final average) are kept genuinely independent. The accumulation
 * itself (alpha = 1/k for the k-th of N samples, composited via plain
 * source-over) is the standard, exact technique for a true running
 * average over sequential draws - not an approximation: after the
 * k-th draw the accumulator holds precisely the mean of samples
 * 1..k, provably by induction (the k-th blend computes
 * newAvg = sample_k/k + oldAvg*(k-1)/k, which IS the running-mean
 * update formula).
 */
/**
 * Memory note: `drawFn` here is a beat's entire layer stack
 * (renderLayerStack), and this loop calls it once per sample (4, by
 * this engine's own config) for ONE output frame - see layerStack.js's
 * own doc comment on renderLayerStack for the full multiplication this
 * created. `sampleCanvas` is pooled the same way (allocated once,
 * cleared and reused per sample) rather than createCanvas()'d fresh
 * each iteration, for the identical reason.
 */
function renderWithMotionBlur(ctx, width, height, t, frameDuration, drawFn, config = {}) {
  const { enabled = true, shutterAngle = 180, shutterPhase = -90, samples = 8 } = config;

  if (!enabled || shutterAngle <= 0 || samples <= 1) {
    drawFn(ctx, t);
    return;
  }

  const shutterFraction = clamp01(shutterAngle / 360);
  const phaseFraction = shutterPhase / 360;
  const windowStart = t + phaseFraction * frameDuration;
  const windowDuration = shutterFraction * frameDuration;

  const sampleCanvas = createCanvas(width, height);
  const sampleCtx = sampleCanvas.getContext('2d');

  for (let k = 1; k <= samples; k++) {
    // Sample times centered within each of `samples` equal sub-slices
    // of the shutter window, not just evenly spaced points touching
    // the edges - matches how real sub-frame accumulation renderers
    // distribute samples for the least biased average.
    const sampleT = windowStart + ((k - 0.5) / samples) * windowDuration;

    sampleCtx.clearRect(0, 0, width, height);
    drawFn(sampleCtx, sampleT);

    ctx.save();
    ctx.globalAlpha = 1 / k;
    ctx.drawImage(sampleCanvas, 0, 0);
    ctx.restore();
  }
}

/** The exact sample times a given config would use - exposed standalone so the distribution itself is directly testable without rendering anything. */
function getSampleTimes(t, frameDuration, config = {}) {
  const { shutterAngle = 180, shutterPhase = -90, samples = 8 } = config;
  const shutterFraction = clamp01(shutterAngle / 360);
  const phaseFraction = shutterPhase / 360;
  const windowStart = t + phaseFraction * frameDuration;
  const windowDuration = shutterFraction * frameDuration;
  const times = [];
  for (let k = 1; k <= samples; k++) {
    times.push(windowStart + ((k - 0.5) / samples) * windowDuration);
  }
  return times;
}

module.exports = { renderWithMotionBlur, getSampleTimes };
