import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory chrome.storage.local
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async key => (key in store ? { [key]: store[key] } : {}),
      set: async obj => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
    },
  },
};

const prefs = await import('../settings/preferences.js');

test('loadPrefs returns defaults when nothing is stored', async () => {
  assert.deepEqual(await prefs.loadPrefs(), { ...prefs.DEFAULT_PREFS });
});

test('default zoom is fit page', () => {
  assert.equal(prefs.DEFAULT_PREFS.scale, 'page-fit');
});

test('loadPrefs rejects invalid stored values', async () => {
  store.nivraPrefs = { mode: 'evil', brightness: 9999, contrast: 'x', scale: 'url(javascript:1)', sidebar: 'yes' };
  const p = await prefs.loadPrefs();
  assert.equal(p.mode, 'smart-dark');
  assert.equal(p.brightness, 150);
  assert.equal(p.contrast, 100);
  assert.equal(p.scale, 'page-fit');
  assert.equal(p.sidebar, true);
});

test('site appearance round-trips and can be forgotten', async () => {
  await prefs.setSiteAppearance('example.com', { mode: 'grayscale', brightness: 80, contrast: 120 });
  assert.deepEqual(await prefs.getSiteAppearance('example.com'),
    { mode: 'grayscale', brightness: 80, contrast: 120 });
  assert.equal(await prefs.getSiteAppearance('other.org'), null);
  await prefs.setSiteAppearance('example.com', null);
  assert.equal(await prefs.getSiteAppearance('example.com'), null);
});

test('site names like __proto__ are not special', async () => {
  assert.equal(await prefs.getSiteAppearance('__proto__'), null);
  assert.equal(await prefs.getSiteAppearance('constructor'), null);
});

test('site list is capped at 200 hosts, oldest dropped', async () => {
  for (let i = 0; i < 205; i++) {
    await prefs.setSiteAppearance(`h${i}.test`, { mode: 'original', brightness: 100, contrast: 100 });
  }
  assert.equal(Object.keys(store.nivraSites).length, 200);
  assert.equal(await prefs.getSiteAppearance('h0.test'), null);
  assert.ok(await prefs.getSiteAppearance('h204.test'));
});

test('every profile uses a valid mode and in-range sliders', () => {
  for (const p of Object.values(prefs.PROFILES)) {
    assert.ok(['smart-dark', 'original', 'true-invert', 'grayscale', 'high-contrast'].includes(p.mode));
    assert.ok(p.brightness >= 50 && p.brightness <= 150);
    assert.ok(p.contrast >= 50 && p.contrast <= 150);
  }
});
