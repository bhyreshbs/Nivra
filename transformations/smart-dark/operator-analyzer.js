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
 *   - Colours arrive as ONE hex string: setFillRGBColor ["#rrggbb"]. The worker
 *     rewrites gray / CMYK / ICC fills into this op, so it is the only colour
 *     op to read (patterns stay setFillColorN → unknown).
 *   - Paths arrive fused with their paint operator:
 *         constructPath [paintOp, [Float32Array path], [minX, minY, maxX, maxY]]
 *     paintOp is OPS.fill / stroke / fillStroke / endPath / …, and minMax is the
 *     path's bounding box in the user space current at paint time. There are no
 *     standalone fill/stroke ops, and the path buffer is draw-commands, not x/y
 *     pairs, so only minMax is used. (minMax is null for an empty path.)
 *   - Form XObjects are bracketed by paintFormXObjectBegin [matrix, bbox] /
 *     paintFormXObjectEnd: Begin = save + transform(matrix), End = restore.
 *     Images inside forms (Word, PowerPoint, Chrome-printed PDFs) are located
 *     through that matrix.
 *   - Alpha arrives as setGState [[["ca", 0.3], …]]. A translucent full-page
 *     fill is not a page background.
 *
 * ─── Performance ────────────────────────────────────────────────────────────
 * getOperatorList() runs once per page per document (cached promise).
 * imageOpsToRects() is pure math and re-runs on every re-render (zoom).
 */

// ─── OPS constants (verified against pdfjs-dist 6.2.108 build) ───────────────
const OPS_SET_GSTATE                  = 9;
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
const OPS_SHOW_TEXT                   = 44;
const OPS_SHOW_SPACED_TEXT            = 45;
const OPS_NEXT_LINE_SHOW_TEXT         = 46;
const OPS_NEXT_LINE_SET_SPACING_SHOW_TEXT = 47;
const OPS_SET_FILL_COLOR_N            = 55;
const OPS_SET_FILL_RGB_COLOR          = 59;
const OPS_PAINT_FORM_BEGIN            = 74;
const OPS_PAINT_FORM_END              = 75;
const OPS_BEGIN_GROUP                 = 76;
const OPS_END_GROUP                   = 77;
const OPS_BEGIN_ANNOTATION            = 80;
const OPS_END_ANNOTATION              = 81;
const OPS_PAINT_IMAGE_XOBJECT         = 85;
const OPS_PAINT_INLINE_IMAGE          = 86;
const OPS_PAINT_INLINE_IMAGE_GROUP    = 87;
const OPS_PAINT_IMAGE_XOBJECT_REPEAT  = 88;
const OPS_CONSTRUCT_PATH              = 91;
const OPS_SET_FILL_TRANSPARENT        = 93;

const FILL_OPS = new Set([
  OPS_FILL, OPS_EOFILL, OPS_FILL_STROKE, OPS_EOFILL_STROKE,
  OPS_CLOSE_FILL_STROKE, OPS_CLOSE_EOFILL_STROKE,
]);
const STROKE_OPS = new Set([OPS_STROKE, OPS_CLOSE_STROKE]);   // stroke-only; the fill+stroke ops count as fills

// Images smaller than this (CSS px) are ignored — tiny textures/bullets.
const MIN_IMAGE_PX = 24;

// A fill drawn with less opacity than this is not treated as a page background.
// (The "covers 80% of the page" threshold lives with the classifier, page-analyzer.js.)
const BG_MIN_ALPHA = 0.9;

