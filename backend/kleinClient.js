'use strict';
/*
 * FLUX.2 [klein] on Cloudflare Workers AI: one model that both generates an image from text AND edits a reference image.
 * That is what lets an ad be ONE WORLD seen through six shots (same place, same objects, same light) instead of six unrelated pictures:
 * shot 1 is generated from text, every following shot is an EDIT of the previous one ("the camera pushes in on the sketch; its lines glow").
 * The API takes multipart/form-data (prompt, width, height, input_image_0..3) and returns { result: { image: base64 } }.
 */
const MODEL = process.env.KLEIN_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
const W = +process.env.KLEIN_W || 512, H = +process.env.KLEIN_H || 1024;   // 2 x 512-px tiles per picture: 768x1344 is 6 tiles and costs ~3x

async function run(fields, files) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !tok) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, buf] of Object.entries(files || {})) fd.append(k, new Blob([buf], { type: 'image/png' }), k + '.png');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${MODEL}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) { /* handled below */ }
  if (!j || !j.result || !j.result.image) throw new Error('image generation failed: ' + (j ? JSON.stringify(j.errors || j) : r.status + ' ' + txt.slice(0, 200)).slice(0, 260));
  return Buffer.from(j.result.image, 'base64');
}

/** shot 1: text -> picture */
const generate = (prompt) => run({ prompt: String(prompt).slice(0, 1800), width: W, height: H });
/** every later shot: an edit of a reference picture (the previous shot, or the client's own photo) */
const edit = (prompt, reference) => run({ prompt: String(prompt).slice(0, 1800), width: W, height: H }, { input_image_0: reference });

module.exports = { generate, edit, W, H, MODEL };
