/**
 * Nivra Background Service Worker
 * 
 * INTERACTION WITH CHROME'S BUILT-IN PDF VIEWER:
 * When a user navigates to a PDF file, Chrome normally intercepts it using its internal PDF viewer.
 * By using declarativeNetRequest to redirect the main_frame (or sub_frame) navigation, our extension
 * intercepts the request BEFORE the built-in PDF viewer can load. We redirect the navigation to our
 * own viewer page (viewer/viewer.html), passing the original PDF URL as a query parameter.
 * 
 * ALLOW ACCESS TO FILE URLS:
 * For Nivra to intercept and render local PDFs (e.g., file:///C:/path/to/doc.pdf), the user MUST
 * explicitly enable "Allow access to file URLs" in the extension's settings page (chrome://extensions).
 * Without this permission, Chrome security policies prevent the extension from redirecting or reading
 * file:// URLs, meaning local PDFs will continue to open in Chrome's default viewer.
 *
 * ENABLE / DISABLE TOGGLE:
 * The popup sends a { type: 'SET_ENABLED', enabled: bool } message via chrome.runtime.sendMessage.
 * The service worker applies the rule immediately and persists state to chrome.storage.local.
 * On browser startup / extension install, the stored state is read and re-applied.
 */

const RULE_ID = 1;
const STORAGE_KEY = 'nivraEnabled';

// ─── Rule builder ─────────────────────────────────────────────────────────────
function _buildRedirectRule() {
  // getURL gives the right scheme for the browser (chrome-extension:// or extension://).
  const viewerUrl = chrome.runtime.getURL('viewer/viewer.html');
  return {
    id: RULE_ID,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${viewerUrl}?file=\\0`
      }
    },
    condition: {
      // A URL whose PATH ends in .pdf, optionally followed by a query string and/or
      // a fragment. [^?#]* keeps ".pdf" out of the query: without it, a web page
      // that merely wraps a PDF — viewer.html?file=report.pdf, docs viewers — also
      // matched and was hijacked, and Nivra then tried to read that HTML as a PDF.
      // http(s) and file only — Chrome no longer supports ftp.
      regexFilter: "^(https?|file):\\/\\/[^?#]*\\.pdf(?:\\?[^#]*)?(?:#.*)?$",
      // Rule matching is case-SENSITIVE unless told otherwise, so without this
      // report.PDF / Report.Pdf were never redirected.
      isUrlFilterCaseSensitive: false,
      resourceTypes: ["main_frame", "sub_frame"]
    }
  };
}

// ─── Apply or remove the redirect rule ────────────────────────────────────────
async function _applyRule(enabled) {
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: [_buildRedirectRule()]
      });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: []
      });
    }
    console.log('[Nivra SW] Redirect rule', enabled ? 'ENABLED' : 'DISABLED');
    return true;
  } catch (err) {
    console.error('[Nivra SW] Failed to update redirect rule:', err);
    return false;
  }
}

// ─── Read storage and apply ───────────────────────────────────────────────────
async function _syncRuleWithStorage() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const enabled = result[STORAGE_KEY] !== undefined ? result[STORAGE_KEY] : true;
  await _applyRule(enabled);
}

// ─── Event: Extension installed or updated ────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // Set default to enabled on first install
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY] === undefined || result[STORAGE_KEY] === null) {
    await chrome.storage.local.set({ [STORAGE_KEY]: true });
  }
  await _syncRuleWithStorage();
});

// ─── Event: Browser startup ──────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  await _syncRuleWithStorage();
});

// ─── Event: Direct message from popup (most reliable MV3 pattern) ─────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SET_ENABLED') {
    const enabled = !!message.enabled;

    // Persist to storage AND apply the rule, then respond
    Promise.all([
      chrome.storage.local.set({ [STORAGE_KEY]: enabled }),
      _applyRule(enabled)
    ])
    .then(() => sendResponse({ success: true, enabled }))
    .catch(err => {
      console.error('[Nivra SW] SET_ENABLED failed:', err);
      sendResponse({ success: false, error: String(err) });
    });

    // Return true to indicate we will call sendResponse asynchronously
    return true;
  }

  if (message?.type === 'GET_ENABLED') {
    chrome.storage.local.get(STORAGE_KEY)
      .then(result => {
        const enabled = result[STORAGE_KEY] !== undefined ? result[STORAGE_KEY] : true;
        sendResponse({ enabled });
      })
      .catch(() => sendResponse({ enabled: true }));

    return true;
  }
});
