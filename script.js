import { makeScene2D } from '@motion-canvas/2d/lib/scenes/Scene2D.js';
import { Circle, Rect, Txt, Layout } from '@motion-canvas/2d/lib/components/index.js';
import { createRef } from '@motion-canvas/core/lib/utils.js';
import { all, waitFor } from '@motion-canvas/core/lib/flow.js';
import { createSignal } from '@motion-canvas/core/lib/signals.js';
import { Player } from '@motion-canvas/player/lib/Player.js';
import { createProject } from '@motion-canvas/core/lib/project.js';

const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const scriptBtn = document.getElementById('scriptBtn');
const renderBtn = document.getElementById('renderBtn');
const loading = document.getElementById('loading');
const loadingMsg = document.getElementById('loadingMsg');
const playerContainer = document.getElementById('playerContainer');
const canvasElement = document.getElementById('motionCanvas');

const BACKEND_URL = 'https://graphmotion.onrender.com';
let currentScript = null;
let videoTitle = '';
let videoAuthor = '';
let playerInstance = null;

// --- UI helpers ---
function showLoading(msg = 'Processing...') {
  preview.classList.add('hidden');
  playerContainer.classList.add('hidden');
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

// --- Preview (Enter) ---
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

// --- Render Animation with Motion Canvas ---
renderBtn.addEventListener('click', async () => {
  if (!currentScript || currentScript.length === 0) {
    alert('Generate a script first.');
    return;
  }

  showLoading('Building Motion Canvas scene...');

  try {
    // Create a dynamic scene from the script
    const scene = makeScene2D(function* (view) {
      // We'll create a group to hold all shapes
      const shapes = [];
      const group = new Layout({ layout: false });
      view.add(group);

      // For each item in the script, create a shape node
      for (const item of currentScript) {
        const shape = item.shape || 'circle';
        const color = item.color || '#ff0000';
        const x = item.x || 400;
        const y = item.y || 300;
        const duration = item.duration || 1;
        let node;
        if (shape === 'circle') {
          node = new Circle({ radius: 30, fill: color, x, y, opacity: 0 });
        } else if (shape === 'rect') {
          node = new Rect({ width: 80, height: 60, fill: color, x, y, opacity: 0 });
        } else if (shape === 'triangle') {
          // Use a simple rect as triangle placeholder
          node = new Rect({ width: 70, height: 70, fill: color, x, y, opacity: 0 });
        } else {
          node = new Circle({ radius: 30, fill: color, x, y, opacity: 0 });
        }
        shapes.push(node);
        group.add(node);
      }

      // Animate each shape: fade in, then wait, then move?
      for (let i = 0; i < shapes.length; i++) {
        const node = shapes[i];
        // fade in over 0.5s
        yield* node.opacity(0, 0).to(1, 0.5);
        // wait a bit
        yield* waitFor(0.3);
      }
      // Keep final frame for a moment
      yield* waitFor(1);
    });

    // Create a project with the scene
    const project = createProject({
      scenes: [scene],
      settings: {
        width: 800,
        height: 600,
        backgroundColor: '#1a1a1a',
      },
    });

    // Create a player instance
    playerInstance = new Player({
      canvas: canvasElement,
      project,
      // optional: controls
    });

    // Show the container
    playerContainer.classList.remove('hidden');
    hideLoading();

    // Play the animation
    await playerInstance.play();

  } catch (err) {
    console.error('Render error:', err);
    hideLoading();
    alert('Render error: ' + err.message);
  }
});
