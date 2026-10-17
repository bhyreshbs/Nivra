/**
 * Nivra PDF Viewer — Main Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Initialises PDF.js and wires it to the Nivra UI and visual engine.
 *
 * ─── Rendering Quality ───────────────────────────────────────────────────────
 * PDF.js PDFViewer handles DPR-aware rendering internally via its outputScale
 * mechanism. A page canvas is capped at a multiple of the screen's pixel count
 * (capCanvasAreaFactor, default 3×) so zoomed-in pages cannot allocate huge
 * canvases. When the cap bites, PDF.js lowers the page canvas's resolution and
 * paints a second, full-resolution "detail" canvas over just the visible area,
 * so zoomed text and lines stay sharp. That only happens while maxCanvasPixels
 * is > 0, so it is deliberately left at PDF.js's default (2^25) — setting it to
 * -1 turns the detail canvas off and zoomed pages go soft.
 *
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
  onDetailRendered as veOnDetailRendered,
  onTextLayerRendered as veOnTextLayerRendered,
  onThumbnailRendered as veOnThumbnailRendered,
  getCurrentMode,
  getState       as veGetState,
  applyState    as veApplyState,
} from '../transformations/visual-engine.js';
import { exportTransformedPdf, renderPagesForOutput } from '../transformations/pdf-export.js';
import {
  loadPrefs, savePrefs, PROFILES, getSiteAppearance, setSiteAppearance,
} from '../settings/preferences.js';
import { takeFile } from '../settings/handoff.js';

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

// ─── ?file= parsing ───────────────────────────────────────────────────────────
/**
 * Resolve the PDF URL from the viewer URL. Two forms exist:
 *   literal — written by the DNR redirect rule (it cannot percent-encode):
 *               viewer.html?file=https://h/a.pdf?X-Sig=1&Expires=2#page=3
 *   encoded — written by the popup:
 *               viewer.html?file=https%3A%2F%2Fh%2Fa.pdf%3FX-Sig%3D1%26Expires%3D2
 * The literal form must not go through URLSearchParams: it would end the value
 * at the first "&" and drop the rest of the signed query string. Everything
 * after "file=" belongs to the PDF URL (so keep file= last), and the fragment
 * (#page=3) is re-attached to it instead of staying on the viewer page.
 *
 * @returns {{url: string, fragment: string}} url has no #fragment
 */
function _resolveFileParam(search, hash) {
  const m = /[?&]file=/.exec(search);
  if (!m) return { url: '', fragment: '' };

  let url = search.slice(m.index + m[0].length);
  if (/^[a-z][a-z0-9+.-]*%3A/i.test(url)) {
    try { url = decodeURIComponent(url); } catch (_) { /* keep as-is */ }
  } else {
    url += hash;                       // literal form: the browser split the fragment off
  }

  const h = url.indexOf('#');
  return h < 0
    ? { url, fragment: '' }
    : { url: url.slice(0, h), fragment: url.slice(h + 1) };
}

