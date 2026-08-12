/**
 * Smart Dark Developer Debug Overlay
 * ─────────────────────────────────────────────────────────────────────────────
 * DEV-ONLY visualization of Smart Dark's per-page analysis. Enabled via:
 *   - URL param:        ?nivraDebug=1
 *   - localStorage:     localStorage.setItem('nivra.debug', '1')
 *
 * When enabled, a small floating panel lets you toggle:
 *   [x] Background   — blue translucent wash over the detected page background
 *   [x] Images       — red outline = preserved (photographic),
 *                      orange outline = detected but inverted (document-like)
 *   [x] Text regions — green outlines around textLayer spans
 *   [x] Info badge   — page classification + stats in the page corner
 *
 * The overlay divs have pointer-events:none and sit above the annotation
 * layer. None of this is created unless the debug flag is on, so production
 * rendering is completely unaffected.
 */

const DEBUG_CLASS = 'nivra-debug-overlay';
const PANEL_ID    = 'nivra-debug-panel';

let _enabled = null;
const _toggles = { background: true, images: true, text: true, info: true };

/** Whether debug mode is enabled (resolved once). */
export function isDebugEnabled() {
  if (_enabled !== null) return _enabled;
  try {
    const url = new URLSearchParams(window.location.search);
    _enabled = url.get('nivraDebug') === '1' ||
               window.localStorage.getItem('nivra.debug') === '1';
  } catch (_) {
    _enabled = false;
  }
  if (_enabled) _createPanel();
  return _enabled;
}

/**
 * Render the debug overlay for one page (replaces any previous one).
 *
 * @param {Element}      pageEl
 * @param {PageViewport} viewport
 * @param {Object}       info
 * @param {string}       info.pageClass       — 'normal' | 'dark-bg' | 'scanned'
 * @param {Array}        info.protectedRects  — CSS-px rects, preserved images
 * @param {Array}        info.invertedRects   — CSS-px rects, document-like images
 * @param {number}       info.textOps
 * @param {number}       info.vectorOps
 * @param {number}       info.imageCoverage
 * @param {RegionStats|null} info.pageStats
 */
export function renderDebugOverlay(pageEl, viewport, info) {
  if (!isDebugEnabled()) return;
  removeDebugOverlay(pageEl);

  const box = document.createElement('div');
  box.className = DEBUG_CLASS;
  box.style.cssText = [
    'position:absolute', 'inset:0', 'pointer-events:none',
    'z-index:1000', 'overflow:hidden',
  ].join(';');

  if (_toggles.background) {
    const bg = document.createElement('div');
    bg.style.cssText = 'position:absolute;inset:0;background:rgba(60,130,255,0.10);';
    box.appendChild(bg);
  }

  const mkRect = (r, color, label) => {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      `left:${r.x}px`, `top:${r.y}px`,
      `width:${r.width}px`, `height:${r.height}px`,
      `outline:2px solid ${color}`,
      'outline-offset:-1px',
    ].join(';');
    if (label) {
      const tag = document.createElement('span');
      tag.textContent = label;
      tag.style.cssText = `position:absolute;top:0;left:0;background:${color};` +
        'color:#fff;font:9px monospace;padding:0 3px;';
      el.appendChild(tag);
    }
    return el;
  };

  if (_toggles.images) {
    for (const r of info.protectedRects || []) {
      box.appendChild(mkRect(r, 'rgba(255,60,60,0.9)', 'IMG·preserve'));
    }
    for (const r of info.invertedRects || []) {
      box.appendChild(mkRect(r, 'rgba(255,150,0,0.9)', 'IMG·invert'));
    }
  }

  if (_toggles.text) {
    pageEl.querySelectorAll('.textLayer span').forEach(span => {
      const b = span.getBoundingClientRect();
      const pb = pageEl.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return;
      box.appendChild(mkRect(
        { x: b.left - pb.left, y: b.top - pb.top, width: b.width, height: b.height },
        'rgba(60,220,120,0.35)', null,
      ));
    });
  }

  if (_toggles.info) {
    const s = info.pageStats;
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.85);' +
      'color:#7fffb0;font:10px monospace;padding:4px 6px;border-radius:4px;white-space:pre;';
    badge.textContent =
      `class: ${info.pageClass}\n` +
      `text ops: ${info.textOps}  vector ops: ${info.vectorOps}\n` +
      `img coverage: ${(info.imageCoverage * 100).toFixed(0)}%` +
      (s ? `\nlum: ${s.luminance.toFixed(2)}  white: ${(s.whiteFrac*100).toFixed(0)}%  sat: ${s.saturation.toFixed(2)}` : '');
    box.appendChild(badge);
  }

  pageEl.appendChild(box);
}

export function removeDebugOverlay(pageEl) {
  pageEl?.querySelector(`:scope > .${DEBUG_CLASS}`)?.remove();
}

export function removeAllDebugOverlays() {
  document.querySelectorAll(`.${DEBUG_CLASS}`).forEach(el => el.remove());
  document.getElementById(PANEL_ID)?.remove();
}

// ─── Panel ───────────────────────────────────────────────────────────────────

function _createPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText = 'position:fixed;bottom:90px;right:12px;z-index:100000;' +
    'background:#111;color:#eee;font:11px monospace;padding:8px 10px;' +
    'border:1px solid #444;border-radius:8px;display:flex;flex-direction:column;gap:4px;';
  panel.innerHTML = '<strong style="color:#7fffb0">Smart Dark Debug</strong>';
  for (const key of Object.keys(_toggles)) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = _toggles[key];
    cb.addEventListener('change', () => {
      _toggles[key] = cb.checked;
      document.querySelectorAll(`.${DEBUG_CLASS}`).forEach(el => el.remove());
      // Ask the engine to re-render overlays for visible pages.
      window.dispatchEvent(new CustomEvent('nivra:debug-refresh'));
    });
    label.append(cb, document.createTextNode(key));
    panel.appendChild(label);
  }
  document.body.appendChild(panel);
}
