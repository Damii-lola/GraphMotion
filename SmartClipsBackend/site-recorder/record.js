#!/usr/bin/env node
"use strict";
/*
 * SmartClips site recorder
 * ------------------------
 * Turns a scroll-driven website into a vertical (TikTok / Reels / Shorts)
 * MP4, frame by frame, with a virtual clock - so the result is perfectly
 * smooth no matter how slow the machine is, and every run is identical.
 *
 *   node record.js --dir ../../aquaforge --out ../out/aquaforge.mp4
 *   node record.js --url https://smartclips.org/aquaforge/ --scene-seconds 6
 *   node record.js --url https://example.com --duration 30          (any page: plain scroll)
 *
 * How it works
 *   1. Chrome opens the page in a phone-sized viewport (540x960 CSS px at 2x
 *      device scale = 1080x1920 output, so the site's mobile layout is used).
 *   2. A script injected BEFORE the page loads replaces performance.now /
 *      Date.now / requestAnimationFrame with a clock the recorder owns. The
 *      page (GSAP, three.js, shaders...) only advances when we say so.
 *   3. Per frame: move the page to its position for that moment, advance the
 *      clock by 1/fps, grab a screenshot, and pipe it into ffmpeg (H.264,
 *      yuv420p, faststart - the format TikTok/Reels/Shorts accept).
 *
 * Page position:
 *   - Pages built with the SmartClips scroll engine expose window.__BEATS and
 *     window.__jumpToProgress(0..1); the recorder plays scene i for
 *     --scene-seconds each (deterministic, exact).
 *   - Any other page is scrolled top to bottom over --duration seconds.
 *   - A page may define window.__assetsReady() so the recorder waits for its
 *     images/textures before frame 0.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
function need(name, dirs) {
  try { return require(name); } catch (_) { /* fall through to sibling projects */ }
  for (const d of dirs) { try { return require(require.resolve(name, { paths: [d] })); } catch (_) { /* next */ } }
  throw new Error(`Cannot find "${name}". Run "npm install" in ${__dirname}.`);
}
const puppeteer = need("puppeteer-core", [__dirname, path.join(ROOT, "_agentic_web"), path.join(ROOT, "backend")]);
const ffmpegPath = need("ffmpeg-static", [__dirname, path.join(ROOT, "backend"), path.join(ROOT, "render-worker")]);

// ---------------------------------------------------------------- options
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const PRESETS = { tiktok: "1080x1920", reels: "1080x1920", shorts: "1080x1920", "tiktok-hd": "1080x1920", small: "720x1280" };

function chromePath() {
  const c = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) throw new Error("Chrome not found. Set CHROME_PATH to your chrome/chromium executable.");
  return hit;
}

// Static server for --dir (so local sites record without deploying).
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".mp4": "video/mp4" };
function serve(dir) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
      const fp = path.join(dir, p);
      if (!fp.startsWith(dir)) { res.writeHead(403); return res.end(); }
      fs.readFile(fp, (e, d) => {
        if (e) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" }); res.end(d);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}/index.html` }));
  });
}

// Injected before any page script: the recorder owns time.
const VIRTUAL_CLOCK = `(() => {
  let vt = 0, id = 0; const base = Date.now(); let q = new Map();
  performance.now = () => vt; Date.now = () => base + vt;
  window.requestAnimationFrame = (cb) => { q.set(++id, cb); return id; };
  window.cancelAnimationFrame = (h) => { q.delete(h); };
  window.__advance = (ms) => { vt += ms; const run = q; q = new Map(); run.forEach((cb) => { try { cb(vt); } catch (e) { console.error(e); } }); };
})();`;

const ease = {
  linear: (x) => x,
  smooth: (x) => x * x * (3 - 2 * x),
  sine: (x) => 0.5 - 0.5 * Math.cos(Math.PI * x),
};

