'use strict';
/*
 * Sound for a generated ad = a quiet music bed (siteAudio.synth, no effects baked in) + REAL sound-effect recordings from
 * backend/sfx/library (CC0, auditioned and picked by a person) placed on the picture with ffmpeg.
 *
 * Levels are relative to each recording normalised to the same peak. Transition whooshes are deliberately quiet
 * (20 %): they must be felt, never noticed. The finished mix is loudness-normalised so every ad plays at the same volume.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const LIB = path.join(__dirname, 'sfx', 'library');
const GAIN = { whoosh: 0.2, tick: 0.3, sparkle: 0.3, riser: 0.25, impact: 0.55 };   // the whoosh level is a hard product rule: 20 %

function library() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(LIB, 'catalog.json'), 'utf8')).filter((x) => x && x.id && x.kind && fs.existsSync(path.join(LIB, x.file)));
    return { list, byId: Object.fromEntries(list.map((x) => [x.id, x])), of: (kind) => list.filter((x) => x.kind === kind) };
  } catch (_) { return { list: [], byId: {}, of: () => [] }; }
}

/** One line per sound for the AI's prompt, grouped by what the sound is for. Empty when no library has been installed. */
function menu() {
  const lib = library(); if (!lib.list.length) return '';
  const kinds = ['whoosh', 'tick', 'sparkle', 'riser', 'impact'];
  return kinds.map((k) => { const l = lib.of(k); return l.length ? `${k}: ` + l.map((x) => `${x.id} (${x.desc || x.title || ''}, ${x.seconds}s)`).join('; ') : ''; }).filter(Boolean).join('\n');
}

const run = (args) => new Promise((resolve, reject) => {
  const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; ff.stderr.on('data', (d) => { err += d; });
  ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('audio mix failed: ' + err.slice(-300)))));
});

const peakCache = new Map();
/** Peak of a recording in dB (volumedetect), so every sample can be brought to the same reference level before its own gain is applied. */
function peakDb(file) {
  if (peakCache.has(file)) return peakCache.get(file);
  const p = new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ff.stderr.on('data', (d) => { err += d; });
    ff.on('close', () => { const m = /max_volume: (-?[0-9.]+) dB/.exec(err); resolve(m ? parseFloat(m[1]) : 0); });
  });
  peakCache.set(file, p); return p;
}

/** events: [{ file (absolute), at (seconds), gain (0..1) }] laid over bedWav; writes outWav (16-bit stereo 44.1 kHz). */
async function mix({ bedWav, events, outWav, end }) {
  const ev = events.filter((e) => e.file && e.at >= 0 && e.gain > 0);
  for (const e of ev) e.norm = Math.pow(10, -(await peakDb(e.file)) / 20);           // gain that takes this recording's peak to 0 dBFS
  const args = ['-i', bedWav]; ev.forEach((e) => args.push('-i', e.file));
  const f = ev.map((e, k) => `[${k + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${(e.gain * Math.min(e.norm, 30)).toFixed(3)},adelay=${Math.round(e.at * 1000)}|${Math.round(e.at * 1000)}[e${k}]`);
  // the bed has a shape: it fades in, sits back under the story, then SWELLS into the end card (over ~2.7 s around the end-card time) - a film with no dynamics feels flat
  const E = Number.isFinite(end) ? end : 17.5;
  f.unshift(`[0:a]volume='if(lt(t,0.6),0.12+0.22*t/0.6,if(lt(t,${(E - 2.4).toFixed(2)}),0.34,if(lt(t,${(E + 0.3).toFixed(2)}),0.34+0.32*(t-${(E - 2.4).toFixed(2)})/2.7,0.66)))':eval=frame[bed]`);
  const ins = '[bed]' + ev.map((_, k) => `[e${k}]`).join('');
  f.push(`${ins}amix=inputs=${ev.length + 1}:duration=first:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=20[out]`);
  await run([...args, '-filter_complex', f.join(';'), '-map', '[out]', '-ar', '44100', '-ac', '2', outWav]);
}

const tmpFile = (ext) => path.join(os.tmpdir(), 'admix-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + ext);
module.exports = { library, menu, mix, tmpFile, GAIN, LIB };
