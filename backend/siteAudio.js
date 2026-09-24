'use strict';
/*
 * Procedural sound design for generated films: a chord-based music bed plus cue sounds (cinematic impact,
 * whoosh, riser, sub drop, glitch, thock) synthesised sample by sample - no audio assets, no services.
 * Cues are timed to the picture, so the soundtrack is generated together with the motion script.
 *
 * Design rules (what separates sound design from noise):
 *   - every sound has an attack, body and tail - impacts are layered (sub boom + thump + crack) and reverberated
 *   - noise is always filtered (band-passed sweeps for whooshes, never raw white noise)
 *   - restraint: the bed sits low and ducks under hits; only the moments that matter get a sound
 *   - one shared reverb glues everything together; the master is loudness-normalised and soft-limited
 */
const fs = require('fs');
const SR = 44100, TAU = 2 * Math.PI;
const KEYS = { C: 65.41, D: 73.42, E: 82.41, F: 87.31, G: 98.0, A: 55.0, B: 61.74 };

/** Cue list derived from a normalised motion script (beats[].transition / text / sfx). */
function cuesFromSpec(spec) {
  const cues = []; let t = 0; const B = spec.beats;
  B.forEach((b, i) => {
    const tr = i < B.length - 1 ? b.transition : null, end = t + b.dur;
    if (b.text && b.text.lines.some((l) => l.s === 'xl') && ['pop', 'scatter', 'drip', 'glitch'].includes(b.text.fx)) cues.push({ t: t + b.text.delay + 0.04, kind: 'impact', gain: 0.36 });
    if (tr) {
      cues.push({ t: end - tr.dur - 0.04, kind: 'whoosh', dur: tr.dur + 0.3, gain: 0.55 });
      if (tr.type === 'glitch') cues.push({ t: end - tr.dur * 0.7, kind: 'glitch', gain: 0.6 });
      if (['fly', 'flash', 'glitch', 'cut', 'iris'].includes(tr.type)) cues.push({ t: end - tr.dur * 0.42, kind: 'impact', gain: tr.type === 'cut' ? 0.5 : 0.75 });
      if (['fly', 'flash'].includes(tr.type)) cues.push({ t: end - tr.dur - 0.9, kind: 'riser', dur: 0.9, gain: 0.36 });
    }
    (b.sfx || []).forEach((s) => cues.push({ t: t + s.at * b.dur, kind: s.kind, gain: 0.5, dur: s.kind === 'riser' ? 1.0 : undefined }));
    t = end;
  });
  cues.push({ t: t - 2.4, kind: 'riser', dur: 1.7, gain: 0.4 }, { t: t - 0.62, kind: 'impact', gain: 0.85 }, { t: t - 0.62, kind: 'sub', gain: 0.8 });
  return cues.filter((c) => c.t >= 0).sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------- building blocks
class Biquad { // RBJ cookbook filter with per-sample parameter updates
  constructor() { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; }
  set(type, f, q) {
    f = Math.max(20, Math.min(SR * 0.45, f)); const w = TAU * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q); let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; } else { b0 = al; b1 = 0; b2 = -al; }
    const a0 = 1 + al; this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  p(x) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}
class Reverb { // Freeverb-style: 4 damped combs + 2 allpasses per side, slightly different tunings for width
  constructor(size = 0.86, damp = 0.32) {
    this.size = size; this.damp = damp;
    const mk = (spread) => ({ combs: [1116, 1188, 1277, 1356].map((n) => ({ b: new Float32Array(n + spread), i: 0, s: 0 })), aps: [556, 441].map((n) => ({ b: new Float32Array(n + spread), i: 0 })) });
    this.L = mk(0); this.R = mk(23);
  }
  side(bank, x) {
    let o = 0;
    for (const c of bank.combs) { const y = c.b[c.i]; c.s = y * (1 - this.damp) + c.s * this.damp; c.b[c.i] = x * 0.015 + c.s * this.size; if (++c.i >= c.b.length) c.i = 0; o += y; }
    for (const a of bank.aps) { const y = a.b[a.i]; const z = o + y * 0.5; a.b[a.i] = z; o = y - o * 0.5 + 0 * z; o = y - z * 0.5 + z * 0; if (++a.i >= a.b.length) a.i = 0; }
    return o;
  }
  process(l, r) { return [this.side(this.L, l), this.side(this.R, r)]; }
}

