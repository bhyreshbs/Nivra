import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 15));

// ─── sw.js: setup window and badge (Chromium) ─────────────────────────────────
function loadSw({ fileAccess, ua = 'Mozilla/5.0 Chrome/147.0 Safari/537.36' }) {
  const L = {};
  const on = n => ({ addListener: f => { L[n] = f; } });
  const calls = { windows: [], tabs: [], badge: [], badgeColor: [] };
  const chrome = {
    runtime: {
      getURL: p => `chrome-extension://id/${p}`, getManifest: () => ({ version: '1.7.1' }),
      setUninstallURL() {}, onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'),
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    extension: { isAllowedFileSchemeAccess: cb => cb(fileAccess) },
    tabs: { create: async o => { calls.tabs.push(o.url); }, update: async () => {}, onUpdated: on('tabsUpdated') },
    windows: { create: async o => { calls.windows.push(o); } },
    action: {
      setBadgeText: async o => { calls.badge.push(o.text); },
      setBadgeBackgroundColor: async o => { calls.badgeColor.push(o.color); },
    },
  };
  vm.runInNewContext(read('background/sw.js'), { chrome, navigator: { userAgent: ua }, console });
  return { L, calls };
}

test('Chromium install opens the setup window and a red badge when file access is off', async () => {
  const { L, calls } = loadSw({ fileAccess: false });
  await L.installed({ reason: 'install' });
  await tick();
  assert.equal(calls.windows.length, 1);
  assert.equal(calls.windows[0].url, 'chrome-extension://id/setup/setup.html');
  assert.equal(calls.windows[0].type, 'popup');
  assert.deepEqual(calls.badge, ['!']);
  assert.deepEqual(calls.badgeColor, ['#d93025']);
  assert.ok(calls.tabs.some(u => u.includes('welcome.html')), 'welcome page still opens');
});

test('an update does not reopen the setup window but keeps the badge accurate', async () => {
  const { L, calls } = loadSw({ fileAccess: false });
  await L.installed({ reason: 'update' });
  await tick();
  assert.equal(calls.windows.length, 0);
  assert.deepEqual(calls.badge, ['!']);
});

test('the badge clears once file access is allowed', async () => {
  const { L, calls } = loadSw({ fileAccess: true });
  await L.startup();
  await tick();
  assert.deepEqual(calls.badge, ['']);
  assert.deepEqual(calls.badgeColor, []);
});

test('GET_FILE_ACCESS answers and refreshes the badge', async () => {
  const { L, calls } = loadSw({ fileAccess: false });
  const reply = await new Promise(resolve => L.message({ type: 'GET_FILE_ACCESS' }, {}, resolve));
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { allowed: false });
  assert.deepEqual(calls.badge, ['!']);
});

test('falls back to a tab when windows.create fails', async () => {
  const L = {};
  const on = n => ({ addListener: f => { L[n] = f; } });
  const tabs = [];
  const chrome = {
    runtime: { getURL: p => `chrome-extension://id/${p}`, getManifest: () => ({ version: '1' }), setUninstallURL() {},
      onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    extension: { isAllowedFileSchemeAccess: cb => cb(false) },
    tabs: { create: async o => { tabs.push(o.url); }, update: async () => {}, onUpdated: on('u') },
    windows: { create: async () => { throw new Error('no windows'); } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  vm.runInNewContext(read('background/sw.js'), { chrome, navigator: { userAgent: 'Chrome/147' }, console });
  await L.installed({ reason: 'install' });
  await tick();
  assert.ok(tabs.includes('chrome-extension://id/setup/setup.html'));
});

// ─── setup.js: the window itself ──────────────────────────────────────────────
function runSetup({ ua, reply, granted = false, origins = ['*://*/*.pdf*', 'file:///*/*.pdf*'] }) {
  const el = {};
  const get = id => el[id] || (el[id] = {
    id, hidden: false, textContent: '', onclick: null, children: [], dataset: {},
    replaceChildren() { this.children = []; }, append(n) { this.children.push(n); },
    addEventListener() {},
  });
  ['card', 'badge', 'title', 'lead', 'steps', 'primary', 'close', 'hint'].forEach(get);
  const created = [];
  const permCalls = [];
  const api = {
    runtime: {
      id: 'ext-id', getManifest: () => ({ host_permissions: origins }),
      sendMessage: (_m, cb) => cb(reply),
    },
    tabs: { create: o => created.push(o.url) },
    permissions: {
      contains: async () => granted,
      request: async o => { permCalls.push(o); granted = true; return true; },
    },
  };
  const intervals = [];
  vm.runInNewContext(read('setup/setup.js'), {
    chrome: api, navigator: { userAgent: ua }, window: { addEventListener() {}, close() {} },
    document: { getElementById: get, createElement: () => ({ children: [], append(n) { this.children.push(n); }, textContent: '' }),
      createTextNode: t => ({ textContent: t }), addEventListener() {}, hidden: false },
    setInterval: (f, ms) => { intervals.push(ms); return 1; }, clearInterval() {}, console,
  });
  return { el, created, permCalls, intervals };
}

const CHROME = 'Mozilla/5.0 Chrome/147.0 Safari/537.36';
const EDGE = CHROME + ' Edg/147.0';
const OPERA = CHROME + ' OPR/131.0';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; rv:145.0) Gecko/20100101 Firefox/145.0';

test('setup window is red and polls while local files are not allowed', async () => {
  const p = runSetup({ ua: CHROME, reply: { allowed: false } });
  await tick();
  assert.equal(p.el.card.dataset.state, 'needed');
  assert.equal(p.el.badge.textContent, '!');
  assert.match(p.el.title.textContent, /allow local files/);
  assert.equal(p.el.primary.hidden, false);
  assert.equal(p.el.close.hidden, true);
  assert.deepEqual(p.intervals, [1500]);
});

test('the settings button opens the right extensions page per browser', async () => {
  for (const [ua, scheme] of [[CHROME, 'chrome'], [EDGE, 'edge'], [OPERA, 'opera']]) {
    const p = runSetup({ ua, reply: { allowed: false } });
    await tick();
    p.el.primary.onclick();
    assert.deepEqual(p.created, [`${scheme}://extensions/?id=ext-id`], scheme);
  }
});

test('setup window turns green when local files are allowed', async () => {
  const p = runSetup({ ua: EDGE, reply: { allowed: true } });
  await tick();
  assert.equal(p.el.card.dataset.state, 'done');
  assert.equal(p.el.badge.textContent, '✓');
  assert.equal(p.el.primary.hidden, true);
  assert.equal(p.el.close.hidden, false);
  assert.deepEqual(p.intervals, []);
});

test('Firefox asks for site access, never for file URLs', async () => {
  const p = runSetup({ ua: FIREFOX, reply: { allowed: false, unsupported: true } });
  await tick();
  assert.equal(p.el.card.dataset.state, 'needed');
  assert.match(p.el.title.textContent, /allow site access/);
  assert.equal(p.el.primary.textContent, 'Allow site access');
  await p.el.primary.onclick();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(p.permCalls)), [{ origins: ['*://*/*.pdf*'] }], 'file:// origins are not requested');
  assert.equal(p.el.card.dataset.state, 'done');
});

test('setup files ship in both packages', () => {
  assert.match(read('package.js'), /'setup',/);
  assert.match(read('package-firefox.js'), /'setup',/);
});
