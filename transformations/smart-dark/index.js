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

import {
  getPageAnalysis, imageOpsToRects, imageOpsToQuads, rectOpsToRects, clearOpListCache,
} from './operator-analyzer.js';
import {
  probePage, snapshotPage, takeSnapshot, probeRegion, regionStats, classifyPage, classifyImageWithOverlap, clearProbeCache,
} from './page-analyzer.js';
import { updateImageOverlay, updateDetailOverlay, removeImageOverlay, removeAllImageOverlays } from './image-protector.js';
import { buildSmartDarkFilter, buildCounterFilter } from './fallback.js';
import * as DebugOverlay from './debug-overlay.js';

// ─── State ────────────────────────────────────────────────────────────────────
let _pdfDoc     = null;
let _isActive   = false;
let _wrapperEl  = null;   // #viewerWrapper — carries the filter custom properties

/** Read by `.canvasWrapper { filter: var(--nivra-filter) }` and the overlay (input.css / image-protector.js). */
const FILTER_VAR  = '--nivra-filter';
const COUNTER_VAR = '--nivra-counter-filter';
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

// pageNumber → request that arrived while that page's analysis was in flight.
// Latest wins; it is replayed when the running analysis finishes (never dropped).
const _rerun = new Map();

// pageNumber → number of pagerendered events seen. An in-flight analysis
// compares it before/after each await to learn that a newer render (zoom) has
// made the viewport and canvas it started with stale.
const _renderEpoch = new Map();

/**
 * Most DISTINCT images analysed per page (largest first); any further image is
 * inverted with the page. Every draw of one image (tiles, a repeated logo) is
 * one image, not hundreds — classified once, one shared verdict — so this only
 * bites on pages like contact sheets with dozens of different pictures.
 */
const MAX_ANALYSED_IMAGES = 200;

// pageNumber → physical width of the canvas that _pageViewports' viewport was
// rendered into. Viewport and canvas only describe the same render while this
// matches the live canvas (PDF.js resizes the canvas as soon as a new render starts).
const _viewportCanvasWidth = new Map();

// Page numbers whose text layer has finished rendering. PDF.js dispatches
// pagerendered (canvas) first and textlayerrendered afterwards, so the analysis
// often runs before any text spans exist. Image-vs-text overlap can only be
// judged once they do; until then a page gets a provisional decision
// (needsTextRetry) that is replaced as soon as textlayerrendered fires —
// however long the text layer takes. No timers, no retry budget.
const _textLayerDone = new Set();

/**
 * @typedef {Object} PageDecision
 * @property {'normal'|'dark-bg'|'scanned'} pageClass
 * @property {Array<{ctm:number[], opIndex:number}>} photographicOps — subset of imageOps to preserve
 * @property {Array<{ctm:number[], opIndex:number}>} invertedOps     — detected but inverted
 * @property {number} textOps
 * @property {number} vectorOps
 * @property {number} imageCoverage
 * @property {Object|null} pageStats
 * @property {boolean} [needsTextRetry] — PROVISIONAL: made before the page's text
 *           layer existed, so every image is inverted; redone on textlayerrendered
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
  _rerun.clear();
  _renderEpoch.clear();
  _viewportCanvasWidth.clear();
  _textLayerDone.clear();
}

/**
 * Activate Smart Dark: filter all rendered pages now; analyze asynchronously.
 */
export function activate(wrapper, brightness, contrast) {
  _isActive = true;
  _wrapperEl = wrapper;
  _brightness = brightness;
  _contrast   = contrast;

  // One variable filters every page (current and future) from its first frame.
  _publishFilters();

  document.querySelectorAll('.pdfViewer .page').forEach(pageEl => {
    const pn = _pageNumber(pageEl);
    if (!pn) return;
    const canvas = _getCanvas(pageEl);
    // Analysis may only refine this (e.g. mark the page as already dark).
    _applyPageFilter(pageEl, _decisionCache.get(pn)?.pageClass ?? 'normal');
    if (canvas?.width) _processPageAsync(pn, null, pageEl, canvas);
  });
}

