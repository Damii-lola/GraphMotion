'use strict';
/*
 * Image -> video: turns a still picture into a few seconds of REAL motion (camera move, steam rising, an object coming alive).
 * Chained clip after clip - the last frame of one clip is the first frame of the next - this is what makes an ad a movie scene
 * (one world, one camera, no cuts) instead of pictures joined by transitions.
 *
 * Provider: the free LTX-Video (distilled) demo on Hugging Face Spaces, called with @gradio/client. Its GPU time is a small free
 * quota per person: anonymous calls get ~30-60 GPU-seconds a day, a free Hugging Face token (HF_TOKEN) more, PRO much more.
 * Providers (chosen by env): FAL_KEY -> fal.ai (LTX-Video 13B distilled, paid per second of video, no queue trouble);
 * otherwise the free Hugging Face Space above. Isolated here so the rest of the pipeline never knows which one made the clip.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const SPACE = process.env.VIDEO_SPACE || 'Lightricks/ltx-video-distilled';
const W = +process.env.VIDEO_W || 512, H = +process.env.VIDEO_H || 1024;
const NEGATIVE = 'worst quality, inconsistent motion, blurry, jittery, distorted, text, letters, watermark, logo';

class QuotaError extends Error { constructor(m) { super(m); this.name = 'QuotaError'; } }

let clientPromise = null;
async function client() {
  if (!clientPromise) {
    clientPromise = import('@gradio/client').then(({ Client }) => Client.connect(SPACE, process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {}));
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

const ff = (args) => new Promise((resolve, reject) => {
  const p = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.slice(-200)))));
});

const FAL_MODEL = process.env.FAL_VIDEO_MODEL || 'fal-ai/ltx-video-13b-distilled/image-to-video';
const useFal = () => !!process.env.FAL_KEY;
const useWorker = () => !!process.env.VIDEO_WORKER_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fal.ai queue: submit, poll, download. */
async function falClip({ startImage, prompt, seconds, seed, out }) {
  const H_ = { Authorization: 'Key ' + process.env.FAL_KEY, 'Content-Type': 'application/json' };
  const ext = /.jpe?g$/i.test(startImage) ? 'jpeg' : 'png';
  const frames = Math.max(9, Math.round((seconds * 24 - 1) / 8) * 8 + 1);          // 8k+1 frames at 24 fps
  const body = {
    prompt: `${prompt}, cinematic, smooth camera movement, natural motion`, negative_prompt: NEGATIVE,
    image_url: `data:image/${ext};base64,${fs.readFileSync(startImage).toString('base64')}`,
    resolution: '480p', aspect_ratio: '9:16', num_frames: frames, frame_rate: 24, seed, enable_safety_checker: false, expand_prompt: false,
  };
  const sub = await fetch('https://queue.fal.run/' + FAL_MODEL, { method: 'POST', headers: H_, body: JSON.stringify(body) });
  if (!sub.ok) { const t = await sub.text(); if (sub.status === 401 || sub.status === 403 || /balance|exhausted|locked|credit/i.test(t)) throw new QuotaError('fal.ai: ' + t.slice(0, 200)); throw new Error('fal.ai submit ' + sub.status + ': ' + t.slice(0, 200)); }
  const job = await sub.json();
  const statusUrl = job.status_url || `https://queue.fal.run/${FAL_MODEL.split('/').slice(0, 2).join('/')}/requests/${job.request_id}/status`;
  const resultUrl = job.response_url || `https://queue.fal.run/${FAL_MODEL.split('/').slice(0, 2).join('/')}/requests/${job.request_id}`;
  const t0 = Date.now();
  for (;;) {
    await sleep(2000);
    const st = await (await fetch(statusUrl, { headers: H_ })).json();
    if (st.status === 'COMPLETED') break;
    if (st.status && !/IN_QUEUE|IN_PROGRESS/.test(st.status)) throw new Error('fal.ai: ' + JSON.stringify(st).slice(0, 200));
    if (Date.now() - t0 > 240000) throw new Error('fal.ai: clip timed out');
  }
  const res = await fetch(resultUrl, { headers: H_ });
  if (!res.ok) throw new Error('fal.ai result ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const r = await res.json();
  const url = r.video && r.video.url; if (!url) throw new Error('fal.ai returned no video: ' + JSON.stringify(r).slice(0, 200));
  const dl = await fetch(url); if (!dl.ok) throw new Error('could not download the clip (' + dl.status + ')');
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
  return out;
}

/** One clip: startImage (png/jpg path) + a director's note -> mp4 of about `seconds` seconds. */
async function clip({ startImage, endImage = null, prompt, seconds = 3, seed = 42, out }) {
  if (useWorker()) {                                   // the free notebook GPU worker: it pulls the job from this server
    const frames = Math.max(9, Math.round((seconds * 24 - 1) / 8) * 8 + 1);
    const mp4 = await require('./videoWorker').enqueue({ prompt: `${prompt}, cinematic, smooth camera movement, natural motion`, negative: NEGATIVE, seed, frames, width: W, height: H, image: fs.readFileSync(startImage).toString('base64'), ...(endImage ? { imageEnd: fs.readFileSync(endImage).toString('base64') } : {}) });
    fs.writeFileSync(out, mp4); return out;
  }
  if (useFal()) {
    let last;
    for (let a = 0; a < 2; a++) { try { return await falClip({ startImage, prompt, seconds, seed, out }); } catch (e) { if (e instanceof QuotaError) throw e; last = e; console.warn('[video] fal attempt ' + (a + 1) + ' failed: ' + String(e.message).slice(0, 200)); await sleep(2000); } }
    throw last;
  }
  const [{ handle_file }, c] = await Promise.all([import('@gradio/client'), client()]);
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await c.predict('/image_to_video', {
        prompt: `${prompt}, cinematic, smooth camera movement, natural motion`, negative_prompt: NEGATIVE,
        input_image_filepath: handle_file(startImage), input_video_filepath: null, height_ui: H, width_ui: W, mode: 'image-to-video',
        duration_ui: seconds, ui_frames_to_use: 9, seed_ui: seed, randomize_seed: false, ui_guidance_scale: 1, improve_texture_flag: true,
      });
      const url = r.data && r.data[0] && (r.data[0].video ? r.data[0].video.url : r.data[0].url);
      if (!url) throw new Error('the video model returned no clip');
      const res = await fetch(url); if (!res.ok) throw new Error('could not download the clip (' + res.status + ')');
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      return out;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/quota|exceeded|too many|429/i.test(m)) throw new QuotaError(m);
      last = e; console.warn(`[video] clip attempt ${attempt + 1} failed: ${m.slice(0, 200)}`);
      clientPromise = null; await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last;
}

