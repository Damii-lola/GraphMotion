const { Property } = require('./keyframes');

/**
 * Time remapping, in After Effects, is: a layer's own internal time
 * becomes a keyframeable VALUE, driven by the composition's real time.
 * That's it - it is not a separate mechanism from keyframes.js's
 * Property class, it's an APPLICATION of it, where the thing being
 * animated happens to be "what time to sample" rather than "what
 * position/opacity/color to show." A TimeRemap wraps a Property whose
 * values are themselves time values, and .at(realTime) returns the
 * remapped time to actually sample content at.
 *
 * This generalizes what the old system did by hand, differently, in
 * every single template: holding a beat "frozen" for a stretch, then
 * "punching" through the rest quickly, was never a first-class concept
 * there - it was one-off Math.sin()/clamp01() arithmetic re-derived
 * per effect. Here it is a genuine, reusable, composable primitive:
 * build a remap curve once, apply it to ANY content that takes a
 * "local time" parameter (a hero icon's entrance animation, a camera
 * move, a whole beat), regardless of what that content actually is.
 */
class TimeRemap {
  constructor(property) {
    this.property = property;
  }

  /** Given the real elapsed time, returns the remapped time to sample content at. */
  at(realTime) {
    return this.property.valueAt(realTime);
  }
}

/**
 * Plain passthrough - remapped time equals real time. The default/no-op
 * case, useful as an explicit "nothing special" rather than every
 * caller needing an if/else for "is this beat time-remapped or not."
 */
function identityRemap(duration) {
  return new TimeRemap(new Property([
    { time: 0, value: 0, interpolation: 'linear' },
    { time: duration, value: duration, interpolation: 'linear' },
  ]));
}

/**
 * Freezes on a single instant of source time for the whole real-time
 * span - a genuine freeze-frame (AE: hold a time-remap keyframe flat).
 */
function holdRemap(duration, frozenAt = 0) {
  return new TimeRemap(new Property([
    { time: 0, value: frozenAt, interpolation: 'hold' },
    { time: duration, value: frozenAt, interpolation: 'hold' },
  ]));
}

/**
 * Plays real time in reverse across the span - source time runs from
 * `sourceDuration` down to 0 as real time runs 0 to `duration`.
 */
function reverseRemap(duration, sourceDuration = duration) {
  return new TimeRemap(new Property([
    { time: 0, value: sourceDuration, interpolation: 'linear' },
    { time: duration, value: 0, interpolation: 'linear' },
  ]));
}

/**
 * Wraps real time modulo `innerDuration` - content defined once over a
 * short span repeats seamlessly for as long as the real span lasts
 * (an idle icon animation authored for 2s, looping for however long a
 * beat with narration-driven duration actually holds - no per-effect
 * modulo math required at the call site anymore).
 */
function loopRemap(duration, innerDuration) {
  const keyframes = [];
  const cycles = Math.ceil(duration / innerDuration) + 1;
  for (let i = 0; i <= cycles; i++) {
    const t = i * innerDuration;
    if (t > duration + innerDuration) break;
    // Hold interpolation would freeze at the wrap point; linear
    // segments between "start of cycle" and "end of cycle" keyframes,
    // each cycle restarting at 0, is what actually produces a clean
    // repeating sawtooth read as content looping seamlessly.
    keyframes.push({ time: t, value: 0, interpolation: 'linear' });
    keyframes.push({ time: t + innerDuration, value: innerDuration, interpolation: 'linear' });
  }
  return new TimeRemap(new Property(keyframes));
}

/**
 * Like loopRemap, but each cycle alternates forward/backward (a
 * triangle wave) instead of snapping back to 0 - content plays
 * forward, then backward, then forward again, seamlessly (no jump cut
 * at the loop point, useful for a continuous "breathing"/idle motion
 * that shouldn't ever visibly reset).
 */
function pingPongRemap(duration, innerDuration) {
  const keyframes = [];
  const halfCycles = Math.ceil(duration / innerDuration) + 1;
  for (let i = 0; i <= halfCycles; i++) {
    const t = i * innerDuration;
    if (t > duration + innerDuration) break;
    const value = i % 2 === 0 ? 0 : innerDuration;
    keyframes.push({ time: t, value, interpolation: 'linear' });
  }
  return new TimeRemap(new Property(keyframes));
}

/**
 * The general case: caller supplies explicit (realTime -> sourceTime)
 * keyframes directly - "hold at 0 until 0.3s, then rapidly reach 2.4s
 * by 0.6s, then ease to 3.0s by 1.5s" - a real speed-ramp, keyframed
 * exactly like AE's own Time Remap property. This is the escape hatch
 * every convenience helper above is really just a shorthand for.
 */
function speedRampRemap(keyframes) {
  return new TimeRemap(new Property(keyframes));
}

module.exports = {
  TimeRemap,
  identityRemap,
  holdRemap,
  reverseRemap,
  loopRemap,
  pingPongRemap,
  speedRampRemap,
};
