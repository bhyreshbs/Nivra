/**
 * Nivra Visual Transformation Engine — Orchestrator
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages mode state, UI bindings, and delegates to mode-specific engines.
 *
 * ─── Modes ───────────────────────────────────────────────────────────────────
 *   smart-dark    → smart-dark/index.js — per-page, document-aware filter on
 *                   .canvasWrapper + photographic-image preservation overlay
 *   true-invert   → page filter: invert(100%)
 *   grayscale     → page filter: grayscale(100%)
 *   high-contrast → page filter: contrast/brightness/saturate
 *   original      → no filter of its own (brightness/contrast still apply)
 *
 * ─── How filters reach the page ──────────────────────────────────────────────
 * Every mode publishes ONE CSS custom property, --nivra-filter, on
 * #viewerWrapper. viewer/input.css applies it to each page's canvas layer:
 *
 *     .pdfViewer .page .canvasWrapper { filter: var(--nivra-filter, none) }
 *
 * So there is no per-page JS (pages PDF.js creates later are filtered from
 * their first frame), a brightness/contrast change is a single property write,
 * and no filter is ever placed on #viewer — that would force one compositing
 * surface as tall as the whole document and would also invert the text layer,
 * selection highlights and annotation widgets.
 *
 * ─── What this file does NOT do ──────────────────────────────────────────────
 *   ✗  getImageData / putImageData
 *   ✗  canvas pixel loops
 *   ✗  canvas-to-canvas rasterization
 *   ✗  any operation that degrades PDF rendering quality
 *
 * Smart Dark never touches #viewerWrapper: its per-page filters only affect
 * the page's canvas layer, so the text layer, annotation layer, form controls
 * and the Nivra UI are never transformed.
 */

import * as SmartDark from './smart-dark/index.js';

// ─── Mode definitions ─────────────────────────────────────────────────────────
const CSS_FILTER = {
  'true-invert':  'invert(100%)',
  'grayscale':    'grayscale(100%)',
  'high-contrast':'contrast(180%) brightness(0.9) saturate(1.2)',
};

const MODE_CLASSES = ['mode-smart-dark'];

/** Custom property read by `.canvasWrapper { filter: var(--nivra-filter) }` (input.css). */
const FILTER_VAR = '--nivra-filter';

// ─── State ────────────────────────────────────────────────────────────────────
let _mode       = 'smart-dark';
let _brightness = 100;
let _contrast   = 100;

// ─── Public API ───────────────────────────────────────────────────────────────

export function getCurrentMode() { return _mode; }
export function getAdjustments() { return { brightness: _brightness, contrast: _contrast }; }
/** CSS filter for the pure-filter modes ('' for smart-dark / original). */
export function getModeFilter(mode) { return CSS_FILTER[mode] || ''; }

/** Paint the filled part of a range track (consumed by glass.css via --p). */
function _paintSlider(el) {
  if (!el) return;
  const span = (+el.max) - (+el.min) || 1;
  el.style.setProperty('--p', (((+el.value) - (+el.min)) / span * 100) + '%');
}

/**
 * Initialize the visual engine.
 * Binds UI controls and applies the default mode (Smart Dark).
 * Must be called after DOMContentLoaded.
 */
export function setupVisualEngine() {
  _bindUIControls();
  _applyMode('smart-dark');
}

/**
 * Notify the engine that a PDF document has been loaded.
 * Must be called before any page rendering occurs.
 *
 * @param {PDFDocumentProxy} pdfDoc
 */
export function setDocument(pdfDoc) {
  SmartDark.setDocument(pdfDoc);
}

/**
 * Called by viewer.js on every PDF.js `pagerendered` event.
 * Delegates to the active mode engine.
 *
 * @param {number}       pageNumber
 * @param {PageViewport} viewport   — from evt.source.viewport
 * @param {Element}      pageEl     — .page div
 * @param {Element}      canvas     — the live PDF.js canvas (evt.source.canvas)
 */
export function onPageRendered(pageNumber, viewport, pageEl, canvas) {
  // Always forwarded, whatever the mode: Smart Dark does its per-page work only
  // while active, but it must keep its record of each page's current viewport
  // and canvas up to date even while another mode is selected — otherwise
  // switching back to Smart Dark would pair a stale viewport with a new canvas.
  // The other modes are CSS-filter only and need no per-page action.
  SmartDark.onPageRendered(pageNumber, viewport, pageEl, canvas);
}

/**
 * Called by viewer.js when PDF.js finishes a page's text layer. Forwarded in
 * every mode (like onPageRendered) so Smart Dark's record stays current.
 *
 * @param {number}  pageNumber
 * @param {Element} pageEl — .page div
 */