/** The last picture of a clip: the start of the next one. */
async function lastFrame(clipPath, out) { await ff(['-sseof', '-0.08', '-i', clipPath, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, '-update', '1', '-frames:v', '1', out]); return out; }

/**
 * Join clips into ONE continuous film. Each clip is stretched to exactly `sceneSeconds` (slow, cinematic; the model makes ~3 s clips),
 * then encoded as VP9 WebM - the codec headless Chrome can decode - at the same size as the pictures.
 */
async function assemble(clips, sceneSeconds, out) {
  // ONE small ffmpeg at a time (a single 6-input command peaked at ~245 MB, which OOM-killed the 512 MB server): every clip is
  // stretched + encoded on its own, then the pieces are joined by stream copy (no re-encode, ~no memory).
  const dir = path.dirname(out), parts = [];
  for (let i = 0; i < clips.length; i++) {
    const p = path.join(dir, `part${i}.webm`); parts.push(p);
    await ff(['-i', clips[i].file, '-vf', `setpts=PTS*${(sceneSeconds / Math.max(0.5, clips[i].seconds)).toFixed(4)},fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`,
      '-t', String(sceneSeconds), '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '6', '-threads', '2', '-g', '15', '-pix_fmt', 'yuv420p', '-an', p]);
  }
  const list = path.join(dir, 'parts.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.split('\\').join('/')}'`).join('\n'));
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  for (const p of parts) fs.rmSync(p, { force: true });
  fs.rmSync(list, { force: true });
  return out;
}

const probeSeconds = (file) => new Promise((resolve) => {
  const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  p.on('close', () => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err); resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 3); });
});

const available = () => (useWorker() ? require('./videoWorker').online() : true);
module.exports = { available, useFal, useWorker, clip, lastFrame, assemble, probeSeconds, QuotaError, W, H };
