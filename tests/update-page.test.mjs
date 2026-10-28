import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 15));

// ─── The extension opens docs/update.html after an update ─────────────────────
function loadSw(ua = 'Mozilla/5.0 Chrome/147.0 Safari/537.36') {
  const L = {};
  const on = n => ({ addListener: f => { L[n] = f; } });
  const tabs = [];
  const chrome = {
    runtime: { getURL: p => `chrome-extension://id/${p}`, getManifest: () => ({ version: '1.7.1' }), setUninstallURL() {},
      onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    extension: { isAllowedFileSchemeAccess: cb => cb(true) },
    tabs: { create: async o => { tabs.push(o.url); }, update: async () => {}, onUpdated: on('u') },
    windows: { create: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  vm.runInNewContext(read('background/sw.js'), { chrome, navigator: { userAgent: ua }, console });
  return { L, tabs };
}

test('an update opens the update page with the new and old version', async () => {
  const { L, tabs } = loadSw();
  await L.installed({ reason: 'update', previousVersion: '1.7.0' });
  await tick();
  assert.deepEqual(tabs, ['https://bhyreshbs.github.io/Nivra/update.html?v=1.7.1&b=chrome&from=1.7.0']);
});

test('the update page carries the browser family', async () => {
  const { L, tabs } = loadSw('Mozilla/5.0 Chrome/147.0 Safari/537.36 OPR/131.0');
  await L.installed({ reason: 'update', previousVersion: '1.7.0' });
  await tick();
  assert.match(tabs[0], /update\.html\?v=1\.7\.1&b=opera&from=1\.7\.0$/);
});

test('browser updates and reloads of the same version do not open it', async () => {
  for (const details of [{ reason: 'chrome_update' }, { reason: 'update', previousVersion: '1.7.1' }]) {
    const { L, tabs } = loadSw();
    await L.installed(details);
    await tick();
    assert.deepEqual(tabs, [], JSON.stringify(details));
  }
});

test('a fresh install opens the welcome page, not the update page', async () => {
  const { L, tabs } = loadSw();
  await L.installed({ reason: 'install' });
  await tick();
  assert.ok(tabs.some(u => u.includes('welcome.html')));
  assert.ok(tabs.every(u => !u.includes('update.html')));
});

// ─── docs/update.html ─────────────────────────────────────────────────────────
test('update.html lists the current version first and it is in the changelog', () => {
  const html = read('docs/update.html');
  const version = JSON.parse(read('manifest.json')).version;
  const versions = [...html.matchAll(/<section class="card release" data-v="([\d.]+)"/g)].map(m => m[1]);
  assert.equal(versions[0], version);
  assert.match(read('CHANGELOG.md'), new RegExp('## ' + version.replace(/\./g, '\\.')));
  assert.equal(JSON.parse(read('manifest.firefox.json')).version, version);
});

function runUpdatePage(search, ua) {
  const html = read('docs/update.html');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop();
  const el = {};
  const get = id => el[id] || (el[id] = { id, textContent: '', hidden: false, addEventListener() {} });
  const releases = ['1.7.1', '1.7.0', '1.6.1'].map(v => ({ v, style: {}, getAttribute: () => v }));
  vm.runInNewContext(js, {
    location: { search }, URLSearchParams, navigator: { userAgent: ua },
    document: { getElementById: get, querySelectorAll: () => releases }, Array,
    setTimeout,
  });
  return { el, releases };
}

test('update.html shows the new version, the old one and highlights the release', () => {
  const p = runUpdatePage('?v=1.7.1&from=1.7.0&b=edge', 'Chrome/147');
  assert.equal(p.el.ver.textContent, '1.7.1');
  assert.match(p.el.lead.textContent, /Updated from 1\.7\.0/);
  assert.ok(p.releases[0].style.borderColor);
  assert.equal(p.releases[1].style.borderColor, undefined);
  assert.equal(p.el['ext-url'].textContent, 'edge://extensions');
});

test('update.html shows the Firefox note instead of the file-URL note on Firefox', () => {
  const p = runUpdatePage('?v=1.7.1&b=firefox', 'Firefox/145.0');
  assert.equal(p.el['local-note'].hidden, true);
  assert.equal(p.el['ff-note'].hidden, false);
});

test('update.html ignores junk in the version parameters', () => {
  const p = runUpdatePage('?v=1.7.1<script>&from=%3Cimg%3E', 'Chrome/147');
  assert.equal(p.el.ver.textContent, '1.7.1');
  assert.doesNotMatch(p.el.lead?.textContent ?? '', /</);
});
