'use strict';
/*
 * Site recorder core - turns a scroll-driven web page into a vertical
 * (TikTok / Reels / Shorts) H.264 MP4, frame by frame, on a virtual clock.
 *
 * Used by:
 *   - siteVideoWorker.js  (forked by the API in siteVideo.js -> /api/site-video)
 *   - the local CLI       (SmartClipsBackend/site-recorder/record.js)
 *
 * How it works
 *   1. Chrome opens the page in a phone-sized viewport (540x960 CSS px @2x =
 *      1080x1920) so the page's own mobile layout is what gets recorded.
 *   2. A script injected BEFORE the page loads replaces performance.now,
 *      Date.now and requestAnimationFrame with a clock we own, so GSAP /
 *      three.js / shaders only advance when we say so: output is smooth and
 *      identical no matter how slow the machine is.
 *   3. Phase 1 (Chrome): per frame, move the page to its position for that
 *      moment, advance the clock 1/fps, save a JPEG to a temp folder.
 *      Chrome is then CLOSED, so its memory is gone before...
 *   4. Phase 2 (ffmpeg): encode the JPEGs to H.264 yuv420p + faststart.
 *      Chrome and x264 never run at the same time (peak = the larger one).
 *
 * Page position:
 *   - Pages built with the SmartClips scroll engine expose window.__BEATS and
 *     window.__jumpToProgress(0..1): scene i plays for sceneSeconds each.
 *   - Any other page is scrolled top to bottom over `duration` seconds.
 *   - A page may define window.__assetsReady() so we wait for its images.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const SITE_BASE = (process.env.SITE_BASE || 'https://smartclips.org').replace(/\/$/, '');
const PRESETS = { tiktok: '1080x1920', reels: '1080x1920', shorts: '1080x1920', small: '720x1280' };
const MAX_FRAMES = +process.env.SITE_VIDEO_MAX_FRAMES || 4800; // hard ceiling (80 s @ 60 fps)

// ------------------------------------------------------------- target check
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Turn what the user typed into a public http(s) URL, or throw a readable error. */
async function resolveTarget(input, { allowPrivate = false } = {}) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Enter a page first.');
  let url;
  if (/^https?:\/\//i.test(s)) url = s;
  else if (/^[a-z0-9_-]+$/i.test(s)) url = `${SITE_BASE}/${s.toLowerCase()}/`; // bare name -> a page on our own site
  else if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) url = 'https://' + s;
  else throw new Error("That doesn't look like a page name or link.");
  let u;
  try { u = new URL(url); } catch (_) { throw new Error('Invalid link.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) pages can be recorded.');
  if (u.username || u.password) throw new Error('Links with a login are not allowed.');
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$/i.test(host) || /\.(local|internal)$/i.test(host)) throw new Error('Local addresses are not allowed.');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error("Couldn't find that site."); });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private network addresses are not allowed.');
  }
  return u.href;
}

// ------------------------------------------------------------- local static server (CLI --dir)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serveDir(dir) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const fp = path.join(dir, p);
      if (!fp.startsWith(dir)) { res.writeHead(403); return res.end(); }
      fs.readFile(fp, (e, d) => {
        if (e) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' }); res.end(d);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}/index.html` }));
  });
}

