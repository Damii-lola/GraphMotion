'use strict';
/*
 * PRODUCT PHOTOS FROM THE WEB (the official site of the product or brand), for when the client gave no photo.
 * 1. the official site is FOUND: the client's own website when given, otherwise a few obvious domains (product.com, brand.com) are tried and accepted only when the page
 *    really talks about this product;
 * 2. the page (and up to two product/shop pages it links to) is read with a PLAIN fetch - no browser. Most JS-built sites still ship their real product data as plain JSON
 *    inside the page's initial HTML (that's what the JS reads to build the visible page), and siteScanner's imageUrls() already mines that; a Shopify store's public
 *    /products.json is tried too. A real headless-browser render would catch a few more sites, but it means a second Chrome process on this same server, which crashed
 *    it three times live (see feedback_web_photo_scan_disabled) - this plain-fetch approach costs nothing extra and can never crash the server;
 * 3. the caller cuts the packshots out (realimg.cutoutReal) and picks the one that fits the plan.
 * Public addresses only (siteScanner's checks); nothing here is trusted as an instruction.
 */
const scanner = require('../siteScanner');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const wordsOf = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const BAD_IMG = /logo|icon|favicon|cookielaw|onetrust|sprinklr|fbcdn|facebook|twitter|instagram|tiktok|avatar|payment|arrow|pixel|tracking|\.svg|\.gif|banner|background|hero-bg|placeholder/i;
const OTHER_FLAVOUR = /zero|sin az|sugar free|sans sucre|light|diet|cherry|vanilla|peach|\btea\b|limited|edition|mango|cranberry|ginger|mini|0%/i;
const rootHost = (h) => h.split('.').slice(-2).join('.');

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
        if (hasProduct && hasBrandOrKind) return { url, html };
      } catch (_) { /* not reachable: next */ }
    }
    return null;
  };
  const res = await Promise.all(doms.slice(0, 4).map(check)), ok = res.find(Boolean);
  if (ok) { log('[webphotos] official page: ' + ok.url); return ok; }
  return null;
}

/** collect and score real pictures from a page and up to two product/shop pages it links to - plain fetch throughout, no browser */
async function collectImages(start, plan, log = console.log) {
  const product = String((plan.product && plan.product.name) || plan.brand || ''), pw = wordsOf(product), kindWords = wordsOf((plan.product && plan.product.kind) || '');
  const found = new Map(), visited = new Set();
  const score = (src) => {
    const text = decodeURIComponent(src).toLowerCase(), hit = pw.length && pw.every((w) => text.includes(w));
    let s = (hit ? 4 : 0) + (kindWords.some((w) => text.includes(w)) ? 1 : 0) + (/\b(can|bottle|pack|prod|product|jar|box|pouch)\b/.test(text) ? 1 : 0);
    if (OTHER_FLAVOUR.test(text) && !OTHER_FLAVOUR.test(product)) s -= 3;
    return s;
  };
  const add = (src, alt = '') => { if (!src || BAD_IMG.test(src + ' ' + alt)) return; const key = src.split('?')[0]; const s = score(src) + (alt ? 0.5 : 0); if (!found.has(key) || found.get(key).score < s) found.set(key, { src, alt, score: s }); };
  const visit = async (url, html) => {
    if (visited.has(url) || visited.size >= 3) return;
    visited.add(url);
    try {
      if (!html) ({ html } = await scanner.getHtml(url));
      scanner.imageUrls(html, url).forEach((u) => add(u));
      try { const shop = await scanner.shopifyProductImages(new URL(url).origin); shop.forEach((u) => add(u, product)); } catch (_) { /* not Shopify */ }
      if (visited.size < 3) {
        const host = new URL(url).hostname, rh = rootHost(host);
        const links = [...html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => { try { const u2 = new URL(m[2], url); return { u: u2.href.split('#')[0], host: u2.hostname, path: u2.pathname.toLowerCase(), t: m[3].replace(/<[^>]*>/g, ' ').toLowerCase() }; } catch (_) { return null; } })
          .filter((l) => l && rootHost(l.host) === rh && /product|shop|brands?\/|range|our-|collection|flavou?r|menu|item/.test(l.path) && !/\.(pdf|jpg|png|jpeg|webp)$/.test(l.path))
          .map((l) => ({ ...l, s: (pw.some((w) => l.path.includes(w) || l.t.includes(w)) ? 3 : 0) + (/product/.test(l.path) ? 2 : 0) + (/shop|store/.test(l.path) ? -1 : 0) })).sort((a, b) => b.s - a.s);
        const seen = new Set([...found.keys()]);
        for (const l of links) { if (visited.size >= 3) break; if (!visited.has(l.u)) await visit(l.u); }
      }
    } catch (e) { log('[webphotos] page failed: ' + String(e.message).slice(0, 80)); }
  };
  await visit(start.url, start.html);
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

/** the pictures as buffers with their labels: [{ buf, label }] (at most `max`) */
async function discover(plan, company, log = console.log, max = 8) {
  const start = await findOfficial(plan, company, log);
  if (!start) { log('[webphotos] no official page found'); return []; }
  const list = await collectImages(start, plan, log);
  log('[webphotos] ' + list.length + ' picture(s) found');
  const out = [];
  for (const it of list) { if (out.length >= max) break; try { const buf = await scanner.getImage(it.src); if (buf && buf.length > 5000) out.push({ buf, label: it.alt + ' ' + it.src.split('/').pop().split('?')[0] }); } catch (_) { /* skip */ } }
  return out;
}

module.exports = { discover, findOfficial, collectImages };