/**
 * Deactivate Smart Dark: remove every per-page filter and overlay.
 */
export function deactivate(_wrapper) {
  _isActive = false;
  _rerun.clear();
  _wrapperEl?.style.removeProperty(FILTER_VAR);
  _wrapperEl?.style.removeProperty(COUNTER_VAR);
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
  // Bookkeeping runs even while Smart Dark is off, so re-activating later pairs
  // each page's CURRENT viewport with its CURRENT canvas (never a stale one).
  // A new render also invalidates anything an in-flight analysis captured.
  _renderEpoch.set(pageNumber, (_renderEpoch.get(pageNumber) ?? 0) + 1);
  // The text layer of the previous render no longer vouches for this one; PDF.js
  // renders a fresh text layer after every page render and says so with
  // textlayerrendered.
  _textLayerDone.delete(pageNumber);
  if (viewport) {
    _pageViewports.set(pageNumber, viewport);
    _viewportCanvasWidth.set(pageNumber, canvas?.width ?? 0);
  }

  if (!_isActive) return;

  // Immediate filter application (analysis may refine the class later).
  _applyPageFilter(pageEl, _decisionCache.get(pageNumber)?.pageClass ?? 'normal');

  // Stale overlay from a previous render (different scale) is invalid.
  removeImageOverlay(pageEl);
  DebugOverlay.removeDebugOverlay(pageEl);

  _processPageAsync(pageNumber, viewport, pageEl, canvas);
}

/**
 * Called by visual-engine when PDF.js finishes a page's text layer (its
 * `textlayerrendered` event) — whatever the active mode, and however long the
 * text layer took. Records that image-vs-text overlap can now be judged, and
 * replaces a provisional decision (all images inverted) with the real one.
 */
export function onTextLayerRendered(pageNumber, pageEl) {
  _textLayerDone.add(pageNumber);
  if (!_isActive) return;                    // activate() re-decides provisional pages itself

  if (!_decisionCache.get(pageNumber)?.needsTextRetry) return;
  const canvas = _getCanvas(pageEl);
  if (canvas?.width) _processPageAsync(pageNumber, null, pageEl, canvas);
}

/**
 * Called by visual-engine when PDF.js repaints a page's full-resolution detail
 * canvas (zoomed-in pages: it covers the visible area and follows scrolling).
 * Refreshes only the sharp half of the photo overlay; the page's analysis and
 * base overlay are untouched. Without a decision yet (analysis still running)
 * there is nothing to do — the analysis builds both halves when it finishes.
 */
export function onDetailRendered(pageNumber, pageEl, detailCanvas) {
  if (!_isActive) return;
  const decision = _decisionCache.get(pageNumber);
  const vp = _pageViewports.get(pageNumber);
  if (!decision || !vp || decision.pageClass !== 'normal' || !decision.photographicOps.length) return;
  if (!_canvasMatchesViewport(pageNumber, _getCanvas(pageEl))) return;   // a newer page render is under way

  updateDetailOverlay(pageEl, detailCanvas, imageOpsToQuads(decision.photographicOps, vp), vp,
                      buildCounterFilter(_brightness, _contrast));
}

/**
 * Re-apply filters after brightness/contrast changes: two custom-property
 * writes, regardless of page count. Analysis, overlay canvases and the decision
 * cache are untouched, so dragging a slider never allocates or re-blits
 * anything. (visual-engine already coalesces calls to once per frame.)
 */
export function updateAdjustments(wrapper, brightness, contrast) {
  if (!_isActive) return;
  _wrapperEl = wrapper ?? _wrapperEl;
  _brightness = brightness;
  _contrast   = contrast;
  _publishFilters();
}

/**
 * Export hook (pdf-export.js): how should this page be treated?
 * Uses the cached on-screen decision when there is one; otherwise classifies
 * from the export canvas (no photograph carve-outs for never-viewed pages).
 *
 * @returns {Promise<{pageClass:string, quads:Array}>}
 */
