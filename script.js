// GraphMotion frontend — the hero generator calls the real backend.
// Preview is fully client-side: Mistral's generated Remotion code is
// transpiled in-browser (Babel Standalone) and played live via
// @remotion/player, loaded from esm.sh. No server-side render for the
// free tier — that's the whole point, it's what makes this fast.

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
// Client-side Remotion: load once from a CDN, cache the modules, then
// transpile + mount whatever scene code the backend hands back.
// ---------------------------------------------------------------------
const REMOTION_VERSION = '4.0.506';
const REACT_VERSION = '18.3.1';
const CDN = {
  react: `https://esm.sh/react@${REACT_VERSION}`,
  reactDomClient: `https://esm.sh/react-dom@${REACT_VERSION}/client?deps=react@${REACT_VERSION}`,
  remotion: `https://esm.sh/remotion@${REMOTION_VERSION}?deps=react@${REACT_VERSION},react-dom@${REACT_VERSION}`,
  player: `https://esm.sh/@remotion/player@${REMOTION_VERSION}?deps=react@${REACT_VERSION},react-dom@${REACT_VERSION}`,
};

let modulesPromise = null;
function loadRemotionModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import(CDN.react),
      import(CDN.reactDomClient),
      import(CDN.remotion),
      import(CDN.player),
    ]).then(([ReactMod, ReactDOMClientMod, Remotion, PlayerMod]) => ({
      React: ReactMod.default || ReactMod,
      createRoot: ReactDOMClientMod.createRoot,
      Remotion,
      Player: PlayerMod.Player,
    }));
  }
  return modulesPromise;
}

// The backend sends a plain, real Remotion .tsx file (with a normal
// `import {...} from 'remotion'` line) — the same shape used for the
// future server-side export. For the live browser preview we strip that
// import line and inject the matching bindings as function arguments
// instead, since there's no module loader for an eval'd string.
function compileScene(rawCode) {
  if (typeof Babel === 'undefined') {
    throw new Error('Preview engine failed to load. Check your connection and try again.');
  }

  const withoutImport = rawCode.replace(
    /^\s*import\s*\{[^}]*\}\s*from\s*['"]remotion['"];?\s*$/m,
    ''
  );
  const withoutExport = withoutImport.replace(
    /export\s+function\s+GeneratedScene/,
    'function GeneratedScene'
  );

  if (!/function\s+GeneratedScene/.test(withoutExport)) {
    throw new Error('Generated code was missing the expected GeneratedScene component.');
  }

  const transpiled = Babel.transform(withoutExport, {
    presets: ['react', 'typescript'],
    filename: 'generated.tsx',
  }).code;

  const factory = new Function(
    'React',
    'AbsoluteFill', 'useCurrentFrame', 'useVideoConfig', 'interpolate', 'spring', 'Sequence', 'Easing', 'Img', 'staticFile',
    `${transpiled}\nreturn GeneratedScene;`
  );

  return factory;
}

let playerRoot = null;

async function mountScene(rawCode, container) {
  const { React, createRoot, Remotion, Player } = await loadRemotionModules();

  const factory = compileScene(rawCode);
  const GeneratedScene = factory(
    React,
    Remotion.AbsoluteFill,
    Remotion.useCurrentFrame,
    Remotion.useVideoConfig,
    Remotion.interpolate,
    Remotion.spring,
    Remotion.Sequence,
    Remotion.Easing,
    Remotion.Img,
    Remotion.staticFile
  );

  if (!playerRoot) playerRoot = createRoot(container);

  playerRoot.render(
    React.createElement(Player, {
      component: GeneratedScene,
      durationInFrames: 240,
      fps: 30,
      compositionWidth: 1080,
      compositionHeight: 1920,
      controls: true,
      autoPlay: true,
      loop: true,
      style: { width: '100%', height: '100%' },
    })
  );
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
  const previewPlayer = document.getElementById('previewPlayer');
  const codeContent = document.getElementById('codeContent');
  const timelinePlayhead = document.getElementById('timelinePlayhead');

  if (!form) return;

  let codeRevealed = false;
  let typeTimer = null;

  function resetCodePanel() {
    codeRevealed = false;
    if (typeTimer) clearInterval(typeTimer);
    codeContent.textContent = '// waiting for a prompt…';
  }

  function revealCode(code) {
    if (codeRevealed || !code) return;
    codeRevealed = true;
    if (typeTimer) clearInterval(typeTimer);

    codeContent.textContent = '';
    const chunkSize = Math.max(1, Math.ceil(code.length / 100));
    let i = 0;
    typeTimer = setInterval(() => {
      i += chunkSize;
      codeContent.textContent = code.slice(0, i);
      if (i >= code.length) clearInterval(typeTimer);
    }, 12);
  }

  function showIdle() {
    previewIdle.hidden = false;
    previewLoading.hidden = true;
    previewPlayer.hidden = true;
    resetCodePanel();
  }

  function showLoading(label) {
    previewIdle.hidden = true;
    previewLoading.hidden = false;
    previewPlayer.hidden = true;
    loadingLabel.textContent = label || 'Writing the animation code…';
    timelinePlayhead.style.left = '30%';
  }

  async function showResult(code) {
    revealCode(code);
    try {
      previewIdle.hidden = true;
      previewLoading.hidden = true;
      previewPlayer.hidden = false;
      await mountScene(code, previewPlayer);
    } catch (err) {
      console.error('Preview mount failed:', err);
      previewPlayer.hidden = true;
      previewIdle.hidden = false;
      errorEl.textContent = 'Could not preview this scene — try a different prompt.';
    }
  }

  function lockUI(prompt) {
    form.hidden = true;
    lockedBanner.hidden = false;
    lockedPrompt.textContent = `"${prompt}"`;
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
        if (data.code) showResult(data.code);
      }
    } catch (err) {
      console.error('free-status check failed', err);
    }
  })();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const prompt = promptInput.value.trim();
    if (!prompt) return;

    errorEl.textContent = '';
    submitBtn.disabled = true;
    showLoading('Writing the animation code…');

    try {
      const res = await fetch(`${API_BASE}/api/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, deviceId: getDeviceId() }),
      });
      const data = await res.json();

      if (res.status === 403 && data.locked) {
        lockUI(data.prompt || prompt);
        if (data.code) showResult(data.code);
        submitBtn.disabled = false;
        return;
      }

      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not generate a preview.');

      await showResult(data.code);
      lockUI(prompt);
      submitBtn.disabled = false;
    } catch (err) {
      showIdle();
      errorEl.textContent = err.message || 'Could not reach the generation service.';
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