/** Last path segment of a URL, without its query string or fragment. */
function _fileNameFromUrl(url) {
  let path = url;
  try { path = new URL(url).pathname; } catch (_) { path = url.split(/[?#]/)[0]; }
  let name = path.split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch (_) { /* keep raw */ }
  return name;
}

/**
 * Address types the viewer will fetch a PDF from. The ?file= value is whatever
 * the link said, so anything else (javascript:, data:, ftp:, chrome:, …) is
 * refused rather than handed to PDF.js. Relative or malformed values do not
 * parse as URLs and are refused too.
 */
const ALLOWED_PDF_SCHEMES = new Set(['http:', 'https:', 'file:', 'blob:']);

function _isAllowedPdfUrl(url) {
  try { return ALLOWED_PDF_SCHEMES.has(new URL(url).protocol); }
  catch (_) { return false; }
}

/**
 * Open the PDF. The request first carries the user's cookies/auth, so a PDF
 * behind a login (intranet, webmail, course portals) loads instead of coming
 * back as a login page or a 401/403. If that request fails at the NETWORK level
 * it is repeated once without credentials.
 *
 * Why the retry: a credentialed request is rejected by CORS whenever the server
 * answers with `Access-Control-Allow-Origin: *` — the norm for public PDFs and
 * CDNs — and the browser reports nothing but "Failed to fetch". That happens
 * whenever the extension lacks host access for the site (the user can restrict
 * it to "on click" / specific sites) and when the viewer is used from an ordinary
 * web page. Real answers — HTTP errors (401/403/404), an invalid PDF, a password
 * prompt — are not network failures and are not retried.
 */
async function _openPdf(options) {
  const attempt = withCredentials => {
    const task = pdfjsLib.getDocument({ ...options, withCredentials });
    return task.promise.catch(err => { task.destroy?.(); throw err; });
  };
  try {
    return await attempt(true);
  } catch (err) {
    if (!_isNetworkFailure(err)) throw err;
    return attempt(false);
  }
}

function _isNetworkFailure(err) {
  return err instanceof TypeError || err?.name === 'UnknownErrorException' ||
         /Failed to fetch|NetworkError|Load failed/i.test(err?.message || '');
}

let _initialPage = 0;
let _prefs = null;
let _localFile = null;      // {name, blob} when opened from the popup's picker / drop zone
let _siteHost = '';
let _sitePinned = false;

const LOCAL_FILES_KEY = 'local files';

/**
 * What a pinned look is keyed by: the hostname of an http(s) PDF, or one shared
 * "local files" entry for file:// PDFs and files picked in the popup.
 * '' (nothing to pin to) for anything else, such as blob: addresses.
 */
function _hostOf(url) {
  if (_localFile) return LOCAL_FILES_KEY;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
    if (u.protocol === 'file:') return LOCAL_FILES_KEY;
  } catch (_) { /* fall through */ }
  return '';
}

/** "Remember for this site": pin the current look to the PDF's website. */
function _setupSitePref() {
  const box   = document.getElementById('site-pref-toggle');
  const label = document.getElementById('site-pref-text');
  if (!box) return;
  if (!_siteHost) {
    box.disabled = true;
    if (label) label.textContent = 'Not available for this PDF';
    return;
  }
  box.disabled = false;
  box.checked = _sitePinned;
  if (label) {
    label.textContent = _siteHost === LOCAL_FILES_KEY
      ? 'Remember for local files'
      : `Remember for ${_siteHost}`;
  }
  box.addEventListener('change', () => {
    _sitePinned = box.checked;
    if (_sitePinned) {
      const { mode, brightness, contrast } = veGetState();
      setSiteAppearance(_siteHost, { mode, brightness, contrast });
    } else {
      setSiteAppearance(_siteHost, null);
    }
  });
}

/** Mark the profile chip whose mode and sliders match the current state (none if custom). */
function _highlightProfile({ mode, brightness, contrast }) {
  document.querySelectorAll('.profile-chip').forEach(chip => {
    const p = PROFILES[chip.dataset.profile];
    chip.classList.toggle('active',
      !!p && p.mode === mode && p.brightness === brightness && p.contrast === contrast);
  });
}

// ─── Initialise ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Integrated-GPU / low-end machines get the lighter visual treatment (see glass.css).
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4) {
    document.documentElement.classList.add('perf-lite');
  }

  // The error overlay's retry button. Wired here, before anything can fail:
  // an inline onclick="" attribute is blocked by the extension's CSP.
  document.getElementById('btn-error-retry')?.addEventListener('click', () => location.reload());

  // 1. Where the PDF comes from: a URL (?file=) or a file handed over by the popup (?idb=)
  const { url, fragment } = _resolveFileParam(window.location.search, window.location.hash);
  const idbKey = new URLSearchParams(window.location.search).get('idb');
  currentFileUrl = url;
  _initialPage = parseInt(new URLSearchParams(fragment).get('page'), 10) || 0;

  if (!currentFileUrl && idbKey) {
    try {
      _localFile = await takeFile(idbKey);
    } catch (err) {
      console.warn('[Nivra] Could not read the chosen file:', err);
    }
    if (!_localFile) {
      _showError('That file is no longer available. Choose it again from the Nivra popup.');
      return;
    }
  } else {
    if (!currentFileUrl) { _showError('No PDF file specified.'); return; }
    if (!_isAllowedPdfUrl(currentFileUrl)) {
      // Fixed text on purpose: never echo the rejected address back into the page.
      _showError('Nivra can only open PDFs from http, https, file or blob addresses.');
      return;
    }
  }

  // 2. Saved preferences (global, overridden by a pinned per-site appearance), then the engine
  _prefs = await loadPrefs();
  _sidebarOpen = _prefs.sidebar;
  _siteHost = _hostOf(currentFileUrl);
  const siteLook = await getSiteAppearance(_siteHost);
  _sitePinned = !!siteLook;
  const startLook = { ..._prefs, ...(siteLook || {}) };
  setupVisualEngine(startLook, state => {
    if (_sitePinned) setSiteAppearance(_siteHost, state);
    else savePrefs(state);
    _highlightProfile(state);
  });
  _highlightProfile(startLook);
  _setupSitePref();

  // 3. Set document title
  try {
    const fname  = _localFile?.name || _fileNameFromUrl(currentFileUrl) || 'Document';
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
    // ── Rendering quality ──────────────────────────────────────────────────
    // maxCanvasPixels is intentionally NOT set (default 2^25). That keeps
    // PDF.js's detail canvas enabled, which is what keeps zoomed-in pages
    // sharp without giant canvases. Smart Dark's photo-preservation overlay
    // follows it (see onDetailRendered in smart-dark/index.js).
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
    pdfViewer.currentScaleValue = _prefs?.scale || 'page-fit';
    _updateScaleUI(pdfViewer.currentScaleValue);
    if (_initialPage) {
      pdfViewer.currentPageNumber = Math.min(_initialPage, pdfViewer.pagesCount);
      _initialPage = 0;
    }
    _setTwoPageView(!!_prefs?.twoPage, { preservePage: true });
    _refreshThumbnailObservation();
  });

  eventBus.on('scalechanging', ({ presetValue, scale }) => {
    _updateScaleUI(presetValue || scale);
    savePrefs({ scale: String(presetValue || scale) });
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

    // PDF.js's full-resolution detail canvas (visible area only) fires its own
    // pagerendered. It is not a page render: it must not reset the page's
    // analysis, only refresh the sharp half of the photo overlay.
    if (evt.isDetailView) {
      if (pageEl && canvas) veOnDetailRendered(evt.pageNumber, pageEl, canvas);
      return;
    }

    if (viewport && pageEl && canvas) {
      veOnPageRendered(evt.pageNumber, viewport, pageEl, canvas);
    }
  });

  // The text layer renders AFTER the canvas (pagerendered). Smart Dark needs its
  // text boxes to tell "photo with a caption on it" from "photo", so it is told
  // the moment each text layer is ready instead of guessing with timers.
  eventBus.on('textlayerrendered', evt => {
    const pageEl = evt.source?.div ?? document.querySelector(
      `.pdfViewer .page[data-page-number="${evt.pageNumber}"]`
    );
    if (pageEl) veOnTextLayerRendered(evt.pageNumber, pageEl);
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
    const source = _localFile
      ? { data: new Uint8Array(await _localFile.blob.arrayBuffer()) }
      : { url: currentFileUrl };
    pdfDoc = await _openPdf({
      ...source,
      // Defence in depth: the extension CSP already forbids eval; this also stops
      // PDF.js from even trying the eval-based font fast path (and logging the block).
      isEvalSupported:     false,
      // Errors only. PDF.js otherwise logs a console warning for every quirk it works
      // around in a document's fonts (e.g. "TT: undefined function: 22"), which Chrome
      // and Edge then list under the extension's Errors. They are harmless.
      verbosity:           pdfjsLib.VerbosityLevel.ERRORS,
      standardFontDataUrl: pdfjsUrl + 'web/standard_fonts/',
      cMapUrl:             pdfjsUrl + 'web/cmaps/',
      cMapPacked:          true,
      // WASM image/colour decoders + CMYK ICC profile (copied by build.js).
      // Without these, JPEG2000 / JBIG2 images render blank and ICC colours are off.
      wasmUrl:             pdfjsUrl + 'web/wasm/',
      iccUrl:              pdfjsUrl + 'web/iccs/',
    });

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
    _buildOutline().catch(err => console.warn('[Nivra] Could not read the outline:', err));
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
  document.getElementById('btn-print')?.addEventListener('click', () => _printDocument());

  // ── Sidebar tabs / toolbar collapse ───────────────────────────────────────
  document.getElementById('tab-pages')?.addEventListener('click', () => _setSidebarTab('pages'));
  document.getElementById('tab-outline')?.addEventListener('click', () => _setSidebarTab('outline'));
  document.getElementById('btn-toolbar-collapse')?.addEventListener('click', () => {
    _setToolbarCollapsed(!document.getElementById('bottom-toolbar')?.classList.contains('is-collapsed'));
  });
  if (_prefs?.toolbarCollapsed) _setToolbarCollapsed(true);

  // ── Rotate ────────────────────────────────────────────────────────────────
  document.getElementById('btn-rotate')?.addEventListener('click', _rotateClockwise);

  // ── Profiles ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.profile-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = PROFILES[chip.dataset.profile];
      if (p) veApplyState(p);
    });
  });

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
    const inInput = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' ||
      active?.tagName === 'SELECT' || active?.isContentEditable;

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
      _updateScaleUI('page-fit');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      _printDocument();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      _setSidebarOpen(!_sidebarOpen);
    } else if (e.key === 'Escape') {
      _closePropertiesModal();
      _closeAll();
    } else if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      _rotateClockwise();
    } else if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.defaultPrevented) {
      const next = e.key === 'ArrowDown' || e.key === 'PageDown';
      const prev = e.key === 'ArrowUp'   || e.key === 'PageUp';
      // Only while the viewer itself has focus: with focus on the thumbnail list
      // or a toolbar control these keys keep their normal meaning.
      if ((next || prev) && _viewerHasFocus(active)) {
        // These keys step one page. Without preventDefault the browser ALSO
        // scrolls the container by its own amount, so every press moved twice.
        e.preventDefault();
        document.getElementById(next ? 'btn-page-next' : 'btn-page-prev')?.click();
      }
    }
  });
}

