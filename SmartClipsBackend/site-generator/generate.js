#!/usr/bin/env node
"use strict";
// Generate a cinematic site (cinema engine) from a company brief with Cloudflare Workers AI.
//   node generate.js --brief briefs/liquiddeath.txt --out ../../liquiddeath2 [--slug name]
//   --plan-only true      only write the director's plan (site.json), no images/audio
//   --spec site.json      reuse a saved plan (add --keep-images true to reuse existing images)
//   --engine classic      the older section-based template
const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..", "..", "backend");
try { require(path.join(backend, "node_modules", "dotenv")).config({ path: path.join(backend, ".env") }); } catch (_) { /* env may already be set */ }

const a = process.argv.slice(2), o = {};
for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1];
if (!o.brief || !o.out) { console.log("Usage: node generate.js --brief <file.txt> --out <folder> [--slug name] [--plan-only true] [--spec site.json] [--keep-images true] [--engine classic]"); process.exit(1); }
const run = o.engine === "classic" ? require(path.join(backend, "siteGenerator")).generateSite : require(path.join(backend, "cinemaGenerator")).generateCinemaSite;
run({
  brief: fs.readFileSync(o.brief, "utf8"), outDir: path.resolve(o.out), slug: o.slug,
  spec: o.spec ? JSON.parse(fs.readFileSync(o.spec, "utf8")) : undefined, planOnly: o["plan-only"] === "true", keepImages: o["keep-images"] === "true", resume: o.resume === "true",
  onProgress: (e) => console.log(`${String(Math.round(e.progress * 100)).padStart(3)}%  ${e.stage}`),
}).then((r) => {
  console.log("\nSite written to", r.outDir);
  const s = r.spec; console.log(`${s.brand} | ${s.theme.look} | motif ${s.motif.type} | grade ${s.grade.mood} | ${s.beats.length} beats, ${s.beats.reduce((t, b) => t + b.dur, 0).toFixed(1)}s`);
  s.beats.forEach((b, i) => console.log(`${String(i + 1).padStart(2)}. ${b.dur.toFixed(1)}s ${b.image.padEnd(10)} ${b.camera.padEnd(10)} ${(b.text ? b.text.lines.map((l) => l.t).join(" / ") : "-").padEnd(34)} ${b.text ? b.text.fx.padEnd(8) : "        "} -> ${b.transition.type}`));
}).catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
