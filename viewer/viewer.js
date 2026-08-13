/**
 * Nivra PDF Viewer — Main Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Initialises PDF.js and wires it to the Nivra UI and visual engine.
 *
 * ─── Rendering Quality ───────────────────────────────────────────────────────
 * PDF.js PDFViewer handles DPR-aware rendering internally via its outputScale
 * mechanism. The key options for maximum fidelity:
 *   maxCanvasPixels: -1   — removes the default 16 MP canvas size cap;
 *                           without this, HiDPI pages are silently downscaled.
 *   textLayerMode:   1    — always render text layer (selection/search/copy)
 *   annotationMode:  2    — render annotations including interactive forms
 *
 * We do NOT override PDF.js's canvas CSS dimensions or manually set canvas
 * width/height — those are managed correctly by PDFViewer internally.
 *
 * ─── Visual Engine integration ────────────────────────────────────────────────
 * - setDocument(pdfDoc) → tells visual engine a new document is loaded
 * - onPageRendered(n, viewport, pageEl, canvas) → delegates per-page treatment
 *   The `evt.source.viewport` from PDF.js provides the exact viewport used
 *   to render that page at the current scale, enabling pixel-accurate
 *   operator-analysis coordinate mapping.
 */

import * as pdfjsLib    from '../pdfjs/build/pdf.mjs';
import * as pdfjsViewer from '../pdfjs/web/pdf_viewer.mjs';
import {
  setupVisualEngine,
  setDocument    as veSetDocument,
  onPageRendered as veOnPageRendered,
  getCurrentMode,
} from '../transformations/visual-engine.js';

// ─── PDF.js worker ────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = '../pdfjs/build/pdf.worker.mjs';

// ─── Global error surface ─────────────────────────────────────────────────────
window.onerror = (msg, _u, _l, _c, err) =>
  _showError('Error: ' + msg + (err ? '\n' + err.stack : ''));
window.addEventListener('unhandledrejection', e =>
  _showError('Unhandled rejection: ' + (e.reason?.stack || e.reason || e)));

function _showError(msg) {
  const log = document.getElementById('error-log');
  if (!log) return;
  log.classList.remove('hidden');
  log.classList.add('flex');
  const m = document.getElementById('error-message');
  if (m) m.textContent = msg;
}

// ─── Popover state ────────────────────────────────────────────────────────────
const POPOVERS = {
  appearance: 'appearance-popover',
  search:     'search-overlay',
  viewSize:   'view-size-popover',
};
let _openPopover = null;
const VIEW_SIZE_LABELS = new Map([
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['page-width', 'Width'],
  ['page-fit', 'Fit'],
  ['auto', 'Auto'],
]);

function _openPopoverFn(name, event) {
  if (event) event.stopPropagation();
  if (_openPopover === name) { _closeAll(); return; }
  _closeAll();
  const el = document.getElementById(POPOVERS[name]);
  if (el) {
    el.classList.add('active');
    _openPopover = name;
    if (name === 'viewSize') {
      document.getElementById('btn-view-size')?.setAttribute('aria-expanded', 'true');
    }
    if (name === 'search') {
      const focusInput = () => {
        const input = document.getElementById('find-input');
        input?.focus({ preventScroll: true });
        input?.select?.();
      };
      requestAnimationFrame(focusInput);
      setTimeout(focusInput, 0);
    }
  }
}

function _closeAll() {
  Object.values(POPOVERS).forEach(id =>
    document.getElementById(id)?.classList.remove('active'));
  document.getElementById('btn-view-size')?.setAttribute('aria-expanded', 'false');
  _openPopover = null;
}

// ─── PDF.js state ─────────────────────────────────────────────────────────────
let pdfDoc = null;
let pdfViewer, eventBus, pdfLinkService, pdfFindController;
let currentFileUrl = '';
let _documentProperties = null;
let _thumbnailObserver = null;
let _sidebarOpen = true;
let _twoPageView = false;
let _activeThumbnailPage = 0;
const _thumbnailButtons = new Map();
const _thumbnailRenderPromises = new Map();
const THUMBNAIL_CSS_WIDTH = 148;
const THUMBNAIL_MAX_DPR = 1.5;

