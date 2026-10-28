import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every browser ships the same version: the Chromium and Firefox manifests,
// package.json / package-lock.json and the popup's label must all agree.
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = p => JSON.parse(read(p));

test('all browsers and package files share one version', () => {
  const version = json('manifest.json').version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(json('manifest.firefox.json').version, version, 'manifest.firefox.json');
  assert.equal(json('package.json').version, version, 'package.json');
  assert.equal(json('package-lock.json').version, version, 'package-lock.json');
  assert.match(read('popup/popup.html'), new RegExp(`class="popup-version">v${version.replace(/\./g, '\\.')}<`), 'popup/popup.html label');
});