// ------------------------------------------------------------- chrome
async function launchChrome() {
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); } catch (_) { throw new Error('puppeteer-core is not installed on this server.'); }
  const lean = ['--hide-scrollbars', '--force-color-profile=srgb', '--disable-extensions', '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--mute-audio', '--js-flags=--max-old-space-size=128'];
  if (process.platform === 'linux') {
    // Serverless-style Chromium build: no system libraries needed, ships its own SwiftShader for WebGL.
    let chromium = null, loadErr = null;
    try { const mod = require('@sparticuz/chromium'); chromium = mod.default || mod; } catch (e) { loadErr = e; } // ESM package: the real object is .default under require()
    if (chromium && Array.isArray(chromium.args)) {
      // The serverless build runs Chrome as ONE process, which cannot host extra browser contexts / windows (they crash it:
      // "Target closed"). SITE_VIDEO_MULTIPROCESS=1 strips those flags so parallel capture can be used on a server with the RAM for it.
      const multi = process.env.SITE_VIDEO_MULTIPROCESS === '1';
      const base = multi ? chromium.args.filter((a) => a !== '--single-process' && a !== '--no-zygote') : chromium.args;
      const args = await puppeteer.defaultArgs({ args: [...new Set([...base, ...lean, '--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'])], headless: 'shell' });
      const br = await puppeteer.launch({ args, executablePath: await chromium.executablePath(), headless: 'shell' });
      br.__single = !multi;
      return br;
    }
    if (loadErr) throw new Error('Chrome package failed to load: ' + loadErr.message);
  }
  const cands = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const exe = cands.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('No Chrome available on this server.');
  return puppeteer.launch({ executablePath: exe, headless: 'new', args: [...lean, '--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
}

// Injected before any page script: the recorder owns time.
const VIRTUAL_CLOCK = `(() => {
  let vt = 0, id = 0; const base = Date.now(); let q = new Map();
  performance.now = () => vt; Date.now = () => base + vt;
  window.requestAnimationFrame = (cb) => { q.set(++id, cb); return id; };
  window.cancelAnimationFrame = (h) => { q.delete(h); };
  window.__advance = (ms) => { vt += ms; const run = q; q = new Map(); run.forEach((cb) => { try { cb(vt); } catch (e) { console.error(e); } }); };
})();`;

const EASE = { linear: (x) => x, smooth: (x) => x * x * (3 - 2 * x), sine: (x) => 0.5 - 0.5 * Math.cos(Math.PI * x) };

/**
 * record({ url | dir, out, preset|size, fps, sceneSeconds, duration, ... }, onProgress)
 * onProgress({ stage: 'loading'|'recording'|'encoding', progress: 0..1, eta: seconds|null })
 */
async function record(o, onProgress) {
  const emit = (stage, progress, eta = null, note = null) => { if (onProgress) try { onProgress({ stage, progress, eta, note }); } catch (_) { /* UI errors never break a render */ } };
  emit('loading', 0.01);
  const [W, H] = (PRESETS[o.preset] || o.size || '1080x1920').split('x').map(Number);
  const fps = Math.max(12, Math.min(60, +o.fps || 60));
  const vw = +o.viewportWidth || 540;
  const dsf = W / vw, vh = Math.round(H / dsf);
  const sceneSeconds = +o.sceneSeconds || 3.5;
  const holdStart = o.holdStart !== undefined ? +o.holdStart : 1.2;
  const holdEnd = o.holdEnd !== undefined ? +o.holdEnd : 2.0;
  const easeFn = EASE[o.ease || 'linear'] || EASE.linear;
  const quality = +o.quality || 88;
  const out = path.resolve(o.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));

  let srv = null, url = o.url;
  if (!url) {
    const dir = path.resolve(o.dir || '.');
    if (!fs.existsSync(dir)) throw new Error('dir not found: ' + dir);
    srv = await serveDir(dir); url = srv.url;
  }

  let totalFrames = 0, frameIdxs = [];
  const browser = await launchChrome();
  try {
    const openPage = async () => {
      const pg = browser.__single ? await browser.newPage() : await (await browser.createBrowserContext()).newPage(); // own context = own window, so every tab keeps rendering and can be captured in parallel
      pg.on('pageerror', (e) => console.warn('[site-video page error]', e.message));
      await pg.setViewport({ width: vw, height: vh, deviceScaleFactor: dsf, isMobile: true, hasTouch: true });
      await pg.evaluateOnNewDocument(VIRTUAL_CLOCK);
      await pg.goto(url, { waitUntil: 'load', timeout: 90000 });
      const t0 = Date.now();
      for (;;) {
        const ok = await pg.evaluate(() => (typeof window.__assetsReady === 'function' ? !!window.__assetsReady() : true));
        if (ok || Date.now() - t0 > 60000) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      await pg.evaluate(() => (document.fonts && document.fonts.ready) || null);
      await pg.evaluate(() => { window.__advance(16); window.__advance(16); });
      return pg;
    };
    const page = await openPage();

    const info = await page.evaluate(() => ({
      beats: Array.isArray(window.__BEATS) && typeof window.__jumpToProgress === 'function' ? window.__BEATS.slice() : null,
      pace: window.__PACE || null, // where inside a scene the text has finished revealing / the exit-transition begins
      maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    }));

    let plan, weight; // plan(f): page position 0..1 at timeline frame f.  weight(f): how many timeline frames ONE captured frame may cover there.
    if (info.beats) {
      const scenes = info.beats.length - 1, endP = 0.975, seg = [];
      for (let i = 0; i < scenes; i++) seg.push([info.beats[i], i === scenes - 1 ? endP : info.beats[i + 1]]);
      // Video pacing != scroll pacing. A scroll-driven scene is linear in scroll distance, which as video reads as
      // slow drifting. Instead spend the scene's time like an editor would: quick reveal, a readable hold, then a
      // short punchy transition. revealEnd / holdEnd are the scene positions (0..1) where those phases end.
      const pc = info.pace || {}, rEnd = pc.revealEnd || 0.3, hEnd = pc.holdEnd || 0.6, F = [0.22, 0.48, 0.30];
      // The calm parts (text reveal + readable hold) play calmSpeed x faster than the base pace; transitions keep their
      // own duration. Everything below is in frames.
      const cs = +o.calmSpeed || 1.06;
      const fStart = Math.round(holdStart * fps), fBase = sceneSeconds * fps, fEnd = Math.round(holdEnd * fps);
      const fR = (fBase * F[0]) / cs, fH = (fBase * F[1]) / cs, fT = fBase * F[2];
      const fScene = Math.round(fR + fH + fT);
      totalFrames = fStart + scenes * fScene + fEnd;
      plan = (f) => {
        if (f < fStart) return 0;
        const g = f - fStart;
        if (g >= scenes * fScene) return endP;
        const i = Math.min(scenes - 1, Math.floor(g / fScene)), gi = g - i * fScene;
        const t = gi < fR ? rEnd * (gi / fR) : gi < fR + fH ? rEnd + (hEnd - rEnd) * ((gi - fR) / fH) : hEnd + (1 - hEnd) * Math.min(1, (gi - fR - fH) / fT);
        return seg[i][0] + (seg[i][1] - seg[i][0]) * t;
      };
      // Where the picture actually changes fast (transitions) every frame matters; where it barely moves
      // (readable holds, the final hold) a captured frame can stand in for several. Only used when the
      // server is too slow to capture every frame.
      weight = (f) => {
        if (f < fStart) return 2;
        const g = f - fStart;
        if (g >= scenes * fScene) return 6;
        const gi = g % fScene;
        return gi < fR ? 3 : gi < fR + fH ? 4 : 1;
      };
    } else {
      totalFrames = Math.round((+o.duration || 30) * fps);
      plan = (f) => easeFn(Math.min(1, f / Math.max(1, totalFrames - 1)));
      weight = () => 3;
    }
    if (totalFrames > MAX_FRAMES) throw new Error(`That would be a ${(totalFrames / fps).toFixed(0)}s video - the limit is ${(MAX_FRAMES / fps).toFixed(0)}s. Use fewer seconds per scene.`);
    const apply = info.beats
      ? (p) => page.evaluate((x) => window.__jumpToProgress(x), p)
      : (p) => page.evaluate((y) => window.scrollTo(0, y), Math.round(p * info.maxScroll));

    // ---- phase 1: frames -> jpeg files, inside a TIME BUDGET.
    // Software-rendered WebGL is slow on small servers. We time a transition frame (the most expensive kind) here,
    // then pick the SMALLEST thinning of the timeline that fits the budget: m = 0 captures every frame (fast
    // machine = full smoothness); larger m thins the calm parts of the video first while keeping every frame of
    // the fast-moving transitions.
    const client = await page.createCDPSession();
    const shot = (q) => client.send('Page.captureScreenshot', { format: 'jpeg', quality: q, optimizeForSpeed: true, captureBeyondViewport: false });
    const heavyP = info.beats ? plan(Math.round(fps * holdStart + sceneSeconds * fps * 0.85)) : 0.5; // mid-transition of the first scene
    for (let k = 0; k < 3; k++) { // warm-up: the first frames pay for shader compilation; not counted
      await apply(heavyP); await page.evaluate((ms) => window.__advance(ms), 16); await shot(40);
      emit('loading', 0.02 + 0.01 * k);
    }
    const tc = Date.now();
    for (let k = 0; k < 4; k++) { await apply(heavyP + k * 1e-4); await page.evaluate((ms) => window.__advance(ms), 16); await shot(quality); }
    const perFrameMs = (Date.now() - tc) / 4;
    const budgetMs = (+o.captureBudgetSeconds || +process.env.SITE_VIDEO_CAPTURE_BUDGET_S || 300) * 1000;
    // pick(calm, trans): thin the calm parts by factor `calm` (0 = keep every frame) and capture every
    // `trans`-th frame of the fast-moving transitions (weight 1). Calm parts are thinned to the limit
    // BEFORE transitions lose a single frame.
    const pick = (calm, trans) => {
      const a = []; let f = 0;
      while (f < totalFrames) {
        a.push(f);
        const w = weight(f);
        f += w === 1 ? trans : calm === 0 ? 1 : Math.max(1, Math.round(w * calm));
      }
      if (a[a.length - 1] !== totalFrames - 1) a.push(totalFrames - 1);
      return a;
    };
    const STEPS = [[0, 1], [0.5, 1], [1, 1], [2, 1], [3, 1], [5, 1], [5, 2], [5, 3], [6, 4]];
    let idxs = pick(...STEPS[STEPS.length - 1]);
    const WORKERS = browser.__single ? 1 : Math.max(1, Math.min(4, Math.round(+o.workers || +process.env.SITE_VIDEO_WORKERS || 2)));
    const capacity = (budgetMs * 0.8 * (1 + (WORKERS - 1) * 0.85)) / perFrameMs; // how many frames fit in the budget with WORKERS tabs
    for (const st of STEPS) { const cand = pick(...st); if (cand.length <= capacity) { idxs = cand; break; } }
    const note = idxs.length < totalFrames * 0.6 ? 'This server is slow, so calm parts of the video use fewer frames; transitions keep full smoothness where possible.' : null;
    // ---- capture, in parallel: the frame list is cut into contiguous chunks, one browser tab per chunk. Each tab
    // first jumps its own clock/scroll state to just before its first frame (GSAP's lag-smoothing is switched off
    // for that jump so time-based animations, e.g. the intro, land exactly where a sequential run would have them).
    if (WORKERS > 1) await page.close().catch(() => {}); // the calibration tab has been driven to a transition; parallel chunks start from fresh tabs
    const dtMs = 1000 / fps, started = Date.now();
    const chunk = Math.ceil(idxs.length / WORKERS);
    let ema = perFrameMs / WORKERS, doneFrames = 0;
    const tabs = WORKERS > 1 ? await Promise.all(Array.from({ length: Math.ceil(idxs.length / chunk) }, () => openPage())) : [page];
    await Promise.all(tabs.map(async (pg, c) => {
      const a = c * chunk, b = Math.min(idxs.length, a + chunk);
      const cl = await pg.createCDPSession();
      const sh = (q) => cl.send('Page.captureScreenshot', { format: 'jpeg', quality: q, optimizeForSpeed: true, captureBeyondViewport: false });
      const ap = info.beats ? (p) => pg.evaluate((x) => window.__jumpToProgress(x), p) : (p) => pg.evaluate((y) => window.scrollTo(0, y), Math.round(p * info.maxScroll));
      let prev = -1;
      if (a > 0) {
        const f0 = idxs[a], wStart = Math.max(0, f0 - 90);
        await pg.evaluate((ms) => { if (window.gsap) window.gsap.ticker.lagSmoothing(0); window.__advance(ms); }, wStart * dtMs);
        for (let w = wStart; w < f0; w += 3) { await ap(plan(w)); await pg.evaluate((ms) => window.__advance(ms), 3 * dtMs); }
        prev = f0 - 1;
      }
      for (let k = a; k < b; k++) {
        const f = idxs[k], t1 = Date.now();
        await ap(plan(f));
        await pg.evaluate((ms) => window.__advance(ms), dtMs * (prev < 0 ? 1 : f - prev));
        prev = f;
        const { data } = await sh(quality);
        await fs.promises.writeFile(path.join(work, `f${String(k).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
        doneFrames++;
        ema = ema * 0.95 + ((Date.now() - t1) / WORKERS) * 0.05;
        if (doneFrames % 4 === 0) emit('recording', 0.03 + 0.72 * (doneFrames / idxs.length), (idxs.length - doneFrames) * ema / 1000 + 30, note);
      }
    }));
    frameIdxs = idxs;
  } finally {
    await browser.close().catch(() => {});
    if (srv) srv.server.close();
  }

  // ---- phase 2: encode (Chrome is gone by now).
  // Captured frames are dense in transitions (gap 1) and sparse in calm parts (gap > 1). Each run of frames with the
  // same gap is encoded on its own: gap 1 is used as-is, gap > 1 is BLENDED up to the full frame rate so calm parts
  // (slow zoom, text settling) flow smoothly instead of stepping. The runs are then joined without re-encoding.
  try {
    emit('encoding', 0.76, null);
    const gaps = frameIdxs.map((f, k) => (k + 1 < frameIdxs.length ? frameIdxs[k + 1] : totalFrames) - f);
    const runs = [];
    for (let k = 0; k < gaps.length; k++) {
      const r = runs[runs.length - 1];
      if (r && r.gap === gaps[k]) r.count++; else runs.push({ start: k, count: 1, gap: gaps[k] });
    }
    const sparse = frameIdxs.length < totalFrames * 0.6;
    const vcodec = ['-c:v', 'libx264', '-preset', o.encode || (sparse ? 'ultrafast' : 'veryfast'), '-crf', String(o.crf || 20), '-threads', String(o.threads || 2),
      '-x264-params', 'rc-lookahead=10:ref=2', '-profile:v', 'high', '-level', '4.2', '-r', String(fps), '-g', String(fps * 2)];
    const runFF = (args) => new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', reject);
      ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.slice(-300)))));
    });
    const parts = [];
    const encStart = Date.now();
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i], part = path.join(work, `part${String(i).padStart(3, '0')}.mp4`), outFrames = r.count * r.gap;
      const blend = r.gap > 1 ? `,framerate=fps=${fps}:interp_start=0:interp_end=255:scene=100` : '';
      await runFF(['-framerate', String(fps / r.gap), '-start_number', String(r.start), '-t', String(outFrames / fps), '-i', path.join(work, 'f%05d.jpg'),
        '-vf', `scale=${W}:${H}:flags=${r.gap > 1 || sparse ? 'bilinear' : 'lanczos'},setsar=1${blend},tpad=stop_mode=clone:stop_duration=2,format=yuv420p`,
        '-frames:v', String(outFrames), ...vcodec, part]);
      parts.push(part);
      const frac = (i + 1) / runs.length, el = (Date.now() - encStart) / 1000;
      emit('encoding', 0.76 + 0.22 * frac, frac > 0.05 ? el / frac - el : null);
    }
    fs.writeFileSync(path.join(work, 'parts.txt'), parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    const join = ['-f', 'concat', '-safe', '0', '-i', path.join(work, 'parts.txt')];
    if (o.audio) join.push('-i', path.resolve(o.audio));
    join.push('-c:v', 'copy');
    if (o.audio) join.push('-c:a', 'aac', '-b:a', '192k', '-af', `afade=t=out:st=${Math.max(0, totalFrames / fps - 1.5)}:d=1.5`, '-shortest');
    join.push('-movflags', '+faststart', out);
    await runFF(join);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  emit('done', 1, 0);
  return { out, seconds: totalFrames / fps, width: W, height: H };
}

module.exports = { record, resolveTarget, PRESETS, SITE_BASE };
