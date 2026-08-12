/**
 * Smart Dark Image Protector
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates and manages a transparent overlay canvas per PDF page that restores
 * PHOTOGRAPHIC image regions to their original appearance while Smart Dark
 * is active.
 *
 * ─── How it works ────────────────────────────────────────────────────────────
 * Smart Dark applies its filter to the page's `.canvasWrapper` (per page —
 * never to the whole viewer). The overlay canvas lives INSIDE the same
 * `.canvasWrapper`, directly above the main canvas, and carries the exact
 * inverse filter chain:
 *
 *   overlay pixels:  F_wrapper( F_overlay( original_pixels ) )
 *                  = F( F⁻¹(pixels) ) ≈ original            → preserved image
 *   elsewhere:       F_wrapper( PDF_canvas_pixels )          → Smart Dark
 *
 * Because the overlay only contains blitted image regions (transparent
 * elsewhere), exactly the image pixels are counter-transformed — no double
 * transformation of anything else.
 *
 * ─── Geometry ────────────────────────────────────────────────────────────────
 * The overlay matches the main canvas's PHYSICAL pixels (canvas.width/height)
 * and, via the `.canvasWrapper canvas { width:100%; height:100% }` rule in
 * pdf_viewer.css, its CSS box automatically matches the page box at every
 * zoom level. Source blit coordinates come from:
 *
 *   physical = css × dpr,   dpr = canvas.width / viewport.width
 *
 * viewport.width/height are CSS pixels — this is exact for any zoom and any
 * devicePixelRatio, and never relies on inline canvas styles (PDF.js v6 sizes
 * canvases via stylesheet, not inline styles).
 *
 * ─── Failure policy ──────────────────────────────────────────────────────────
 * If the canvas wrapper, canvas, viewport or rects cannot be resolved, NO
 * overlay is created. A missing overlay degrades to "image inverts with the
 * page" — never to a misaligned box on top of the document.
 */

export const OVERLAY_CLASS = 'nivra-image-overlay';

/**
 * Create or update the image overlay for a single page.
 *
 * @param {Element}           pageEl        — the .page div
 * @param {HTMLCanvasElement} mainCanvas    — PDF.js main canvas (physical px)
 * @param {Array<{x,y,width,height}>} rects — image boxes in CSS px (viewport space)
 * @param {PageViewport}      viewport      — viewport used for this render
 * @param {string}            counterFilter — exact inverse of the wrapper filter
 */
export function updateImageOverlay(pageEl, mainCanvas, rects, viewport, counterFilter) {
  removeImageOverlay(pageEl);

  const wrapper = pageEl?.querySelector('.canvasWrapper');
  if (!wrapper || !rects.length || !mainCanvas?.width || !mainCanvas?.height) return;
  if (!viewport?.width || !viewport?.height) return;

  // Exact physical/CSS ratio for THIS render (any zoom, any DPR).
  const dprX = mainCanvas.width  / viewport.width;
  const dprY = mainCanvas.height / viewport.height;
  if (!(dprX > 0) || !(dprY > 0)) return;

  const overlay = document.createElement('canvas');
  overlay.className = OVERLAY_CLASS;
  overlay.width  = mainCanvas.width;
  overlay.height = mainCanvas.height;
  // CSS size: inset:0 + width/height:100% via stylesheet (.canvasWrapper canvas).
  overlay.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    `filter:${counterFilter}`,
  ].join(';');

  const ctx = overlay.getContext('2d');
  if (!ctx) return;

  let painted = false;
  for (const { x, y, width, height } of rects) {
    const sx = Math.round(x * dprX);
    const sy = Math.round(y * dprY);
    const sw = Math.round(width  * dprX);
    const sh = Math.round(height * dprY);

    const cx = Math.max(0, Math.min(sx, mainCanvas.width));
    const cy = Math.max(0, Math.min(sy, mainCanvas.height));
    const cw = Math.max(0, Math.min(sw, mainCanvas.width  - cx));
    const ch = Math.max(0, Math.min(sh, mainCanvas.height - cy));
    if (cw <= 0 || ch <= 0) continue;

    // Source = destination: the same physical rect on the main canvas.
    ctx.drawImage(mainCanvas, cx, cy, cw, ch, cx, cy, cw, ch);
    painted = true;
  }

  if (!painted) return;

  // Inside .canvasWrapper, right after the main canvas → above the canvas,
  // below textLayer/annotationLayer, clipped by the wrapper's overflow:hidden.
  wrapper.appendChild(overlay);
}

/**
 * Remove the image overlay from a single page.
 */
export function removeImageOverlay(pageEl) {
  pageEl?.querySelector(`.${OVERLAY_CLASS}`)?.remove();
}

/**
 * Remove all image overlays from all pages in the document.
 */
export function removeAllImageOverlays() {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach(el => el.remove());
}
