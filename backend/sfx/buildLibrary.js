'use strict';
// Installs the sounds a person picked in audition.html into the library the generator uses:
//   node buildLibrary.js whoosh_03 whoosh_05 tick_02 sparkle_01 riser_02 impact_04
// Adds a one-line description per sound (optional, after a colon):  whoosh_03:airy-fast-swipe
const fs = require('fs');
const path = require('path');
const cand = JSON.parse(fs.readFileSync(path.join(__dirname, 'candidates', 'candidates.json'), 'utf8'));
const LIB = path.join(__dirname, 'library');
fs.mkdirSync(LIB, { recursive: true });
const out = [];
for (const arg of process.argv.slice(2)) {
  const [id, desc] = arg.split(':'), c = cand.find((x) => x.id === id);
  if (!c) { console.warn('unknown', id); continue; }
  fs.copyFileSync(path.join(__dirname, 'candidates', c.file), path.join(LIB, c.file));
  out.push({ id: c.id, kind: c.kind, file: c.file, seconds: c.seconds, desc: (desc || c.title).replace(/[^A-Za-z0-9 ,.'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50), title: c.title, license: c.license, creator: c.creator, source: c.source });
}
fs.writeFileSync(path.join(LIB, 'catalog.json'), JSON.stringify(out, null, 2));
console.log('library:', out.map((o) => o.id).join(', '));
