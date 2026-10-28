/**
 * Nivra first-run setup window
 * ─────────────────────────────────────────────────────────────────────────────
 * Opened by the background script right after install. Shows whether the one
 * manual step is done, in red until it is:
 *   - Chromium (Edge, Chrome, Opera): "Allow access to file URLs" for local PDFs.
 *   - Firefox: site access (host permissions are opt-in there; file URLs are not
 *     available to add-ons at all).
 * The page re-checks by itself, so it turns green as soon as the user flips the switch.
 */
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const ua = navigator.userAgent;
  const IS_FIREFOX = /\bFirefox\//.test(ua);
  const IS_EDGE = /\bEdg\//.test(ua);
  const IS_OPERA = !IS_EDGE && /\bOPR\//.test(ua);
  const EXT_PAGE = IS_EDGE ? 'edge' : IS_OPERA ? 'opera' : 'chrome';

  const $ = id => document.getElementById(id);
  const card = $('card');
  let timer = null;

  function ask(message) {
    return new Promise(resolve => {
      try {
        const r = api.runtime.sendMessage(message, resolve);
        if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
      } catch (_) { resolve(null); }
    });
  }

  function setSteps(items) {
    const list = $('steps');
    list.replaceChildren();
    for (const parts of items) {
      const li = document.createElement('li');
      for (const [text, bold] of parts) {
        const node = bold ? document.createElement('strong') : document.createTextNode('');
        node.textContent = text;
        li.append(node);
      }
      list.append(li);
    }
    list.hidden = !items.length;
  }

  function render(state, { title, lead, steps = [], button = null, onButton = null, hint = '' }) {
    card.dataset.state = state;
    $('badge').textContent = state === 'done' ? '✓' : state === 'needed' ? '!' : '…';
    $('title').textContent = title;
    $('lead').textContent = lead;
    setSteps(steps);
    const primary = $('primary');
    primary.hidden = !button;
    if (button) { primary.textContent = button; primary.onclick = onButton; }
    $('close').hidden = state !== 'done';
    $('hint').textContent = hint;
  }

  // ─── Chromium: file URL access ─────────────────────────────────────────────
  function renderChromium(allowed) {
    if (allowed) {
      render('done', {
        title: 'You’re all set',
        lead: 'Local PDFs on your computer will now open in Nivra, and so will PDFs on the web.',
      });
      return;
    }
    render('needed', {
      title: 'One more step: allow local files',
      lead: 'Without it, PDFs saved on your computer keep opening in the browser’s own viewer.',
      steps: [
        [['Click ', false], ['Open Nivra settings', true], [' below.', false]],
        [['Find ', false], ['Nivra', true], [' and click ', false], ['Details', true], ['.', false]],
        [['Switch on ', false], ['Allow access to file URLs', true], ['.', false]],
      ],
      button: 'Open Nivra settings',
      onButton: () => {
        api.tabs.create({ url: `${EXT_PAGE}://extensions/?id=${api.runtime.id}` });
      },
      hint: 'This window turns green by itself once you switch it on.',
    });
  }

  // ─── Firefox: site access ──────────────────────────────────────────────────
  const SITE_ORIGINS = (api.runtime.getManifest().host_permissions || []).filter(o => !o.startsWith('file:'));

  async function hasSiteAccess() {
    try { return await api.permissions.contains({ origins: SITE_ORIGINS }); } catch (_) { return false; }
  }

  function renderFirefox(granted) {
    if (granted) {
      render('done', {
        title: 'You’re all set',
        lead: 'PDF links on the web will open in Nivra. PDFs saved on your computer stay in Firefox’s viewer; drop one on the Nivra popup to read it in Nivra.',
      });
      return;
    }
    render('needed', {
      title: 'One more step: allow site access',
      lead: 'Firefox needs your permission before Nivra can open PDF links.',
      button: 'Allow site access',
      // Runs straight from the click: permissions.request needs a user gesture.
      onButton: async () => {
        try { await api.permissions.request({ origins: SITE_ORIGINS }); } catch (_) { /* denied */ }
        check();
      },
      hint: 'Click the button, then choose Allow in Firefox’s prompt.',
    });
  }

  // ─── Check loop ────────────────────────────────────────────────────────────
  async function check() {
    const reply = await ask({ type: 'GET_FILE_ACCESS' });
    if (IS_FIREFOX || reply?.unsupported) {
      const granted = await hasSiteAccess();
      renderFirefox(granted);
      return granted;
    }
    const allowed = !!reply?.allowed;
    renderChromium(allowed);
    return allowed;
  }

  function startPolling() {
    clearInterval(timer);
    timer = setInterval(async () => { if (await check()) clearInterval(timer); }, 1500);
  }

  $('close').addEventListener('click', () => window.close());
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

  check().then(done => { if (!done) startPolling(); });
})();
