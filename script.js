import { Canvas } from '@motion-canvas/core/lib/Canvas.js';
import { Scene } from '@motion-canvas/core/lib/scenes/Scene.js';
import { createRef } from '@motion-canvas/core/lib/utils.js';
import { Circle, Rect, Txt, makeScene2D } from '@motion-canvas/2d/lib/scenes/Scene2D.js';
import { all, waitFor } from '@motion-canvas/core/lib/flow.js';
import { createSignal } from '@motion-canvas/core/lib/signals.js';

const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const scriptBtn = document.getElementById('scriptBtn');
const renderBtn = document.getElementById('renderBtn');
const loading = document.getElementById('loading');
const loadingMsg = document.getElementById('loadingMsg');
const canvasContainer = document.getElementById('canvasContainer');
const canvasElement = document.getElementById('motionCanvas');

const BACKEND_URL = 'https://graphmotion.onrender.com';
let currentScript = null; // store the script from Mistral
let videoTitle = '';
let videoAuthor = '';

// --- UI helpers ---
function showLoading(msg = 'Processing...') {
  preview.classList.add('hidden');
  canvasContainer.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingMsg.textContent = msg;
  input.disabled = true;
  downloadBtn.disabled = true;
  scriptBtn.disabled = true;
  renderBtn.disabled = true;
}

function hideLoading() {
  loading.classList.add('hidden');
  input.disabled = false;
  downloadBtn.disabled = false;
  scriptBtn.disabled = false;
  renderBtn.disabled = currentScript === null;
}

function isTikTokUrl(url) {
  return url.includes('tiktok.com');
}

// --- Preview (same as before) ---
input.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (!url || !isTikTokUrl(url)) return alert('Enter a valid TikTok URL');
    showLoading('Fetching video...');
    try {
      const res = await fetch(`${BACKEND_URL}/get-video-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview failed');
      videoTitle = data.title;
      videoAuthor = data.author;
      hideLoading();
      preview.innerHTML = `
        <div class="video-wrapper">
          <video controls autoplay>
            <source src="${data.videoUrl}" type="video/mp4" />
          </video>
          <div class="video-info">
            <h2>${data.title}</h2>
            <p>${data.author}</p>
          </div>
        </div>
      `;
      preview.classList.remove('hidden');
    } catch (err) {
      hideLoading();
      alert('Preview error: ' + err.message);
    }
  }
});

// --- Download full video ---
downloadBtn.addEventListener('click', async () => {
  const url = input.value.trim();
  if (!url || !isTikTokUrl(url)) return alert('Enter a valid TikTok URL');
  showLoading('Downloading & uploading...');
  try {
    const res = await fetch(`${BACKEND_URL}/download-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Download failed');
    hideLoading();
    preview.innerHTML = `
      <div class="video-wrapper">
        <video controls autoplay>
          <source src="${data.signedUrl}" type="video/mp4" />
        </video>
        <div class="video-info">
          <h2>${data.title}</h2>
          <p>${data.author}</p>
          <a href="${data.signedUrl}" download="${data.title || 'video'}.mp4" class="download-link">⬇️ Download Video</a>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');
    // Update global metadata
    videoTitle = data.title;
    videoAuthor = data.author;
  } catch (err) {
    hideLoading();
    alert('Download error: ' + err.message);
  }
});

// --- Generate Script (Mistral) ---
scriptBtn.addEventListener('click', async () => {
  if (!videoTitle) {
    alert('Please preview or download a video first to get its title.');
    return;
  }
  showLoading('Contacting Mistral AI...');
  try {
    const res = await fetch(`${BACKEND_URL}/generate-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: videoTitle, author: videoAuthor }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Script generation failed');
    currentScript = data.script; // array of scenes
    hideLoading();
    renderBtn.disabled = false;
    alert('Script generated successfully! Click "Render Animation" to see it.');
    console.log('Script:', currentScript);
  } catch (err) {
    hideLoading();
    alert('Script error: ' + err.message);
  }
});

// --- Render Animation (Motion Canvas) ---
renderBtn.addEventListener('click', async () => {
  if (!currentScript) return alert('Generate a script first.');
  // Show canvas container
  canvasContainer.classList.remove('hidden');
  // We'll clear any previous animation
  // Use Motion Canvas to render the script
  try {
    // Build a dynamic scene based on currentScript
    const scene = makeScene2D(function* (view) {
      // Create shapes based on the script
      const shapes = [];
      for (const item of currentScript) {
        const shape = item.shape || 'circle';
        const color = item.color || '#ff0000';
        const x = item.x || 400;
        const y = item.y || 300;
        const duration = item.duration || 1;
        let node;
        if (shape === 'circle') {
          node = new Circle({ radius: 50, fill: color, x, y });
        } else if (shape === 'rect') {
          node = new Rect({ width: 100, height: 80, fill: color, x, y });
        } else if (shape === 'triangle') {
          // Triangle via polygon
          node = new Rect({ width: 80, height: 80, fill: color, x, y });
        } else {
          node = new Circle({ radius: 40, fill: color, x, y });
        }
        shapes.push(node);
        view.add(node);
      }
      // Animate: fade in each shape with a delay
      for (let i = 0; i < shapes.length; i++) {
        const node = shapes[i];
        yield* node.opacity(0, 0).to(1, 0.5);
        yield* waitFor(0.3);
      }
    });
    // Render the scene onto the canvas
    const canvas = new Canvas(canvasElement, { width: 800, height: 600 });
    await canvas.loadScene(scene);
    canvas.play();
    renderBtn.disabled = true; // disable until new script generated
  } catch (err) {
    alert('Render error: ' + err.message);
  }
});
