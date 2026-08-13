/**
 * PDF Operator List Analyzer  (PDF.js v6 compatible)
 * ─────────────────────────────────────────────────────────────────────────────
 * Walks a page's operator list (getOperatorList) and extracts:
 *
 *   1. Image painting operations with their CTM at paint time
 *      → bounding rects in CSS pixels for a given viewport.
 *   2. Page content statistics (text ops, vector ops, large fills)
 *      → used by the page classifier (normal / dark-bg / scanned).
 *
 * ─── PDF.js v6 operator reality ──────────────────────────────────────────────
 *   - OPS.paintJpegXObject (82) was REMOVED (pdfjs ≥ 4). JPEGs now arrive as
 *     OPS.paintImageXObject (85). Photographic content is detected by sampling
 *     rendered pixels (page-analyzer.js), not by trusting the encoding.
 *   - OPS.paintImageXObjectRepeat (88) and OPS.paintInlineImageXObjectGroup (87)
 *     paint one image many times (tiling); their args carry the positions.
 *   - OPS.paintImageMaskXObject (83) / paintImageMaskXObjectGroup (84) /
 *     paintSolidColorImageMask (90) are 1-bit stencil masks (font glyphs) —
 *     never photographic, always skipped.
 *
 * ─── Performance ────────────────────────────────────────────────────────────
 * getOperatorList() runs once per page per document (cached promise).
 * imageOpsToRects() is pure math and re-runs on every re-render (zoom).
 */

// ─── OPS constants (verified against pdfjs-dist 6.2.108 build) ───────────────
const OPS_SAVE                        = 10;
const OPS_RESTORE                     = 11;
const OPS_TRANSFORM                   = 12;
const OPS_STROKE                      = 20;
const OPS_CLOSE_STROKE                = 21;
const OPS_FILL                        = 22;
const OPS_EOFILL                      = 23;
const OPS_FILL_STROKE                 = 24;
const OPS_EOFILL_STROKE               = 25;
const OPS_CLOSE_FILL_STROKE           = 26;
const OPS_CLOSE_EOFILL_STROKE         = 27;
const OPS_ENDPATH                     = 28;
const OPS_SHOW_TEXT                   = 44;
const OPS_SHOW_SPACED_TEXT            = 45;
const OPS_NEXT_LINE_SHOW_TEXT         = 46;
const OPS_NEXT_LINE_SET_SPACING_SHOW_TEXT = 47;
const OPS_SET_FILL_COLOR_N            = 55;
const OPS_SET_FILL_GRAY               = 57;
const OPS_SET_FILL_RGB_COLOR          = 59;
const OPS_PAINT_IMAGE_XOBJECT         = 85;
const OPS_PAINT_INLINE_IMAGE          = 86;
const OPS_PAINT_INLINE_IMAGE_GROUP    = 87;
const OPS_PAINT_IMAGE_XOBJECT_REPEAT  = 88;
const OPS_CONSTRUCT_PATH              = 91;

// Images smaller than this (CSS px) are ignored — tiny textures/bullets.
const MIN_IMAGE_PX = 24;

// A fill covering at least this fraction of the page counts as a painted bg.
const BG_FILL_FRACTION = 0.8;

// ─── Cache ────────────────────────────────────────────────────────────────────
// pageNumber → Promise<PageAnalysis>
const _cache = new Map();

export function clearOpListCache() { _cache.clear(); }

/**
 * @typedef {Object} PageAnalysis
 * @property {Array<{ctm:number[], opIndex:number}>} imageOps
 *          — image paints with their CTM and operator-list index
 * @property {number} textOps                  — showText op count
 * @property {number} vectorOps                — path/stroke/fill op count
 * @property {Array<{rect:number[], opIndex:number}>} vectorPaints
 *          — vector paint boxes in PDF user space + paint op index
 * @property {Array<{rect:number[], color:number[]|null}>} bgFills
 *          — fills (rect in PDF user space + color), for background detection
 */

/**
 * Get (and cache) the operator analysis for a page.
 *
 * @param {PDFPageProxy} pdfPage
 * @returns {Promise<PageAnalysis>}
 */
export function getPageAnalysis(pdfPage) {
  const n = pdfPage.pageNumber;
  if (!_cache.has(n)) {
    _cache.set(n, pdfPage.getOperatorList().then(_analyzeOps));
  }
  return _cache.get(n);
}

/**
 * Convert image ops to CSS-pixel bounding rects for the given viewport.
 * Pure math — cheap enough to re-run on every zoom/re-render.
 *
 * @param {Array<{ctm:number[]}>} imageOps
 * @param {PageViewport} viewport
 * @returns {Array<{x,y,width,height}>}
 */
