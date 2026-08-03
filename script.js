// GraphMotion frontend — no hardcoded data beyond the demo copy itself,
// all real signups go through the backend API.

// Point this at your Render backend once deployed, e.g.:
// const API_BASE = "https://graphmotion-backend.onrender.com";
const API_BASE = "https://graphmotion-backend.onrender.com";

// ---------------------------------------------------------------------
// Hero typing effect
// ---------------------------------------------------------------------
(function typePrompt() {
  const el = document.getElementById('typedPrompt');
  if (!el) return;

  const text = "explain compound interest, upbeat and visual";
  let i = 0;

  function tick() {
    if (i <= text.length) {
      el.textContent = text.slice(0, i);
      i++;
      setTimeout(tick, 38);
    }
  }
  tick();
})();

// ---------------------------------------------------------------------
// Live demo: prompt -> POST /api/render -> poll /api/render/:jobId -> play mp4
// ---------------------------------------------------------------------
(function setupDemoForm() {
  const form = document.getElementById('demoForm');
  if (!form) return;

  const promptInput = document.getElementById('demoPrompt');
  const submitBtn = document.getElementById('demoSubmit');
  const statusWrap = document.getElementById('demoStatusWrap');
  const statusLabel = document.getElementById('demoStatusLabel');
  const statusPercent = document.getElementById('demoStatusPercent');
  const progressFill = document.getElementById('demoProgressFill');
  const videoWrap = document.getElementById('demoVideoWrap');
  const video = document.getElementById('demoVideo');
  const errorEl = document.getElementById('demoError');

  const STATUS_LABELS = {
    queued: 'Queued…',
    generating: 'Writing the animation code…',
    rendering: 'Rendering frames…',
    done: 'Done.',
    error: 'Something went wrong.',
  };

  let pollTimer = null;

  function setProgress(status, progress) {
    statusLabel.textContent = STATUS_LABELS[status] || status;
    const pct = Math.round((progress || 0) * 100);
    statusPercent.textContent = `${pct}%`;
    progressFill.style.width = `${pct}%`;
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function pollJob(jobId) {
    try {
      const res = await fetch(`${API_BASE}/api/render/${jobId}`);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Render failed.');
      }

      setProgress(data.status, data.progress);

      if (data.status === 'done' && data.url) {
        stopPolling();
        video.src = `${API_BASE}${data.url}`;
        videoWrap.hidden = false;
        submitBtn.disabled = false;
        return;
      }

      if (data.status === 'error') {
        throw new Error(data.error || 'Render failed.');
      }

      pollTimer = setTimeout(() => pollJob(jobId), 2500);
    } catch (err) {
      stopPolling();
      statusWrap.hidden = true;
      errorEl.textContent = err.message || 'Could not reach the render service.';
      submitBtn.disabled = false;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    stopPolling();

    const prompt = promptInput.value.trim();
    if (!prompt) return;

    errorEl.textContent = '';
    videoWrap.hidden = true;
    video.removeAttribute('src');
    statusWrap.hidden = false;
    submitBtn.disabled = true;
    setProgress('queued', 0);

    try {
      const res = await fetch(`${API_BASE}/api/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not start the render.');
      }

      pollJob(data.jobId);
    } catch (err) {
      statusWrap.hidden = true;
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