/**
 * Does the viewer itself have keyboard focus — the page / PDF scroll area, or
 * nothing in particular — as opposed to a toolbar control, thumbnail or field?
 */
function _viewerHasFocus(active) {
  const container = document.getElementById('viewerContainer');
  return !active || active === document.body || active === document.documentElement ||
         active === container || !!container?.contains(active);
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
  savePrefs({ sidebar: _sidebarOpen });
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
      // A positioned box the size of the canvas: Smart Dark lays its photo overlay in it.
      const stack = document.createElement('div');
      stack.className = 'thumb-stack';
      stack.append(canvas);
      canvasWrap.replaceChildren(stack);

      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({
        canvasContext: ctx,
        viewport: cssViewport,
        transform: renderTransform,
      }).promise;

      // Release the page's parsed operator list and decoded resources now that the
      // thumbnail is drawn. Without this every thumbnail kept its page's data alive
      // for the life of the document, so memory grew with each page scrolled past.
      // (PDF.js skips the cleanup while a main-view render of the page is running.)
      page.cleanup();

      if (itemEl) itemEl.dataset.rendered = 'true';
      veOnThumbnailRendered(pageNumber);
    } catch (err) {
      console.warn(`[Nivra] Failed to render thumbnail for page ${pageNumber}:`, err);
      const note = document.createElement('div');
      note.className = 'thumbnail-placeholder';
      note.textContent = 'Preview unavailable';
      canvasWrap.replaceChildren(note);
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
  savePrefs({ twoPage: _twoPageView });
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

/** Rotate every page 90° clockwise for this session (the file is never changed). */
function _rotateClockwise() {
  if (!pdfViewer) return;
  pdfViewer.pagesRotation = (pdfViewer.pagesRotation + 90) % 360;
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

  // Unknown: say so. The old fallback called pdfDoc.getData(), which makes PDF.js
  // pull the whole file (every range it had not fetched yet) just to read a length.
  return '—';
}

function _resolveFileName(meta) {
  return _firstNonEmpty(
    meta?.contentDispositionFilename,
    _localFile?.name,
    _fileNameFromUrl(currentFileUrl),
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
const MODE_LABELS = {
  'smart-dark':    'Smart Dark',
  'true-invert':   'True Invert',
  'grayscale':     'Grayscale',
  'high-contrast': 'High Contrast',
  'original':      'Original',
};
let _exporting = false;

async function _downloadTransformed() {
  if (!pdfDoc || _exporting) return;
  _exporting = true;

  const btn = document.getElementById('btn-download');
  const idleTitle = btn?.title || '';
  btn?.classList.add('is-busy');

  try {
    const blob = await exportTransformedPdf(pdfDoc, {
      onProgress: (done, total) => { if (btn) btn.title = `Exporting page ${done} of ${total}…`; },
    });

    const base = (document.getElementById('document-title')?.textContent || 'document')
      .replace(/\.pdf$/i, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim() || 'document';
    const label = MODE_LABELS[getCurrentMode()] || 'Transformed';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base} - ${label} (Nivra).pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    console.error('[Nivra] Export failed:', err);
    alert('Could not export the PDF: ' + (err?.message || err));
  } finally {
    _exporting = false;
    btn?.classList.remove('is-busy');
    if (btn) btn.title = idleTitle;
  }
}

// ─── Print ────────────────────────────────────────────────────────────────────
// window.print() on the live viewer would print the toolbar plus whichever
// pages PDF.js currently has in the DOM. Instead every page is rendered
// offscreen into a print-only container (#nivra-print); @media print in
// input.css hides everything else. Pages are rendered in the CURRENT mode with
// the current brightness/contrast, exactly as on screen (same filters, dark
// pages skipped, photos restored), at ~150 dpi. Switch to Original first for an
// ink-friendly printout.
const PRINT_SCALE    = 2.083;   // 72 pt × 2.083 ≈ 150 dpi
const PRINT_MAX_SIDE = 3000;    // px, longest side
let _printing = false;

async function _printDocument() {
  if (!pdfDoc || _printing) return;
  _printing = true;

  const toast = _showToast('Preparing pages for print…');
  const urls = [];
  let container = null, sheet = null;
  const cleanup = () => {
    container?.remove();
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));
    container = sheet = null;
    toast.hide();
    _printing = false;
  };

  try {
    // mode / brightness / contrast default to the live viewer state.
    const pages = await renderPagesForOutput(pdfDoc, {
      maxScale: PRINT_SCALE,
      maxSidePx: PRINT_MAX_SIDE,
      onProgress: (done, total) => toast.update(`Preparing page ${done} of ${total}…`),
    });

    // One named @page per distinct page size, so mixed portrait / landscape /
    // custom-size documents each print on a correctly sized sheet.
    container = document.createElement('div');
    container.id = 'nivra-print';
    const names = new Map();
    let rules = '@page { margin: 0; }\n';
    const imgs = pages.map(({ blob, pt }) => {
      const key = `${Math.round(pt[0] * 100)}x${Math.round(pt[1] * 100)}`;
      let name = names.get(key);
      if (!name) {
        name = `nivra-p${names.size}`;
        names.set(key, name);
        rules += `@page ${name} { size: ${pt[0].toFixed(2)}pt ${pt[1].toFixed(2)}pt; margin: 0; }\n` +
                 `.${name} { page: ${name}; }\n`;
      }
      const url = URL.createObjectURL(blob);
      urls.push(url);

      const wrap = document.createElement('div');
      wrap.className = `nivra-print-page ${name}`;
      wrap.style.width  = `${pt[0].toFixed(2)}pt`;
      wrap.style.height = `${pt[1].toFixed(2)}pt`;
      const img = new Image();
      img.alt = '';
      img.src = url;
      wrap.appendChild(img);
      container.appendChild(wrap);
      return img;
    });

    // A constructable stylesheet, not a <style> element: an inserted <style> would need
    // style-src 'unsafe-inline' in the extension CSP, a constructed sheet does not.
    sheet = new CSSStyleSheet();
    sheet.replaceSync(rules);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    document.body.appendChild(container);

    // The print preview must not be taken before every bitmap is decoded.
    await Promise.all(imgs.map(img => img.decode().catch(() => {})));
    toast.hide();

    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();            // blocks until the dialog closes in Chromium
    cleanup();                 // idempotent; afterprint may already have run
  } catch (err) {
    console.error('[Nivra] Print failed:', err);
    cleanup();
    alert('Could not prepare the document for printing: ' + (err?.message || err));
  }
}

/** Small transient status pill (styled in glass.css). */
function _showToast(text) {
  const el = document.createElement('div');
  el.className = 'nivra-toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  return {
    update: t => { el.textContent = t; },
    hide: () => { el.classList.remove('is-visible'); setTimeout(() => el.remove(), 400); },
  };
}

