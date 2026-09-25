'use strict';
/*
 * Image -> video: turns a still picture into a few seconds of REAL motion (camera move, steam rising, an object coming alive).
 * Chained clip after clip - the last frame of one clip is the first frame of the next - this is what makes an ad a movie scene
 * (one world, one camera, no cuts) instead of pictures joined by transitions.
 *
 * Provider: the free LTX-Video (distilled) demo on Hugging Face Spaces, called with @gradio/client. Its GPU time is a small free
 * quota per person: anonymous calls get ~30-60 GPU-seconds a day, a free Hugging Face token (HF_TOKEN) more, PRO much more.
 * The provider is isolated here so a paid API (fal.ai, Replicate ...) can be dropped in without touching the rest.
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

/** One clip: startImage (png/jpg path) + a director's note -> mp4 of about `seconds` seconds. */
async function clip({ startImage, prompt, seconds = 3, seed = 42, out }) {
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
async function lastFrame(clipPath, out) { await ff(['-sseof', '-0.08', '-i', clipPath, '-update', '1', '-frames:v', '1', out]); return out; }

/**
 * Join clips into ONE continuous film. Each clip is stretched to exactly `sceneSeconds` (slow, cinematic; the model makes ~3 s clips),
 * then encoded as VP9 WebM - the codec headless Chrome can decode - at the same size as the pictures.
 */
async function assemble(clips, sceneSeconds, out) {
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const f = clips.map((c, i) => `[${i}:v]setpts=PTS*${(sceneSeconds / Math.max(0.5, c.seconds)).toFixed(4)},fps=30,scale=${W}:${H}:flags=lanczos,setsar=1[v${i}]`);
  const graph = f.join(';') + ';' + clips.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[o]`;
  await ff([...inputs, '-filter_complex', graph, '-map', '[o]', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-an', out]);
  return out;
}

const probeSeconds = (file) => new Promise((resolve) => {
  const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  p.on('close', () => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err); resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 3); });
});

module.exports = { clip, lastFrame, assemble, probeSeconds, QuotaError, W, H };
