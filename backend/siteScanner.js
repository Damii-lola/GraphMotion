'use strict';
/*
 * Reads the company's own website so the ad is written from real facts. The visitor types a URL (optional); this fetches the page
 * (public addresses only, redirects re-checked, size and time capped) and boils it down to the text that says what the company is:
 * title, description, headings, the first paragraphs and list items. The result is added to the brief the AI reads.
 * Nothing on the page is trusted as an instruction: it is only quoted as company information.
 */
const fetch = require('node-fetch');
const { resolveTarget } = require('./siteRecorder');

const MAX_BYTES = 1.5 * 1024 * 1024, MAX_CHARS = 1800, TIMEOUT_MS = 9000;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...' };
const decode = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 31 && n < 0x2fff ? String.fromCharCode(n) : ' '; } return ENT[e.toLowerCase()] || ' '; });
const clean = (s) => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function getHtml(start) {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const safe = await resolveTarget(url);                                  // public http(s) only: no localhost / private networks, on every hop
    const r = await fetch(safe, { redirect: 'manual', timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartClipsBot/1.0)', Accept: 'text/html' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), safe).href; continue; }
    if (!r.ok) throw new Error('the website answered ' + r.status);
    if (!/html|xml/i.test(r.headers.get('content-type') || '')) throw new Error('that link is not a web page');
    const chunks = []; let n = 0;                                          // read only the first MAX_BYTES: a huge page is truncated, not refused
    for await (const c of r.body) { chunks.push(c); n += c.length; if (n >= MAX_BYTES) break; }
    try { r.body.destroy(); } catch (_) { /* already closed */ }
    return { html: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES), url: safe };
  }
  throw new Error('too many redirects');
}