function synth({ duration, cues, music }) {
  const n = Math.ceil((duration + 2.2) * SR);
  const musL = new Float32Array(n), musR = new Float32Array(n), fxL = new Float32Array(n), fxR = new Float32Array(n), sendL = new Float32Array(n), sendR = new Float32Array(n);
  let seed = 987654321; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const noise = () => rnd() * 2 - 1;
  const style = (music && music.style) || 'dark drone', root = KEYS[(music && music.key) || 'A'] || 55, bpm = Math.max(70, Math.min(150, (music && music.bpm) || 100));
  const putFx = (i, l, r, send) => { if (i < 0 || i >= n) return; fxL[i] += l; fxR[i] += r; sendL[i] += l * send; sendR[i] += r * send; };

  // ---- music bed
  if (style !== 'none') {
    const major = style === 'warm pad', prog = major ? [0, 7, 9, 5] : [0, -4, 3, -2], tri = major ? [0, 4, 7, 12] : [0, 3, 7, 12];
    const chordLen = style === 'dark drone' ? 8 : 4, f0 = root * 2;
    const beat = 60 / bpm, kicks = []; if (style === 'pulse' || style === 'tense') { const step = style === 'tense' ? 1.0 : beat; for (let t = 0.3; t < duration + 1; t += step) kicks.push(t); }
    const lpL = new Biquad(), lpR = new Biquad(); let ki = 0, lastKick = -9;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      while (ki < kicks.length && kicks[ki] <= t) { lastKick = kicks[ki]; ki++; }
      const duck = 1 - 0.5 * Math.exp(-(t - lastKick) * 6.5);
      const ci = Math.floor(t / chordLen), cph = (t % chordLen) / chordLen, env = Math.min(1, cph * chordLen / 1.2) * Math.min(1, (1 - cph) * chordLen / 1.4 + 0.0);
      let pl = 0, pr = 0;
      for (const [chord, w] of [[ci, env], [ci - 1, 1 - env]]) {
        if (w <= 0.001 || chord < 0) continue;
        const rs = prog[chord % prog.length];
        for (let k = 0; k < tri.length; k++) {
          const f = f0 * Math.pow(2, (rs + tri[k]) / 12);
          for (let v = 0; v < 2; v++) {
            const det = 1 + (v ? 0.0028 : -0.0026); let s = 0;
            for (let h = 1; h <= 5; h++) s += Math.sin(TAU * f * det * h * t + v * 1.7 + k) / h;
            s *= w * 0.052; if (v) pr += s * 1.1, pl += s * 0.7; else pl += s * 1.1, pr += s * 0.7;
          }
        }
        const sub = Math.sin(TAU * f0 * Math.pow(2, rs / 12) * 0.5 * t) * 0.16 * w; pl += sub; pr += sub;
      }
      if (i % 64 === 0) { const c = 420 + 330 * (0.5 + 0.5 * Math.sin(TAU * 0.09 * t)) + (major ? 350 : 0); lpL.set('lp', c, 0.7); lpR.set('lp', c * 0.97, 0.7); }
      const swell = Math.min(1, t / 3) * Math.min(1, Math.max(0, (duration + 1.2 - t) / 1.6));
      const ml = lpL.p(pl) * duck * swell * 1.5, mr = lpR.p(pr) * duck * swell * 1.5;
      musL[i] += ml; musR[i] += mr; sendL[i] += ml * 0.35; sendR[i] += mr * 0.35;
      if (style === 'tense') { const sh = Math.sin(TAU * f0 * 8 * t) * Math.sin(TAU * 0.4 * t) * 0.004 * (t / duration) * swell; musL[i] += sh; musR[i] += sh; }
    }
    for (const t of kicks) { // soft kick + off-beat hat
      for (let k = 0; k < 0.3 * SR; k++) { const x = k / SR, f = 46 + 90 * Math.exp(-x * 32), s = Math.sin(TAU * f * x) * Math.exp(-x * 10) * (style === 'tense' ? 0.32 : 0.42); const j = Math.round(t * SR) + k; if (j < n) { musL[j] += s; musR[j] += s; } }
      if (style === 'pulse') { const th = t + beat / 2, hp = new Biquad(); hp.set('hp', 7000, 0.7); for (let k = 0; k < 0.05 * SR; k++) { const s = hp.p(noise()) * Math.exp(-(k / SR) * 70) * 0.1; const j = Math.round(th * SR) + k; if (j < n) { musL[j] += s * 0.8; musR[j] += s * 1.2; } } }
    }
  }

  // ---- cue sounds
  for (const c of cues) {
    const g = c.gain === undefined ? 0.5 : c.gain, i0 = Math.round(c.t * SR);
    if (c.kind === 'impact') {
      let ph = 0, ph2 = 0;
      for (let k = 0; k < 2.2 * SR; k++) {                                        // sub boom: pitch-dropping sine with a slow tail
        const x = k / SR, f = 31 + 42 * Math.exp(-x * 7); ph += TAU * f / SR;
        let s = Math.sin(ph) * (1 - Math.exp(-x / 0.005)) * Math.exp(-x * 2.3) * 0.95;
        if (x < 0.32) { ph2 += TAU * (58 + 130 * Math.exp(-x * 26)) / SR; s += Math.sin(ph2) * Math.exp(-x * 13) * 0.75; } // thump body
        putFx(i0 + k, s * g, s * g, 0.35);
      }
      const hp = new Biquad(), lp = new Biquad(); hp.set('hp', 1600, 0.7); lp.set('lp', 9000, 0.7);      // crack: brief filtered noise for definition
      for (let k = 0; k < 0.16 * SR; k++) { const s = lp.p(hp.p(noise())) * Math.exp(-(k / SR) * 42) * g * 0.42; putFx(i0 + k, s * 0.9, s * 1.1, 0.7); }
    } else if (c.kind === 'sub') {
      let ph = 0; for (let k = 0; k < 1.9 * SR; k++) { const x = k / SR; ph += TAU * (27 + 34 * Math.exp(-x * 2.2)) / SR; const s = Math.sin(ph) * Math.exp(-x * 1.5) * (1 - Math.exp(-x / 0.03)) * g; putFx(i0 + k, s, s, 0.1); }
    } else if (c.kind === 'whoosh') {
      const len = Math.max(0.35, c.dur || 0.7), bp = new Biquad(), lp = new Biquad(); lp.set('lp', 6500, 0.6);
      for (let k = 0; k < len * SR; k++) {
        const x = k / (len * SR); if (k % 32 === 0) bp.set('bp', 260 * Math.pow(15, Math.pow(x, 1.25)), 1.5);
        const env = Math.pow(Math.sin(Math.PI * Math.pow(x, 0.85)), 2), s = lp.p(bp.p(noise())) * env * g * 2.6, pan = (x - 0.5) * 0.8;
        putFx(i0 + k, s * (1 - pan), s * (1 + pan), 0.3);
      }
    } else if (c.kind === 'riser') {
      const len = c.dur || 1.2, lp = new Biquad(), hp = new Biquad(); hp.set('hp', 900, 0.6); const dets = [-0.004, 0.0, 0.005];
      for (let k = 0; k < len * SR; k++) {
        const x = k / (len * SR), t = k / SR, f = 170 * Math.pow(6.5, x); if (k % 32 === 0) lp.set('lp', 350 + 4600 * Math.pow(x, 1.5), 0.9);
        let s = 0; for (const d of dets) for (let h = 1; h <= 4; h++) s += Math.sin(TAU * f * (1 + d) * h * t) / h; // (phase from f*t: gliding pitch smeared by the detune, reads as a riser)
        const nz = hp.p(noise()) * x * 0.5, env = Math.pow(x, 1.7) * Math.min(1, (len - t) / 0.05);
        const o = lp.p(s * 0.09 + nz * 0.25) * env * g * 2.4; putFx(i0 + k, o, o, 0.4);
      }
    } else if (c.kind === 'tick') {
      for (let k = 0; k < 0.06 * SR; k++) { const x = k / SR, s = (Math.sin(TAU * 170 * x) * Math.exp(-x * 60) + Math.sin(TAU * 1250 * x) * Math.exp(-x * 320) * 0.4) * g * 0.45; putFx(i0 + k, s, s, 0.15); }
    } else if (c.kind === 'glitch') {
      const notes = [1, 1.5, 2, 3, 1.25], base = root * 8;
      for (let b = 0; b < 5; b++) {
        const t0 = c.t + b * 0.06 + rnd() * 0.012, f = base * notes[Math.floor(rnd() * notes.length)], len = 0.03 + rnd() * 0.02; let hold = 0;
        for (let k = 0; k < len * SR; k++) {
          const x = k / SR; if (k % 5 === 0) { const w = ((f * x) % 1) * 2 - 1; hold = Math.round(w * 16) / 16; }        // sample-and-hold + 5-bit crush
          const s = hold * Math.min(1, k / 40) * (1 - k / (len * SR)) * g * 0.3; putFx(Math.round(t0 * SR) + k, s * 0.9, s * 1.1, 0.25);
        }
      }
    }
  }

  // ---- mix: shared reverb, loudness normalisation, soft limiter, fades
  const rev = new Reverb(), outL = new Float32Array(n), outR = new Float32Array(n);
  let sumSq = 0, peak = 1e-6;
  for (let i = 0; i < n; i++) {
    const [rl, rr] = rev.process(sendL[i], sendR[i]);
    const l = musL[i] * 0.42 + fxL[i] + rl * 5.5, r = musR[i] * 0.42 + fxR[i] + rr * 5.5; outL[i] = l; outR[i] = r;
    sumSq += l * l + r * r; peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const gain = 1.55 / peak; // peak-referenced (not RMS): the hits set the ceiling and the bed sits well underneath, so the mix keeps its punch
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR, fade = Math.min(1, t / 0.2) * Math.min(1, Math.max(0, (duration + 1.6 - t) / 1.4));
    const l = Math.tanh(outL[i] * gain * 1.15) * 0.94 * fade, r = Math.tanh(outR[i] * gain * 1.15) * 0.94 * fade;
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  return buf;
}

module.exports = { cuesFromSpec, synth, writeWav: (file, opts) => fs.writeFileSync(file, synth(opts)) };
