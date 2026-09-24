'use strict';
/*
 * brief -> cinematic site (cinema engine) : director (LLM) -> photographs (Flux) -> soundtrack (synth) -> page.
 * Output folder: index.html, images/*.webp, audio.wav, site.json. The page exposes __duration / __seek /
 * __energy / __audio / __assetsReady, which is what siteRecorder.js needs to render it to video.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');
const { directFilm, normalize } = require('./cinemaDirector');
const { synth, cuesFromSpec } = require('./siteAudio');

const IMAGE_SUFFIX = ', wide cinematic photograph, dramatic rim lighting, volumetric atmosphere, deep contrast, epic scale, film grain, vertical composition with the subject centred, no text, no letters, no logos, no watermark';

async function flux(prompt) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !tok) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: prompt.slice(0, 900), steps: 6 }),
  });
  const j = await r.json();
  if (!j.result || !j.result.image) throw new Error('image generation failed: ' + JSON.stringify(j.errors || j).slice(0, 220));
  return Buffer.from(j.result.image, 'base64');
}
const toWebp = (inFile, outFile) => new Promise((resolve, reject) => {
  const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-i', inFile, '-vf', "scale='min(1280,iw)':-2", '-quality', '84', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; ff.stderr.on('data', (d) => { err += d; });
  ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('webp conversion failed: ' + err.slice(-200)))));
});

async function generateCinemaSite({ brief, outDir, slug, onProgress, spec: given, planOnly, keepImages }) {
  const say = (stage, progress) => { if (onProgress) onProgress({ stage, progress }); };
  let spec = given ? (given.theme ? given : normalize(given, slug)) : null; // a saved site.json is already normalised
  if (!spec) { say('Directing the film', 0.05); spec = await directFilm(brief, slug); }
  fs.mkdirSync(outDir, { recursive: true });
  if (planOnly) { fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2)); return { outDir, spec }; }
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  try {
    for (let k = 0; k < spec.images.length; k++) {
      const im = spec.images[k], webp = path.join(outDir, 'images', im.id + '.webp');
      if (keepImages && fs.existsSync(webp)) { say(`Image ${k + 1}/${spec.images.length} (kept)`, 0.12 + 0.7 * ((k + 1) / spec.images.length)); continue; }
      say(`Painting image ${k + 1} of ${spec.images.length}`, 0.12 + 0.7 * (k / spec.images.length));
      const png = path.join(tmp, im.id + '.png');
      fs.writeFileSync(png, await flux(`${im.prompt}, ${spec.imageStyle}${IMAGE_SUFFIX}`));
      await toWebp(png, webp);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  say('Composing the soundtrack', 0.88);
  const total = spec.beats.reduce((s, b) => s + b.dur, 0);
  spec.audio = 'audio.wav'; spec.cues = cuesFromSpec(spec);
  fs.writeFileSync(path.join(outDir, 'audio.wav'), synth({ duration: total, cues: spec.cues, music: spec.music }));
  say('Building the page', 0.95);
  const tpl = fs.readFileSync(path.join(__dirname, 'siteTemplate2', 'index.html'), 'utf8');
  const html = tpl.replace('/*__SITE_JSON__*/null', () => JSON.stringify(spec).replace(/</g, '\\u003c')).replace('{{TITLE}}', () => spec.brand.replace(/[<>&]/g, '')).replace('{{FIRST}}', () => spec.beats[0].image);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(spec, null, 2));
  say('Done', 1);
  return { outDir, spec };
}

module.exports = { generateCinemaSite };
