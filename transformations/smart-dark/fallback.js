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
 * Preserved photos are not run through this chain and back: the overlay that
 * carries them sits OUTSIDE the filtered wrapper (see image-protector.js), so it
 * shows the original pixels exactly. (Undoing the chain with an inverse filter was
 * only approximate — every filter step clamps — and has been removed.)
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