// ─── Initialise ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Visual engine (sets up UI and applies default Smart Dark)
  setupVisualEngine();

  // 2. Resolve file URL
  const params   = new URLSearchParams(window.location.search);
  currentFileUrl = params.get('file') || '';
  if (!currentFileUrl) { _showError('No PDF file specified.'); return; }

  // 3. Set document title
  try {
    const fname  = decodeURIComponent(currentFileUrl.split('/').pop() || 'Document');
    const titleEl = document.getElementById('document-title');
    if (titleEl) { titleEl.textContent = fname; titleEl.title = fname; }
    document.title = fname + ' — Nivra';
  } catch (_) {}

  // 4. Prepare container
  //    PDF.js hard-requires #viewerContainer to be position:absolute.
  //    We set it via JS to guarantee this regardless of CSS specificity or FOUC.
  const container = document.getElementById('viewerContainer');
  const viewer    = document.getElementById('viewer');
  if (!container || !viewer) {
    _showError('Viewer DOM elements not found (#viewerContainer / #viewer).');
    return;
  }

  // Guarantee absolute positioning BEFORE PDFViewer constructor runs
  Object.assign(container.style, {
    position: 'absolute',
    top:      '0',
    bottom:   '0',
    left:     '0',
    right:    '0',
    overflow: 'auto',
    outline:  'none',
  });

  // 5. Build PDF.js viewer
  eventBus          = new pdfjsViewer.EventBus();
  pdfLinkService    = new pdfjsViewer.PDFLinkService({ eventBus });
  pdfFindController = new pdfjsViewer.PDFFindController({
    eventBus,
    linkService: pdfLinkService,
  });

  pdfViewer = new pdfjsViewer.PDFViewer({
    container,
    viewer,
    eventBus,
    linkService:       pdfLinkService,
    findController:    pdfFindController,
    removePageBorders: false,
    //
    // ── Rendering quality options ──────────────────────────────────────────
    // maxCanvasPixels: -1 removes the default 16 MP cap. Without this, PDF.js
    // silently scales DOWN the canvas on HiDPI displays and at higher zoom
    // levels, causing pixelated text and jagged table lines.
    maxCanvasPixels: -1,
    //
    // textLayerMode 1 = ENABLE — required for text selection, search, copy.
    textLayerMode: 1,
    //
    // annotationMode 2 = ENABLE_FORMS — renders links, form fields, etc.
    annotationMode: 2,
  });
  pdfLinkService.setViewer(pdfViewer);

  // 6. Wire PDF.js events

  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = 'auto';
    _updateScaleUI('auto');
    _setTwoPageView(false, { preservePage: true });
    _refreshThumbnailObservation();
  });

  eventBus.on('scalechanging', ({ presetValue, scale }) => {
    _updateScaleUI(presetValue || scale);
  });

  eventBus.on('pagechanging', ({ pageNumber }) => {
    const inp = document.getElementById('page-number-input');
    if (inp) inp.value = pageNumber;
    _setActiveThumbnail(pageNumber);
  });

  eventBus.on('spreadmodechanged', ({ mode }) => {
    _twoPageView = mode !== pdfjsViewer.SpreadMode.NONE;
    _updateTwoPageViewButton();
  });

  eventBus.on('pagerendered', evt => {
    // evt.source is the PDFPageView; .viewport is the exact viewport used to
    // render this page at the current scale + DPR. Prefer the page view's own
    // canvas reference: PDF.js v6 can swap/clone canvases mid-render, so a
    // DOM query may return a stale canvas during re-renders.
    const pageView  = evt.source;
    const viewport  = pageView?.viewport;
    const pageEl    = pageView?.div ?? document.querySelector(
      `.pdfViewer .page[data-page-number="${evt.pageNumber}"]`
    );
    const canvas    = pageView?.canvas
      ?? pageEl?.querySelector('.canvasWrapper canvas');

    if (viewport && pageEl && canvas) {
      veOnPageRendered(evt.pageNumber, viewport, pageEl, canvas);
    }
  });

  eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
    const el = document.getElementById('find-results-count');
    if (!el) return;
    el.textContent = matchesCount?.total
      ? `${matchesCount.current} / ${matchesCount.total}`
      : '0 / 0';
  });

  // 7. Load PDF
  const pdfjsUrl = new URL('../pdfjs/', import.meta.url).href;
  try {
    const task = pdfjsLib.getDocument({
      url:                 currentFileUrl,
      standardFontDataUrl: pdfjsUrl + 'web/standard_fonts/',
      cMapUrl:             pdfjsUrl + 'web/cmaps/',
      cMapPacked:          true,
    });
    pdfDoc = await task.promise;

    // Tell visual engine which document is loaded (clears operator cache, etc.)
    veSetDocument(pdfDoc);

    pdfViewer.setDocument(pdfDoc);
    pdfLinkService.setDocument(pdfDoc, null);

    const countEl = document.getElementById('page-count-display');
    const pageInp = document.getElementById('page-number-input');
    if (countEl) countEl.textContent = pdfDoc.numPages;
    if (pageInp) pageInp.max = pdfDoc.numPages;

    _populateDocumentProperties().catch(err => {
      console.warn('[Nivra] Failed to populate document properties:', err);
    });
    _buildThumbnailSidebar();
  } catch (err) {
    _showError('Could not load PDF: ' + (err.message || String(err)));
    return;
  }

  // 8. Wire UI controls
  _setupUI();
});

