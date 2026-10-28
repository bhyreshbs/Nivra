/**
 * Nivra browser detection
 * ─────────────────────────────────────────────────────────────────────────────
 * One place to tell Chrome, Edge, Opera and Firefox apart. Works in the service
 * worker, the popup and extension pages (anything with a `navigator`).
 *
 * Every helper takes an optional user-agent string and UA-CH brand list so it can
 * be unit-tested; by default it reads the current navigator.
 *
 * Order matters: Edge and Opera are Chromium and their UAs also contain "Chrome/",
 * so they are checked before falling back to Chrome.
 */

// Same pattern as the Edge detection in background/sw.js; keep the two in sync.
const EDGE_UA_RE    = /\bEdg(e|A|iOS)?\//;
const OPERA_UA_RE   = /\bOPR\//;
const FIREFOX_UA_RE = /\bFirefox\//;

function _currentUA() {
  return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
}

function _currentBrands() {
  return typeof navigator !== 'undefined' ? navigator.userAgentData?.brands || [] : [];
}

function _hasBrand(brands, name) {
  return Array.isArray(brands) && brands.some(b => b.brand === name);
}

export function isFirefox(ua = _currentUA()) {
  return FIREFOX_UA_RE.test(ua);
}

export function isEdge(ua = _currentUA(), brands = _currentBrands()) {
  return EDGE_UA_RE.test(ua) || _hasBrand(brands, 'Microsoft Edge');
}

export function isOpera(ua = _currentUA(), brands = _currentBrands()) {
  return !isEdge(ua, brands) && (OPERA_UA_RE.test(ua) || _hasBrand(brands, 'Opera'));
}

/** 'firefox' | 'edge' | 'opera' | 'chrome' (Chrome is the fallback for any other Chromium browser). */
export function browserId(ua = _currentUA(), brands = _currentBrands()) {
  if (isFirefox(ua)) return 'firefox';
  if (isEdge(ua, brands)) return 'edge';
  if (isOpera(ua, brands)) return 'opera';
  return 'chrome';
}

const NAMES = { firefox: 'Firefox', edge: 'Edge', opera: 'Opera', chrome: 'Chrome' };

/** Display name: 'Firefox' | 'Edge' | 'Opera' | 'Chrome'. */
export function browserName(ua = _currentUA(), brands = _currentBrands()) {
  return NAMES[browserId(ua, brands)];
}

/**
 * URL of the browser's extensions page. With an extension id, Chromium browsers
 * open that extension's detail page; Firefox has no per-extension URL, so it
 * always returns about:addons.
 */
export function extensionsPageUrl(extensionId, ua = _currentUA(), brands = _currentBrands()) {
  const id = browserId(ua, brands);
  if (id === 'firefox') return 'about:addons';
  const base = `${id}://extensions/`;
  return extensionId ? `${base}?id=${extensionId}` : base;
}
