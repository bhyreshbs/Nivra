/**
 * Nivra Popup Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles:
 *   - Enable/disable toggle via chrome.runtime.sendMessage (direct to SW)
 *   - On disable: if current tab is in Nivra viewer, redirect back to raw PDF
 *   - On enable: if current tab is a raw PDF, redirect into Nivra viewer
 *   - "Open in Nivra" — detects if the active tab has a PDF and redirects it
 *   - "File URL Access" — opens the extension detail page for file access
 *   - "Keyboard Shortcuts" — shows available shortcuts inline
 */

import { putFile } from '../settings/handoff.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const toggle       = document.getElementById('toggle-enabled');
const statusCard   = document.getElementById('status-card');
const statusDot    = document.getElementById('status-dot');
const statusLabel  = document.getElementById('status-label');
const statusDetail = document.getElementById('status-detail');

const btnOpenNivra  = document.getElementById('btn-open-in-nivra');
const openDetail    = document.getElementById('open-nivra-detail');

const btnFileAccess = document.getElementById('btn-file-access');
const btnShortcuts  = document.getElementById('btn-keyboard-shortcuts');

const IS_EDGE = /\bEdg\//.test(navigator.userAgent);
const IS_OPERA = !IS_EDGE && /\bOPR\//.test(navigator.userAgent);
const BROWSER = IS_EDGE ? 'Edge' : IS_OPERA ? 'Opera' : 'Chrome';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const EXTENSION_ID = chrome.runtime.id;
const VIEWER_PATH  = 'viewer/viewer.html';

/**
 * Check if a URL is a Nivra viewer page and extract the original PDF URL.
 * Returns the original PDF URL string, or null if not a Nivra viewer page.
 */
function _extractNivraPdfUrl(tabUrl) {
  if (!tabUrl || !tabUrl.includes(EXTENSION_ID)) return null;
  try {
    // Same two forms as viewer.js: literal (redirect rule) or percent-encoded
    // (this popup). URLSearchParams would cut a literal URL at its first "&".
    const parsed = new URL(tabUrl);
    const m = /[?&]file=/.exec(parsed.search);
    if (!m) return null;
    let url = parsed.search.slice(m.index + m[0].length);
    if (/^[a-z][a-z0-9+.-]*%3A/i.test(url)) {
      try { url = decodeURIComponent(url); } catch (_) { /* keep as-is */ }
    } else {
      url += parsed.hash;
    }
    return url || null;
  } catch (_) {
    return null;
  }
}

/**
 * Check if a URL points directly to a PDF file (not through Nivra).
 */
function _isRawPdfUrl(url) {
  if (!url) return false;
  if (url.includes(EXTENSION_ID)) return false;
  return /\.pdf(\?[^#]*)?(#.*)?$/i.test(url);
}

// ─── Initialize ───────────────────────────────────────────────────────────────
(async function init() {
  // Ask the service worker for the current state (this also wakes it up)
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ENABLED' });
    _setToggleUI(response?.enabled !== false);
  } catch (err) {
    console.warn('[Nivra Popup] Could not get state from SW, defaulting to enabled:', err);
    _setToggleUI(true);
  }

  // Check active tab for PDF
  _checkActiveTab();
})();

// ─── Toggle handler ───────────────────────────────────────────────────────────
toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  _setToggleUI(enabled);

  try {
    // 1. Tell the service worker to add/remove the redirect rule
    const response = await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });

    if (!response?.success) {
      console.error('[Nivra Popup] SW responded with error:', response?.error);
      return;
    }

    // 2. Handle the CURRENT tab — make the toggle feel immediate
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.id) return;

    if (!enabled) {
      // Disabled → if the current tab is showing a PDF inside Nivra, send it
      // back to the raw PDF URL so Chrome's default viewer picks it up.
      const originalPdfUrl = _extractNivraPdfUrl(tab.url);
      if (originalPdfUrl) {
        chrome.tabs.update(tab.id, { url: originalPdfUrl });
        window.close();
      }
    } else {
      // Enabled → if the current tab has a raw PDF URL (e.g. user disabled
      // Nivra, opened a PDF in Chrome viewer, then re-enabled), push it
      // through the Nivra viewer.
      if (_isRawPdfUrl(tab.url)) {
        const nivraUrl = chrome.runtime.getURL(VIEWER_PATH) + '?file=' + encodeURIComponent(tab.url);
        chrome.tabs.update(tab.id, { url: nivraUrl });
        window.close();
      }
    }
  } catch (err) {
    console.error('[Nivra Popup] Failed to send toggle message to SW:', err);
  }
});