// ─── UI wiring ────────────────────────────────────────────────────────────────
function _setupUI() {
  _setSidebarOpen(_sidebarOpen);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    pdfViewer.currentScale = Math.min(pdfViewer.currentScale * 1.25, 10);
  });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    pdfViewer.currentScale = Math.max(pdfViewer.currentScale / 1.25, 0.1);
  });
  document.getElementById('btn-view-size')?.addEventListener('click', e => {
    _openPopoverFn('viewSize', e);
  });
  document.querySelectorAll('.view-size-option').forEach(option => {
    option.addEventListener('click', e => {
      e.stopPropagation();
      const scaleValue = option.dataset.scaleValue;
      if (!scaleValue) return;
      pdfViewer.currentScaleValue = scaleValue;
      _updateScaleUI(scaleValue);
      _closeAll();
    });
  });

  // ── Page nav ──────────────────────────────────────────────────────────────
  document.getElementById('btn-page-prev')?.addEventListener('click', () => {
    pdfViewer?.previousPage?.();
  });
  document.getElementById('btn-page-next')?.addEventListener('click', () => {
    pdfViewer?.nextPage?.();
  });
  document.getElementById('page-number-input')?.addEventListener('change', e => {
    const p = parseInt(e.target.value, 10);
    if (pdfDoc && p >= 1 && p <= pdfDoc.numPages) {
      _goToPage(p, { smooth: true });
    } else {
      e.target.value = pdfViewer.currentPageNumber;
    }
  });

  // ── Sidebar ───────────────────────────────────────────────────────────────
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    _setSidebarOpen(!_sidebarOpen);
  });
  document.getElementById('btn-two-page-view')?.addEventListener('click', () => {
    _setTwoPageView(!_twoPageView, { preservePage: true });
  });

  // ── Popovers ──────────────────────────────────────────────────────────────
  document.getElementById('btn-appearance')?.addEventListener('click',
    e => _openPopoverFn('appearance', e));
  document.getElementById('btn-close-appearance')?.addEventListener('click', _closeAll);
  document.getElementById('btn-search')?.addEventListener('click',
    e => _openPopoverFn('search', e));
  document.getElementById('btn-close-search')?.addEventListener('click', () => {
    _closeAll();
    _dispatchFind('', false, '');
  });
  document.getElementById('btn-properties')?.addEventListener('click', () => {
    _closeAll();
    _openPropertiesModal();
  });
  document.getElementById('btn-close-properties')?.addEventListener('click', _closePropertiesModal);
  document.getElementById('properties-modal')?.addEventListener('click', e => {
    if (e.target?.id === 'properties-modal') _closePropertiesModal();
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('[id$="-popover"]') &&
        !e.target.closest('#search-overlay')  &&
        !e.target.closest('.toolbar-btn')     &&
        !e.target.closest('#btn-appearance')  &&
        !e.target.closest('#view-size-control')) {
      _closeAll();
    }
  });

  // ── Download ──────────────────────────────────────────────────────────────
  document.getElementById('btn-download')?.addEventListener('click', async () => {
    _closeAll();
    await _downloadTransformed();
  });

  // ── Print ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-print')?.addEventListener('click', () => window.print());

  // ── Search ────────────────────────────────────────────────────────────────
  const findInput = document.getElementById('find-input');
  findInput?.addEventListener('input',   ()  => _dispatchFind(''));
  findInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _dispatchFind('again', e.shiftKey);
    } else if (e.key === 'Escape') {
      _closeAll();
      _dispatchFind('', false, '');
    }
  });
  document.getElementById('btn-find-next')?.addEventListener('click',
    () => _dispatchFind('again', false));
  document.getElementById('btn-find-prev')?.addEventListener('click',
    () => _dispatchFind('again', true));

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  window.addEventListener('keydown', e => {
    const active = document.activeElement;
    const inInput = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA';

    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      _openPopoverFn('search');
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      document.getElementById('btn-zoom-in')?.click();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      document.getElementById('btn-zoom-out')?.click();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      pdfViewer.currentScaleValue = 'auto';
      _updateScaleUI('auto');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      window.print();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      _setSidebarOpen(!_sidebarOpen);
    } else if (e.key === 'Escape') {
      _closePropertiesModal();
      _closeAll();
    } else if (!inInput) {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        document.getElementById('btn-page-next')?.click();
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        document.getElementById('btn-page-prev')?.click();
      }
    }
  });
}

