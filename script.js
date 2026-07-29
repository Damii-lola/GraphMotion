console.log('[GraphMotion] Script loaded');

// ----- Import Motion Canvas (keep as is) -----
import { makeScene2D } from 'https://esm.sh/@motion-canvas/2d@3.12.0/lib/scenes/Scene2D.js';
import { Circle, Rect, Layout } from 'https://esm.sh/@motion-canvas/2d@3.12.0/lib/components/index.js';
import { waitFor } from 'https://esm.sh/@motion-canvas/core@3.12.0/lib/flow.js';
import { createProject } from 'https://esm.sh/@motion-canvas/core@3.12.0/lib/project.js';
import { Player } from 'https://esm.sh/@motion-canvas/player@3.12.0/lib/Player.js';

console.log('[GraphMotion] Imports loaded');

// ----- DOM elements -----
const input = document.getElementById('urlInput');
const preview = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const scriptBtn = document.getElementById('scriptBtn');
const renderBtn = document.getElementById('renderBtn');
const loading = document.getElementById('loading');
const loadingMsg = document.getElementById('loadingMsg');
const playerContainer = document.getElementById('playerContainer');
const canvasElement = document.getElementById('motionCanvas');
const statusText = document.getElementById('statusText');

const BACKEND_URL = 'https://graphmotion.onrender.com'; // <-- CHANGE if different

let currentScript = null;
let videoTitle = '';
let videoAuthor = '';
let playerInstance = null;

// ----- Check backend connection on load -----
async function checkBackend() {
  try {
    statusText.textContent = 'Checking...';
    const res = await fetch(`${BACKEND_URL}/ping`, { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      statusText.textContent = `✅ Online (${text})`;
      statusText.style.color = '#22c55e';
    } else {
      statusText.textContent = `⚠️ Server error (${res.status})`;
      statusText.style.color = '#ef4444';
    }
  } catch (err) {
    statusText.textContent = `❌ Cannot reach backend (${err.message})`;
    statusText.style.color = '#ef4444';
  }
}
checkBackend();

// ----- UI helpers -----
function showLoading(msg = 'Processing...') {
  console.log('[UI] showLoading:', msg);
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
  console.log('[UI] hideLoading');
  loading.classList.add('hidden');
  input.disabled = false;
  downloadBtn.disabled = false;
  scriptBtn.disabled = false;
  renderBtn.disabled = currentScript === null;
}

function isTikTokUrl(url) {
  return url.includes('tiktok.com');
}

// ----- Utility: make fetch with error logging -----
async function apiCall(endpoint, body) {
  const url = `${BACKEND_URL}${endpoint}`;
  console.log(`[API] Calling ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ----- Preview (Enter) -----
input.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const url = input.value.trim();
    if (!url || !isTikTokUrl(url)) {
      alert('Enter a valid TikTok URL');
      return;
    }
    console.log('[Preview] URL:', url);
    showLoading('Fetching video...');
    try {
      const data = await apiCall('/get-video-info', { url });
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
      console.error('[Preview] Error:', err);
      hideLoading();
      alert('Preview error: ' + err.message);
    }
  }
});

// ----- Download full video -----
downloadBtn.addEventListener('click', async () => {
  console.log('[Download] Button clicked');
  const url = input.value.trim();
  if (!url || !isTikTokUrl(url)) {
    alert('Enter a valid TikTok URL');
    return;
  }
  showLoading('Downloading & uploading...');
  try {
    const data = await apiCall('/download-video', { url });
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
    console.error('[Download] Error:', err);
    hideLoading();
    alert('Download error: ' + err.message);
  }
});

// ----- Generate Script (Mistral) -----
scriptBtn.addEventListener('click', async () => {
  console.log('[Script] Button clicked');
  if (!videoTitle) {
    alert('Please preview or download a video first to get its title.');
    return;
  }
  showLoading('Contacting Mistral AI...');
  try {
    const data = await apiCall('/generate-script', { title: videoTitle, author: videoAuthor });
    currentScript = data.script;
    hideLoading();
    renderBtn.disabled = false;
    alert(`✅ Script generated with ${currentScript.length} scenes! Click "Render Animation".`);
    console.log('[GraphMotion] Script:', currentScript);
  } catch (err) {
    console.error('[Script] Error:', err);
    hideLoading();
    alert('Script error: ' + err.message);
  }
});

// ----- Render Animation with Motion Canvas -----
renderBtn.addEventListener('click', async () => {
  console.log('[Render] Button clicked');
  if (!currentScript || currentScript.length === 0) {
    alert('Generate a script first.');
    return;
  }

  showLoading('Building Motion Canvas scene...');
  console.log('[Render] Script:', currentScript);

  try {
    const scene = makeScene2D(function* (view) {
      const group = new Layout({ layout: false });
      view.add(group);
      const nodes = [];
      for (const item of currentScript) {
        const shape = item.shape || 'circle';
        const color = item.color || '#ff0000';
        const x = Number(item.x) || 400;
        const y = Number(item.y) || 300;
        let node;
        if (shape === 'circle') {
          node = new Circle({ radius: 30, fill: color, x, y, opacity: 0 });
        } else if (shape === 'rect') {
          node = new Rect({ width: 80, height: 60, fill: color, x, y, opacity: 0 });
        } else {
          node = new Circle({ radius: 30, fill: color, x, y, opacity: 0 });
        }
        nodes.push(node);
        group.add(node);
      }
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        yield* node.opacity(0, 0).to(1, 0.5);
        yield* waitFor(0.3);
      }
      yield* waitFor(1);
    });

    const project = createProject({
      scenes: [scene],
      settings: {
        width: 800,
        height: 600,
        backgroundColor: '#1a1a1a',
      },
    });

    playerInstance = new Player({
      canvas: canvasElement,
      project,
    });

    playerContainer.classList.remove('hidden');
    hideLoading();
    await playerInstance.play();

  } catch (err) {
    console.error('[Render] Error:', err);
    hideLoading();
    alert('Render error: ' + err.message + '\nCheck console for details.');
  }
});