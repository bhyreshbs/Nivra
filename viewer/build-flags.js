// Build-time flags. Shipped as-is in the Chromium (Edge/Chrome) and Firefox packages;
// package-opera.js overwrites this file in dist-opera/ only.

// true when PDF.js's standard fonts and CMaps are stored as base64 text (<name>.txt)
// and the ICC profile is left out, because the Opera add-ons store rejects those
// binary file types (.pfb, .bcmap, .icc).
export const ENCODED_BINARY_DATA = false;
