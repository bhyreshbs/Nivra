/**
 * Smart Dark Page Analyzer — pixel-level content classification
 * ─────────────────────────────────────────────────────────────────────────────
 * Complements operator-analyzer.js (structure) with cheap pixel evidence from the
 * rendered canvas. The canvas is read ONCE per analysis: a downscaled snapshot
 * (256 px wide, one drawImage + one getImageData). Page-level and per-image
 * statistics are then computed from that CPU copy, so the cost no longer grows
 * with the number of images on the page (it used to be one temporary canvas and
 * one GPU readback per image). Nothing is ever written back to the displayed
 * canvas, so rendering sharpness is untouched.
 *
 * Classifications
 * ───────────────
 * Page level:
 *   'normal'   — light document background → apply Smart Dark inversion
 *   'dark-bg'  — page background already dark → skip inversion entirely
 *   'scanned'  — one image covers ≥ 85% of the page and there is little text
 *                → invert as a unit, but do NOT carve image overlays out of it
 *
 * Image level (per detected image rect):
 *   'photographic'    — preserve via overlay
 *   'document-like'   — invert with the page
 *   'content-underlay'— invert with the page because actual text/vector content
 *                       overlaps the image and must stay visually coherent
 *
 * Results are cached per page and reused across zoom/mode toggles.
 */

/** Page background luminance below this → already dark, skip inversion. */
const DARK_BG_LUMINANCE = 0.35;

/** A painted fill covering ≥ this fraction of the page counts as the page background. */
const BG_FILL_FRACTION = 0.8;

/** Image covering ≥ this fraction of the page area → scanned-page candidate. */
const SCANNED_AREA_FRACTION = 0.85;

/** Page with fewer text ops than this + a page-covering image → scanned. */
const SCANNED_MAX_TEXT_OPS = 8;

/** Image region: fraction of near-white pixels above this → document-like. */
const DOC_LIKE_WHITE_FRACTION = 0.55;

/** Image region: mean saturation below this → not vividly colored. */
const DOC_LIKE_MAX_SATURATION = 0.18;

/** Width of the per-page pixel snapshot, in px (height follows the page's aspect). */
const SNAPSHOT_WIDTH = 256;

/** Resolution the snapshot is box-averaged to for statistics (same as the old probes). */
const PAGE_PROBE_SIZE   = 64;   // whole page
const REGION_PROBE_SIZE = 24;   // one image

/**
 * Snapshots are only needed while a page is being (re)decided — a provisional
 * decision is redone once its text layer arrives — so only a few are kept
 * (256 px wide ≈ 0.3 MB each) instead of one per page for the whole document.
 */
const SNAPSHOT_CACHE_MAX = 6;

// pageNumber → Snapshot, insertion-ordered so the oldest entry is evicted first
const _snapshotCache = new Map();

export function clearProbeCache() { _snapshotCache.clear(); }

/**
 * @typedef {Object} RegionStats
 * @property {number} luminance   — mean luminance 0..1
 * @property {number} whiteFrac   — fraction of pixels with lum > 0.92
 * @property {number} darkFrac    — fraction of pixels with lum < 0.08
 * @property {number} saturation  — mean HSV-ish saturation 0..1
 * @property {number} colorfulFrac— fraction of pixels with sat > 0.25 and mid luminance
 */

/**
 * @typedef {Object} Snapshot
 * @property {Uint8ClampedArray} data   — RGBA, width × height, on the CPU
 * @property {number} width
 * @property {number} height
 * @property {number} srcWidth          — size, in canvas px, of the canvas it was taken from:
 * @property {number} srcHeight           probeRegion() coordinates are in that space
 */

/**
 * Take a downscaled CPU copy of a rendered canvas: ONE drawImage and ONE
 * getImageData, regardless of how many regions are sampled from it later.
 * Not cached — use snapshotPage() for the on-screen page.
 *
 * NOTE: requires the canvas to be fully rendered — call after `pagerendered`.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Snapshot|null}  null for an empty or tainted canvas
 */
