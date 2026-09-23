#!/usr/bin/env node
"use strict";
/*
 * Recorder API - the thing record.html (the "Site -> Video" page) talks to.
 *
 *   node server.js            (listens on :8787, override with PORT)
 *
 *   POST /api/site-video      { page, sceneSeconds?, fps?, preset?, duration? }  -> { id }
 *   GET  /api/site-video/:id  -> { status, progress, eta, error?, videoUrl? }
 *   GET  /videos/:id.mp4      (?download=1 to force a download)
 *   GET  /health
 *
 * `page` can be a bare site folder name from this repo ("aquaforge"), a full
 * URL, or "smartclips.org/aquaforge". One recording runs at a time (Chrome +
 * WebGL is heavy); the rest wait in a queue.
 *
 * This needs a real Chrome and a decent machine, so it runs on your PC for
 * now. It is NOT part of the Render backend (that one is deliberately
 * browser-free and memory-capped).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { record } = require("./record");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = +process.env.PORT || 8787;
const OUT = path.join(__dirname, "..", "out", "jobs");
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) { // tidy videos older than a day
  const p = path.join(OUT, f);
  try { if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

const jobs = new Map();
const queue = [];
let busy = false;

function resolveTarget(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("Enter a page first.");
  if (/^https?:\/\//i.test(s)) return checkUrl(s);
  if (/^[a-z0-9_-]+$/i.test(s)) {
    const dir = path.join(ROOT, s);
    if (fs.existsSync(path.join(dir, "index.html"))) return { dir, label: s };
    throw new Error(`No site folder called "${s}" in this repo. Enter a full URL instead.`);
  }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return checkUrl("https://" + s);
  throw new Error("That doesn't look like a page name or URL.");
}
function checkUrl(u) {
  let x; try { x = new URL(u); } catch (_) { throw new Error("Invalid URL."); }
  if (!/^https?:$/.test(x.protocol)) throw new Error("Only http(s) pages.");
  const h = x.hostname;
  const priv = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/i.test(h);
  if (priv && !process.env.ALLOW_PRIVATE) throw new Error("Private/local addresses are blocked (set ALLOW_PRIVATE=1 to allow).");
  return { url: x.href, label: x.hostname + x.pathname };
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    job.status = "loading"; job.started = Date.now();
    const target = resolveTarget(job.page);
    const opts = { out: job.file, fps: job.fps, preset: job.preset, "scene-seconds": job.sceneSeconds, duration: job.duration };
    if (target.dir) opts.dir = target.dir; else opts.url = target.url;
    await record(opts, (e) => {
      if (e.stage === "loading") { job.status = "loading"; job.progress = 0.02; }
      else if (e.stage === "recording") { job.status = "recording"; job.progress = 0.05 + 0.9 * (e.total ? e.frame / e.total : 0); job.eta = e.eta; }
      else if (e.stage === "encoding") { job.status = "encoding"; job.progress = 0.97; job.eta = null; }
    });
    job.status = "done"; job.progress = 1; job.eta = 0;
  } catch (e) {
    job.status = "error"; job.error = e.message || String(e);
  } finally {
    busy = false; setImmediate(pump);
  }
}

const clamp = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
function view(job) {
  return {
    id: job.id, status: job.status, progress: +job.progress.toFixed(3), eta: job.eta == null ? null : Math.round(job.eta),
    error: job.error || null, page: job.page,
    position: job.status === "queued" ? queue.indexOf(job) + 1 : 0,
    videoUrl: job.status === "done" ? `/videos/${job.id}.mp4` : null,
  };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true"); // https page -> localhost recorder
}
const json = (res, code, obj) => { cors(res); res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  if (url.pathname === "/health") return json(res, 200, { ok: true, busy, queued: queue.length });

  if (req.method === "POST" && url.pathname === "/api/site-video") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on("end", () => {
      let b; try { b = JSON.parse(body || "{}"); } catch (_) { return json(res, 400, { error: "Bad JSON." }); }
      try { resolveTarget(b.page); } catch (e) { return json(res, 400, { error: e.message }); }
      const id = crypto.randomBytes(6).toString("hex");
      const job = {
        id, page: String(b.page).trim().slice(0, 300), status: "queued", progress: 0, eta: null, created: Date.now(), file: path.join(OUT, id + ".mp4"),
        sceneSeconds: clamp(b.sceneSeconds, 2, 12, 5), fps: clamp(b.fps, 24, 30, 30), duration: clamp(b.duration, 5, 90, 30),
        preset: b.preset === "small" ? "small" : "tiktok",
      };
      jobs.set(id, job); queue.push(job); pump();
      json(res, 202, { id });
    });
    return;
  }

  let m = url.pathname.match(/^\/api\/site-video\/([a-f0-9]+)$/);
  if (req.method === "GET" && m) { const j = jobs.get(m[1]); return j ? json(res, 200, view(j)) : json(res, 404, { error: "Unknown job." }); }

  m = url.pathname.match(/^\/videos\/([a-f0-9]+)\.mp4$/);
  if (req.method === "GET" && m) {
    const j = jobs.get(m[1]);
    if (!j || j.status !== "done" || !fs.existsSync(j.file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(j.file).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    cors(res);
    const head = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
    if (url.searchParams.get("download")) head["Content-Disposition"] = `attachment; filename="smartclips-${m[1]}.mp4"`;
    if (range) {
      const a = range[1] ? +range[1] : 0, e = range[2] ? Math.min(+range[2], size - 1) : size - 1;
      res.writeHead(206, { ...head, "Content-Range": `bytes ${a}-${e}/${size}`, "Content-Length": e - a + 1 });
      return fs.createReadStream(j.file, { start: a, end: e }).pipe(res);
    }
    res.writeHead(200, { ...head, "Content-Length": size });
    return fs.createReadStream(j.file).pipe(res);
  }
  json(res, 404, { error: "Not found." });
}).listen(PORT, () => console.log(`SmartClips recorder API on http://localhost:${PORT}  (open record.html)`));