// ─── Search helpers ───────────────────────────────────────────────────────────
function _dispatchFind(type, findPrevious = false, overrideQuery = null) {
  const query = overrideQuery !== null
    ? overrideQuery
    : (document.getElementById('find-input')?.value || '');
  eventBus.dispatch('find', {
    source:          window,
    type,
    query,
    phraseSearch:    true,
    caseSensitive:   false,
    entireWord:      false,
    highlightAll:    true,
    findPrevious,
    matchDiacritics: false,
  });
}

function _openPropertiesModal() {
  const modal = document.getElementById('properties-modal');
  if (!modal) return;
  modal.hidden = false;
}

function _setSidebarOpen(open) {
  _sidebarOpen = !!open;
  const wrapper = document.getElementById('viewerWrapper');
  const toggle = document.getElementById('sidebar-toggle');
  if (wrapper) wrapper.classList.toggle('sidebar-open', _sidebarOpen);
  if (toggle) toggle.setAttribute('aria-expanded', String(_sidebarOpen));
  if (_sidebarOpen) {
    _refreshThumbnailObservation();
    _setActiveThumbnail(pdfViewer?.currentPageNumber || 1, false);
  }
}

function _buildThumbnailSidebar() {
  const list = document.getElementById('thumbnail-list');
  if (!list || !pdfDoc) return;

  _thumbnailObserver?.disconnect();
  _thumbnailButtons.clear();
  _thumbnailRenderPromises.clear();
  list.textContent = '';

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    const item = document.createElement('div');
    item.className = 'thumbnail-item';
    item.dataset.pageNumber = String(pageNumber);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumbnail-button';
    button.dataset.pageNumber = String(pageNumber);
    button.setAttribute('aria-label', `Go to page ${pageNumber}`);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'thumbnail-canvas-wrap';
    const placeholder = document.createElement('div');
    placeholder.className = 'thumbnail-placeholder';
    placeholder.textContent = 'Loading...';
    canvasWrap.appendChild(placeholder);

    const label = document.createElement('div');
    label.className = 'thumbnail-page-label';
    label.textContent = `Page ${pageNumber}`;

    button.append(canvasWrap, label);
    button.addEventListener('click', () => _goToPage(pageNumber, { smooth: true }));
    item.appendChild(button);
    list.appendChild(item);

    _thumbnailButtons.set(pageNumber, button);
  }

  _refreshThumbnailObservation();
  _setActiveThumbnail(pdfViewer?.currentPageNumber || 1, false);
  _updateTwoPageViewButton();
}

function _refreshThumbnailObservation() {
  const root = document.getElementById('thumbnail-scroll');
  if (!root) return;

  _thumbnailObserver?.disconnect();
  _thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = entry.target;
      const pageNumber = Number(item.dataset.pageNumber);
      const canvasWrap = item.querySelector('.thumbnail-canvas-wrap');
      if (pageNumber && canvasWrap) {
        _renderThumbnail(pageNumber, canvasWrap, item);
      }
      _thumbnailObserver?.unobserve(item);
    }
  }, {
    root,
    rootMargin: '240px 0px',
    threshold: 0.01,
  });

  root.querySelectorAll('.thumbnail-item').forEach(item => {
    if (item.dataset.rendered !== 'true') _thumbnailObserver.observe(item);
  });
}