export function onTextLayerRendered(pageNumber, pageEl) {
  SmartDark.onTextLayerRendered(pageNumber, pageEl);
}

/**
 * Called by viewer.js when PDF.js finishes (re)painting a page's full-resolution
 * detail canvas — shown over the visible part of a zoomed-in page.
 *
 * @param {number}  pageNumber
 * @param {Element} pageEl        — .page div
 * @param {Element} detailCanvas  — the live detail canvas
 */
export function onDetailRendered(pageNumber, pageEl, detailCanvas) {
  if (_mode === 'smart-dark') {
    SmartDark.onDetailRendered(pageNumber, pageEl, detailCanvas);
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _bindUIControls() {
  const modeBtns = document.querySelectorAll('.mode-card');
  const bSlider  = document.getElementById('brightness-slider');
  const cSlider  = document.getElementById('contrast-slider');
  const bVal     = document.getElementById('brightness-val');
  const cVal     = document.getElementById('contrast-val');
  const btnReset = document.getElementById('btn-reset-appearance');

  _paintSlider(bSlider);
  _paintSlider(cSlider);

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => _applyMode(btn.dataset.mode, modeBtns));
  });

  bSlider?.addEventListener('input', e => {
    _brightness = +e.target.value;
    if (bVal) bVal.textContent = _brightness + '%';
    _paintSlider(e.target);
    _applyAdjustments();
  });

  cSlider?.addEventListener('input', e => {
    _contrast = +e.target.value;
    if (cVal) cVal.textContent = _contrast + '%';
    _paintSlider(e.target);
    _applyAdjustments();
  });

  btnReset?.addEventListener('click', () => {
    _brightness = 100; _contrast = 100;
    if (bSlider) bSlider.value = 100;
    if (cSlider) cSlider.value = 100;
    if (bVal) bVal.textContent = '100%';
    if (cVal) cVal.textContent = '100%';
    _paintSlider(bSlider);
    _paintSlider(cSlider);
    _applyMode('smart-dark', modeBtns);
  });
}

function _applyMode(mode, cards) {
  const wrapper = document.getElementById('viewerWrapper');
  if (!wrapper) return;

  const prev = _mode;
  _mode = mode;

  // 1. Clear all mode classes + the shared page-filter variable
  MODE_CLASSES.forEach(c => wrapper.classList.remove(c));
  wrapper.style.removeProperty(FILTER_VAR);

  // 2. Deactivate previous mode
  if (prev === 'smart-dark') {
    SmartDark.deactivate(wrapper);   // removes per-page filters + overlays
  }

  // 3. Apply new mode
  if (mode === 'smart-dark') {
    wrapper.classList.add('mode-smart-dark');   // page background CSS hook
    SmartDark.activate(wrapper, _brightness, _contrast);
  } else {
    // Every other mode — Original included — is the mode's own filter (none, for
    // Original) plus the brightness/contrast sliders. Applied to each page's canvas
    // layer by CSS, so the text layer, annotations and the Nivra UI are never transformed.
    _publishPageFilter(wrapper, mode);
  }

  // 4. Update card UI
  if (cards) {
    cards.forEach(c => c.classList.toggle('active', c.dataset.mode === mode));
  } else {
    document.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('active', c.dataset.mode === mode);
    });
  }
}

let _adjFrame = 0;
function _applyAdjustments() {
  if (_adjFrame) return;
  _adjFrame = requestAnimationFrame(() => { _adjFrame = 0; _flushAdjustments(); });
}

function _flushAdjustments() {
  const wrapper = document.getElementById('viewerWrapper');
  if (!wrapper) return;

  if (_mode === 'smart-dark') {
    SmartDark.updateAdjustments(wrapper, _brightness, _contrast);
  } else {
    _publishPageFilter(wrapper, _mode);
  }
}

/** Publish the mode's filter + sliders as --nivra-filter; nothing to apply removes it. */
function _publishPageFilter(wrapper, mode) {
  const value = _composeFilter(mode);
  if (value) wrapper.style.setProperty(FILTER_VAR, value);
  else wrapper.style.removeProperty(FILTER_VAR);
}

/** Mode filter followed by the user's brightness / contrast. */
function _composeFilter(mode) {
  return [
    CSS_FILTER[mode] || '',
    _brightness !== 100 ? `brightness(${_brightness / 100})` : '',
    _contrast   !== 100 ? `contrast(${_contrast   / 100})` : '',
  ].filter(Boolean).join(' ');
}
