/**
 * Smart Dark Page Analyzer — pixel-level content classification
 * ─────────────────────────────────────────────────────────────────────────────
 * Complements operator-analyzer.js (structure) with a cheap pixel probe of the
 * rendered canvas (evidence). The probe is a single 64×64 downsampled draw of
 * the main canvas — one drawImage + one getImageData per analysis, cached per
 * page. It NEVER writes back to the displayed canvas, so rendering sharpness
 * is untouched.
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
 *   'photographic'   — rich mid-tones / saturated color → PRESERVE via overlay
 *   'document-like'  — mostly white/light, low saturation (letterhead scans,
 *                      table snapshots, watermarks) → let it invert with the
 *                      page so it becomes dark instead of a glaring white box
 *
 * Results are cached per page and reused across zoom/mode toggles.
 */

/** Page background luminance below this → already dark, skip inversion. */
const DARK_BG_LUMINANCE = 0.35;

/** Image covering ≥ this fraction of the page area → scanned-page candidate. */
const SCANNED_AREA_FRACTION = 0.85;

/** Page with fewer text ops than this + a page-covering image → scanned. */
const SCANNED_MAX_TEXT_OPS = 8;

/** Image region: fraction of near-white pixels above this → document-like. */
const DOC_LIKE_WHITE_FRACTION = 0.55;

/** Image region: mean saturation below this → not vividly colored. */
const DOC_LIKE_MAX_SATURATION = 0.18;

/** Probe resolution (per page / per image region). */
const PROBE_SIZE = 64;

// pageNumber → Promise<PixelProbe>
const _probeCache = new Map();

export function clearProbeCache() { _probeCache.clear(); }

/**
 * @typedef {Object} RegionStats
 * @property {number} luminance   — mean luminance 0..1
 * @property {number} whiteFrac   — fraction of pixels with lum > 0.92
 * @property {number} darkFrac    — fraction of pixels with lum < 0.08
 * @property {number} saturation  — mean HSV-ish saturation 0..1
 * @property {number} colorfulFrac— fraction of pixels with sat > 0.25 and mid luminance
 */

/**
 * Sample the whole rendered page canvas into a tiny probe bitmap.
 * Cached per page for the lifetime of the document.
 *
 * NOTE: requires the canvas to be fully rendered — call after `pagerendered`.
 *
 * @param {number}            pageNumber
 * @param {HTMLCanvasElement} canvas
 * @returns {ImageData|null} 64×64 RGBA probe
 */
export function probePage(pageNumber, canvas) {
  if (_probeCache.has(pageNumber)) return _probeCache.get(pageNumber);
  const probe = _sample(canvas, 0, 0, canvas.width, canvas.height, PROBE_SIZE);
  _probeCache.set(pageNumber, probe);
  return probe;
}

/**
 * Sample a sub-rect (physical pixel coords) of the main canvas.
 * NOT cached — cheap (small drawImage + getImageData).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} sx  @param {number} sy  @param {number} sw  @param {number} sh
 * @param {number} size — probe resolution (square)
 * @returns {ImageData|null}
 */
export function probeRegion(canvas, sx, sy, sw, sh, size = 24) {
  return _sample(canvas, sx, sy, sw, sh, size);
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
  //    a large fill whose color is dark → the document is already dark.
  if (bgFills?.length && pageSize) {
    const pageArea = pageSize.w * pageSize.h;
    for (const { rect, color } of bgFills) {
      const area = rect[2] * rect[3];
      if (area / pageArea >= BG_FILL_FRACTION && color) {
        const lum = color.length === 1
          ? color[0]
          : 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
        if (lum < DARK_BG_LUMINANCE) return 'dark-bg';
      }
    }
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

// ─── Internal ────────────────────────────────────────────────────────────────

function _sample(canvas, sx, sy, sw, sh, size) {
  try {
    if (!canvas || !canvas.width || sw <= 0 || sh <= 0) return null;
    // Clamp source rect to canvas bounds
    const x = Math.max(0, Math.min(sx, canvas.width));
    const y = Math.max(0, Math.min(sy, canvas.height));
    const w = Math.max(0, Math.min(sw, canvas.width  - x));
    const h = Math.max(0, Math.min(sh, canvas.height - y));
    if (w < 2 || h < 2) return null;

    const probe = document.createElement('canvas');
    probe.width = probe.height = size;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(canvas, x, y, w, h, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
  } catch (_) {
    return null;   // tainted canvas or OOM — caller falls back safely
  }
}
