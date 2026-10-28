/**
 * Nivra Background Script: Firefox
 *
 * Loaded only by manifest.firefox.json (as an event page); Chrome, Edge and Opera use sw.js.
 *
 * INTERACTION WITH FIREFOX'S BUILT-IN PDF VIEWER:
 * A blocking webRequest.onBeforeRequest listener redirects main_frame navigations to PDFs
 * to viewer/viewer.html?file=<url> before any response arrives, so Firefox's own pdf.js
 * viewer never loads. When Nivra is disabled the listener lets the request through and
 * Firefox's default viewer is used.
 *
 * WHY THE LISTENER IS NEVER REMOVED:
 * An event page is suspended when idle and only woken for listeners registered while it
 * loads. Adding/removing the listener on toggle would leave a suspended page unable to
 * intercept anything, so it is always registered and checks the enabled flag instead.
 *
 * ENABLE / DISABLE TOGGLE:
 * Same contract as sw.js: the popup sends { type: 'SET_ENABLED', enabled: bool }, the
 * state is persisted to storage.local under 'nivraEnabled' (default true) and applied
 * immediately; it is re-read on install and on browser startup.
 *
 * LOCAL FILES:
 * Firefox does not fire webRequest for file:// URLs and has no "Allow access to file
 * URLs" toggle, so local PDFs keep opening in Firefox's viewer (dropping a file on the
 * popup still works).
 */

const api = globalThis.browser ?? globalThis.chrome;

const STORAGE_KEY = 'nivraEnabled';

// Identical to PDF_URL_RE in sw.js (tests/sw-firefox.test.mjs keeps them in sync).
export const PDF_URL_RE = /^(https?|file):\/\/[^?#]*\.pdf(?:\?[^#]*)?(?:#.*)?$/i;

// ─── Install / uninstall pages ────────────────────────────────────────────────
const SITE_URL = 'https://bhyreshbs.github.io/Nivra/';

function _sitePage(name) {
  return `${SITE_URL}${name}?v=${api.runtime.getManifest().version}&b=firefox`;
}

function _registerUninstallPage() {
  try {
    api.runtime.setUninstallURL(_sitePage('goodbye.html'));
  } catch (err) {
    console.warn('[Nivra BG] Could not set uninstall URL:', err);
  }
}

// ─── Enabled state ────────────────────────────────────────────────────────────
// Cached so the blocking listener can answer without a storage round-trip; null
// means "not loaded yet" (fresh wake of the event page).
let _enabled = null;

export async function isEnabled() {
  if (_enabled === null) {
    const result = await api.storage.local.get(STORAGE_KEY);
    _enabled = result[STORAGE_KEY] !== undefined ? !!result[STORAGE_KEY] : true;
  }
  return _enabled;
}

export async function setEnabled(enabled) {
  _enabled = !!enabled;
  await api.storage.local.set({ [STORAGE_KEY]: _enabled });
  console.log('[Nivra BG] Redirect', _enabled ? 'ENABLED' : 'DISABLED');
  return _enabled;
}

async function _syncWithStorage() {
  _enabled = null;
  return isEnabled();
}

// ─── Redirect ─────────────────────────────────────────────────────────────────
export function viewerUrlFor(pdfUrl) {
  // Literal (unencoded) form, identical to the DNR rule's \0 substitution in sw.js.
  return `${api.runtime.getURL('viewer/viewer.html')}?file=${pdfUrl}`;
}

export async function onBeforeRequest(details) {
  if (details.type !== 'main_frame' || !PDF_URL_RE.test(details.url)) return {};
  if (!(await isEnabled())) return {};
  return { redirectUrl: viewerUrlFor(details.url) };
}

// Requests are only visible for hosts in host_permissions; the regex does the PDF check.
api.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking']
);

// ─── Event: Extension installed or updated ────────────────────────────────────
api.runtime.onInstalled.addListener(async (details) => {
  const result = await api.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY] === undefined || result[STORAGE_KEY] === null) {
    await api.storage.local.set({ [STORAGE_KEY]: true });
  }
  await _syncWithStorage();
  _registerUninstallPage();
  // Welcome page on a fresh install only, not on updates or browser updates.
  if (details?.reason === 'install') {
    Promise.resolve(api.tabs.create({ url: _sitePage('welcome.html') })).catch(() => {});
  }
});

// ─── Event: Browser startup ──────────────────────────────────────────────────
api.runtime.onStartup.addListener(async () => {
  await _syncWithStorage();
  _registerUninstallPage();
});

// ─── Event: Messages from the popup ───────────────────────────────────────────
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SET_ENABLED') {
    setEnabled(message.enabled)
      .then(enabled => sendResponse({ success: true, enabled }))
      .catch(err => {
        console.error('[Nivra BG] SET_ENABLED failed:', err);
        sendResponse({ success: false, error: String(err) });
      });
    return true;
  }

  if (message?.type === 'GET_FILE_ACCESS') {
    // Firefox has no file-URL toggle and webRequest never sees file:// URLs.
    sendResponse({ allowed: false, unsupported: true });
    return false;
  }

  if (message?.type === 'GET_ENABLED') {
    isEnabled()
      .then(enabled => sendResponse({ enabled }))
      .catch(() => sendResponse({ enabled: true }));
    return true;
  }
});
