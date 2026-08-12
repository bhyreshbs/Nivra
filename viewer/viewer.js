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
  download:   'download-popover',
  settings:   'settings-popover',
};
let _openPopover = null;

function _openPopoverFn(name, event) {
  if (event) event.stopPropagation();
  if (_openPopover === name) { _closeAll(); return; }
  _closeAll();
  const el = document.getElementById(POPOVERS[name]);
  if (el) {
    el.classList.add('active');
    _openPopover = name;
    if (name === 'search') document.getElementById('find-input')?.focus();
  }
}

function _closeAll() {
  Object.values(POPOVERS).forEach(id =>
    document.getElementById(id)?.classList.remove('active'));
  _openPopover = null;
}

// ─── PDF.js state ─────────────────────────────────────────────────────────────
let pdfDoc = null;
let pdfViewer, eventBus, pdfLinkService, pdfFindController;
let currentFileUrl = '';

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
    pdfViewer.currentScaleValue = 'page-fit';
    _updateScaleUI('page-fit');
  });

  eventBus.on('scalechanging', ({ scale }) => {
    _updateScaleUI(scale);
  });

  eventBus.on('pagechanging', ({ pageNumber }) => {
    const inp = document.getElementById('page-number-input');
    if (inp) inp.value = pageNumber;
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
  } catch (err) {
    _showError('Could not load PDF: ' + (err.message || String(err)));
    return;
  }

  // 8. Wire UI controls
  _setupUI();
});

// ─── UI wiring ────────────────────────────────────────────────────────────────
function _setupUI() {
  // ── Zoom ──────────────────────────────────────────────────────────────────
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    pdfViewer.currentScale = Math.min(pdfViewer.currentScale * 1.25, 10);
  });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    pdfViewer.currentScale = Math.max(pdfViewer.currentScale / 1.25, 0.1);
  });
  document.getElementById('scale-select')?.addEventListener('change', e => {
    pdfViewer.currentScaleValue = e.target.value;
  });

  // ── Fit ───────────────────────────────────────────────────────────────────
  document.getElementById('btn-fit-width')?.addEventListener('click', () => {
    pdfViewer.currentScaleValue = 'page-width';
  });
  document.getElementById('btn-fit-page')?.addEventListener('click', () => {
    pdfViewer.currentScaleValue = 'page-fit';
  });

  // ── Page nav ──────────────────────────────────────────────────────────────
  document.getElementById('btn-page-prev')?.addEventListener('click', () => {
    if (pdfViewer.currentPageNumber > 1) pdfViewer.currentPageNumber--;
  });
  document.getElementById('btn-page-next')?.addEventListener('click', () => {
    if (pdfDoc && pdfViewer.currentPageNumber < pdfDoc.numPages)
      pdfViewer.currentPageNumber++;
  });
  document.getElementById('page-number-input')?.addEventListener('change', e => {
    const p = parseInt(e.target.value, 10);
    if (pdfDoc && p >= 1 && p <= pdfDoc.numPages) {
      pdfViewer.currentPageNumber = p;
    } else {
      e.target.value = pdfViewer.currentPageNumber;
    }
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
  document.getElementById('btn-download')?.addEventListener('click',
    e => _openPopoverFn('download', e));
  document.getElementById('btn-settings')?.addEventListener('click',
    e => _openPopoverFn('settings', e));

  // Close on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('[id$="-popover"]') &&
        !e.target.closest('#search-overlay')  &&
        !e.target.closest('.toolbar-btn')     &&
        !e.target.closest('#btn-appearance')) {
      _closeAll();
    }
  });

  // ── Download ──────────────────────────────────────────────────────────────
  document.getElementById('btn-download-original')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href     = currentFileUrl;
    a.download = document.getElementById('document-title')?.textContent || 'document.pdf';
    a.click();
    _closeAll();
  });
  document.getElementById('btn-download-transformed')?.addEventListener('click', async () => {
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
      pdfViewer.currentScaleValue = 'page-fit';
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      window.print();
    } else if (e.key === 'Escape') {
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
  const sel = document.getElementById('scale-select');
  if (!sel) return;

  if (typeof scaleValue === 'string') {
    const opt = sel.querySelector(`option[value="${scaleValue}"]`);
    if (opt) { sel.value = scaleValue; return; }
  }

  const num = parseFloat(scaleValue);
  if (isNaN(num)) return;

  // Find closest option
  let best = null, bestDiff = Infinity;
  for (const opt of sel.options) {
    const v = parseFloat(opt.value);
    if (!isNaN(v)) {
      const d = Math.abs(v - num);
      if (d < bestDiff) { bestDiff = d; best = opt; }
    }
  }
  if (best && bestDiff < 0.05) sel.value = best.value;
}
