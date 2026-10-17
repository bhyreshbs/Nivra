/**
 * Nivra — Transformed PDF export
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces a real, multi-page PDF file (no popup, no print dialog) that looks
 * like the viewer does with the current mode + brightness/contrast.
 *
 *   for every page of the document (not just the ones currently on screen):
 *     1. render the page offscreen with PDF.js at ~180 dpi
 *     2. apply the active mode's filter via CanvasRenderingContext2D.filter
 *        (Smart Dark also skips already-dark pages and restores photographs)
 *     3. encode as JPEG
 *   then wrap the JPEGs in a minimal PDF whose page size matches the source
 *   page (in PDF points), so nothing is stretched or split across sheets.
 *
 * Trade-off: pages are raster images, so the exported file has no selectable
 * text. The original document is never modified.
 *
 * The same page renderer feeds printing (renderPagesForOutput): print needs
 * every page too, not just the ones PDF.js happens to have in the DOM.
 */

import { getCurrentMode, getAdjustments, getModeFilter } from './visual-engine.js';
import { getExportDecision } from './smart-dark/index.js';
import { buildSmartDarkFilter } from './smart-dark/fallback.js';

const MAX_SCALE   = 2.5;    // 72 pt × 2.5 = 180 dpi
const MAX_SIDE_PX = 3200;   // keeps huge pages (posters, maps) within canvas limits
const JPEG_QUALITY = 0.92;

/**
 * @param {PDFDocumentProxy} pdfDoc
 * @param {{onProgress?: (done:number,total:number)=>void}} [opts]
 * @returns {Promise<Blob>} application/pdf
 */
export async function exportTransformedPdf(pdfDoc, { onProgress } = {}) {
  const mode = getCurrentMode();
  const { brightness, contrast } = getAdjustments();
  const pages = await renderPagesForOutput(pdfDoc, { mode, brightness, contrast, onProgress });
  return _buildPdf(pages);
}

/**
 * Render EVERY page of the document offscreen (PDF.js only keeps the visible
 * ones in the DOM) and encode each as a JPEG.
 *
 * @param {PDFDocumentProxy} pdfDoc
 * @param {Object}   [opts]
 * @param {string}   [opts.mode]        — defaults to the active mode
 * @param {number}   [opts.brightness]  — defaults to the slider value
 * @param {number}   [opts.contrast]    — defaults to the slider value
 * @param {number}   [opts.maxScale]    — render scale cap (72 pt × scale = dpi)
 * @param {number}   [opts.maxSidePx]   — longest-side cap, in pixels
 * @param {number}   [opts.quality]     — JPEG quality 0..1
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Array<{blob:Blob, px:number[], pt:number[]}>>}
 *          px = bitmap size, pt = page size in PDF points
 */
export async function renderPagesForOutput(pdfDoc, {
  mode       = getCurrentMode(),
  brightness = getAdjustments().brightness,
  contrast   = getAdjustments().contrast,
  maxScale   = MAX_SCALE,
  maxSidePx  = MAX_SIDE_PX,
  quality    = JPEG_QUALITY,
  onProgress,
} = {}) {
  const pages = [];

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    onProgress?.(n, pdfDoc.numPages);

    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxScale, maxSidePx / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });

    const src = document.createElement('canvas');
    src.width  = Math.ceil(viewport.width);
    src.height = Math.ceil(viewport.height);
    await page.render({
      canvasContext: src.getContext('2d', { alpha: false }),
      viewport,
    }).promise;

    const out = document.createElement('canvas');
    out.width  = src.width;
    out.height = src.height;
    await _paint(out.getContext('2d', { alpha: false }), src, page, viewport, mode, brightness, contrast);

    const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error(`Could not encode page ${n}`);
    pages.push({ blob, px: [out.width, out.height], pt: [base.width, base.height] });

    // Release the big bitmaps before the next page.
    src.width = src.height = out.width = out.height = 0;
    page.cleanup();
  }

  return pages;
}

// ─── Painting ─────────────────────────────────────────────────────────────────

async function _paint(ctx, src, page, viewport, mode, brightness, contrast) {
  if (mode === 'original') {
    ctx.drawImage(src, 0, 0);
    return;
  }

  if (mode === 'smart-dark') {
    const { pageClass, quads } = await getExportDecision(page, src, viewport);
    if (pageClass === 'dark-bg') {            // on screen these pages are left alone
      ctx.drawImage(src, 0, 0);
      return;
    }
    ctx.filter = buildSmartDarkFilter(brightness, contrast);
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    // Photographs: paint the untouched pixels back, clipped to each image quad.
    for (const { points } of quads) {
      if (!points?.length) continue;
      ctx.save();
      ctx.beginPath();
      points.forEach(({ x, y }, i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(src, 0, 0);
      ctx.restore();
    }
    return;
  }

  const parts = [
    getModeFilter(mode),
    brightness !== 100 ? `brightness(${brightness / 100})` : '',
    contrast   !== 100 ? `contrast(${contrast / 100})`     : '',
  ].filter(Boolean);
  if (parts.length) ctx.filter = parts.join(' ');
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
}

// ─── Minimal PDF writer (one full-page JPEG per page) ─────────────────────────
//
//   1 Catalog · 2 Pages · then for page i (0-based):
//   3+3i Page · 4+3i content stream · 5+3i image XObject

function _buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;

  const push = data => {
    if (data instanceof Blob) { chunks.push(data); length += data.size; return; }
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const begin = id => { offsets[id] = length; push(`${id} 0 obj\n`); };
  const num = v => (Math.round(v * 100) / 100).toString();

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,   // %PDF-1.4
                       0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));                    // binary marker

  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  begin(2); push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach(({ blob, px, pt }, i) => {
    const pageId = 3 + 3 * i, contentId = 4 + 3 * i, imageId = 5 + 3 * i;
    const [w, h] = [num(pt[0]), num(pt[1])];

    begin(pageId);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
         `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);

    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    begin(contentId);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

    begin(imageId);
    push(`<< /Type /XObject /Subtype /Image /Width ${px[0]} /Height ${px[1]} ` +
         `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${blob.size} >>\nstream\n`);
    push(blob);
    push('\nendstream\nendobj\n');
  });

  const objectCount = 2 + 3 * pages.length;
  const xrefAt = length;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objectCount; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref + `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
