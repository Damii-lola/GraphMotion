'use strict';
/*
 * PRODUCT PHOTOS FROM THE WEB (the official site of the product or brand), for when the client gave no photo.
 * 1. the official site is FOUND: the client's own website when given, otherwise a few obvious domains (product.com, brand.com) are tried and accepted only when the page
 *    really talks about this product;
 * 2. the page is RENDERED in headless Chrome (most brand sites build their pictures with JavaScript, a plain download sees nothing), a few product / brand pages are
 *    followed, and the real pictures on them are collected, best-looking product shots first;
 * 3. the caller cuts the packshots out (realimg.cutoutReal) and picks the one that fits the plan.
 * Public addresses only (siteScanner's checks); nothing here is trusted as an instruction.
 */
const scanner = require('../siteScanner');
const { resolveTarget, launchChrome } = require('../siteRecorder');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const wordsOf = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const BAD_IMG = /logo|icon|favicon|cookielaw|onetrust|sprinklr|fbcdn|facebook|twitter|instagram|tiktok|avatar|payment|arrow|pixel|tracking|\.svg|\.gif|banner|background|hero-bg|placeholder/i;
const OTHER_FLAVOUR = /zero|sin az|sugar free|sans sucre|light|diet|cherry|vanilla|peach|\btea\b|limited|edition|mango|cranberry|ginger|mini|0%/i;

/** the official page: the client's website, or the first obvious domain whose page mentions the product (and its brand or kind of product) */
async function findOfficial(plan, company, log = console.log) {
  const product = String((plan.product && plan.product.name) || plan.brand || ''), brand = String(plan.brand || ''), kind = String((plan.product && plan.product.kind) || '');
  if (company && company.siteHost) return 'https://' + company.siteHost;
  const doms = [...new Set([slug(product), slug(brand), slug(brand) + slug(product), slug(product) + slug(brand)].filter((d) => d.length >= 4 && d.length <= 28))].slice(0, 5);
  const pw = wordsOf(product), bw = wordsOf(brand), kw = wordsOf(kind).filter((w) => !['product', 'pack', 'packaged'].includes(w));
  const check = async (d) => {   // all the guesses in parallel: at most one slow answer of waiting
    for (const host of [d + '.com', 'www.' + d + '.com']) {
      try {
        const { html, url } = await scanner.getHtml('https://' + host);
        const t = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').toLowerCase().slice(0, 60000);
        const hasProduct = pw.length > 0 && pw.filter((w) => t.includes(w)).length / pw.length >= 0.66, hasBrandOrKind = (bw.length && bw.some((w) => t.includes(w)) && slug(brand) !== slug(product)) || kw.some((w) => t.includes(w));   // most of the product's words is enough (a brand's own homepage rarely spells out every word of a product line's full name)
        if (hasProduct && hasBrandOrKind) return url;
      } catch (_) { /* not reachable: next */ }
    }
    return null;
  };
  const res = await Promise.all(doms.slice(0, 4).map(check)), ok = res.find(Boolean);
  if (ok) { log('[webphotos] official page: ' + ok); return ok; }
  return null;
}

