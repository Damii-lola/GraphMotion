#!/usr/bin/env node
"use strict";
// Local command-line front end for the SAME recorder the live backend uses
// (backend/siteRecorder.js). Handy for testing a page without the API.
//
//   node record.js aquaforge                       -> records https://smartclips.org/aquaforge/
//   node record.js https://example.com --duration 20
//   node record.js --dir ../../aquaforge           -> records a local folder
//   options: --out file.mp4  --scene-seconds 5  --fps 30  --preset tiktok|small  --audio music.mp3
const path = require("path");
const { record, resolveTarget } = require("../../backend/siteRecorder");

(async () => {
  const a = process.argv.slice(2), o = {};
  let page = null;
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) { page = a[i]; continue; }
    const k = a[i].slice(2), v = a[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
  }
  if (!page && !o.dir) { console.log("Usage: node record.js <page-name | url> [--dir folder] [--out file.mp4] [--scene-seconds 5] [--fps 30] [--preset tiktok|small] [--audio file]"); process.exit(1); }
  const opts = {
    out: o.out || path.join(__dirname, "..", "out", "recording.mp4"), preset: o.preset, fps: o.fps, sceneSeconds: o["scene-seconds"], duration: o.duration,
    holdStart: o["hold-start"], holdEnd: o["hold-end"], maxSeconds: o["max-seconds"], ease: o.ease, audio: o.audio, crf: o.crf,
  };
  if (o.dir) opts.dir = path.resolve(o.dir); else opts.url = await resolveTarget(page, { allowPrivate: !!o.private });
  const t0 = Date.now();
  let lastStage = "";
  const res = await record(opts, (e) => {
    process.stdout.write(`\r${e.stage.padEnd(10)} ${(e.progress * 100).toFixed(0).padStart(3)}%  ${e.eta ? "eta " + Math.round(e.eta) + "s" : ""}      `);
    lastStage = e.stage;
  });
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${res.out} (${res.seconds.toFixed(1)}s, ${res.width}x${res.height})`);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
