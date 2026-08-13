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
 * @param {Array<{points:Array<{x:number,y:number}>,bounds:{x:number,y:number,width:number,height:number}}>} regions
 *                                          — exact image quads in CSS px (viewport space)
 * @param {PageViewport}      viewport      — viewport used for this render
 * @param {string}            counterFilter — exact inverse of the wrapper filter
 */
export function updateImageOverlay(pageEl, mainCanvas, regions, viewport, counterFilter) {
  removeImageOverlay(pageEl);

  const wrapper = pageEl?.querySelector('.canvasWrapper');
  if (!wrapper || !regions.length || !mainCanvas?.width || !mainCanvas?.height) return;
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
  for (const { points } of regions) {
    if (!points?.length) continue;

    const quad = points.map(({ x, y }) => ({
      x: x * dprX,
      y: y * dprY,
    }));

    const minX = Math.min(...quad.map(p => p.x));
    const minY = Math.min(...quad.map(p => p.y));
    const maxX = Math.max(...quad.map(p => p.x));
    const maxY = Math.max(...quad.map(p => p.y));

    const sx = Math.max(0, Math.floor(minX) - 1);
    const sy = Math.max(0, Math.floor(minY) - 1);
    const ex = Math.min(mainCanvas.width, Math.ceil(maxX) + 1);
    const ey = Math.min(mainCanvas.height, Math.ceil(maxY) + 1);
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw <= 0 || sh <= 0) continue;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i += 1) {
      ctx.lineTo(quad[i].x, quad[i].y);
    }
    ctx.closePath();
    ctx.clip();

    // Copy from the same physical pixel space as the PDF.js canvas while the
    // exact clip path eliminates ghost edges from rounded bounding-box blits.
    ctx.drawImage(mainCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
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