export function takeSnapshot(canvas) {
  try {
    if (!canvas?.width || !canvas?.height) return null;
    const width  = Math.min(SNAPSHOT_WIDTH, canvas.width);
    const height = Math.max(1, Math.round(canvas.height * width / canvas.width));

    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';   // mip-mapped: a real area average for big reductions
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    tmp.width = tmp.height = 0;           // release the scratch bitmap
    return { data, width, height, srcWidth: canvas.width, srcHeight: canvas.height };
  } catch (_) {
    return null;                          // tainted canvas or OOM — callers fall back safely
  }
}

/**
 * Snapshot of an on-screen page, kept for a short while. A cached snapshot is
 * only reused for a canvas of the same pixel size (a zoom re-render changes it).
 *
 * @param {number}            pageNumber
 * @param {HTMLCanvasElement} canvas
 * @returns {Snapshot|null}
 */
export function snapshotPage(pageNumber, canvas) {
  const hit = _snapshotCache.get(pageNumber);
  if (hit && hit.srcWidth === canvas?.width && hit.srcHeight === canvas?.height) return hit;

  const snap = takeSnapshot(canvas);
  _snapshotCache.delete(pageNumber);
  if (snap) {
    _snapshotCache.set(pageNumber, snap);
    while (_snapshotCache.size > SNAPSHOT_CACHE_MAX) {
      _snapshotCache.delete(_snapshotCache.keys().next().value);
    }
  }
  return snap;
}

/**
 * Whole-page probe: the snapshot box-averaged to 64×64.
 *
 * @param {number}            pageNumber
 * @param {HTMLCanvasElement} canvas
 * @returns {{data:Uint8ClampedArray,width:number,height:number}|null}
 */
export function probePage(pageNumber, canvas) {
  const snap = snapshotPage(pageNumber, canvas);
  return snap ? probeRegion(snap, 0, 0, snap.srcWidth, snap.srcHeight, PAGE_PROBE_SIZE) : null;
}

/**
 * Sample a sub-rect of a snapshot — pure CPU, no canvas, no GPU readback.
 * The rect is in the snapshot's SOURCE canvas pixels; the region is box-averaged
 * to size × size, which is what the old per-image canvas probe produced.
 *
 * @param {Snapshot|null} snap
 * @param {number} sx  @param {number} sy  @param {number} sw  @param {number} sh
 * @param {number} [size] — probe resolution (square)
 * @returns {{data:Uint8ClampedArray,width:number,height:number}|null}
 */
export function probeRegion(snap, sx, sy, sw, sh, size = REGION_PROBE_SIZE) {
  if (!snap || !(sw > 0) || !(sh > 0)) return null;

  const fx = snap.width  / snap.srcWidth;
  const fy = snap.height / snap.srcHeight;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  const x0 = clamp(sx * fx, snap.width),        y0 = clamp(sy * fy, snap.height);
  const x1 = clamp((sx + sw) * fx, snap.width), y1 = clamp((sy + sh) * fy, snap.height);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 2 || rh < 2) return null;      // too few pixels to say anything

  const src = snap.data, W = snap.width, H = snap.height;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    const ya = Math.min(H - 1, Math.floor(y0 + (j * rh) / size));
    const yb = Math.min(H, Math.max(ya + 1, Math.ceil(y0 + ((j + 1) * rh) / size)));
    for (let i = 0; i < size; i++) {
      const xa = Math.min(W - 1, Math.floor(x0 + (i * rw) / size));
      const xb = Math.min(W, Math.max(xa + 1, Math.ceil(x0 + ((i + 1) * rw) / size)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const k = (y * W + x) * 4;
          r += src[k]; g += src[k + 1]; b += src[k + 2]; n++;
        }
      }
      const o = (j * size + i) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: size, height: size };
}

/**
 * Compute statistics for a probe bitmap.
 *
 * @param {ImageData|null} probe
 * @returns {RegionStats|null}
 */
export function regionStats(probe) {
  if (!probe) return null;
  const d = probe.data;
  const n = d.length / 4;
  if (!n) return null;

  let lumSum = 0, satSum = 0, white = 0, dark = 0, colorful = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max === 0 ? 0 : (max - min) / max;
    lumSum += lum;
    satSum += sat;
    if (lum > 0.92) white++;
    if (lum < 0.08) dark++;
    if (sat > 0.25 && lum > 0.08 && lum < 0.92) colorful++;
  }
  return {
    luminance:    lumSum / n,
    whiteFrac:    white / n,
    darkFrac:     dark / n,
    saturation:   satSum / n,
    colorfulFrac: colorful / n,
  };
}

