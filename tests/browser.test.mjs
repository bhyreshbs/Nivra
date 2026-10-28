import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isFirefox, isEdge, isOpera, browserId, browserName, extensionsPageUrl,
} from '../shared/browser.js';

const UA = {
  chrome:     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  chromeMac:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  edge:       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
  edgeLegacy: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19045',
  edgeAndroid:'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36 EdgA/147.0.0.0',
  opera:      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 OPR/131.0.0.0',
  operaGX:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 OPR/131.0.0.0 (Edition std-2)',
  firefox:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0',
};

const NO_BRANDS = [];

test('Chrome is detected as Chrome only', () => {
  for (const ua of [UA.chrome, UA.chromeMac]) {
    assert.equal(browserId(ua, NO_BRANDS), 'chrome');
    assert.equal(browserName(ua, NO_BRANDS), 'Chrome');
    assert.equal(isEdge(ua, NO_BRANDS), false);
    assert.equal(isOpera(ua, NO_BRANDS), false);
    assert.equal(isFirefox(ua), false);
  }
});

test('Edge is detected from Edg/, Edge/ and EdgA/', () => {
  for (const ua of [UA.edge, UA.edgeLegacy, UA.edgeAndroid]) {
    assert.equal(isEdge(ua, NO_BRANDS), true, ua);
    assert.equal(browserId(ua, NO_BRANDS), 'edge');
    assert.equal(browserName(ua, NO_BRANDS), 'Edge');
    assert.equal(isOpera(ua, NO_BRANDS), false);
  }
});

test('Edge is detected from the UA-CH brand when the UA is reduced', () => {
  const brands = [{ brand: 'Chromium', version: '147' }, { brand: 'Microsoft Edge', version: '147' }];
  assert.equal(isEdge(UA.chrome, brands), true);
  assert.equal(browserId(UA.chrome, brands), 'edge');
});

test('Edge detection matches the regex used in background/sw.js', () => {
  const swRe = /\bEdg(e|A|iOS)?\//;
  for (const ua of Object.values(UA)) {
    assert.equal(isEdge(ua, NO_BRANDS), swRe.test(ua), ua);
  }
});

test('Opera and Opera GX are detected from OPR/', () => {
  for (const ua of [UA.opera, UA.operaGX]) {
    assert.equal(isOpera(ua, NO_BRANDS), true, ua);
    assert.equal(browserId(ua, NO_BRANDS), 'opera');
    assert.equal(browserName(ua, NO_BRANDS), 'Opera');
    assert.equal(isEdge(ua, NO_BRANDS), false);
  }
});

test('Opera is detected from the UA-CH brand', () => {
  const brands = [{ brand: 'Chromium', version: '146' }, { brand: 'Opera', version: '131' }];
  assert.equal(browserId(UA.chrome, brands), 'opera');
});

test('Firefox is detected on desktop and Android', () => {
  for (const ua of [UA.firefox, UA.firefoxMac, UA.firefoxAndroid]) {
    assert.equal(isFirefox(ua), true, ua);
    assert.equal(browserId(ua, NO_BRANDS), 'firefox');
    assert.equal(browserName(ua, NO_BRANDS), 'Firefox');
    assert.equal(isEdge(ua, NO_BRANDS), false);
    assert.equal(isOpera(ua, NO_BRANDS), false);
  }
});

test('extensionsPageUrl returns each browser\'s extensions page', () => {
  assert.equal(extensionsPageUrl(undefined, UA.chrome, NO_BRANDS), 'chrome://extensions/');
  assert.equal(extensionsPageUrl(undefined, UA.edge, NO_BRANDS), 'edge://extensions/');
  assert.equal(extensionsPageUrl(undefined, UA.opera, NO_BRANDS), 'opera://extensions/');
  assert.equal(extensionsPageUrl(undefined, UA.firefox, NO_BRANDS), 'about:addons');
});

test('extensionsPageUrl links to the extension detail page on Chromium browsers', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(extensionsPageUrl(id, UA.chrome, NO_BRANDS), `chrome://extensions/?id=${id}`);
  assert.equal(extensionsPageUrl(id, UA.edge, NO_BRANDS), `edge://extensions/?id=${id}`);
  assert.equal(extensionsPageUrl(id, UA.opera, NO_BRANDS), `opera://extensions/?id=${id}`);
  assert.equal(extensionsPageUrl(id, UA.firefox, NO_BRANDS), 'about:addons');
});

test('defaults read the current navigator', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: UA.opera, userAgentData: { brands: [] } },
      configurable: true,
    });
    assert.equal(browserId(), 'opera');
    assert.equal(extensionsPageUrl('x'), 'opera://extensions/?id=x');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});