async function _renderThumbnail(pageNumber, canvasWrap, itemEl) {
  if (!pdfDoc || !canvasWrap || itemEl?.dataset.rendered === 'true') return;
  if (_thumbnailRenderPromises.has(pageNumber)) return _thumbnailRenderPromises.get(pageNumber);

  const renderPromise = (async () => {
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = THUMBNAIL_CSS_WIDTH / baseViewport.width;
      const cssViewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, THUMBNAIL_MAX_DPR);
      const canvas = document.createElement('canvas');
      const renderTransform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

      canvas.width = Math.max(1, Math.floor(cssViewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(cssViewport.height * outputScale));
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;

      canvasWrap.style.minHeight = `${Math.ceil(cssViewport.height)}px`;
      canvasWrap.replaceChildren(canvas);

      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({
        canvasContext: ctx,
        viewport: cssViewport,
        transform: renderTransform,
      }).promise;

      if (itemEl) itemEl.dataset.rendered = 'true';
    } catch (err) {
      console.warn(`[Nivra] Failed to render thumbnail for page ${pageNumber}:`, err);
      canvasWrap.innerHTML = '<div class="thumbnail-placeholder">Preview unavailable</div>';
    } finally {
      _thumbnailRenderPromises.delete(pageNumber);
    }
  })();

  _thumbnailRenderPromises.set(pageNumber, renderPromise);
  return renderPromise;
}

function _setActiveThumbnail(pageNumber, ensureVisible = true) {
  if (!pageNumber || _activeThumbnailPage === pageNumber && ensureVisible === false) return;
  _activeThumbnailPage = pageNumber;

  for (const [num, button] of _thumbnailButtons.entries()) {
    button.classList.toggle('is-active', num === pageNumber);
  }

  const active = _thumbnailButtons.get(pageNumber);
  if (active && ensureVisible && _sidebarOpen) {
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function _goToPage(pageNumber, { smooth = false } = {}) {
  if (!pdfDoc || !pdfViewer || pageNumber < 1 || pageNumber > pdfDoc.numPages) return;
  pdfViewer.currentPageNumber = pageNumber;

  const pageView = pdfViewer.getPageView(pageNumber - 1);
  pageView?.div?.scrollIntoView({
    behavior: smooth ? 'smooth' : 'auto',
    block: 'start',
    inline: 'nearest',
  });
}

function _setTwoPageView(enabled, { preservePage = false } = {}) {
  _twoPageView = !!enabled;
  const currentPage = preservePage ? (pdfViewer?.currentPageNumber || 1) : 1;

  if (pdfViewer) {
    pdfViewer.spreadMode = _twoPageView
      ? pdfjsViewer.SpreadMode.ODD
      : pdfjsViewer.SpreadMode.NONE;
    if (preservePage) {
      requestAnimationFrame(() => _goToPage(currentPage, { smooth: false }));
    }
  }

  _updateTwoPageViewButton();
}

function _updateTwoPageViewButton() {
  const btn = document.getElementById('btn-two-page-view');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(_twoPageView));
}

function _closePropertiesModal() {
  const modal = document.getElementById('properties-modal');
  if (!modal) return;
  modal.hidden = true;
}

async function _populateDocumentProperties() {
  if (!pdfDoc) return;

  const [meta, downloadInfo, page] = await Promise.all([
    pdfDoc.getMetadata(),
    pdfDoc.getDownloadInfo().catch(() => null),
    pdfDoc.getPage(1),
  ]);

  const info = meta?.info || {};
  const xmp = meta?.metadata || null;
  const viewport = page.getViewport({ scale: 1 });
  const fileSize = await _resolveFileSize(meta, downloadInfo);
  const fileName = _resolveFileName(meta);

  _documentProperties = {
    'prop-file-name': fileName,
    'prop-file-size': fileSize,
    'prop-title': _firstNonEmpty(
      info.Title,
      _readMetadataValue(xmp, 'dc:title'),
      fileName,
    ),
    'prop-author': _firstNonEmpty(
      info.Author,
      _readMetadataValue(xmp, 'dc:creator'),
    ),
    'prop-created-date': _formatPdfDate(info.CreationDate),
    'prop-modified-date': _formatPdfDate(info.ModDate),
    'prop-application': _firstNonEmpty(
      info.Creator,
      _readMetadataValue(xmp, 'xmp:CreatorTool'),
    ),
    'prop-pdf-producer': _firstNonEmpty(
      info.Producer,
      _readMetadataValue(xmp, 'pdf:Producer'),
    ),
    'prop-pdf-version': _firstNonEmpty(info.PDFFormatVersion),
    'prop-page-count': String(pdfDoc.numPages),
    'prop-page-size': _formatPageSize(viewport.width, viewport.height, viewport.rotation),
    'prop-fast-web-view': typeof info.IsLinearized === 'boolean'
      ? (info.IsLinearized ? 'Yes' : 'No')
      : 'No',
  };

  _applyDocumentProperties();
}

function _applyDocumentProperties() {
  if (!_documentProperties) return;
  for (const [id, value] of Object.entries(_documentProperties)) {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '—';
  }
}

async function _resolveFileSize(meta, downloadInfo) {
  const contentLength = meta?.contentLength
    ?? downloadInfo?.length
    ?? null;
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return _formatBytes(contentLength);
  }

  try {
    const bytes = await pdfDoc.getData();
    if (bytes?.length) return _formatBytes(bytes.length);
  } catch (_) {}

  return '—';
}

