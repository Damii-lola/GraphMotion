#!/usr/bin/env node
"use strict";
// Generate a cinematic site from a company brief with Cloudflare Workers AI.
//   node generate.js --brief briefs/liquiddeath.txt --slug liquiddeath --out ../../liquiddeath
// Needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (read from backend/.env).
const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..", "..", "backend");
try { require(path.join(backend, "node_modules", "dotenv")).config({ path: path.join(backend, ".env") }); } catch (_) { /* env may already be set */ }
const { generateSite } = require(path.join(backend, "siteGenerator"));

const a = process.argv.slice(2), o = {};
for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1];
if (!o.brief || !o.out) { console.log("Usage: node generate.js --brief <file.txt> --out <folder> [--slug name] [--spec site.json (reuse a saved plan)]"); process.exit(1); }
generateSite({
  brief: fs.readFileSync(o.brief, "utf8"), outDir: path.resolve(o.out), slug: o.slug,
  spec: o.spec ? JSON.parse(fs.readFileSync(o.spec, "utf8")) : undefined, planOnly: o["plan-only"] === "true",
  onProgress: (e) => console.log(`${String(Math.round(e.progress * 100)).padStart(3)}%  ${e.stage}`),
}).then((r) => { console.log("\nSite written to", r.outDir); console.log(JSON.stringify(r.spec.scenes.map((s) => ({ id: s.id, title: s.title, tone: s.tone, align: s.align })), null, 1)); })
  .catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
