/**
 * Nivra preferences — persisted in chrome.storage.local (never leaves the device).
 * Falls back to defaults when storage is unavailable (e.g. the viewer opened outside the extension).
 */

const STORAGE_KEY = 'nivraPrefs';

export const DEFAULT_PREFS = Object.freeze({
  mode:       'smart-dark',
  brightness: 100,
  contrast:   100,
  sidebar:    true,
  twoPage:    false,
  scale:      'page-fit',
  toolbarCollapsed: false,
});

const MODES = new Set(['smart-dark', 'original', 'true-invert', 'grayscale', 'high-contrast']);
const clamp = (v, lo, hi, fallback) =>
  Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : fallback;

/** Coerce anything read from storage into a valid prefs object. */
function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_PREFS;
  return {
    mode:       MODES.has(r.mode) ? r.mode : d.mode,
    brightness: clamp(r.brightness, 50, 150, d.brightness),
    contrast:   clamp(r.contrast,   50, 150, d.contrast),
    sidebar:    typeof r.sidebar === 'boolean' ? r.sidebar : d.sidebar,
    twoPage:    typeof r.twoPage === 'boolean' ? r.twoPage : d.twoPage,
    toolbarCollapsed: typeof r.toolbarCollapsed === 'boolean' ? r.toolbarCollapsed : d.toolbarCollapsed,
    scale:      typeof r.scale === 'string' && /^(auto|page-width|page-fit|page-actual|\d+(\.\d+)?)$/.test(r.scale)
                  ? r.scale : d.scale,
  };
}

let _prefs = { ...DEFAULT_PREFS };
let _timer = 0;

export async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    _prefs = sanitize(stored[STORAGE_KEY]);
  } catch (_) {
    _prefs = { ...DEFAULT_PREFS };
  }
  return { ..._prefs };
}

export function getPrefs() { return { ..._prefs }; }

/** Merge a partial update and write it to storage (debounced). */
export function savePrefs(partial) {
  _prefs = sanitize({ ..._prefs, ...partial });
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    try { chrome.storage.local.set({ [STORAGE_KEY]: _prefs }); } catch (_) { /* no storage */ }
  }, 250);
}

// ─── Per-site appearance ──────────────────────────────────────────────────────
// A website (hostname) can pin its own mode + brightness + contrast.
const SITES_KEY = 'nivraSites';
const MAX_SITES = 200;

function _cleanAppearance(a) {
  const s = sanitize(a);
  return { mode: s.mode, brightness: s.brightness, contrast: s.contrast };
}

export async function getSiteAppearance(host) {
  if (!host) return null;
  try {
    const stored = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY];
    const entry = stored && Object.prototype.hasOwnProperty.call(stored, host) ? stored[host] : null;
    return entry ? _cleanAppearance(entry) : null;
  } catch (_) { return null; }
}

/** Pin `appearance` for `host`, or forget the host when `appearance` is null. */
export async function setSiteAppearance(host, appearance) {
  if (!host) return;
  try {
    const sites = { ...((await chrome.storage.local.get(SITES_KEY))[SITES_KEY] || {}) };
    delete sites[host];
    if (appearance) sites[host] = _cleanAppearance(appearance);   // re-inserted last = newest
    const keys = Object.keys(sites);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SITES))) delete sites[k];
    await chrome.storage.local.set({ [SITES_KEY]: sites });
  } catch (_) { /* no storage */ }
}

/** Named visual presets: a display mode plus brightness / contrast. */
export const PROFILES = Object.freeze({
  reading:  { label: 'Reading',  mode: 'smart-dark', brightness: 95,  contrast: 100 },
  night:    { label: 'Night',    mode: 'smart-dark', brightness: 75,  contrast: 95  },
  study:    { label: 'Study',    mode: 'smart-dark', brightness: 100, contrast: 110 },
  focus:    { label: 'Focus',    mode: 'grayscale',  brightness: 90,  contrast: 105 },
  original: { label: 'Original', mode: 'original',   brightness: 100, contrast: 100 },
});