async function record(o, onProgress) {
  const emit = (e) => { if (onProgress) try { onProgress(e); } catch (_) { /* ignore UI errors */ } };
  emit({ stage: "loading" });
  const [W, H] = (PRESETS[o.preset] || o.size || "1080x1920").split("x").map(Number);
  const fps = +o.fps || 30;
  const vw = +o["viewport-width"] || 540;
  const dsf = W / vw, vh = Math.round(H / dsf);
  const sceneSeconds = +o["scene-seconds"] || 5;
  const holdStart = o["hold-start"] !== undefined ? +o["hold-start"] : 1.2;
  const holdEnd = o["hold-end"] !== undefined ? +o["hold-end"] : 2.0;
  const easeFn = ease[o.ease || "linear"] || ease.linear;
  const quality = +o.quality || 92;
  const out = path.resolve(o.out || path.join(__dirname, "..", "out", "recording.mp4"));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  let srv = null, url = o.url;
  if (!url) {
    const dir = path.resolve(o.dir || ".");
    if (!fs.existsSync(dir)) throw new Error("--dir not found: " + dir);
    srv = await serve(dir); url = srv.url;
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath(), headless: "new",
    args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  let ff = null;
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.warn("[page error]", e.message));
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: dsf, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(VIRTUAL_CLOCK);
    console.log(`Opening ${url}  (${vw}x${vh} css @${dsf.toFixed(2)}x -> ${W}x${H}, ${fps}fps)`);
    await page.goto(url, { waitUntil: "load", timeout: 90000 });

    // wait for the page's own assets, then let fonts settle
    const t0 = Date.now();
    for (;;) {
      const ok = await page.evaluate(() => (typeof window.__assetsReady === "function" ? !!window.__assetsReady() : true));
      if (ok || Date.now() - t0 > 60000) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    await page.evaluate(() => (document.fonts && document.fonts.ready) || null);
    await page.evaluate(() => { window.__advance(16); window.__advance(16); });

    const info = await page.evaluate(() => ({
      beats: Array.isArray(window.__BEATS) && typeof window.__jumpToProgress === "function" ? window.__BEATS.slice() : null,
      maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    }));

    // ---- timeline: frame index -> page position (0..1)
    let plan, totalFrames;
    if (info.beats) {
      const scenes = info.beats.length - 1, endP = 0.975;
      const seg = [];
      for (let i = 0; i < scenes; i++) seg.push([info.beats[i], i === scenes - 1 ? endP : info.beats[i + 1]]);
      const fStart = Math.round(holdStart * fps), fScene = Math.round(sceneSeconds * fps), fEnd = Math.round(holdEnd * fps);
      totalFrames = fStart + scenes * fScene + fEnd;
      plan = (f) => {
        if (f < fStart) return 0;
        const g = f - fStart, i = Math.min(scenes - 1, Math.floor(g / fScene));
        if (g >= scenes * fScene) return endP;
        const x = easeFn((g % fScene) / fScene);
        return seg[i][0] + (seg[i][1] - seg[i][0]) * x;
      };
      console.log(`Scroll engine detected: ${scenes} scenes x ${sceneSeconds}s + holds = ${(totalFrames / fps).toFixed(1)}s`);
    } else {
      const dur = +o.duration || 30;
      totalFrames = Math.round(dur * fps);
      plan = (f) => easeFn(Math.min(1, f / (totalFrames - 1)));
      console.log(`Plain page: scrolling ${info.maxScroll}px over ${dur}s`);
    }
    const apply = info.beats
      ? (p) => page.evaluate((x) => window.__jumpToProgress(x), p)
      : (p) => page.evaluate((y) => window.scrollTo(0, y), Math.round(p * info.maxScroll));

    // ---- encoder
    const args = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-"];
    if (o.audio) args.push("-i", path.resolve(o.audio));
    args.push("-vf", `scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p`, "-c:v", "libx264", "-preset", o.encode || "medium", "-crf", String(o.crf || 18),
      "-profile:v", "high", "-level", "4.2", "-r", String(fps), "-g", String(fps * 2), "-movflags", "+faststart");
    if (o.audio) args.push("-c:a", "aac", "-b:a", "192k", "-af", `afade=t=out:st=${Math.max(0, totalFrames / fps - 1.5)}:d=1.5`, "-shortest");
    args.push(out);
    ff = spawn(ffmpegPath, args, { stdio: ["pipe", "inherit", "inherit"] });
    const ffDone = new Promise((res, rej) => { ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exited " + c)))); ff.on("error", rej); });
    ff.stdin.on("error", () => {});

    const client = await page.createCDPSession();
    const started = Date.now(); emit({ stage: "recording", frame: 0, total: totalFrames, eta: null });
    for (let f = 0; f < totalFrames; f++) {
      await apply(plan(f));
      await page.evaluate((ms) => window.__advance(ms), 1000 / fps);
      const { data } = await client.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true });
      if (!ff.stdin.write(Buffer.from(data, "base64"))) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % 5 === 0) emit({ stage: "recording", frame: f + 1, total: totalFrames, eta: ((Date.now() - started) / 1000 / (f + 1)) * (totalFrames - f - 1) });
      if (!onProgress && (f % 15 === 0 || f === totalFrames - 1)) {
        const el = (Date.now() - started) / 1000, eta = (el / (f + 1)) * (totalFrames - f - 1);
        process.stdout.write(`\rframe ${f + 1}/${totalFrames}  ${((f + 1) / totalFrames * 100).toFixed(0)}%  ${((f + 1) / el).toFixed(1)} fps  eta ${eta.toFixed(0)}s   `);
      }
    }
    process.stdout.write("\n");
    emit({ stage: "encoding" });
    ff.stdin.end();
    await ffDone;
    const mb = (fs.statSync(out).size / 1048576).toFixed(1);
    console.log(`Done: ${out}  (${mb} MB, ${(totalFrames / fps).toFixed(1)}s, ${W}x${H})`);
    return out;
  } finally {
    await browser.close().catch(() => {});
    if (srv) srv.server.close();
    if (ff && !ff.killed && ff.exitCode === null) ff.kill();
  }
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || (!o.url && !o.dir)) {
    console.log(`Usage: node record.js (--dir <folder> | --url <url>) [options]
  --out <file.mp4>          output (default ../out/recording.mp4)
  --preset tiktok|reels|shorts|small   or --size WxH   (default 1080x1920)
  --fps 30                  frames per second
  --scene-seconds 5         seconds per scene (scroll-engine pages)
  --duration 30             seconds for plain pages
  --hold-start 1.2 --hold-end 2       still time before/after
  --ease linear|smooth|sine per-scene easing
  --audio <file>            mux a music/voice track (trimmed, fades out)
  --crf 18 --encode medium  H.264 quality / speed
  --viewport-width 540      CSS width of the phone viewport`);
    process.exit(o.help ? 0 : 1);
  }
  record(o).catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
}
module.exports = { record };