/** render pages in Chrome and collect their real pictures: { src, alt, w, h, score } best first */
async function renderImages(startUrl, plan, log = console.log, budgetMs = 55000) {
  const product = String((plan.product && plan.product.name) || plan.brand || ''), pw = wordsOf(product), kindWords = wordsOf((plan.product && plan.product.kind) || '');
  const deadline = Date.now() + budgetMs, found = new Map(), visited = new Set(), queue = [startUrl];
  const rootHost = (h) => h.split('.').slice(-2).join('.');
  let browser = null;
  try {
    browser = await launchChrome();
    while (queue.length && visited.size < 4 && Date.now() < deadline) {
      const u = queue.shift(); if (visited.has(u)) continue; visited.add(u);
      let page = null;
      try {
        await resolveTarget(u);   // public addresses only
        page = await browser.newPage(); await page.setViewport({ width: 1280, height: 1800 });
        await page.setUserAgent('Mozilla/5.0 (compatible; SmartClipsBot/1.0)');
        await page.goto(u, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
        await page.evaluate(async () => { for (let y = 0; y < 4; y++) { window.scrollBy(0, 700); await new Promise((r) => setTimeout(r, 250)); } window.scrollTo(0, 0); }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        const data = await page.evaluate(() => {
          const imgs = [], links = [];
          document.querySelectorAll('img').forEach((i) => imgs.push({ src: i.currentSrc || i.src, w: i.naturalWidth || i.clientWidth, h: i.naturalHeight || i.clientHeight, alt: (i.alt || '') + ' ' + (i.title || '') }));
          document.querySelectorAll('a[href]').forEach((a) => links.push({ href: a.href, text: (a.innerText || '').slice(0, 60) }));
          return { imgs, links, host: location.hostname };
        });
        for (const i of data.imgs) {
          if (!i.src || /^data:/.test(i.src) || BAD_IMG.test(i.src + ' ' + i.alt) || Math.min(i.w || 0, i.h || 0) < 220) continue;
          const text = (i.alt + ' ' + decodeURIComponent(i.src)).toLowerCase(), hit = pw.length && pw.every((w) => text.includes(w));
          let score = (hit ? 4 : 0) + (kindWords.some((w) => text.includes(w)) ? 1 : 0) + (/\b(can|bottle|pack|prod|product|jar|box|pouch)\b|prod/.test(text) ? 1 : 0) + Math.min(2, (Math.min(i.w, i.h) - 220) / 400);
          if (OTHER_FLAVOUR.test(text) && !OTHER_FLAVOUR.test(product)) score -= 3;   // the regular product first: not the zero-sugar, tea or limited edition
          const key = i.src.split('?')[0]; if (!found.has(key) || found.get(key).score < score) found.set(key, { src: i.src, alt: i.alt.trim(), w: i.w, h: i.h, score });
        }
        // follow links to product / brand pages of the same site (the pictures of the products live there)
        if (visited.size < 4) {
          const rh = rootHost(data.host);
          const cand = data.links.map((l) => { try { const x = new URL(l.href); return { u: x.href.split('#')[0], host: x.hostname, path: x.pathname.toLowerCase(), t: l.text.toLowerCase() }; } catch (_) { return null; } })
            .filter((l) => l && rootHost(l.host) === rh && /product|shop|brands?\/|range|our-|collection|flavou?r|menu|item/.test(l.path) && !/\.(pdf|jpg|png)$/.test(l.path))
            .map((l) => ({ ...l, s: (pw.some((w) => l.path.includes(w) || l.t.includes(w)) ? 3 : 0) + (/product/.test(l.path) ? 2 : 0) + (/shop|store/.test(l.path) ? -1 : 0) })).sort((a, b) => b.s - a.s);
          for (const c of cand.slice(0, 2)) if (!visited.has(c.u) && !queue.includes(c.u)) queue.push(c.u);
        }
      } catch (e) { log('[webphotos] page failed: ' + String(e.message).slice(0, 80)); }
      finally { if (page) await page.close().catch(() => {}); }
    }
  } finally { if (browser) await browser.close().catch(() => {}); }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

/** the pictures as buffers with their labels: [{ buf, label }] (at most `max`) */
async function discover(plan, company, log = console.log, max = 8) {
  const start = await findOfficial(plan, company, log);
  if (!start) { log('[webphotos] no official page found'); return []; }
  const list = await renderImages(start, plan, log);
  log('[webphotos] ' + list.length + ' picture(s) on the rendered pages');
  const out = [];
  for (const it of list) { if (out.length >= max) break; try { const buf = await scanner.getImage(it.src); if (buf && buf.length > 5000) out.push({ buf, label: it.alt + ' ' + it.src.split('/').pop().split('?')[0] }); } catch (_) { /* skip */ } }
  return out;
}

module.exports = { discover, findOfficial, renderImages };
