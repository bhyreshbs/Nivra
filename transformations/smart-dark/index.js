/**
 * Nivra Smart Dark Engine — Main Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * Document-aware dark rendering built on top of PDF.js's native, full-
 * resolution renderer.
 *
 * ─── Pipeline ────────────────────────────────────────────────────────────────
 *
 *  PDF
 *   ↓
 *  PDF.js high-resolution page render (untouched — full DPR, crisp vectors)
 *   ↓
 *  Per-page CSS filter on .canvasWrapper: invert(100%) hue-rotate(180deg)
 *    • text / vector / table lines stay GPU-crisp, never re-rasterized
 *    • text layer + annotation layer + Nivra UI are NEVER filtered
 *   ↓
 *  Async per-page analysis (cached, never blocks first paint):
 *    • operator analysis → images, text/vector counts, large fills
 *    • 64×64 pixel probe → background luminance, per-image composition
 *   ↓
 *  Page classification:
 *    normal   → invert + preserve photographic images
 *    dark-bg  → already dark: no transformation
 *    scanned  → full-page scan: invert as a unit, no overlays
 *   ↓
 *  Image classification per detected image:
 *    photographic   → preserved via counter-filtered overlay canvas
 *    document-like  → (letterhead scans, watermarks) invert with the page
 *   ↓
 *  Final: dark page, light crisp text, real photos preserved, no white boxes
 *
 * ─── What is NOT done ────────────────────────────────────────────────────────
 *   ✗  global filter on #viewerWrapper (would hit text/annotation/UI layers)
 *   ✗  getImageData on the full canvas (only a 64×64 probe)
 *   ✗  canvas-to-canvas re-rasterization of the page
 *   ✗  synchronous analysis before first paint
 */

import { getPageAnalysis, imageOpsToRects, clearOpListCache } from './operator-analyzer.js';
import {
  probePage, probeRegion, regionStats, classifyPage, classifyImage, clearProbeCache,
} from './page-analyzer.js';
import { updateImageOverlay, removeImageOverlay, removeAllImageOverlays } from './image-protector.js';
import { buildSmartDarkFilter, buildCounterFilter } from './fallback.js';
import * as DebugOverlay from './debug-overlay.js';

// ─── State ────────────────────────────────────────────────────────────────────
let _pdfDoc     = null;
let _isActive   = false;
let _brightness = 100;
let _contrast   = 100;
let _preserveImages = _loadPreserveSetting();

// pageNumber → viewport of the last completed render (for re-activation and
// adjustment updates, where no pagerendered event fires).
const _pageViewports = new Map();

// pageNumber → cached PageDecision (analysis result, geometry-independent).
const _decisionCache = new Map();

// In-flight analysis dedup (pageNumber → true).
const _inFlight = new Set();

/**
 * @typedef {Object} PageDecision
 * @property {'normal'|'dark-bg'|'scanned'} pageClass
 * @property {Array<{ctm:number[]}>} photographicOps — subset of imageOps to preserve
 * @property {Array<{ctm:number[]}>} invertedOps     — detected but inverted
 * @property {number} textOps
 * @property {number} vectorOps
 * @property {number} imageCoverage
 * @property {Object|null} pageStats
 */

// ─── Public API ───────────────────────────────────────────────────────────────

export function setDocument(pdfDoc) {
  _pdfDoc = pdfDoc;
  clearOpListCache();
  clearProbeCache();
  removeAllImageOverlays();
  DebugOverlay.removeAllDebugOverlays();
  _pageViewports.clear();
  _decisionCache.clear();
  _inFlight.clear();
}

/**
 * Activate Smart Dark: filter all rendered pages now; analyze asynchronously.
 */
export function activate(_wrapper, brightness, contrast) {
  _isActive = true;
  _brightness = brightness;
  _contrast   = contrast;

  document.querySelectorAll('.pdfViewer .page').forEach(pageEl => {
    const pn = _pageNumber(pageEl);
    if (!pn) return;
    const canvas = _getCanvas(pageEl);
    // Apply the filter immediately — analysis only refines it.
    _applyPageFilter(pageEl, _decisionCache.get(pn)?.pageClass ?? 'normal');
    if (canvas?.width) _processPageAsync(pn, null, pageEl, canvas);
  });
}

/**
 * Deactivate Smart Dark: remove every per-page filter and overlay.
 */