/**
 * Decide the Smart Dark strategy for a page.
 *
 * @param {Object}      args
 * @param {RegionStats} args.pageStats     — from regionStats(probePage(...))
 * @param {number}      args.textOps       — from operator analysis
 * @param {number}      args.imageCoverage — largest image area / page area (0..1)
 * @param {Array}       args.bgFills       — large fills from operator analysis
 * @param {{w:number,h:number}} args.pageSize — PDF user space size
 * @returns {'normal'|'dark-bg'|'scanned'}
 */
export function classifyPage({ pageStats, textOps, imageCoverage, bgFills, pageSize }) {
  // 1. Painted dark background wins (operator evidence beats pixels):
  //    the TOPMOST near-full-page fill decides — a black backdrop that is later
  //    covered by a white page fill must not make the page "dark". A topmost
  //    fill of unknown colour (pattern) defers to the pixel evidence below.
  if (bgFills?.length && pageSize) {
    const pageArea = pageSize.w * pageSize.h;
    let paintedLum = null;
    for (const { rect, color } of bgFills) {            // paint order: later = on top
      if ((rect[2] * rect[3]) / pageArea < BG_FILL_FRACTION) continue;
      paintedLum = color
        ? 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
        : null;
    }
    if (paintedLum !== null && paintedLum < DARK_BG_LUMINANCE) return 'dark-bg';
  }

  // 2. Full-page scan: one image covers almost everything and text is sparse.
  if (imageCoverage >= SCANNED_AREA_FRACTION && textOps < SCANNED_MAX_TEXT_OPS) {
    return 'scanned';
  }

  // 3. Pixel evidence: page background already dark → leave it alone.
  //    "Background" ≈ the dominant edge color; the whole-page mean luminance
  //    is a safe proxy because documents are mostly background.
  if (pageStats && pageStats.luminance < DARK_BG_LUMINANCE) return 'dark-bg';

  return 'normal';
}

/**
 * Decide whether an image region should be PRESERVED (kept original) or
 * allowed to invert with the page.
 *
 * @param {RegionStats} stats — stats of the image's rendered region
 * @returns {'photographic'|'document-like'}
 */
export function classifyImage(stats) {
  if (!stats) return 'photographic';   // can't sample → preserve (conservative)

  // Mostly white/light and not vividly colored → it is a scan of document
  // content (letterhead, table, watermark). Inverting it yields a consistent
  // dark document; preserving it would produce a glaring white box.
  if (stats.whiteFrac >= DOC_LIKE_WHITE_FRACTION &&
      stats.saturation <= DOC_LIKE_MAX_SATURATION &&
      stats.colorfulFrac < 0.08) {
    return 'document-like';
  }

  return 'photographic';
}

/**
 * Decide whether an image should be preserved after considering overlap with
 * real document content rendered on top of it.
 *
 * @param {RegionStats|null} stats
 * @param {Object} overlap
 * @param {number} overlap.textSpanHits
 * @param {number} overlap.textOverlapArea
 * @param {number} overlap.vectorHits
 * @param {number} overlap.vectorOverlapArea
 * @param {number} overlap.imageArea
 * @returns {'photographic'|'document-like'|'content-underlay'}
 */
export function classifyImageWithOverlap(stats, overlap) {
  const imageArea = Math.max(1, overlap?.imageArea || 1);
  const textRatio = (overlap?.textOverlapArea || 0) / imageArea;
  const vectorRatio = (overlap?.vectorOverlapArea || 0) / imageArea;

  // Actual document content is painted over this image. It must participate in
  // the same Smart Dark transform as the surrounding document, otherwise the
  // overlaid text/lines land on a preserved light patch and become unreadable.
  if ((overlap?.textSpanHits || 0) >= 2) return 'content-underlay';
  if ((overlap?.textSpanHits || 0) >= 1 && textRatio >= 0.01) return 'content-underlay';
  if ((overlap?.vectorHits || 0) >= 2 && vectorRatio >= 0.015) return 'content-underlay';
  if (((overlap?.textSpanHits || 0) + (overlap?.vectorHits || 0)) >= 2 &&
      (textRatio + vectorRatio) >= 0.012) {
    return 'content-underlay';
  }

  return classifyImage(stats);
}