export function imageOpsToRects(imageOps, viewport) {
  return imageOpsToQuads(imageOps, viewport).map(({ bounds }) => ({ ...bounds }));
}

/**
 * Convert image ops to exact CSS-pixel quads plus bounds.
 *
 * @param {Array<{ctm:number[], opIndex?:number}>} imageOps
 * @param {PageViewport} viewport
 * @returns {Array<{points:Array<{x:number,y:number}>, bounds:{x:number,y:number,width:number,height:number}, opIndex?:number}>}
 */
export function imageOpsToQuads(imageOps, viewport) {
  const vt  = viewport.transform;   // PDF user space → CSS px
  const vpW = viewport.width;
  const vpH = viewport.height;
  const quads = [];

  for (const { ctm, opIndex } of imageOps) {
    const [a, b, c, d, e, f] = ctm;

    // Image occupies the unit square [0,0]–[1,1] in its own space.
    const points = [
      [e,         f        ],
      [a + e,     b + f    ],
      [a + c + e, b + d + f],
      [c + e,     d + f    ],
    ].map(([px, py]) => ({
      x: vt[0] * px + vt[2] * py + vt[4],
      y: vt[1] * px + vt[3] * py + vt[5],
    }));

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;

    if (w < MIN_IMAGE_PX || h < MIN_IMAGE_PX) continue;

    // Clamp bounds to viewport with a tiny float margin but keep the exact quad.
    const cx = Math.max(-1, x);
    const cy = Math.max(-1, y);
    const cw = Math.min(w - (cx - x), vpW - cx + 1);
    const ch = Math.min(h - (cy - y), vpH - cy + 1);

    if (cw > 1 && ch > 1) {
      quads.push({
        points,
        bounds: { x: cx, y: cy, width: cw, height: ch },
        opIndex,
      });
    }
  }

  return quads;
}

/**
 * Convert PDF-space rect records to CSS-pixel rects for the given viewport.
 *
 * @param {Array<{rect:number[], opIndex:number}>} rectOps
 * @param {PageViewport} viewport
 * @returns {Array<{x:number,y:number,width:number,height:number,opIndex:number}>}
 */
