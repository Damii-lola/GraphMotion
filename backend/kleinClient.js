'use strict';
/*
 * FLUX.2 [klein] on Cloudflare Workers AI: one model that both generates an image from text AND edits a reference image.
 * That is what lets an ad be ONE WORLD seen through six shots (same place, same objects, same light) instead of six unrelated pictures:
 * shot 1 is generated from text, every following shot is an EDIT of the previous one ("the camera pushes in on the sketch; its lines glow").
 * The API takes multipart/form-data (prompt, width, height, input_image_0..3) and returns { result: { image: base64 } }.
 */
const MODEL = process.env.KLEIN_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
const W = +process.env.KLEIN_W || 512, H = +process.env.KLEIN_H || 1024;   // billing turned out to be per picture, not per tile (see neuronBudget.js)

async function runOnce(fields, files) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !tok) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, buf] of Object.entries(files || {})) fd.append(k, new Blob([buf], { type: 'image/png' }), k + '.png');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${MODEL}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd, signal: AbortSignal.timeout(+process.env.KLEIN_TIMEOUT_MS || 100000) });   // a hung request never blocks a whole film
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) { /* handled below */ }
  if (!j || !j.result || !j.result.image) throw new Error('image generation failed: ' + (j ? JSON.stringify(j.errors || j) : r.status + ' ' + txt.slice(0, 200)).slice(0, 260));
  return Buffer.from(j.result.image, 'base64');
}

/** A hiccup (network, 5xx, busy) is retried twice; a safety-filter refusal or a quota error is not, those are answers. */
async function run(fields, files) {
  let last;
  for (let k = 0; k < 3; k++) {
    try { return await runOnce(fields, files); }
    catch (e) { last = e; if (/8007|NSFW|flagged|4006|429|allocation|Neuron guard|not set/i.test(String(e.message))) throw e; console.warn(`[klein] attempt ${k + 1} failed: ${String(e.message).slice(0, 160)}`); await new Promise((r) => setTimeout(r, 1500 * (k + 1))); }
  }
  throw last;
}

/** shot 1: text -> picture */
const generate = (prompt, o = {}) => run({ prompt: String(prompt).slice(0, 1800), width: o.width || W, height: o.height || H });
/** every later shot: an edit of a reference picture (the previous shot, or the client's own photo) */
/** reference = the picture to edit; extra = up to 3 more reference images (the client's logo / product photos) so the brand stays in every shot */
const edit = (prompt, reference, extra = []) => { const files = { input_image_0: reference }; extra.slice(0, 3).forEach((b, k) => { files['input_image_' + (k + 1)] = b; }); return run({ prompt: String(prompt).slice(0, 1800), width: W, height: H }, files); };

module.exports = { generate, edit, W, H, MODEL };
