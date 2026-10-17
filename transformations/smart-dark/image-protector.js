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

/** The detail overlay carries OVERLAY_CLASS too, so every "is this ours?" check covers both. */
export const DETAIL_OVERLAY_CLASS = 'nivra-detail-overlay';

/*
 * ─── Zoomed-in pages: two layers ─────────────────────────────────────────────
 * When a page is zoomed past PDF.js's canvas-size cap, PDF.js renders the page
 * canvas at reduced resolution and lays a second, full-resolution "detail"
 * canvas over the visible area only. A photo overlay copied from the main canvas
 * alone would then sit, blurry, on top of crisp detail. So there are two:
 *
 *   base overlay   — copied from the main canvas; covers every photo on the page
 *                    (at the main canvas's resolution)
 *   detail overlay — copied from the detail canvas; same position and size as it,
 *                    so photos in view are restored at full resolution
 *
 * Both carry the counter filter. The detail overlay is later in the DOM, so it
 * paints above the base one.
 */

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
  removeImageOverlay(pageEl);   // removes the detail overlay too: it is rebuilt by the caller

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
  overlay.style.cssText = _overlayCss('top:0;left:0;width:100%;height:100%', counterFilter);

  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  if (!_paintRegions(ctx, mainCanvas, regions, 0, 0, dprX, dprY)) return;

  // Inside .canvasWrapper, right after the main canvas → above the canvas,
  // below textLayer/annotationLayer, clipped by the wrapper's overflow:hidden.
  wrapper.appendChild(overlay);
}

/**
 * Create the full-resolution half of the overlay from PDF.js's detail canvas.
 * Same arguments as updateImageOverlay, with the detail canvas as the source.
 * Replaces any previous detail overlay; leaves the base overlay alone.
 */
export function updateDetailOverlay(pageEl, detailCanvas, regions, viewport, counterFilter) {
  pageEl?.querySelector(`.${DETAIL_OVERLAY_CLASS}`)?.remove();

  const wrapper = pageEl?.querySelector('.canvasWrapper');
  if (!wrapper || !regions.length || !detailCanvas?.width || !detailCanvas?.height) return;
  if (!viewport?.width || !viewport?.height) return;

  // Where the detail canvas sits on the page, in the viewport's CSS px. PDF.js
  // positions it as percentages of the page box, so measure it as a FRACTION of
  // the wrapper: that stays exact even while a CSS zoom transform is in flight.
  const w = wrapper.getBoundingClientRect();
  const d = detailCanvas.getBoundingClientRect();
  if (!w.width || !w.height || !d.width || !d.height) return;
  const fx = (d.left - w.left) / w.width,  fy = (d.top - w.top) / w.height;
  const fw = d.width / w.width,            fh = d.height / w.height;

  const originX = fx * viewport.width,  originY = fy * viewport.height;
  const dprX = detailCanvas.width  / (fw * viewport.width);
  const dprY = detailCanvas.height / (fh * viewport.height);
  if (!(dprX > 0) || !(dprY > 0)) return;

  const overlay = document.createElement('canvas');
  overlay.className = `${OVERLAY_CLASS} ${DETAIL_OVERLAY_CLASS}`;
  overlay.width  = detailCanvas.width;
  overlay.height = detailCanvas.height;
  overlay.style.cssText = _overlayCss(
    `left:${fx * 100}%;top:${fy * 100}%;width:${fw * 100}%;height:${fh * 100}%`, counterFilter);

  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  if (!_paintRegions(ctx, detailCanvas, regions, originX, originY, dprX, dprY)) return;

  wrapper.appendChild(overlay);   // after the base overlay → paints above it
}

/**
 * Remove every image overlay (base + detail) from a single page.
 */
export function removeImageOverlay(pageEl) {
  pageEl?.querySelectorAll(`.${OVERLAY_CLASS}`).forEach(el => el.remove());
}

/**
 * Remove all image overlays from all pages in the document.
 */
export function removeAllImageOverlays() {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach(el => el.remove());
}

// ─── Internal ────────────────────────────────────────────────────────────────

function _overlayCss(box, counterFilter) {
  return [
    'position:absolute',
    box,
    'pointer-events:none',
    // Follows brightness/contrast live via the variable Smart Dark publishes on
    // #viewerWrapper; the literal is only a fallback for the first paint.
    `filter:var(--nivra-counter-filter, ${counterFilter})`,
  ].join(';');
}

/**
 * Copy each image quad from `source` into `ctx` (same pixel size as source).
 * Quad points are CSS px in viewport space; (originX, originY) is where the
 * source canvas starts in that space and dprX/dprY are its pixels per CSS px.
 * The exact clip path removes the ghost edges a rounded bounding-box blit leaves.
 *
 * @returns {boolean} whether anything was painted
 */
function _paintRegions(ctx, source, regions, originX, originY, dprX, dprY) {
  let painted = false;
  for (const { points } of regions) {
    if (!points?.length) continue;

    const quad = points.map(({ x, y }) => ({
      x: (x - originX) * dprX,
      y: (y - originY) * dprY,
    }));

    const minX = Math.min(...quad.map(p => p.x));
    const minY = Math.min(...quad.map(p => p.y));
    const maxX = Math.max(...quad.map(p => p.x));
    const maxY = Math.max(...quad.map(p => p.y));

    const sx = Math.max(0, Math.floor(minX) - 1);
    const sy = Math.max(0, Math.floor(minY) - 1);
    const ex = Math.min(source.width, Math.ceil(maxX) + 1);
    const ey = Math.min(source.height, Math.ceil(maxY) + 1);
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw <= 0 || sh <= 0) continue;     // this quad is outside the source canvas

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(source, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
    painted = true;
  }
  return painted;
}