// ─── Outline (bookmarks) ──────────────────────────────────────────────────────
async function _buildOutline() {
  const outline = await pdfDoc?.getOutline();
  const tab  = document.getElementById('tab-outline');
  const list = document.getElementById('outline-list');
  if (!tab || !list || !outline?.length) return;   // no bookmarks: the tab stays disabled

  list.replaceChildren(_outlineItems(outline, 0));
  tab.disabled = false;
}

function _outlineItems(items, depth) {
  const ul = document.createElement('ul');
  ul.className = 'outline-level';
  for (const item of items) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'outline-row';
    row.style.setProperty('--depth', depth);

    const hasKids = item.items?.length > 0;
    const twist = document.createElement('button');
    twist.type = 'button';
    twist.className = 'outline-twist';
    twist.setAttribute('aria-label', 'Expand section');
    twist.setAttribute('aria-expanded', 'false');
    twist.textContent = hasKids ? '›' : '';
    twist.disabled = !hasKids;

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'outline-link';
    link.textContent = item.title?.trim() || 'Untitled';
    link.title = link.textContent;
    if (item.bold) link.classList.add('is-bold');
    if (item.italic) link.classList.add('is-italic');
    link.addEventListener('click', () => _followOutlineItem(item));

    row.append(twist, link);
    li.append(row);

    if (hasKids) {
      const kids = _outlineItems(item.items, depth + 1);
      kids.hidden = true;
      li.append(kids);
      twist.addEventListener('click', () => {
        kids.hidden = !kids.hidden;
        twist.setAttribute('aria-expanded', String(!kids.hidden));
        li.classList.toggle('is-open', !kids.hidden);
      });
    }
    ul.append(li);
  }
  return ul;
}

function _followOutlineItem(item) {
  if (item.dest) {
    pdfLinkService.goToDestination(item.dest);
  } else if (item.url && /^https?:\/\//i.test(item.url)) {
    window.open(item.url, '_blank', 'noopener,noreferrer');
  }
}

function _setSidebarTab(which) {
  const outline = which === 'outline';
  document.getElementById('thumbnail-scroll').hidden = outline;
  document.getElementById('outline-scroll').hidden = !outline;
  for (const [id, active] of [['tab-pages', !outline], ['tab-outline', outline]]) {
    const tab = document.getElementById(id);
    tab?.classList.toggle('is-active', active);
    tab?.setAttribute('aria-selected', String(active));
  }
  if (!outline) _refreshThumbnailObservation();
}

// ─── Bottom toolbar collapse ──────────────────────────────────────────────────
function _setToolbarCollapsed(collapsed) {
  const bar = document.getElementById('bottom-toolbar');
  const btn = document.getElementById('btn-toolbar-collapse');
  if (!bar || !btn) return;
  if (collapsed) _closeAll();
  bar.classList.toggle('is-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Expand toolbar' : 'Collapse toolbar';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  savePrefs({ toolbarCollapsed: collapsed });
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