/** { url, host, text } - text is at most ~1800 characters of what the site says about itself. */
async function scan(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const { html, url } = await getHtml(s);
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ');
  const meta = (name) => { const m = new RegExp('<meta[^>]*(?:name|property)=.' + name + '.[^>]*>', 'i').exec(html); const c = m && /content=(["'])([\s\S]*?)\1/i.exec(m[0]); return c ? clean(c[2]) : ''; };   // the value may contain the OTHER kind of quote (world's)
  const title = clean((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const parts = [];
  const add = (t, min = 3) => { t = clean(t); if (t.length >= min && !parts.some((p) => p.toLowerCase() === t.toLowerCase())) parts.push(t); };
  add(meta('og:site_name')); add(title); add(meta('description'), 20); add(meta('og:description'), 20);
  for (const m of body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) { add(m[1], 6); if (parts.length > 14) break; }
  for (const m of body.matchAll(/<(p|li)[^>]*>([\s\S]*?)<\/\1>/gi)) { const t = clean(m[2]); if (t.length >= 40 && t.length <= 320) add(t, 40); if (parts.length > 30) break; }
  let text = ''; for (const p of parts) { if ((text + ' | ' + p).length > MAX_CHARS) break; text += (text ? ' | ' : '') + p; }
  if (text.length < 20) throw new Error('nothing readable on that page (it may need JavaScript to show its content)');
  let image = null;                                                          // the site's own share picture: the real product / brand look, used as a reference by the picture model
  try { const u = meta('og:image') || meta('twitter:image') || meta('twitter:image:src'); if (u) image = await getImage(new URL(u, url).href); } catch (_) { /* optional */ }
  // the product photos of the site: the home page and up to two product / shop pages
  let images = [];
  try {
    const urls = imageUrls(html, url), host = new URL(url).hostname;
    const links = [...html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1/gi)].map((m) => { try { return new URL(decode(m[2]), url); } catch (_) { return null; } }).filter((u) => u && u.hostname === host && /product|shop|store|collection|flavou?r|our-|range|menu/i.test(u.pathname)).map((u) => u.href.split('#')[0]);
    for (const l of [...new Set(links)].slice(0, 2)) { try { const p = await getHtml(l); imageUrls(p.html, p.url).forEach((u) => { if (!urls.includes(u)) urls.push(u); }); } catch (_) { /* a page that will not load is skipped */ } }
    images = await fetchImages(urls, 6);
  } catch (_) { /* optional */ }
  return { url, host: new URL(url).hostname.replace(/^www\./, ''), text, image, images };
}

/** Download one picture (same public-address rule and redirect checks, 6 MB cap, must really be an image). */
async function getImage(start) {
  let url = start;
  for (let hop = 0; hop < 3; hop++) {
    const safe = await resolveTarget(url);
    const r = await fetch(safe, { redirect: 'manual', timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartClipsBot/1.0)', Accept: 'image/*' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), safe).href; continue; }
    if (!r.ok || !/^image\/(png|jpe?g|webp)/i.test(r.headers.get('content-type') || '')) return null;
    const chunks = []; let n = 0;
    for await (const c of r.body) { chunks.push(c); n += c.length; if (n > 6 * 1024 * 1024) return null; }
    return Buffer.concat(chunks);
  }
  return null;
}

const IMG_OK = /\.(jpe?g|png|webp)(\?|#|$)/i, SKIP = /logo|icon|sprite[-_]?(sheet|icons?)|avatar|favicon|flag|payment|social|arrow|placeholder|blank|pixel|tracking|banner-ad/i, PROD = /product|shop|item|pack|bottle|\bcan\b|flavou?r|snack|drink|packshot|gallery|catalog|store/i;
/** the image addresses on a page, best first: product structured data, the share image, product-looking pictures */
function imageUrls(html, base) {
  const out = [], add = (u) => { try { if (!u) return; const a = new URL(String(u).trim().split(' ')[0], base).href; if (!out.includes(a)) out.push(a); } catch (_) { /* not a valid address */ } };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if ([].concat(o['@type'] || []).includes('Product') && o.image) [].concat(o.image).forEach((im) => add(typeof im === 'string' ? im : im && (im.url || im.contentUrl))); Object.values(o).forEach((v) => { if (v && typeof v === 'object') walk(v); }); }; walk(JSON.parse(m[1])); } catch (_) { /* bad JSON-LD */ } }
  const meta = (n) => { const m = new RegExp('<meta[^>]*(?:name|property)=.' + n + '.[^>]*>', 'i').exec(html); const c = m && /content=(["'])([\s\S]*?)\1/i.exec(m[0]); return c ? decode(c[2]) : ''; };
  add(meta('og:image')); add(meta('twitter:image'));
  const imgs = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0], attr = (a) => { const q = new RegExp('\\b' + a + '=(["\'])([\\s\\S]*?)\\1', 'i').exec(tag); return q ? decode(q[2]) : ''; };
    let src = attr('data-src') || attr('data-lazy-src') || attr('src'); const ss = attr('srcset') || attr('data-srcset');
    if (ss) { const best = ss.split(',').map((p) => p.trim().split(/\s+/)).map((p) => [p[0], parseFloat(p[1]) || 0]).sort((a, b) => b[1] - a[1])[0]; if (best && best[0]) src = best[0]; }
    if (!src || /^data:/.test(src) || SKIP.test(src + ' ' + attr('alt') + ' ' + attr('class'))) continue;
    if (!IMG_OK.test(src) && !PROD.test(src)) continue;
    imgs.push({ src, score: (PROD.test(src + ' ' + attr('alt') + ' ' + attr('class')) ? 2 : 0) + ((parseInt(attr('width'), 10) || 0) >= 300 ? 1 : 0) });
  }
  imgs.sort((a, b) => b.score - a.score).forEach((i) => add(i.src));
  return out.slice(0, 14);
}
async function fetchImages(urls, max) { const bufs = []; for (const u of urls) { if (bufs.length >= max) break; try { const b = await getImage(u); if (b && b.length > 6000) bufs.push(b); } catch (_) { /* skip */ } } return bufs; }
/** a link the client gave for their product: a picture address, or a page (product page, shop listing) whose pictures are collected */
async function scanImages(input, max = 5) {
  let s = String(input || '').trim(); if (!s) return []; if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (IMG_OK.test(s.split('?')[0])) { const b = await getImage(s); return b ? [b] : []; }
  const { html, url } = await getHtml(s); return fetchImages(imageUrls(html, url), max);
}

module.exports = { scan, scanImages, getHtml, getImage };
