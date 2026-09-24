'use strict';
// LOCAL TESTING ONLY (GENERATE_MOCK=1): stands in for the Cloudflare call so the whole company-details -> preview -> video
// flow can be exercised without spending a single neuron. Never used in production (the env flag is not set there).
const fs = require('fs');
const path = require('path');
const gen = require('./siteGenerator');

module.exports = async function mockGenerate(input, outDir, onProgress) {
  const n = input.company;
  const raw = {
    brand: n, tagline: 'Made for you', look: 'clean', accent: '#FF6B35', bg: '#0B1C2D', cta: 'Get started',
    scenes: [
      { id: 'hook', tag: 'Stop scrolling', headline: `What if ${n} *changed* everything?` },
      { id: 'pain', tag: 'Real talk', headline: 'The old way is *broken*', sub: input.focus.split(/\s+/).slice(0, 8).join(' ') },
      { id: 'solution', tag: 'Meet it', headline: `Meet *${n}*`, sub: 'Built around you', sticker: { n: '100%', l: 'focused' }, tone: 'light' },
      { id: 'feature', tag: 'How it works', headline: 'Simple, fast and *yours*', sticker: { n: '3x', l: 'faster' } },
      { id: 'proof', tag: 'The proof', headline: 'People *love* it', sub: 'Join the crowd', sticker: { n: '4.9', l: 'rating' } },
      { id: 'cta', headline: `Try *${n}* today` },
    ],
  };
  const spec = gen.normalizeSpec(raw, n, { brand: n, brief: '' });
  const src = path.join(__dirname, '..', 'aquaforge2', 'images'), map = { hook: 'hero', pain: 'story', solution: 'product1', feature: 'product2', proof: 'proof', cta: 'join' };
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  for (const [k, v] of Object.entries(map)) fs.copyFileSync(path.join(src, v + '.webp'), path.join(outDir, 'images', k + '.webp'));
  return gen.generateSite({ spec, logo: input.logo, images: [], outDir, onProgress });
};