function _resolveFileName(meta) {
  return _firstNonEmpty(
    meta?.contentDispositionFilename,
    decodeURIComponent(currentFileUrl.split('/').pop() || ''),
    'Document.pdf',
  );
}

function _readMetadataValue(metadata, key) {
  if (!metadata?.get) return '';
  const value = metadata.get(key);
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    if (typeof value['x-default'] === 'string') return value['x-default'];
    const first = Object.values(value).find(v => typeof v === 'string' && v.trim());
    if (first) return first;
  }
  return typeof value === 'string' ? value : '';
}

function _firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '—';
}

function _formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : (size >= 10 ? 1 : 2);
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function _formatPdfDate(raw) {
  if (!raw || typeof raw !== 'string') return '—';

  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+\-])?(\d{2})?'?(\d{2})?'?/.exec(raw);
  if (!match) return raw;

  const [
    ,
    year,
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
    offsetSign = 'Z',
    offsetHour = '00',
    offsetMinute = '00',
  ] = match;

  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  let adjustedMillis = utcMillis;
  if (offsetSign !== 'Z') {
    const offsetMillis = ((Number(offsetHour) * 60) + Number(offsetMinute)) * 60 * 1000;
    adjustedMillis += offsetSign === '+' ? -offsetMillis : offsetMillis;
  }

  const date = new Date(adjustedMillis);
  return Number.isNaN(date.getTime())
    ? raw
    : new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}

function _formatPageSize(widthPts, heightPts, rotation = 0) {
  if (!(widthPts > 0) || !(heightPts > 0)) return '—';

  const normalized = rotation % 180 === 0
    ? [widthPts, heightPts]
    : [heightPts, widthPts];
  const [wPts, hPts] = normalized;
  const wIn = wPts / 72;
  const hIn = hPts / 72;
  const wMm = wIn * 25.4;
  const hMm = hIn * 25.4;
  const standard = _getStandardPageName(wMm, hMm);
  const parts = [];

  if (standard) parts.push(standard);
  parts.push(`${wIn.toFixed(2)} × ${hIn.toFixed(2)} in`);
  parts.push(`(${Math.round(wMm)} × ${Math.round(hMm)} mm)`);

  return parts.join(' ');
}

function _getStandardPageName(widthMm, heightMm) {
  const dims = [widthMm, heightMm].sort((a, b) => a - b);
  const sizes = [
    ['A4', 210, 297],
    ['Letter', 215.9, 279.4],
    ['Legal', 215.9, 355.6],
    ['A3', 297, 420],
  ];
  for (const [name, w, h] of sizes) {
    if (Math.abs(dims[0] - w) <= 3 && Math.abs(dims[1] - h) <= 3) {
      return name;
    }
  }
  return '';
}