export function rectOpsToRects(rectOps, viewport) {
  const vt  = viewport.transform;
  const vpW = viewport.width;
  const vpH = viewport.height;
  const rects = [];

  for (const { rect, opIndex } of rectOps) {
    const [x, y, w, h] = rect;
    const corners = [
      [x,     y    ],
      [x + w, y    ],
      [x,     y + h],
      [x + w, y + h],
    ].map(([px, py]) => [
      vt[0] * px + vt[2] * py + vt[4],
      vt[1] * px + vt[3] * py + vt[5],
    ]);

    const xs = corners.map(p => p[0]);
    const ys = corners.map(p => p[1]);
    const cx = Math.max(-1, Math.min(...xs));
    const cy = Math.max(-1, Math.min(...ys));
    const cw = Math.min(Math.max(...xs) - Math.min(...xs), vpW - cx + 1);
    const ch = Math.min(Math.max(...ys) - Math.min(...ys), vpH - cy + 1);

    if (cw > 1 && ch > 1) rects.push({ x: cx, y: cy, width: cw, height: ch, opIndex });
  }

  return rects;
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Walk the operator list tracking the CTM; collect image ops and page stats.
 *
 * @param {{fnArray:number[], argsArray:any[][]}} ops
 * @returns {PageAnalysis}
 */
function _analyzeOps(ops) {
  const { fnArray, argsArray } = ops;

  const imageOps = [];
  const vectorPaints = [];
  const bgFills  = [];
  let textOps   = 0;
  let vectorOps = 0;

  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  let fillColor = null;         // last fill color: [r,g,b] or [gray] or null
  let pendingPathRect = null;   // bbox of current path (path space)

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    switch (fn) {
      case OPS_SAVE:
        ctmStack.push(ctm.slice());
        break;
      case OPS_RESTORE:
        ctm = ctmStack.length ? ctmStack.pop() : [1, 0, 0, 1, 0, 0];
        break;
      case OPS_TRANSFORM:
        ctm = _matMul(ctm, argsArray[i]);
        break;

      case OPS_PAINT_IMAGE_XOBJECT:
      case OPS_PAINT_INLINE_IMAGE:
        imageOps.push({ ctm: ctm.slice(), opIndex: i });
        break;

      case OPS_PAINT_INLINE_IMAGE_GROUP: {
        // args = [imgData, map[]] — map entries carry {transform, x, y, w, h}
        const map = argsArray[i]?.[1];
        if (Array.isArray(map)) {
          for (const entry of map) {
            if (entry?.transform) imageOps.push({ ctm: _matMul(ctm, entry.transform), opIndex: i });
          }
        }
        break;
      }

      case OPS_PAINT_IMAGE_XOBJECT_REPEAT: {
        // args = [objId, scaleX, scaleY, positions[]]
        const a = argsArray[i];
        if (a && Array.isArray(a[3])) {
          const [, sx, sy, positions] = a;
          for (let p = 0; p + 1 < positions.length; p += 2) {
            imageOps.push({
              ctm: _matMul(ctm, [sx, 0, 0, sy, positions[p], positions[p + 1]]),
              opIndex: i,
            });
          }
        }
        break;
      }

      case OPS_SET_FILL_RGB_COLOR:
        fillColor = [argsArray[i][0], argsArray[i][1], argsArray[i][2]];
        break;
      case OPS_SET_FILL_GRAY:
        fillColor = [argsArray[i][0]];
        break;
      case OPS_SET_FILL_COLOR_N:
        fillColor = null;        // ICC/pattern — color unknown
        break;

      case OPS_CONSTRUCT_PATH: {
        vectorOps++;
        // args = [ops[], pts[]] — bbox of the path in path space
        const pts = argsArray[i]?.[1];
        if (pts && pts.length >= 4) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let p = 0; p + 1 < pts.length; p += 2) {
            if (pts[p] < minX)     minX = pts[p];
            if (pts[p] > maxX)     maxX = pts[p];
            if (pts[p+1] < minY)   minY = pts[p+1];
            if (pts[p+1] > maxY)   maxY = pts[p+1];
          }
          pendingPathRect = [minX, minY, maxX, maxY];
        }
        break;
      }

      case OPS_FILL:
      case OPS_EOFILL:
      case OPS_FILL_STROKE:
      case OPS_EOFILL_STROKE:
      case OPS_CLOSE_FILL_STROKE:
      case OPS_CLOSE_EOFILL_STROKE: {
        vectorOps++;
        if (pendingPathRect) {
          const [x0, y0, x1, y1] = pendingPathRect;
          const [a2, b2, c2, d2, e2, f2] = ctm;
          const cs = [[x0,y0],[x1,y0],[x0,y1],[x1,y1]].map(([px,py]) => [
            a2*px + c2*py + e2, b2*px + d2*py + f2,
          ]);
          const rxs = cs.map(p => p[0]);
          const rys = cs.map(p => p[1]);
          bgFills.push({
            rect: [Math.min(...rxs), Math.min(...rys),
                   Math.max(...rxs) - Math.min(...rxs),
                   Math.max(...rys) - Math.min(...rys)],
            color: fillColor,
          });
          vectorPaints.push({
            rect: [Math.min(...rxs), Math.min(...rys),
                   Math.max(...rxs) - Math.min(...rxs),
                   Math.max(...rys) - Math.min(...rys)],
            opIndex: i,
          });
        }
        pendingPathRect = null;
        break;
      }

      case OPS_STROKE:
      case OPS_CLOSE_STROKE:
        vectorOps++;
        if (pendingPathRect) {
          const [x0, y0, x1, y1] = pendingPathRect;
          const [a2, b2, c2, d2, e2, f2] = ctm;
          const cs = [[x0,y0],[x1,y0],[x0,y1],[x1,y1]].map(([px,py]) => [
            a2*px + c2*py + e2, b2*px + d2*py + f2,
          ]);
          const rxs = cs.map(p => p[0]);
          const rys = cs.map(p => p[1]);
          vectorPaints.push({
            rect: [Math.min(...rxs), Math.min(...rys),
                   Math.max(...rxs) - Math.min(...rxs),
                   Math.max(...rys) - Math.min(...rys)],
            opIndex: i,
          });
        }
        pendingPathRect = null;
        break;

      case OPS_ENDPATH:
        vectorOps++;
        pendingPathRect = null;
        break;

      case OPS_SHOW_TEXT:
      case OPS_SHOW_SPACED_TEXT:
      case OPS_NEXT_LINE_SHOW_TEXT:
      case OPS_NEXT_LINE_SET_SPACING_SHOW_TEXT:
        textOps++;
        break;
    }
  }

  return { imageOps, textOps, vectorOps, vectorPaints, bgFills };
}

/**
 * PDF 2D affine matrix multiply (m1 × m2), [a b c d e f] convention.
 */
function _matMul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1*a2 + c1*b2,
    b1*a2 + d1*b2,
    a1*c2 + c1*d2,
    b1*c2 + d1*d2,
    a1*e2 + c1*f2 + e1,
    b1*e2 + d1*f2 + f1,
  ];
}
