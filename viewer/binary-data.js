/**
 * Where PDF.js loads its data files from: standard fonts, CMaps, WASM decoders and
 * the CMYK ICC profile (all copied by build.js).
 *
 * Normal packages (Edge, Chrome, Firefox) let PDF.js fetch the files directly.
 *
 * The Opera package (package-opera.js) cannot ship .pfb / .ttf / .bcmap / .icc files:
 * the Opera add-ons store rejects them. There the fonts and CMaps are stored as base64
 * text next to their original name (FoxitSerif.pfb -> FoxitSerif.pfb.txt) and loaded
 * through EncodedBinaryDataFactory; the ICC profile is left out, so PDF.js uses its
 * built-in CMYK conversion.
 */
import { ENCODED_BINARY_DATA } from './build-flags.js';

/** Decode base64 text into bytes. */
export function decodeBase64(text) {
  const clean = text.replace(/\s+/g, '');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(clean);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * PDF.js BinaryDataFactory (getDocument option) for the encoded layout: fonts and
 * CMaps are read from <filename>.txt and decoded; WASM files are fetched as-is.
 */
export class EncodedBinaryDataFactory {
  constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null }) {
    this.cMapUrl = cMapUrl;
    this.standardFontDataUrl = standardFontDataUrl;
    this.wasmUrl = wasmUrl;
  }

  async fetch({ kind, filename }) {
    const base = this[kind];
    if (!base) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    const encoded = kind !== 'wasmUrl';
    const url = `${base}${filename}${encoded ? '.txt' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Unable to load ${kind} data at: ${url}`);
    return encoded ? decodeBase64(await res.text()) : new Uint8Array(await res.arrayBuffer());
  }
}

/** getDocument() options for the data files, given the URL of the pdfjs/ folder. */
export function binaryDataOptions(pdfjsUrl) {
  const options = {
    standardFontDataUrl: pdfjsUrl + 'web/standard_fonts/',
    cMapUrl:             pdfjsUrl + 'web/cmaps/',
    cMapPacked:          true,
    // WASM image/colour decoders + CMYK ICC profile (copied by build.js).
    // Without these, JPEG2000 / JBIG2 images render blank and ICC colours are off.
    wasmUrl:             pdfjsUrl + 'web/wasm/',
    iccUrl:              pdfjsUrl + 'web/iccs/',
  };
  if (!ENCODED_BINARY_DATA) return options;
  delete options.iccUrl;
  return { ...options, BinaryDataFactory: EncodedBinaryDataFactory };
}