// ─── Download Transformed ─────────────────────────────────────────────────────
async function _downloadTransformed() {
  const pages = document.querySelectorAll('.pdfViewer .page');
  if (!pages.length) {
    alert('No pages available. Scroll through the document first to render pages.');
    return;
  }

  const mode     = getCurrentMode();
  const docTitle = document.getElementById('document-title')?.textContent || 'document';

  // CSS filter strings matching the visual engine's mode filters
  const modeFilters = {
    'true-invert':  'invert(100%)',
    'grayscale':    'grayscale(100%)',
    'high-contrast':'contrast(180%) brightness(0.9) saturate(1.2)',
  };

  const pageImages = [];
  for (const page of pages) {
    const canvas = page.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) continue;

    const offscreen = document.createElement('canvas');
    offscreen.width  = canvas.width;
    offscreen.height = canvas.height;
    const ctx = offscreen.getContext('2d');

    if (mode === 'smart-dark' || mode === 'original') {
      // Smart Dark: apply the same filter chain the engine applies to the
      // page's canvas layer, then composite the image-preservation overlay
      // (raw original pixels) on top — matching the on-screen result.
      if (mode === 'smart-dark') {
        ctx.filter = 'invert(100%) hue-rotate(180deg)';
      }
      ctx.drawImage(canvas, 0, 0);
      if (mode === 'smart-dark') {
        ctx.filter = 'none';
        const overlay = page.querySelector('canvas.nivra-image-overlay');
        if (overlay?.width) ctx.drawImage(overlay, 0, 0);
      }
    } else {
      const f = modeFilters[mode];
      if (f) ctx.filter = f;
      ctx.drawImage(canvas, 0, 0);
    }

    pageImages.push(offscreen.toDataURL('image/jpeg', 0.93));
  }

  if (!pageImages.length) {
    alert('No rendered pages captured.');
    return;
  }

  const modeLabel = {
    'smart-dark':   'Smart Dark',
    'true-invert':  'True Invert',
    'grayscale':    'Grayscale',
    'high-contrast':'High Contrast',
    'original':     'Original',
  }[mode] || mode;

  const pw = window.open('', '_blank', 'width=900,height=700');
  if (!pw) {
    alert('Please allow pop-ups for this extension to download the transformed PDF.');
    return;
  }

  pw.document.write(`<!DOCTYPE html>
<html><head>
  <title>${docTitle} — ${modeLabel} (Nivra)</title>
  <style>
    @page { margin:0; size:auto; }
    *     { margin:0; padding:0; box-sizing:border-box; }
    body  { background:#fff; }
    .p    { width:100%; page-break-after:always; display:block; }
    img   { width:100%; display:block; }
    .bar  { position:fixed; bottom:0; left:0; right:0;
            background:#1e1e1e; color:#aaa; font:12px sans-serif;
            padding:8px 16px; text-align:center; }
    @media print { .bar { display:none; } }
  </style>
</head><body>
${pageImages.map((s, i) =>
  `<div class="p"><img src="${s}" alt="Page ${i+1}"></div>`).join('\n')}
<div class="bar">Nivra — <strong>${modeLabel}</strong> &nbsp;|&nbsp; Press <kbd>Ctrl+P</kbd> to save as PDF</div>
</body></html>`);
  pw.document.close();
  setTimeout(() => { try { pw.print(); } catch(_){} }, 600);
}

// ─── Scale UI helper ──────────────────────────────────────────────────────────
function _updateScaleUI(scaleValue) {
  const labelEl = document.getElementById('view-size-label');
  const optionEls = document.querySelectorAll('.view-size-option');
  if (!labelEl || !optionEls.length) return;

  let activeValue = null;
  let label = '';

  if (typeof scaleValue === 'string') {
    if (VIEW_SIZE_LABELS.has(scaleValue)) {
      activeValue = scaleValue;
      label = VIEW_SIZE_LABELS.get(scaleValue);
    }
  }

  if (!label) {
    const num = parseFloat(scaleValue);
    if (isNaN(num)) return;

    let bestValue = null;
    let bestDiff = Infinity;
    for (const [value] of VIEW_SIZE_LABELS) {
      const numericValue = parseFloat(value);
      if (!Number.isNaN(numericValue)) {
        const diff = Math.abs(numericValue - num);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestValue = value;
        }
      }
    }
    if (bestValue && bestDiff < 0.05) {
      activeValue = bestValue;
      label = VIEW_SIZE_LABELS.get(bestValue);
    } else {
      label = `${Math.round(num * 100)}%`;
    }
  }

  labelEl.textContent = label;
  optionEls.forEach(option => {
    option.classList.toggle('is-active', option.dataset.scaleValue === activeValue);
  });
}
