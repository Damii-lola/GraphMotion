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