// Only line-like strokes (rules, table borders) count as content painted over an
// image. A stroked frame around a photo has a bbox as large as the photo, which
// would otherwise make the photo look like "document content" and get inverted.
const STROKE_LINE_MAX_PT = 3;

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
 * Walk the operator list tracking the graphics state (CTM, fill colour, fill
 * alpha); collect image ops and page statistics.
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

  // Graphics state that q/Q (and form/group brackets) save and restore.
  let ctm = [1, 0, 0, 1, 0, 0];
  let fillColor = [0, 0, 0];     // PDF default is black; null = unknown (pattern) / invisible
  let fillAlpha = 1;
  const stack = [];
  const push = () => stack.push({ ctm, fillColor, fillAlpha });
  const pop  = () => { const t = stack.pop(); if (t) ({ ctm, fillColor, fillAlpha } = t); };

  // Annotation appearance streams are drawn in their own space; keep the stack
  // balanced but do not let them count as page content.
  let annotationDepth = 0;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    switch (fn) {
      case OPS_SAVE:
      case OPS_BEGIN_GROUP:
        push();
        break;
      case OPS_RESTORE:
      case OPS_END_GROUP:
        pop();
        break;
      case OPS_TRANSFORM:
        ctm = _matMul(ctm, argsArray[i]);
        break;

      case OPS_PAINT_FORM_BEGIN: {
        // args = [matrix|null, bbox|null] — save, then transform(matrix)
        push();
        const matrix = argsArray[i]?.[0];
        if (matrix) ctm = _matMul(ctm, matrix);
        break;
      }
      case OPS_PAINT_FORM_END:
        pop();
        break;

      case OPS_BEGIN_ANNOTATION:
        push();
        annotationDepth++;
        break;
      case OPS_END_ANNOTATION:
        pop();
        if (annotationDepth > 0) annotationDepth--;
        break;

      case OPS_SET_GSTATE: {
        // args = [[ [key, value], … ]]
        const pairs = argsArray[i]?.[0];
        if (Array.isArray(pairs)) {
          for (const pair of pairs) {
            if (pair?.[0] === 'ca' && typeof pair[1] === 'number') fillAlpha = pair[1];
          }
        }
        break;
      }

      case OPS_PAINT_IMAGE_XOBJECT:
      case OPS_PAINT_INLINE_IMAGE:
        if (!annotationDepth) imageOps.push({ ctm: ctm.slice(), opIndex: i });
        break;

      case OPS_PAINT_INLINE_IMAGE_GROUP: {
        // args = [imgData, map[]] — map entries carry {transform, x, y, w, h}
        const map = argsArray[i]?.[1];
        if (!annotationDepth && Array.isArray(map)) {
          for (const entry of map) {
            if (entry?.transform) imageOps.push({ ctm: _matMul(ctm, entry.transform), opIndex: i });
          }
        }
        break;
      }

      case OPS_PAINT_IMAGE_XOBJECT_REPEAT: {
        // args = [objId, scaleX, scaleY, positions[]]
        const a = argsArray[i];
        if (!annotationDepth && a && Array.isArray(a[3])) {
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
        fillColor = _parseHexColor(argsArray[i]?.[0]);
        break;
      case OPS_SET_FILL_COLOR_N:
      case OPS_SET_FILL_TRANSPARENT:
        fillColor = null;        // pattern / ICC remainder / invisible
        break;

      case OPS_CONSTRUCT_PATH: {
        // args = [paintOp, [Float32Array path], minMax|null]
        vectorOps++;
        const a = argsArray[i];
        const paintOp = a?.[0];
        const minMax  = a?.[2];
        if (annotationDepth || !minMax || !(minMax[0] <= minMax[2]) || !(minMax[1] <= minMax[3])) break;

        const rect = _userSpaceRect(minMax, ctm);
        if (FILL_OPS.has(paintOp)) {
          if (fillAlpha >= BG_MIN_ALPHA) bgFills.push({ rect, color: fillColor });
          vectorPaints.push({ rect, opIndex: i });
        } else if (STROKE_OPS.has(paintOp) && Math.min(rect[2], rect[3]) <= STROKE_LINE_MAX_PT) {
          vectorPaints.push({ rect, opIndex: i });
        }
        break;
      }

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

/** "#rrggbb" → [r, g, b] in 0..1, or null when the value is not a hex colour. */
function _parseHexColor(hex) {
  const m = typeof hex === 'string' ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
}

/**
 * Axis-aligned [x, y, width, height] of a path bbox [minX, minY, maxX, maxY]
 * after the CTM, in PDF user space.
 */
function _userSpaceRect([x0, y0, x1, y1], [a, b, c, d, e, f]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const x = a * px + c * py + e;
    const y = b * px + d * py + f;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX - minX, maxY - minY];
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
