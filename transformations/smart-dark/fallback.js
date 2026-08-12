/**
 * Smart Dark Filter Chain Builder
 *
 * The base Smart Dark transform is `invert(100%) hue-rotate(180deg)`:
 * luminance is flipped (white page → dark page, black text → light text)
 * while hue-rotate(180deg) restores approximate hue fidelity, so semantic
 * colors (links, warnings, charts) stay recognizable instead of becoming
 * photographic negatives.
 *
 * The filter is applied per-page on the `.canvasWrapper` element — never on
 * #viewerWrapper — so the text layer, annotation layer, form controls and
 * the Nivra UI are never transformed.
 *
 * The image-preservation overlay sits inside the same `.canvasWrapper` and
 * receives the EXACT INVERSE of the full filter chain (including user
 * brightness/contrast), so parent-filter(child-filter(pixels)) ≈ identity:
 *
 *   net = F( F⁻¹(image_pixels) ) ≈ image_pixels (original)
 *
 * CSS filter lists apply left-to-right, so the inverse chain is the
 * element-wise inverse of the parent chain in REVERSE order.
 */

/** Base Smart Dark chain (no user adjustments). */
export const SMART_DARK_FILTER = 'invert(100%) hue-rotate(180deg)';

/**
 * Build the full Smart Dark filter for a page's canvas layer.
 *
 * @param {number} brightness — user brightness (100 = neutral)
 * @param {number} contrast   — user contrast   (100 = neutral)
 * @returns {string} CSS filter value
 */
export function buildSmartDarkFilter(brightness = 100, contrast = 100) {
  const parts = [SMART_DARK_FILTER];
  if (brightness !== 100) parts.push(`brightness(${brightness / 100})`);
  if (contrast   !== 100) parts.push(`contrast(${contrast / 100})`);
  return parts.join(' ');
}

/**
 * Build the exact inverse of buildSmartDarkFilter(), for use on the
 * image-preservation overlay canvas.
 *
 * Inverses:
 *   invert(100%)      → invert(100%)        (self-inverse)
 *   hue-rotate(180°)  → hue-rotate(180deg)  (self-inverse)
 *   brightness(b)     → brightness(1/b)
 *   contrast(c)       → contrast(1/c)
 *
 * @param {number} brightness
 * @param {number} contrast
 * @returns {string} CSS filter value
 */
export function buildCounterFilter(brightness = 100, contrast = 100) {
  const parts = [];
  // Reverse order of buildSmartDarkFilter's chain.
  if (contrast   !== 100) parts.push(`contrast(${100 / contrast})`);
  if (brightness !== 100) parts.push(`brightness(${100 / brightness})`);
  parts.push('hue-rotate(180deg) invert(100%)');
  return parts.join(' ');
}
