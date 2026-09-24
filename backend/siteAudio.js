'use strict';
/*
 * Procedural sound design for generated sites: a music bed + cue sounds (whoosh / impact / riser / tick /
 * glitch / sub) synthesised sample by sample - no audio assets, no external services. Cues are timed to
 * the picture, so the soundtrack is generated together with the motion script.
 */
const fs = require('fs');
const SR = 44100;
const KEYS = { C: 65.41, D: 73.42, E: 82.41, F: 87.31, G: 98.0, A: 55.0, B: 61.74 };

/** Cue list derived from a normalised motion script (beats[].transition / text / sfx). */
function cuesFromSpec(spec) {
  const cues = []; let t = 0; const B = spec.beats;
  B.forEach((b, i) => {
    const tr = i < B.length - 1 ? b.transition : null, end = t + b.dur;
    if (b.text && b.text.lines.length) {
      const big = b.text.lines.some((l) => l.s === 'xl') && ['pop', 'scatter', 'drip', 'glitch'].includes(b.text.fx);
      cues.push({ t: t + b.text.delay + 0.02, kind: big ? 'impact' : 'tick', gain: big ? 0.55 : 0.28 });
    }
    if (tr) {
      cues.push({ t: end - tr.dur - 0.05, kind: 'whoosh', dur: tr.dur + 0.25, gain: 0.5 });
      if (['burst', 'glitch', 'zoomthrough', 'shatter', 'cut'].includes(tr.type)) cues.push({ t: end - tr.dur * 0.45, kind: tr.type === 'glitch' ? 'glitch' : 'impact', gain: tr.type === 'cut' ? 0.5 : 0.7 });
      if (['burst', 'zoomthrough'].includes(tr.type)) cues.push({ t: end - tr.dur - 0.9, kind: 'riser', dur: 0.9, gain: 0.32 });
    }
    (b.sfx || []).forEach((s) => cues.push({ t: t + s.at * b.dur, kind: s.kind, gain: 0.5, dur: s.kind === 'riser' ? 1.0 : undefined }));
    t = end;
  });
  cues.push({ t: t - 2.2, kind: 'riser', dur: 1.6, gain: 0.35 }, { t: t - 0.55, kind: 'sub', gain: 0.75 });
  return cues.filter((c) => c.t >= 0).sort((a, b) => a.t - b.t);
}

