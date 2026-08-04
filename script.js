// GraphMotion frontend — the hero generator calls the real backend.
// No hardcoded data beyond UI copy; every render and every lock decision
// comes from the server.

const API_BASE = "https://graphmotion.onrender.com";
const DEVICE_ID_KEY = "gm_device_id";

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------------
// Hero generator
// ---------------------------------------------------------------------
(function setupGenerator() {
  const form = document.getElementById('generatorForm');
  const lockedBanner = document.getElementById('lockedBanner');
  const lockedPrompt = document.getElementById('lockedPrompt');
  const errorEl = document.getElementById('generatorError');
  const promptInput = document.getElementById('promptInput');
  const submitBtn = document.getElementById('generatorSubmit');

  const previewIdle = document.getElementById('previewIdle');
  const previewLoading = document.getElementById('previewLoading');
  const loadingLabel = document.getElementById('loadingLabel');
  const resultVideo = document.getElementById('resultVideo');

  if (!form) return;

  const STATUS_LABELS = {
    queued: 'Queued…',
    generating: 'Writing the animation code…',
    rendering: 'Rendering frames…',
  };

  function showIdle() {
    previewIdle.hidden = false;
    previewLoading.hidden = true;
    resultVideo.hidden = true;
  }

  function showLoading(status) {
    previewIdle.hidden = true;
    previewLoading.hidden = false;
    resultVideo.hidden = true;
    loadingLabel.textContent = STATUS_LABELS[status] || 'Rendering…';
  }

  function showResult(url) {
    previewIdle.hidden = true;
    previewLoading.hidden = true;
    resultVideo.src = `${API_BASE}${url}`;
    resultVideo.hidden = false;
  }

  function lockUI(prompt) {
    form.hidden = true;
    lockedBanner.hidden = false;
    lockedPrompt.textContent = `"${prompt}"`;
  }

  let pollTimer = null;
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function pollJob(jobId, prompt) {
    try {
      const res = await fetch(`${API_BASE}/api/render/${jobId}`);
      const data = await res.json();

      if (!res.ok || !data.ok) throw new Error(data.error || 'Render failed.');

      if (data.status === 'error') throw new Error(data.error || 'Render failed.');

      showLoading(data.status);

      if (data.status === 'done' && data.url) {
        stopPolling();
        showResult(data.url);
        lockUI(prompt);
        submitBtn.disabled = false;
        return;
      }

      pollTimer = setTimeout(() => pollJob(jobId, prompt), 2500);
    } catch (err) {
      stopPolling();
      showIdle();
      errorEl.textContent = err.message || 'Could not reach the render service.';
      submitBtn.disabled = false;
    }
  }

  // On load: ask the server whether this visitor already used their free
  // generation. If so, skip straight to the locked state with their result.
  (async function checkFreeStatus() {
    try {
      const deviceId = getDeviceId();
      const res = await fetch(`${API_BASE}/api/free-status?deviceId=${encodeURIComponent(deviceId)}`);
      const data = await res.json();

      if (data.ok && data.used) {
        lockUI(data.prompt || '');
        if (data.url) showResult(data.url);
      }
    } catch (err) {
      // If the status check fails, leave the form usable — the render
      // endpoint itself still enforces the limit server-side either way.
      console.error('free-status check failed', err);
    }
  })();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    stopPolling();

    const prompt = promptInput.value.trim();
    if (!prompt) return;

    errorEl.textContent = '';
    submitBtn.disabled = true;
    showLoading('queued');

    try {
      const res = await fetch(`${API_BASE}/api/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, deviceId: getDeviceId() }),
      });
      const data = await res.json();

      if (res.status === 403 && data.locked) {
        // Already used, caught late (e.g. two tabs). Lock the UI instead of erroring.
        lockUI(data.prompt || prompt);
        if (data.url) showResult(data.url);
        submitBtn.disabled = false;
        return;
      }

      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not start the render.');

      pollJob(data.jobId, prompt);
    } catch (err) {
      showIdle();
      errorEl.textContent = err.message || 'Could not reach the render service.';
      submitBtn.disabled = false;
    }
  });
})();

// ---------------------------------------------------------------------
// Waitlist form
// ---------------------------------------------------------------------
(function setupWaitlistForm() {
  const form = document.getElementById('waitlistForm');
  const status = document.getElementById('formStatus');
  if (!form || !status) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput = document.getElementById('email');
    const email = emailInput.value.trim();

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      status.textContent = 'Enter a valid email address.';
      status.className = 'form-status error';
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    status.textContent = 'Sending…';
    status.className = 'form-status';

    try {
      const res = await fetch(`${API_BASE}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'landing_page' }),
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        status.textContent = data.alreadySignedUp
          ? "You're already on the list — see you in Discord."
          : "You're in. Check your email for next steps.";
        status.className = 'form-status success';
        form.reset();
      } else {
        status.textContent = data.error || 'Something went wrong. Try again.';
        status.className = 'form-status error';
      }
    } catch (err) {
      status.textContent = 'Could not reach the server. Try again in a moment.';
      status.className = 'form-status error';
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
