/**
 * Nivra Visual Transformation Engine — Orchestrator
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages mode state, UI bindings, and delegates to mode-specific engines.
 *
 * ─── Modes ───────────────────────────────────────────────────────────────────
 *   smart-dark    → smart-dark/index.js — per-page, document-aware filter on
 *                   .canvasWrapper + photographic-image preservation overlay
 *   true-invert   → CSS filter on #viewer: invert(100%)
 *   grayscale     → CSS filter on #viewer: grayscale(100%)
 *   high-contrast → CSS filter on #viewer: contrast/brightness/saturate
 *   original      → no filter
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

// ─── State ────────────────────────────────────────────────────────────────────
let _mode       = 'smart-dark';
let _brightness = 100;
let _contrast   = 100;

// ─── Public API ───────────────────────────────────────────────────────────────

export function getCurrentMode() { return _mode; }

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
  if (_mode === 'smart-dark') {
    SmartDark.onPageRendered(pageNumber, viewport, pageEl, canvas);
  }
  // Other modes: CSS filter only — no per-page action needed
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _bindUIControls() {
  const modeBtns = document.querySelectorAll('.mode-card');
  const bSlider  = document.getElementById('brightness-slider');
  const cSlider  = document.getElementById('contrast-slider');
  const bVal     = document.getElementById('brightness-val');
  const cVal     = document.getElementById('contrast-val');
  const btnReset = document.getElementById('btn-reset-appearance');

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => _applyMode(btn.dataset.mode, modeBtns));
  });

  bSlider?.addEventListener('input', e => {
    _brightness = +e.target.value;
    if (bVal) bVal.textContent = _brightness + '%';
    _applyAdjustments();
  });

  cSlider?.addEventListener('input', e => {
    _contrast = +e.target.value;
    if (cVal) cVal.textContent = _contrast + '%';
    _applyAdjustments();
  });

  btnReset?.addEventListener('click', () => {
    _brightness = 100; _contrast = 100;
    if (bSlider) bSlider.value = 100;
    if (cSlider) cSlider.value = 100;
    if (bVal) bVal.textContent = '100%';
    if (cVal) cVal.textContent = '100%';
    _applyMode('smart-dark', modeBtns);
  });
}

function _applyMode(mode, cards) {
  const wrapper = document.getElementById('viewerWrapper');
  const viewer = document.getElementById('viewer');
  if (!wrapper || !viewer) return;

  const prev = _mode;
  _mode = mode;

  // 1. Clear all mode classes + any leftover PDF-layer filter
  MODE_CLASSES.forEach(c => wrapper.classList.remove(c));
  wrapper.style.filter = '';
  viewer.style.filter = '';

  // 2. Deactivate previous mode
  if (prev === 'smart-dark') {
    SmartDark.deactivate(wrapper);   // removes per-page filters + overlays
  }

  // 3. Apply new mode
  if (mode === 'smart-dark') {
    wrapper.classList.add('mode-smart-dark');   // page background CSS hook
    SmartDark.activate(wrapper, _brightness, _contrast);
  } else if (mode === 'original') {
    // Nothing to apply — already cleared above
  } else {
    // CSS filter modes on the PDF layer only, so the surrounding viewer shell
    // stays visually stationary regardless of the selected appearance mode.
    const parts = [
      CSS_FILTER[mode]  || '',
      _brightness !== 100 ? `brightness(${_brightness / 100})` : '',
      _contrast   !== 100 ? `contrast(${_contrast   / 100})` : '',
    ].filter(Boolean);
    viewer.style.filter = parts.join(' ');
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

function _applyAdjustments() {
  const wrapper = document.getElementById('viewerWrapper');
  const viewer = document.getElementById('viewer');
  if (!wrapper || !viewer) return;

  if (_mode === 'smart-dark') {
    SmartDark.updateAdjustments(wrapper, _brightness, _contrast);
  } else if (_mode !== 'original') {
    const parts = [
      CSS_FILTER[_mode] || '',
      _brightness !== 100 ? `brightness(${_brightness / 100})` : '',
      _contrast   !== 100 ? `contrast(${_contrast   / 100})` : '',
    ].filter(Boolean);
    viewer.style.filter = parts.join(' ');
  }
}
