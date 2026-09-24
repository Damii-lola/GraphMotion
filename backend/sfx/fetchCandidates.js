'use strict';
/*
 * Collects CANDIDATE sound effects for a human to audition (nothing here is used in a film until a person has listened and picked).
 * Source: Openverse (https://api.openverse.org, no key needed) which indexes Freesound and other openly licensed audio.
 * Only CC0 / public-domain sounds are kept: no attribution needed, safe to put inside a client's ad.
 *
 *   node fetchCandidates.js            -> candidates/<kind>_<n>.mp3 + candidates/candidates.json + audition.html
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const OUT = path.join(__dirname, 'candidates');
fs.mkdirSync(OUT, { recursive: true });

// what each kind of moment in an ad needs, and the words that find it
const KINDS = {
  whoosh: { want: 8, q: ['whoosh', 'swoosh', 'air swish', 'transition swipe', 'fast swoosh'], max: 2800, hint: 'scene-to-scene dive; must sit UNDER the picture, soft' },
  riser: { want: 5, q: ['riser', 'rising sweep', 'build up sweep', 'swell'], max: 4500, hint: 'builds into the end card' },
  impact: { want: 6, q: ['impact', 'cinematic hit', 'boom', 'sub drop', 'thud'], max: 4000, hint: 'end-card landing / big moments' },
  tick: { want: 8, q: ['ui click', 'soft click', 'pop', 'tick', 'bubble pop', 'button click'], max: 900, hint: 'a caption landing' },
  sparkle: { want: 6, q: ['sparkle', 'chime', 'shimmer', 'magic twinkle', 'ding'], max: 2500, hint: 'proof stickers, CTA button' },
};

async function search(q, page = 1) {
  const url = 'https://api.openverse.org/v1/audio/?q=' + encodeURIComponent(q) + '&license=cc0,pdm&page_size=20&page=' + page;
  const r = await fetch(url, { headers: { 'User-Agent': 'smartclips-sfx-audition/1.0' }, timeout: 30000 });
  if (!r.ok) throw new Error('openverse ' + r.status);
  return (await r.json()).results || [];
}

(async () => {
  const out = [], seen = new Set();
  for (const [kind, k] of Object.entries(KINDS)) {
    const pool = [];
    for (const q of k.q) { try { for (const r of await search(q)) if (r.url && !seen.has(r.id) && r.duration && r.duration <= k.max && r.duration >= 150 && !/LL-Q|[(]eng[)]/.test(r.title)) { pool.push({ ...r, q }); } } catch (e) { console.warn(kind, q, e.message); } }
    // spread the picks across the different search words, best-matching first
    const picks = []; const byQ = k.q.map((q) => pool.filter((p) => p.q === q));
    for (let i = 0; picks.length < k.want && i < 20; i++) for (const list of byQ) { const p = list[i]; if (p && !seen.has(p.id) && picks.length < k.want) { picks.push(p); seen.add(p.id); } }
    let n = 0;
    for (const p of picks) {
      n++; const file = `${kind}_${String(n).padStart(2, '0')}.mp3`;
      try {
        const r = await fetch(p.url, { timeout: 60000 }); if (!r.ok) throw new Error(String(r.status));
        fs.writeFileSync(path.join(OUT, file), await r.buffer());
        out.push({ id: file.replace('.mp3', ''), kind, file, title: p.title, seconds: +(p.duration / 1000).toFixed(2), license: (p.license || '').toUpperCase(), creator: p.creator || '', source: p.foreign_landing_url || '', found_by: p.q });
        console.log('ok ', file, p.duration + 'ms', p.title);
      } catch (e) { console.warn('skip', file, e.message); }
    }
  }
  fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify(out, null, 2));
  const rows = out.map((c) => `<tr data-id="${c.id}"><td><b>${c.id}</b><br><small>${c.kind} · ${c.seconds}s</small></td><td><audio controls preload="none" src="candidates/${c.file}"></audio></td><td>${c.title.replace(/</g, '&lt;')}<br><small><a href="${c.source}" target="_blank">${c.creator ? c.creator + ' · ' : ''}${c.license}</a></small></td><td><label><input type="radio" name="${c.id}" value="yes"> keep</label> <label><input type="radio" name="${c.id}" value="no"> no</label></td></tr>`).join('\n');
  fs.writeFileSync(path.join(__dirname, 'audition.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SmartClips sound audition</title>
<style>body{font:15px system-ui;margin:24px;max-width:980px}h1{margin:0 0 4px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:8px;vertical-align:middle}h2{margin:28px 0 6px;text-transform:capitalize}textarea{width:100%;height:120px}small{color:#777}</style></head><body>
<h1>Sound audition</h1><p>Play each one (turn your volume DOWN first), tick <b>keep</b> for the ones you like, then press the button and paste the result to Claude. Everything here is CC0 (no attribution needed).</p>
${Object.keys(KINDS).map((k) => `<h2>${k} <small>- ${KINDS[k].hint}</small></h2><table>${rows.split('\n').filter((r) => r.includes(`<small>${k} ·`)).join('\n')}</table>`).join('\n')}
<p><button onclick="var k=[...document.querySelectorAll('input[value=yes]:checked')].map(function(i){return i.name});var o=document.getElementById('o');o.value='KEEP: '+k.join(', ');o.select()">Make my list</button></p><textarea id="o" placeholder="your list appears here"></textarea>
</body></html>`);
  console.log('\n' + out.length + ' candidates. Open backend/sfx/audition.html');
})().catch((e) => { console.error(e); process.exit(1); });
