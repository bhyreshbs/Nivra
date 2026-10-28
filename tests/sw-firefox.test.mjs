import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─── Minimal Firefox `browser` mock that records registered listeners ─────────
const VIEWER = 'moz-extension://1234-uuid/viewer/viewer.html';
const store = {};
const listeners = {};
const created = [];
let webRequestFilter, webRequestExtra;

const on = name => ({ addListener: fn => { listeners[name] = fn; } });

globalThis.browser = {
  storage: {
    local: {
      get: async key => (key in store ? { [key]: store[key] } : {}),
      set: async obj => { Object.assign(store, obj); },
    },
  },
  runtime: {
    getURL: p => `moz-extension://1234-uuid/${p}`,
    getManifest: () => ({ version: '9.9.9' }),
    setUninstallURL: url => { listeners.uninstallUrl = url; },
    onInstalled: on('installed'),
    onStartup: on('startup'),
    onMessage: on('message'),
  },
  tabs: { create: async opts => { created.push(opts.url); } },
  webRequest: {
    onBeforeRequest: {
      addListener: (fn, filter, extra) => {
        listeners.beforeRequest = fn; webRequestFilter = filter; webRequestExtra = extra;
      },
    },
  },
};

// The root package.json marks .js as CommonJS, so load the source as an ES module directly.
const src = readFileSync(new URL('../background/sw.firefox.js', import.meta.url), 'utf8');
const bg = await import('data:text/javascript,' + encodeURIComponent(src));

const req = (url, type = 'main_frame') => listeners.beforeRequest({ url, type });

function sendMessage(message) {
  return new Promise(resolve => {
    const async = listeners.message(message, {}, resolve);
    assert.equal(typeof async, 'boolean');
  });
}

async function reset(stored) {
  for (const k of Object.keys(store)) delete store[k];
  if (stored !== undefined) store.nivraEnabled = stored;
  await listeners.startup();
}

// ─── URL matching ─────────────────────────────────────────────────────────────
test('PDF_URL_RE is identical to the one in background/sw.js', () => {
  const sw = readFileSync(new URL('../background/sw.js', import.meta.url), 'utf8');
  const m = sw.match(/const PDF_URL_RE = \/(.+)\/([a-z]*);/);
  assert.ok(m, 'PDF_URL_RE not found in sw.js');
  assert.equal(bg.PDF_URL_RE.source, m[1]);
  assert.equal(bg.PDF_URL_RE.flags, m[2]);
});

test('matches PDF URLs', () => {
  for (const url of [
    'https://example.com/report.pdf',
    'http://example.com/a/b/report.pdf',
    'https://example.com/Report.PDF',
    'https://example.com/report.Pdf',
    'https://example.com/report.pdf?download=1',
    'https://example.com/report.pdf#page=3',
    'https://example.com/report.pdf?x=1#page=3',
    'file:///C:/docs/report.pdf',
  ]) assert.ok(bg.PDF_URL_RE.test(url), url);
});

test('does not match non-PDF URLs', () => {
  for (const url of [
    'https://example.com/',
    'https://example.com/report.pdfx',
    'https://example.com/report.pdf.html',
    'https://example.com/viewer.html?file=report.pdf',
    'https://example.com/page#section.pdf',
    'ftp://example.com/report.pdf',
    'moz-extension://1234-uuid/viewer/viewer.html?file=https://example.com/a.pdf',
  ]) assert.ok(!bg.PDF_URL_RE.test(url), url);
});

// ─── Redirect listener ────────────────────────────────────────────────────────
test('registers a blocking main_frame listener at load time', () => {
  assert.equal(typeof listeners.beforeRequest, 'function');
  assert.deepEqual(webRequestFilter.types, ['main_frame']);
  assert.deepEqual(webRequestExtra, ['blocking']);
});

test('redirects PDFs to the viewer with the literal URL when enabled', async () => {
  await reset(true);
  const url = 'https://example.com/a b/report.pdf?x=1#page=2';
  assert.deepEqual(await req(url), { redirectUrl: `${VIEWER}?file=${url}` });
});

test('leaves non-PDF and non-main_frame requests alone', async () => {
  await reset(true);
  assert.deepEqual(await req('https://example.com/index.html'), {});
  assert.deepEqual(await req('https://example.com/report.pdf', 'sub_frame'), {});
  assert.deepEqual(await req('https://example.com/report.pdf', 'xmlhttprequest'), {});
});

// ─── Toggle ───────────────────────────────────────────────────────────────────
test('enabled by default when nothing is stored', async () => {
  await reset();
  assert.equal(await bg.isEnabled(), true);
  assert.ok((await req('https://example.com/a.pdf')).redirectUrl);
});

test('stored false disables the redirect after startup', async () => {
  await reset(false);
  assert.equal(await bg.isEnabled(), false);
  assert.deepEqual(await req('https://example.com/a.pdf'), {});
});

test('SET_ENABLED toggles immediately and persists', async () => {
  await reset(true);
  assert.deepEqual(await sendMessage({ type: 'SET_ENABLED', enabled: false }), { success: true, enabled: false });
  assert.equal(store.nivraEnabled, false);
  assert.deepEqual(await req('https://example.com/a.pdf'), {});

  assert.deepEqual(await sendMessage({ type: 'SET_ENABLED', enabled: true }), { success: true, enabled: true });
  assert.equal(store.nivraEnabled, true);
  assert.ok((await req('https://example.com/a.pdf')).redirectUrl);
});

test('GET_ENABLED reports the current state', async () => {
  await reset(false);
  assert.deepEqual(await sendMessage({ type: 'GET_ENABLED' }), { enabled: false });
});

test('GET_FILE_ACCESS reports file access as unsupported', async () => {
  assert.deepEqual(await sendMessage({ type: 'GET_FILE_ACCESS' }), { allowed: false, unsupported: true });
});

test('a state change made while suspended is picked up on the next wake', async () => {
  await reset(true);
  store.nivraEnabled = false; // e.g. written by another context
  await listeners.startup();
  assert.deepEqual(await req('https://example.com/a.pdf'), {});
});

// ─── Install ──────────────────────────────────────────────────────────────────
test('fresh install stores enabled=true, opens welcome and sets the uninstall page', async () => {
  for (const k of Object.keys(store)) delete store[k];
  created.length = 0;
  await listeners.installed({ reason: 'install' });
  assert.equal(store.nivraEnabled, true);
  assert.deepEqual(created, ['https://bhyreshbs.github.io/Nivra/welcome.html?v=9.9.9&b=firefox']);
  assert.equal(listeners.uninstallUrl, 'https://bhyreshbs.github.io/Nivra/goodbye.html?v=9.9.9&b=firefox');
});

test('update keeps a stored false and opens no tab', async () => {
  store.nivraEnabled = false;
  created.length = 0;
  await listeners.installed({ reason: 'update' });
  assert.equal(store.nivraEnabled, false);
  assert.deepEqual(created, []);
  assert.equal(await bg.isEnabled(), false);
});
