import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// viewer/ is CommonJS to Node (root package.json), so load copies from an ES-module folder,
// once with the shipped flag (false) and once with the Opera flag (true).
const src = name => readFileSync(new URL(`../viewer/${name}`, import.meta.url), 'utf8');

async function load(encoded) {
  const dir = mkdtempSync(join(tmpdir(), 'nivra-bd-'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'binary-data.js'), src('binary-data.js'));
  const flags = src('build-flags.js');
  writeFileSync(join(dir, 'build-flags.js'), encoded
    ? flags.replace('ENCODED_BINARY_DATA = false', 'ENCODED_BINARY_DATA = true')
    : flags);
  const mod = await import(pathToFileURL(join(dir, 'binary-data.js')).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

const normal = await load(false);
const opera = await load(true);
const BASE = 'chrome-extension://id/pdfjs/';

test('the shipped flag is off', () => {
  assert.match(src('build-flags.js'), /export const ENCODED_BINARY_DATA = false;/);
});

test('normal packages get exactly the options the viewer always passed', () => {
  assert.deepEqual(normal.binaryDataOptions(BASE), {
    standardFontDataUrl: BASE + 'web/standard_fonts/',
    cMapUrl:             BASE + 'web/cmaps/',
    cMapPacked:          true,
    wasmUrl:             BASE + 'web/wasm/',
    iccUrl:              BASE + 'web/iccs/',
  });
});

test('the Opera layout adds the decoding factory and drops the ICC profile', () => {
  const o = opera.binaryDataOptions(BASE);
  assert.equal(o.BinaryDataFactory, opera.EncodedBinaryDataFactory);
  assert.equal('iccUrl' in o, false);
  assert.equal(o.standardFontDataUrl, BASE + 'web/standard_fonts/');
  assert.equal(o.cMapUrl, BASE + 'web/cmaps/');
  assert.equal(o.cMapPacked, true);
  assert.equal(o.wasmUrl, BASE + 'web/wasm/');
});

test('decodeBase64 round-trips binary data', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual(opera.decodeBase64(b64), bytes);
  assert.deepEqual(opera.decodeBase64(b64.replace(/(.{60})/g, '$1\n')), bytes);
});

test('the factory reads <file>.txt for fonts and CMaps and raw bytes for WASM', async () => {
  const font = Uint8Array.from([1, 2, 3, 250]);
  const cmap = Uint8Array.from([9, 8, 7]);
  const wasm = Uint8Array.from([0, 97, 115, 109]);
  const files = {
    [BASE + 'web/standard_fonts/FoxitSerif.pfb.txt']: Buffer.from(font).toString('base64'),
    [BASE + 'web/cmaps/UniJIS-UCS2-H.bcmap.txt']: Buffer.from(cmap).toString('base64'),
    [BASE + 'web/wasm/openjpeg.wasm']: wasm,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => url in files
    ? new Response(files[url])
    : new Response('', { status: 404 });
  try {
    const f = new opera.EncodedBinaryDataFactory(opera.binaryDataOptions(BASE));
    assert.deepEqual(await f.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSerif.pfb' }), font);
    assert.deepEqual(await f.fetch({ kind: 'cMapUrl', filename: 'UniJIS-UCS2-H.bcmap' }), cmap);
    assert.deepEqual(await f.fetch({ kind: 'wasmUrl', filename: 'openjpeg.wasm' }), wasm);
    await assert.rejects(f.fetch({ kind: 'cMapUrl', filename: 'Missing.bcmap' }), /Unable to load/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