function _setToggleUI(enabled) {
  toggle.checked = !!enabled;

  if (enabled) {
    statusCard.classList.add('active');
    statusDot.classList.add('on');
    statusLabel.textContent = 'Active';
    statusDetail.textContent = 'Intercepting PDF files';
  } else {
    statusCard.classList.remove('active');
    statusDot.classList.remove('on');
    statusLabel.textContent = 'Disabled';
    statusDetail.textContent = `PDFs use ${BROWSER}'s default viewer`;
  }
}

// ─── Open in Nivra ────────────────────────────────────────────────────────────
async function _checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const url = tab.url;
    const isAlreadyNivra = !!_extractNivraPdfUrl(url);
    const isRawPdf = _isRawPdfUrl(url);

    if (isRawPdf) {
      btnOpenNivra.disabled = false;
      openDetail.textContent = 'Render this PDF with Nivra';

      btnOpenNivra.addEventListener('click', () => {
        const nivraUrl = chrome.runtime.getURL(VIEWER_PATH) + '?file=' + encodeURIComponent(url);
        chrome.tabs.update(tab.id, { url: nivraUrl });
        window.close();
      });
    } else if (isAlreadyNivra) {
      openDetail.textContent = 'Already open in Nivra';
    }
  } catch (err) {
    console.warn('[Nivra Popup] Could not check active tab:', err);
  }
}

// ─── Open a PDF from disk (choose or drag-and-drop) ──────────────────────────
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const dropText  = document.getElementById('drop-zone-text');

async function _openLocalFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    dropText.textContent = 'That is not a PDF file';
    return;
  }
  dropText.textContent = 'Opening…';
  try {
    const key = await putFile(file);
    await chrome.tabs.create({ url: chrome.runtime.getURL(VIEWER_PATH) + '?idb=' + key });
    window.close();
  } catch (err) {
    console.error('[Nivra Popup] Could not open file:', err);
    dropText.textContent = 'Could not open that file';
  }
}

fileInput.addEventListener('change', () => _openLocalFile(fileInput.files[0]));
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, e => {
  e.preventDefault();
  dropZone.classList.add('is-over');
}));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, e => {
  e.preventDefault();
  dropZone.classList.remove('is-over');
}));
dropZone.addEventListener('drop', e => _openLocalFile(e.dataTransfer?.files?.[0]));
// A drop that misses the zone must not navigate the popup to the file.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// ─── File URL Access ──────────────────────────────────────────────────────────
function _openExtensionSettings() {
  chrome.tabs.create({
    url: `${IS_EDGE ? 'edge' : IS_OPERA ? 'opera' : 'chrome'}://extensions/?id=${EXTENSION_ID}`
  });
  window.close();
}
btnFileAccess.addEventListener('click', _openExtensionSettings);
document.getElementById('btn-banner-access').addEventListener('click', _openExtensionSettings);

// Local PDFs only work with "Allow access to file URLs"; say so instead of failing silently.
(async function _checkFileAccess() {
  try {
    const { allowed } = await chrome.runtime.sendMessage({ type: 'GET_FILE_ACCESS' });
    document.getElementById('access-banner').hidden = !!allowed;
    if (allowed) document.getElementById('file-access-detail').textContent = 'Local PDF support is on';
  } catch (_) { /* worker unavailable: leave the banner hidden */ }
})();

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────
btnShortcuts.addEventListener('click', () => {
  const existingTip = document.getElementById('shortcuts-tip');
  if (existingTip) {
    existingTip.remove();
    return;
  }

  const tip = document.createElement('div');
  tip.id = 'shortcuts-tip';
  tip.className = 'shortcuts-tip';
  tip.innerHTML = `
    <div class="shortcuts-tip-title">Viewer Shortcuts</div>
    <div><kbd>Ctrl+F</kbd> Search in document</div>
    <div><kbd>Ctrl+B</kbd> Toggle sidebar</div>
    <div><kbd>Ctrl+P</kbd> Print</div>
    <div><kbd>R</kbd> Rotate clockwise</div>
    <div><kbd>Ctrl+0</kbd> Reset zoom</div>
    <div><kbd>Ctrl++/−</kbd> Zoom in / out</div>
    <div><kbd>↑ / ↓</kbd> Previous / next page</div>
    <div><kbd>Esc</kbd> Close panels</div>
  `;

  const footer = document.querySelector('.popup-footer');
  footer.parentNode.insertBefore(tip, footer);
});