function synth({ duration, cues, music }) {
  const n = Math.ceil((duration + 1.2) * SR), L = new Float32Array(n), R = new Float32Array(n);
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const add = (i, l, r) => { if (i >= 0 && i < n) { L[i] += l; R[i] += (r === undefined ? l : r); } };
  const style = (music && music.style) || 'dark drone', root = KEYS[(music && music.key) || 'A'] || 55, bpm = (music && music.bpm) || 100;

  // ---- music bed
  if (style !== 'none') {
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.11 * t), swell = Math.min(1, t / 2.5) * Math.min(1, (duration - t + 0.8) / 1.6);
      let v = Math.sin(2 * Math.PI * root * t) * 0.5 + Math.sin(2 * Math.PI * root * 1.5 * t + 0.4) * 0.22 + (((root * 2.003 * t) % 1) * 2 - 1) * 0.16;
      if (style === 'warm pad') v += Math.sin(2 * Math.PI * root * 2.52 * t) * 0.18 + Math.sin(2 * Math.PI * root * 3 * t) * 0.12;
      if (style === 'tense') v += Math.sin(2 * Math.PI * (root * 8 + t * 6) * t * 0.5) * 0.05 * (t / duration);
      const cut = 0.02 + 0.06 * lfo; lp += (v - lp) * cut; // moving low-pass makes the drone breathe
      const bed = lp * (0.5 + 0.5 * lfo) * 0.55 * swell; add(i, bed, bed);
    }
    if (style === 'pulse' || style === 'tense') { // heartbeat / four-on-the-floor sub pulse
      const beat = 60 / bpm;
      for (let t = 0.4; t < duration; t += beat) for (let k = 0; k < 0.22 * SR; k++) { const x = k / SR, e = Math.exp(-x * 16), f = 95 * Math.exp(-x * 9) + 42; const s = Math.sin(2 * Math.PI * f * x) * e * 0.34; add(Math.round(t * SR) + k, s, s); }
    }
  }
  // ---- cue sounds
  const noiseBurst = (t0, len, gain, cutoff, pan) => { let lp = 0; for (let k = 0; k < len * SR; k++) { const x = k / (len * SR), e = Math.pow(1 - x, 3); lp += ((rnd() * 2 - 1) - lp) * cutoff; add(Math.round(t0 * SR) + k, lp * e * gain * (1 - pan), lp * e * gain * (1 + pan)); } };
  for (const c of cues) {
    const g = c.gain === undefined ? 0.5 : c.gain, i0 = Math.round(c.t * SR);
    if (c.kind === 'whoosh') {
      const len = Math.max(0.3, c.dur || 0.7); let low = 0, band = 0;
      for (let k = 0; k < len * SR; k++) {
        const x = k / (len * SR), env = Math.pow(Math.sin(Math.PI * Math.min(1, x * 0.92 + 0.02)), 1.8), fc = 0.02 + 0.5 * Math.pow(x, 1.6);
        const inp = rnd() * 2 - 1; low += fc * band; const high = inp - low - 0.35 * band; band += fc * high; // state-variable band-pass sweeping upward
        const pan = (x - 0.5) * 0.7; add(i0 + k, band * env * g * 1.3 * (1 - pan), band * env * g * 1.3 * (1 + pan));
      }
    } else if (c.kind === 'impact' || c.kind === 'sub') {
      const len = c.kind === 'sub' ? 1.3 : 1.2, f0 = c.kind === 'sub' ? 62 : 120, f1 = c.kind === 'sub' ? 26 : 38; let ph = 0;
      for (let k = 0; k < len * SR; k++) { const x = k / SR, f = f1 + (f0 - f1) * Math.exp(-x * 7); ph += 2 * Math.PI * f / SR; const s = Math.sin(ph) * Math.exp(-x * (c.kind === 'sub' ? 2.6 : 3.4)) * g * 1.15; add(i0 + k, s, s); }
      if (c.kind === 'impact') { noiseBurst(c.t, 0.22, g * 0.5, 0.35, 0); noiseBurst(c.t, 0.9, g * 0.16, 0.04, 0); }
    } else if (c.kind === 'riser') {
      const len = c.dur || 1.2; let band = 0, low = 0;
      for (let k = 0; k < len * SR; k++) { const x = k / (len * SR), env = x * x, fc = 0.05 + 0.6 * x; const inp = rnd() * 2 - 1; low += fc * band; const high = inp - low - 0.3 * band; band += fc * high; const tone = Math.sin(2 * Math.PI * (180 + 1500 * x * x) * (k / SR)) * 0.25; const s = (band * 0.9 + tone) * env * g; add(i0 + k, s, s); }
    } else if (c.kind === 'tick') {
      for (let k = 0; k < 0.05 * SR; k++) { const x = k / SR, s = (Math.sin(2 * Math.PI * 2100 * x) * 0.4 + (rnd() * 2 - 1) * 0.6) * Math.exp(-x * 90) * g; add(i0 + k, s * 0.9, s * 1.1); }
    } else if (c.kind === 'glitch') {
      for (let b = 0; b < 5; b++) { const t0 = c.t + b * 0.045 + rnd() * 0.02, f = 350 + rnd() * 2800, len = 0.02 + rnd() * 0.03; for (let k = 0; k < len * SR; k++) { const x = k / SR, sq = Math.sin(2 * Math.PI * f * x) > 0 ? 1 : -1; const s = (sq * 0.5 + (rnd() * 2 - 1) * 0.5) * (1 - k / (len * SR)) * g * 0.6; add(Math.round(t0 * SR) + k, s, -s * 0.6 + s * 0.4); } }
    }
  }
  // ---- tiny reverb (three feedback combs), soft clip, master fades
  const combs = [[0.037, 0.32], [0.061, 0.27], [0.089, 0.22]];
  const wetL = new Float32Array(n), wetR = new Float32Array(n);
  for (const [dly, fb] of combs) { const d = Math.round(dly * SR); for (let i = d; i < n; i++) { wetL[i] += (L[i - d] + wetL[i - d] * fb) * fb; wetR[i] += (R[i - d] + wetR[i - d] * fb) * fb; } }
  let peak = 1e-6; for (let i = 0; i < n; i++) { L[i] += wetL[i] * 0.55; R[i] += wetR[i] * 0.55; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const norm = 0.86 / peak; const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR, fade = Math.min(1, t / 0.15) * Math.min(1, Math.max(0, (duration + 1.1 - t) / 1.2));
    const l = Math.tanh(L[i] * norm * 1.25) * fade, r = Math.tanh(R[i] * norm * 1.25) * fade;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(l * 32767))), 44 + i * 4); buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
  }
  return buf;
}

module.exports = { cuesFromSpec, synth, writeWav: (file, opts) => fs.writeFileSync(file, synth(opts)) };
