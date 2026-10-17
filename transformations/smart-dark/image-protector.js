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
 * Each overlay is sized to the UNION BOUNDS of the image regions it carries —
 * not to the whole page — and positioned with CSS percentages of the page box.
 * A page with one small photo therefore costs a small canvas instead of a second
 * page-sized bitmap (about 5 MB per page at 100% on a 1080p screen, double on
 * HiDPI, and doubled again on zoomed pages that carry two layers). Source pixels
 * are copied 1:1, so the placement is exact:
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

  // The main canvas fills the whole page box.
  const overlay = _buildOverlay(mainCanvas, regions, 0, 0, dprX, dprY,
    { x: 0, y: 0, w: 1, h: 1 }, OVERLAY_CLASS, counterFilter);

  // Inside .canvasWrapper, right after the main canvas → above the canvas,
  // below textLayer/annotationLayer, clipped by the wrapper's overflow:hidden.
  if (overlay) wrapper.appendChild(overlay);
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

  const overlay = _buildOverlay(detailCanvas, regions, originX, originY, dprX, dprY,
    { x: fx, y: fy, w: fw, h: fh }, `${OVERLAY_CLASS} ${DETAIL_OVERLAY_CLASS}`, counterFilter);
  if (overlay) wrapper.appendChild(overlay);   // after the base overlay → paints above it
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
 * Build one overlay canvas from `source`, sized to the union bounds of the image
 * quads (clamped to the source) and positioned over the page with CSS percentages.
 *
 * Quad points are CSS px in viewport space; (originX, originY) is where the
 * source canvas starts in that space and dprX/dprY are its pixels per CSS px.
 * `box` is where the source canvas sits on the page, as fractions of the page box
 * ({x:0,y:0,w:1,h:1} for the main canvas). Pixels are copied 1:1, and the exact
 * clip path removes the ghost edges a rounded bounding-box blit leaves.
 *
 * @returns {HTMLCanvasElement|null} null when no quad touches the source
 */
function _buildOverlay(source, regions, originX, originY, dprX, dprY, box, className, counterFilter) {
  // 1. Which quads land inside the source, and the union of their pixel bounds.
  const items = [];
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
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
    if (ex - sx <= 0 || ey - sy <= 0) continue;     // this quad is outside the source canvas

    items.push({ quad, sx, sy, ex, ey });
    ux0 = Math.min(ux0, sx);  uy0 = Math.min(uy0, sy);
    ux1 = Math.max(ux1, ex);  uy1 = Math.max(uy1, ey);
  }
  if (!items.length) return null;

  // 2. A canvas of exactly that size — everything outside it would be transparent anyway.
  const w = ux1 - ux0, h = uy1 - uy0;
  const overlay = document.createElement('canvas');
  overlay.className = className;
  overlay.width  = w;
  overlay.height = h;
  const ctx = overlay.getContext('2d');
  if (!ctx) return null;

  for (const { quad, sx, sy, ex, ey } of items) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(quad[0].x - ux0, quad[0].y - uy0);
    for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i].x - ux0, quad[i].y - uy0);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(source, sx, sy, ex - sx, ey - sy, sx - ux0, sy - uy0, ex - sx, ey - sy);
    ctx.restore();
  }

  // 3. Put it back where those pixels came from: its offset and size, as
  //    fractions of the page box.
  const pct = v => `${v * 100}%`;
  overlay.style.cssText = _overlayCss([
    `left:${pct(box.x + (ux0 / source.width) * box.w)}`,
    `top:${pct(box.y + (uy0 / source.height) * box.h)}`,
    `width:${pct((w / source.width) * box.w)}`,
    `height:${pct((h / source.height) * box.h)}`,
  ].join(';'), counterFilter);
  return overlay;
}