export function deactivate(_wrapper) {
  _isActive = false;
  document.querySelectorAll('.pdfViewer .page').forEach(pageEl => {
    _clearPageFilter(pageEl);
    removeImageOverlay(pageEl);
  });
  DebugOverlay.removeAllDebugOverlays();
}

/**
 * Called by visual-engine on each PDF.js `pagerendered` event.
 */
export function onPageRendered(pageNumber, viewport, pageEl, canvas) {
  if (!_isActive) return;

  if (viewport) _pageViewports.set(pageNumber, viewport);

  // Immediate filter application (analysis may refine the class later).
  _applyPageFilter(pageEl, _decisionCache.get(pageNumber)?.pageClass ?? 'normal');

  // Stale overlay from a previous render (different scale) is invalid.
  removeImageOverlay(pageEl);
  DebugOverlay.removeDebugOverlay(pageEl);

  _processPageAsync(pageNumber, viewport, pageEl, canvas);
}

/**
 * Re-apply filters after brightness/contrast changes. Analysis is cached —
 * this only rebuilds filter strings and (cheaply) reblits overlays.
 */
export function updateAdjustments(_wrapper, brightness, contrast) {
  if (!_isActive) return;
  _brightness = brightness;
  _contrast   = contrast;

  document.querySelectorAll('.pdfViewer .page').forEach(pageEl => {
    const pn = _pageNumber(pageEl);
    if (!pn) return;
    const decision = _decisionCache.get(pn);
    _applyPageFilter(pageEl, decision?.pageClass ?? 'normal');
    _updateOverlayForPage(pn, pageEl, _getCanvas(pageEl), decision);
  });
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Apply (or skip) the Smart Dark filter on the page's canvas layer.
 * The filter targets .canvasWrapper ONLY: text layer, annotation layer and
 * the Nivra UI are unaffected.
 */
function _applyPageFilter(pageEl, pageClass) {
  const cw = pageEl.querySelector('.canvasWrapper');
  if (!cw) return;
  cw.style.filter = pageClass === 'dark-bg'
    ? ''
    : buildSmartDarkFilter(_brightness, _contrast);
  pageEl.classList.toggle('nivra-smart-dark-skip', pageClass === 'dark-bg');
}

function _clearPageFilter(pageEl) {
  const cw = pageEl.querySelector('.canvasWrapper');
  if (cw) cw.style.filter = '';
  pageEl.classList.remove('nivra-smart-dark-skip');
}

/**
 * Analyze a page (or reuse the cached decision) and apply overlays.
 * Never throws; failures degrade to "filter only, no overlay".
 */
async function _processPageAsync(pageNumber, viewport, pageEl, canvas) {
  if (!_pdfDoc) return;
  const key = String(pageNumber);
  if (_inFlight.has(key)) return;
  _inFlight.add(key);

  try {
    let decision = _decisionCache.get(pageNumber);

    // Resolve the viewport: event → stored → reconstructed from the canvas box.
    let vp = viewport ?? _pageViewports.get(pageNumber) ?? null;

    if (!decision || !vp) {
      const pdfPage = await _pdfDoc.getPage(pageNumber);
      const analysis = await getPageAnalysis(pdfPage);   // cached in analyzer

      if (!vp) vp = _reconstructViewport(pdfPage, pageEl);
      if (!vp) return;
      _pageViewports.set(pageNumber, vp);

      if (!decision) {
        // The canvas may have been swapped mid-render — use the live one.
        const liveCanvas = _getCanvas(pageEl) || canvas;
        if (!liveCanvas?.width || !pageEl.contains(liveCanvas)) return;
        decision = _decide(pdfPage, analysis, vp, liveCanvas);
        _decisionCache.set(pageNumber, decision);
      }
    }

    // Refine the page filter if analysis found an already-dark page.
    _applyPageFilter(pageEl, decision.pageClass);

    const liveCanvas = _getCanvas(pageEl) || canvas;
    _updateOverlayForPage(pageNumber, pageEl, liveCanvas, decision, vp);

    DebugOverlay.renderDebugOverlay(pageEl, vp, {
      pageClass:      decision.pageClass,
      protectedRects: imageOpsToRects(decision.photographicOps, vp),
      invertedRects:  imageOpsToRects(decision.invertedOps, vp),
      textOps:        decision.textOps,
      vectorOps:      decision.vectorOps,
      imageCoverage:  decision.imageCoverage,
      pageStats:      decision.pageStats,
    });
  } catch (err) {
    console.warn(`[Nivra Smart Dark] Page ${pageNumber} analysis failed:`, err?.message || err);
  } finally {
    _inFlight.delete(key);
  }
}

/**
 * Combine operator evidence + pixel evidence into a PageDecision.
 */
function _decide(pdfPage, analysis, viewport, canvas) {
  const { imageOps, textOps, vectorOps, bgFills } = analysis;
  const vpW = viewport.width, vpH = viewport.height;
  const pageArea = vpW * vpH;

  // Per-op rects (null when filtered out as tiny) — aligned with imageOps.
  const rects = imageOps.map(op => imageOpsToRects([op], viewport)[0] ?? null);

  let imageCoverage = 0;
  for (const r of rects) {
    if (r) imageCoverage = Math.max(imageCoverage, (r.width * r.height) / pageArea);
  }

  // Pixel probe of the full page (tiny, cached).
  const pageStats = regionStats(probePage(pdfPage.pageNumber, canvas));

  const pageClass = classifyPage({
    pageStats,
    textOps,
    imageCoverage,
    bgFills,
    pageSize: { w: vpW, h: vpH },
  });

  // Per-image classification — only when preservation is meaningful.
  const photographicOps = [];
  const invertedOps     = [];

  if (pageClass === 'normal' && _preserveImages) {
    const dprX = canvas.width / vpW;
    const dprY = canvas.height / vpH;
    imageOps.forEach((op, idx) => {
      const r = rects[idx];
      if (!r) { invertedOps.push(op); return; }
      // Skip page-covering images: that is a scan/photo background, not an
      // embedded picture — protecting it would defeat the dark mode.
      if ((r.width * r.height) / pageArea >= 0.85) { invertedOps.push(op); return; }
      const stats = regionStats(probeRegion(
        canvas,
        r.x * dprX, r.y * dprY, r.width * dprX, r.height * dprY,
      ));
      (classifyImage(stats) === 'photographic' ? photographicOps : invertedOps).push(op);
    });
  } else {
    invertedOps.push(...imageOps);
  }

  return { pageClass, photographicOps, invertedOps, textOps, vectorOps, imageCoverage, pageStats };
}

/**
 * (Re)create the image-preservation overlay for a page from its cached
 * decision. Geometry-only — safe to call on zoom and adjustment changes.
 */
function _updateOverlayForPage(pageNumber, pageEl, canvas, decision, viewport = null) {
  if (!decision || !canvas?.width) return;

  const vp = viewport ?? _pageViewports.get(pageNumber) ?? _reconstructViewport(pageEl);
  if (!vp) return;

  if (decision.pageClass !== 'normal' || !decision.photographicOps.length) {
    removeImageOverlay(pageEl);
    return;
  }

  const rects = imageOpsToRects(decision.photographicOps, vp);
  updateImageOverlay(pageEl, canvas, rects, vp, buildCounterFilter(_brightness, _contrast));
}

/**
 * Reconstruct the viewport for an already-rendered page when no pagerendered
 * event supplied one. PDF.js v6 sizes canvases via stylesheet (no inline
 * style.width), so measure the canvas's on-screen box and derive the scale.
 */
function _reconstructViewport(pdfPage, pageEl) {
  try {
    const canvas = _getCanvas(pageEl);
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const base = pdfPage.getViewport({ scale: 1 });
    if (!base.width) return null;
    return pdfPage.getViewport({ scale: rect.width / base.width });
  } catch (_) {
    return null;
  }
}

function _getCanvas(pageEl) {
  // The main canvas is the first canvas inside .canvasWrapper that is NOT
  // one of our overlays.
  const wrapper = pageEl.querySelector('.canvasWrapper');
  if (!wrapper) return null;
  for (const c of wrapper.querySelectorAll('canvas')) {
    if (!c.classList.contains('nivra-image-overlay')) return c;
  }
  return null;
}

function _pageNumber(pageEl) {
  return parseInt(pageEl.dataset.pageNumber, 10) || null;
}

function _loadPreserveSetting() {
  try {
    return window.localStorage.getItem('nivra.smartDark.preserveImages') !== 'false';
  } catch (_) {
    return true;
  }
}

/** Debug-refresh hook: re-render overlays when the dev panel toggles change. */
window.addEventListener('nivra:debug-refresh', () => {
  if (!_isActive) return;
  document.querySelectorAll('.pdfViewer .page').forEach(pageEl => {
    const pn = _pageNumber(pageEl);
    if (!pn) return;
    const canvas = _getCanvas(pageEl);
    if (canvas?.width) _processPageAsync(pn, null, pageEl, canvas);
  });
});