export async function getExportDecision(pdfPage, canvas, viewport) {
  const cached = _decisionCache.get(pdfPage.pageNumber);
  if (cached) {
    return {
      pageClass: cached.pageClass,
      quads: cached.pageClass === 'normal'
        ? imageOpsToQuads(cached.photographicOps, viewport)
        : [],
    };
  }

  const analysis = await getPageAnalysis(pdfPage);
  const pageArea = viewport.width * viewport.height;
  let coverage = 0;
  for (const r of imageOpsToRects(analysis.imageOps, viewport)) {
    coverage = Math.max(coverage, (r.width * r.height) / pageArea);
  }
  const pageClass = classifyPage({
    pageStats: regionStats(probeRegion(takeSnapshot(canvas), 0, 0, canvas.width, canvas.height, 64)),
    textOps: analysis.textOps,
    imageCoverage: coverage,
    bgFills: analysis.bgFills,
    pageSize: _userSpaceSize(pdfPage),
  });
  return { pageClass, quads: [] };
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Publish the Smart Dark filter chain (and its exact inverse, used by the
 * image-preservation overlay) as CSS custom properties on #viewerWrapper.
 * input.css applies --nivra-filter to every .canvasWrapper, so the text layer,
 * annotation layer and the Nivra UI are never transformed.
 */
function _publishFilters() {
  if (!_wrapperEl) return;
  _wrapperEl.style.setProperty(FILTER_VAR,  buildSmartDarkFilter(_brightness, _contrast));
  _wrapperEl.style.setProperty(COUNTER_VAR, buildCounterFilter(_brightness, _contrast));
}

/**
 * Opt a page out of the filter when it is already dark. The CSS rule
 * `.nivra-smart-dark-skip .canvasWrapper { filter: none }` does the rest.
 */
function _applyPageFilter(pageEl, pageClass) {
  pageEl.classList.toggle('nivra-smart-dark-skip', pageClass === 'dark-bg');
}

function _clearPageFilter(pageEl) {
  pageEl.classList.remove('nivra-smart-dark-skip');
}

/**
 * Analyze a page (or reuse the cached decision) and apply overlays.
 * Never throws; failures degrade to "filter only, no overlay".
 *
 * Concurrency: at most one run per page. A request that arrives while a run is
 * awaiting analysis is queued (latest wins) and replayed afterwards. After every
 * await the run checks whether a newer render (zoom) has arrived and, if so,
 * abandons its now-stale viewport/canvas — the replay recomputes with fresh ones.
 */
async function _processPageAsync(pageNumber, viewport, pageEl, canvas) {
  if (!_pdfDoc) return;
  const key = String(pageNumber);
  if (_inFlight.has(key)) {
    _rerun.set(pageNumber, { viewport, pageEl, canvas });
    return;
  }
  _inFlight.add(key);

  const doc   = _pdfDoc;
  const epoch = _renderEpoch.get(pageNumber) ?? 0;
  // True when the world changed under us while awaiting.
  const stale = () => !_isActive || doc !== _pdfDoc || (_renderEpoch.get(pageNumber) ?? 0) !== epoch;

  try {
    let decision = _decisionCache.get(pageNumber);

    // A provisional decision (made before the text layer existed) is only good
    // until the text layer is there — then it is redone with real text boxes.
    if (decision?.needsTextRetry && _textLayerDone.has(pageNumber)) {
      _decisionCache.delete(pageNumber);
      decision = undefined;
    }

    // Resolve the viewport: stored (newest render) → event → reconstructed from the canvas box.
    let vp = _pageViewports.get(pageNumber) ?? viewport ?? null;

    if (!decision || !vp) {
      const pdfPage = await doc.getPage(pageNumber);
      const analysis = await getPageAnalysis(pdfPage);   // cached in analyzer
      if (stale()) return;

      if (!vp) {
        vp = _reconstructViewport(pdfPage, pageEl);
        if (!vp) return;
        _pageViewports.set(pageNumber, vp);
        _viewportCanvasWidth.set(pageNumber, (_getCanvas(pageEl) || canvas)?.width ?? 0);
      }

      if (!decision) {
        // The canvas may have been swapped mid-render — use the live one.
        const liveCanvas = _getCanvas(pageEl) || canvas;
        if (!liveCanvas?.width || !pageEl.contains(liveCanvas)) return;
        if (!_canvasMatchesViewport(pageNumber, liveCanvas)) return;
        decision = _decide(pdfPage, analysis, vp, liveCanvas, pageEl);
        _decisionCache.set(pageNumber, decision);
      }
    }

    // Refine the page filter if analysis found an already-dark page.
    _applyPageFilter(pageEl, decision.pageClass);

    const liveCanvas = _getCanvas(pageEl) || canvas;
    // PDF.js resizes the canvas the moment a new render starts, before its
    // pagerendered fires. Until then viewport and canvas disagree: do nothing —
    // that pagerendered will build the overlay from a matching pair.
    if (!_canvasMatchesViewport(pageNumber, liveCanvas)) return;
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
    // Replay the newest request that arrived while we were busy.
    const next = _rerun.get(pageNumber);
    if (next) {
      _rerun.delete(pageNumber);
      if (_isActive && next.pageEl?.isConnected) {
        _processPageAsync(pageNumber, next.viewport, next.pageEl, next.canvas);
      }
    }
  }
}

/**
 * Does the live canvas still belong to the render the stored viewport describes?
 * (Unknown pairing — e.g. nothing recorded yet — is given the benefit of the doubt.)
 */
function _canvasMatchesViewport(pageNumber, canvas) {
  const expected = _viewportCanvasWidth.get(pageNumber);
  return !expected || !canvas || canvas.width === expected;
}

/**
 * Page size in PDF user-space units (points). Operator-list fills are measured
 * in these units, so the "covers 80% of the page" test must use them too —
 * not the zoomed CSS-pixel viewport, which would shrink every ratio by scale².
 */
function _userSpaceSize(pdfPage) {
  const v = pdfPage.getViewport({ scale: 1 });
  return { w: v.width, h: v.height };
}

/**
 * Combine operator evidence + pixel evidence into a PageDecision.
 */
function _decide(pdfPage, analysis, viewport, canvas, pageEl) {
  const { imageOps, textOps, vectorOps, vectorPaints, bgFills } = analysis;
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
    pageSize: _userSpaceSize(pdfPage),
  });

  // Per-image classification — only when preservation is meaningful.
  const photographicOps = [];
  const invertedOps     = [];

  if (pageClass === 'normal' && _preserveImages) {
    const dprX = canvas.width / vpW;
    const dprY = canvas.height / vpH;
    const textRects   = _getTextRects(pageEl);
    const vectorRects = rectOpsToRects(vectorPaints, viewport);
    // No text boxes although the page draws text: only provisional while the
    // text layer has not rendered yet. Once it has, an empty layer is the
    // truth (invisible / unmapped text) and classification proceeds without it.
    if (textOps > 0 && textRects.length === 0 && !_textLayerDone.has(pdfPage.pageNumber)) {
      invertedOps.push(...imageOps);
      return {
        pageClass,
        photographicOps,
        invertedOps,
        textOps,
        vectorOps,
        imageCoverage,
        pageStats,
        needsTextRetry: true,
      };
    }
    // Group every draw of the same image so its pixels are judged once, not once
    // per tile. The key is the image's own id: PDF.js merges consecutive draws
    // into one repeat op only sometimes, so the operator index alone would count
    // a logo drawn 400 times as 400 images. Inline images have no id → own group.
    const groups = new Map();   // image key → { members: [{ op, r }], largest: rect }
    imageOps.forEach((op, idx) => {
      const r = rects[idx];
      if (!r) { invertedOps.push(op); return; }
      // Skip page-covering images: that is a scan/photo background, not an
      // embedded picture — protecting it would defeat the dark mode.
      if ((r.width * r.height) / pageArea >= 0.85) { invertedOps.push(op); return; }
      const key = op.imageId ?? `op#${op.opIndex}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { members: [], largest: r });
      g.members.push({ op, r });
      if (r.width * r.height > g.largest.width * g.largest.height) g.largest = r;
    });

    // The page is read ONCE (a downscaled CPU copy); every image is judged from
    // it. No per-image canvas, no per-image GPU readback.
    const snapshot = groups.size ? snapshotPage(pdfPage.pageNumber, canvas) : null;

    const area = r => r.width * r.height;
    const ranked = [...groups.values()].sort((a, b) => area(b.largest) - area(a.largest));
    ranked.forEach((g, rank) => {
      if (rank >= MAX_ANALYSED_IMAGES) {            // beyond the cap: invert with the page
        g.members.forEach(m => invertedOps.push(m.op));
        return;
      }
      const L = g.largest;
      const stats = regionStats(probeRegion(snapshot, L.x * dprX, L.y * dprY, L.width * dprX, L.height * dprY));
      g.members.forEach(({ op, r }) => {
        const overlap = _measureContentOverlap(r, op.opIndex, textRects, vectorRects);
        (classifyImageWithOverlap(stats, overlap) === 'photographic'
          ? photographicOps
          : invertedOps).push(op);
      });
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

  const vp = viewport ?? _pageViewports.get(pageNumber) ?? null;
  if (!vp) return;

  if (decision.pageClass !== 'normal' || !decision.photographicOps.length) {
    removeImageOverlay(pageEl);
    return;
  }

  const regions = imageOpsToQuads(decision.photographicOps, vp);
  const counter = buildCounterFilter(_brightness, _contrast);
  updateImageOverlay(pageEl, canvas, regions, vp, counter);

  // Zoomed-in page: PDF.js also has a full-resolution detail canvas on top of
  // the (lower-resolution) main one. Restore photos there at full resolution too.
  const detail = _getDetailCanvas(pageEl);
  if (detail) updateDetailOverlay(pageEl, detail, regions, vp, counter);
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

function _getTextRects(pageEl) {
  if (!pageEl) return [];
  const pageBox = pageEl.getBoundingClientRect();
  const textRects = [];
  for (const span of pageEl.querySelectorAll('.textLayer span')) {
    const text = span.textContent?.trim();
    if (!text) continue;
    const box = span.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    textRects.push({
      x: box.left - pageBox.left,
      y: box.top - pageBox.top,
      width: box.width,
      height: box.height,
    });
  }
  return textRects;
}

function _measureContentOverlap(imageRect, imageOpIndex, textRects, vectorRects) {
  let textSpanHits = 0;
  let textOverlapArea = 0;
  for (const textRect of textRects) {
    const area = _intersectionArea(imageRect, textRect);
    if (area > 0) {
      textSpanHits++;
      textOverlapArea += area;
    }
  }

  let vectorHits = 0;
  let vectorOverlapArea = 0;
  for (const vectorRect of vectorRects) {
    if (vectorRect.opIndex <= imageOpIndex) continue;
    const area = _intersectionArea(imageRect, vectorRect);
    if (area > 0) {
      vectorHits++;
      vectorOverlapArea += area;
    }
  }

  return {
    textSpanHits,
    textOverlapArea,
    vectorHits,
    vectorOverlapArea,
    imageArea: imageRect.width * imageRect.height,
  };
}

function _intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top ? (right - left) * (bottom - top) : 0;
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

/**
 * PDF.js's detail canvas: the second canvas in .canvasWrapper (it is inserted
 * right after the main one), ignoring our own overlays. Null when the page is
 * not zoomed past the canvas cap.
 */
function _getDetailCanvas(pageEl) {
  const wrapper = pageEl.querySelector('.canvasWrapper');
  if (!wrapper) return null;
  const canvases = [...wrapper.querySelectorAll('canvas')]
    .filter(c => !c.classList.contains('nivra-image-overlay'));
  return canvases.length > 1 ? canvases[1] : null;
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
