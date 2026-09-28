'use strict';
/*
 * Sound for a generated ad = a real, present music bed (a CC0 loop from backend/music/library when this video's mood has one,
 * else siteAudio's synth as a fallback) + REAL sound-effect recordings from backend/sfx/library (CC0, auditioned and picked by
 * a person) placed on the picture with ffmpeg. Both libraries hold several tracks per mood/kind, picked by this video's own
 * dice seed, so the SAME reference generated many times reaches for different music and hits, not the identical ones every time.
 *
 * Levels are relative to each recording normalised to the same peak. Transition whooshes are deliberately quiet
 * (20 %): they must be felt, never noticed. The bed ducks a little under every impact/riser landing (a real produced mix's
 * "pump", not just layering). The finished mix is loudness-normalised so every ad plays at the same volume.
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

// ------------------------------------------------------------- real music loops (CC0), so the bed is a real beat, not just synthesised
const MUSIC_LIB = path.join(__dirname, 'music', 'library');
/** { list, of(mood) } - every real loop, CC0, auditioned; several per mood so the SAME reference used again still picks a different one. */
function musicLibrary() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(MUSIC_LIB, 'catalog.json'), 'utf8')).filter((x) => x && x.id && x.mood && x.seconds > 0 && fs.existsSync(path.join(MUSIC_LIB, x.file)));
    return { list, of: (mood) => list.filter((x) => x.mood === mood) };
  } catch (_) { return { list: [], of: () => [] }; }
}

// a small, fast seeded RNG (same family the rest of engine 2 already uses for its own per-video dice) - so two videos that land on
// the very same track still don't sound identical: a different bit of it, in a slightly different key
function rngFrom(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Picks a real loop for this mood (seeded, so ten videos of the same reference/mood don't all reach for the same track), then loops
 * and trims it to fit `duration` with a fade in/out - writes outWav. Every video also gets its OWN small pitch nudge and, for a loop
 * long enough to have more than one "section", its own start point, so even two videos that pick the identical track don't play back
 * identically. Returns the picked catalog entry, or null when that mood has no loop (the caller falls back to the synthesised bed). */
async function realBed({ mood, seed, duration, outWav }) {
  const pool = musicLibrary().of(mood);
  if (!pool.length) return null;
  const s = Math.abs(Math.round(seed || 0)), rng = rngFrom(s + 1), track = pool[s % pool.length];
  const src = path.join(MUSIC_LIB, track.file);
  const need = duration + 1;
  const spare = Math.max(0, track.seconds - need), startAt = spare > 1 ? rng() * spare : 0;   // a different bit of a long track each time
  const pitch = 1 + (rng() - 0.5) * 0.04;   // +-2%: pitch-shifting a busy drum loop is a known source of smeared/robotic-sounding transients, so this stays gentle - still a genuine per-video difference
  const loops = Math.max(0, Math.ceil(need / Math.max(1, track.seconds - startAt)) - 1), fadeOutAt = Math.max(0, need - 1.2);
  await run(['-ss', startAt.toFixed(2), '-stream_loop', String(loops), '-i', src, '-t', need.toFixed(2), '-af',
    `rubberband=pitch=${pitch.toFixed(4)},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOutAt.toFixed(2)}:d=1.2`, '-ar', '44100', '-ac', '2', outWav]);
  return track;
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

/** events: [{ file (absolute), at (seconds), gain (0..1) }] laid over bedWav; writes outWav (16-bit stereo 44.1 kHz).
 * duckAt: seconds where the bed should duck for a beat (impact/riser landings) - a short professional-mix "pump", not a background hum
 * that never moves; every one of those hits should be FELT under the beat, not just laid flatly on top of it. */
async function mix({ bedWav, events, outWav, end, duckAt }) {
  const ev = events.filter((e) => e.file && e.at >= 0 && e.gain > 0);
  for (const e of ev) e.norm = Math.pow(10, -(await peakDb(e.file)) / 20);           // gain that takes this recording's peak to 0 dBFS
  const args = ['-i', bedWav]; ev.forEach((e) => args.push('-i', e.file));
  const f = ev.map((e, k) => `[${k + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${(e.gain * Math.min(e.norm, 30)).toFixed(3)},adelay=${Math.round(e.at * 1000)}|${Math.round(e.at * 1000)}[e${k}]`);
  // the bed has a shape: it fades in, plays as a real, PRESENT beat under the story (not a background hum - direct user
  // feedback: "we need a nice beat to play"), then swells further into the end card (over ~2.7 s around the end-card time)
  const E = Number.isFinite(end) ? end : 17.5;
  // 0.58->0.8 (the previous fix) was tuned for the old bare synth pad; a real, already-produced drum loop carries far more of its
  // own energy at the same number and clashed badly with the separate picture-timed hits on top of it - direct, urgent user report
  const shape = `if(lt(t,0.6),0.12+0.34*t/0.6,if(lt(t,${(E - 2.4).toFixed(2)}),0.46,if(lt(t,${(E + 0.3).toFixed(2)}),0.46+0.19*(t-${(E - 2.4).toFixed(2)})/2.7,0.65)))`;
  // a brief, gentle dip (12%) around each hit, ~0.3s wide - the classic "duck" that makes a mix feel produced instead of just layered
  const dips = (duckAt || []).slice(0, 8).map((t0) => `(1-0.12*max(0,1-abs(t-${t0.toFixed(2)})/0.16))`);
  const duck = dips.length ? dips.reduceRight((acc, d) => (acc ? `min(${d},${acc})` : d), '') : '1';
  f.unshift(`[0:a]volume='(${shape})*(${duck})':eval=frame[bed]`);
  const ins = '[bed]' + ev.map((_, k) => `[e${k}]`).join('');
  f.push(`${ins}amix=inputs=${ev.length + 1}:duration=first:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=20[out]`);
  await run([...args, '-filter_complex', f.join(';'), '-map', '[out]', '-ar', '44100', '-ac', '2', outWav]);
}

const tmpFile = (ext) => path.join(os.tmpdir(), 'admix-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + ext);
module.exports = { library, menu, mix, tmpFile, GAIN, LIB, musicLibrary, realBed };
