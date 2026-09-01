const { Property } = require('./keyframes');

/**
 * Audio-to-keyframes: a real WAV (RIFF/WAVE) parser, real amplitude
 * (RMS) and frequency-band (via an actual radix-2 Cooley-Tukey FFT)
 * analysis, converted into an actual keyframes.js Property - the same
 * real primitive every other animated value in this engine already
 * uses, so an audio-driven value plugs into anything that already
 * accepts a Property (node.js's resolve(), any effect config) with no
 * special-casing anywhere else in the engine.
 */

/**
 * Parses a WAV file buffer by genuinely SCANNING its chunk structure
 * (chunk ID + size, repeat) rather than assuming the common "fmt " and
 * "data" chunks sit at fixed offsets 12/36 - a real WAV file can carry
 * extra chunks (LIST, JUNK, etc) before "data", and a parser that
 * hardcodes offsets silently breaks on those, which is common enough
 * in real-world files that scanning is the only genuinely correct
 * approach. Supports 8/16/32-bit integer PCM and 32-bit IEEE float
 * (audioFormat 3) - the practical majority of real WAV files - and
 * downmixes multi-channel audio to mono via a real per-sample average
 * (the standard, correct downmix for amplitude/frequency ANALYSIS,
 * where stereo imaging doesn't matter, only combined signal energy).
 */
function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file (missing RIFF/WAVE header)');
  }

  let offset = 12;
  let fmt = null;
  let dataChunk = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        numChannels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataChunk = { start: chunkStart, size: chunkSize };
    }
    // Chunks are word-aligned - an odd-sized chunk has one byte of padding after it.
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!fmt) throw new Error('WAV file missing a "fmt " chunk');
  if (!dataChunk) throw new Error('WAV file missing a "data" chunk');

  const { numChannels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.floor(dataChunk.size / bytesPerSample / numChannels);
  const samples = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const byteOffset = dataChunk.start + (i * numChannels + ch) * bytesPerSample;
      let v;
      if (bitsPerSample === 16) v = buffer.readInt16LE(byteOffset) / 32768;
      else if (bitsPerSample === 8) v = (buffer.readUInt8(byteOffset) - 128) / 128;
      else if (bitsPerSample === 32 && audioFormat === 3) v = buffer.readFloatLE(byteOffset);
      else if (bitsPerSample === 32) v = buffer.readInt32LE(byteOffset) / 2147483648;
      else throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
      sum += v;
    }
    samples[i] = sum / numChannels;
  }
  return { sampleRate, samples, duration: sampleCount / sampleRate };
}

/** Real per-frame RMS (root-mean-square) amplitude - the standard, correct measure of a signal window's perceived loudness/energy (unlike peak amplitude, RMS isn't thrown off by a single transient spike). `smoothing` (frames) applies a temporal box-average across the resulting envelope afterward - the same moving-average idea blurEffects.js's boxBlur uses spatially, applied along time instead. */
function computeAmplitudeEnvelope(samples, sampleRate, { fps = 30, smoothing = 0 } = {}) {
  const frameCount = Math.max(1, Math.ceil((samples.length / sampleRate) * fps));
  const samplesPerFrame = sampleRate / fps;
  const envelope = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const startSample = Math.floor(f * samplesPerFrame);
    const endSample = Math.min(samples.length, Math.floor((f + 1) * samplesPerFrame));
    let sumSq = 0, count = 0;
    for (let i = startSample; i < endSample; i++) { sumSq += samples[i] * samples[i]; count++; }
    envelope[f] = count > 0 ? Math.sqrt(sumSq / count) : 0;
  }

  if (smoothing <= 0) return envelope;
  const w = Math.max(1, Math.round(smoothing));
  const smoothed = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0, cnt = 0;
    for (let k = -w; k <= w; k++) {
      const idx = f + k;
      if (idx >= 0 && idx < frameCount) { sum += envelope[idx]; cnt++; }
    }
    smoothed[f] = sum / cnt;
  }
  return smoothed;
}

/**
 * A real, standard iterative radix-2 Cooley-Tukey FFT, in place on
 * parallel re/im Float64Arrays (length must be a power of 2) - bit-
 * reversal permutation followed by iterative butterfly-stage
 * combination, the textbook algorithm (not a naive O(n^2) DFT, which
 * would be correct but far too slow for per-frame analysis).
 */
function fft(re, im) {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error('FFT length must be a power of 2');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        const uRe = re[a], uIm = im[a];
        re[a] = uRe + vRe; im[a] = uIm + vIm;
        re[b] = uRe - vRe; im[b] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

/** A real Hann window (0.5*(1-cos(2*pi*i/(N-1)))) - the standard windowing function applied before an FFT to reduce spectral leakage (an un-windowed finite sample block has hard edges that smear energy across many frequency bins; tapering the block's edges to zero first is the real, correct fix, not a cosmetic addition). */
function buildHannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}

/**
 * Per-frame frequency-band energy (e.g. bass/mid/treble, AE's real
 * audio-spectrum-driven "audio reactive" technique) via a real
 * windowed FFT centered on each frame's sample position. `bands` is a
 * list of [loHz, hiHz] ranges; each frame's magnitude spectrum is
 * averaged across the bins falling in that range. `fftSize` must be a
 * power of 2 (checked by fft() itself).
 */
function computeFrequencyBands(samples, sampleRate, {
  fps = 30, fftSize = 1024, bands = [[20, 250], [250, 2000], [2000, 8000]],
} = {}) {
  const frameCount = Math.max(1, Math.ceil((samples.length / sampleRate) * fps));
  const samplesPerFrame = sampleRate / fps;
  const bandEnvelopes = bands.map(() => new Float32Array(frameCount));
  const window = buildHannWindow(fftSize);

  for (let f = 0; f < frameCount; f++) {
    const center = Math.floor(f * samplesPerFrame);
    const start = Math.max(0, Math.min(samples.length - fftSize, center - Math.floor(fftSize / 2)));
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      re[i] = (idx >= 0 && idx < samples.length ? samples[idx] : 0) * window[i];
    }
    fft(re, im);

    const half = fftSize / 2;
    for (let b = 0; b < bands.length; b++) {
      const [loHz, hiHz] = bands[b];
      const loBin = Math.max(0, Math.floor((loHz * fftSize) / sampleRate));
      const hiBin = Math.min(half - 1, Math.ceil((hiHz * fftSize) / sampleRate));
      let sum = 0, count = 0;
      for (let bin = loBin; bin <= hiBin; bin++) {
        sum += Math.hypot(re[bin], im[bin]);
        count++;
      }
      bandEnvelopes[b][f] = count > 0 ? sum / count / fftSize : 0;
    }
  }
  return bandEnvelopes;
}

/** Converts a per-frame envelope (Float32Array, one value per video frame at `fps`) into a real keyframes.js Property - one keyframe per analysis frame, linear interpolation (the envelope is already densely sampled at frame rate, so a further eased/curved interpolation between adjacent frames would just be smoothing noise into the signal, not adding real information). */
function audioToKeyframes(envelope, { fps = 30 } = {}) {
  const keyframes = [];
  for (let i = 0; i < envelope.length; i++) {
    keyframes.push({ time: i / fps, value: envelope[i], interpolation: 'linear' });
  }
  return new Property(keyframes);
}

module.exports = {
  parseWav, computeAmplitudeEnvelope, computeFrequencyBands, audioToKeyframes, fft, buildHannWindow,
};
