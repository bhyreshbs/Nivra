import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs the feedback script from docs/goodbye.html against a stub page.
const html = readFileSync(new URL('../docs/goodbye.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const feedback = scripts.find(s => s.includes('FEEDBACK_KEY'));

function page({ key = '', fetchImpl = null, message = 'It crashed', email = '' } = {}) {
  const el = {};
  const get = id => el[id] || (el[id] = {
    id, value: '', hidden: true, href: '', textContent: '', className: '', disabled: false,
    _l: {}, addEventListener(t, f) { this._l[t] = f; }, focus() {}, reset() {},
  });
  ['fb', 'fb-reason', 'fb-message', 'fb-email', 'fb-website', 'fb-send', 'fb-fallback',
    'fb-mail', 'fb-gmail', 'fb-copy', 'fb-status'].forEach(get);
  el['fb-reason'].value = 'Something was broken';
  el['fb-message'].value = message;
  el['fb-email'].value = email;
  const src = feedback.replace(/var FEEDBACK_KEY = '[^']*';/, `var FEEDBACK_KEY = '${key}';`);
  vm.runInNewContext(src, {
    document: { getElementById: get }, location: { search: '?v=1.7.0&b=opera' },
    URLSearchParams, navigator: {}, fetch: fetchImpl, encodeURIComponent, setTimeout,
  });
  return { el, submit: () => el.fb._l.submit({ preventDefault() {} }) };
}
const tick = () => new Promise(r => setTimeout(r, 10));

test('goodbye page has the form and no bare mailto button', () => {
  assert.ok(feedback, 'feedback script present');
  assert.match(html, /<form class="fb" id="fb"/);
  assert.doesNotMatch(html, /class="btn" href="mailto:/);
});

test('without a key it prepares mail app, Gmail and copy options', () => {
  const p = page({ email: 'me@example.com' });
  p.submit();
  assert.equal(p.el['fb-fallback'].hidden, false);
  const mail = p.el['fb-mail'].href;
  assert.ok(mail.startsWith('mailto:support@bhyresh.me?subject='));
  const body = decodeURIComponent(mail.split('&body=')[1]);
  assert.match(body, /It crashed/);
  assert.match(body, /Nivra 1\.7\.0 \/ opera/);
  assert.match(body, /Reply to: me@example\.com/);
  assert.ok(p.el['fb-gmail'].href.startsWith('https://mail.google.com/mail/?view=cm'));
});

test('an empty note is rejected', () => {
  const p = page({ message: '   ' });
  p.submit();
  assert.match(p.el['fb-status'].textContent, /write a short note/);
  assert.equal(p.el['fb-fallback'].hidden, true);
});

test('with a key it posts to Web3Forms and confirms', async () => {
  let sent;
  const p = page({ key: 'KEY123', fetchImpl: async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { json: async () => ({ success: true }) };
  } });
  p.submit();
  await tick();
  assert.equal(sent.url, 'https://api.web3forms.com/submit');
  assert.equal(sent.body.access_key, 'KEY123');
  assert.match(sent.body.message, /It crashed/);
  assert.match(p.el['fb-status'].textContent, /Thank you/);
  assert.equal(p.el['fb-fallback'].hidden, true);
  assert.equal(p.el['fb-send'].disabled, false);
});

test('a failed send falls back to the mail options', async () => {
  const p = page({ key: 'KEY123', fetchImpl: async () => { throw new Error('offline'); } });
  p.submit();
  await tick();
  assert.equal(p.el['fb-fallback'].hidden, false);
  assert.match(p.el['fb-status'].textContent, /Could not send/);
  assert.equal(p.el['fb-send'].disabled, false);
});

test('the bot honeypot blocks the send', async () => {
  let called = false;
  const p = page({ key: 'KEY123', fetchImpl: async () => { called = true; return { json: async () => ({ success: true }) }; } });
  p.el['fb-website'].value = 'spam';
  p.submit();
  await tick();
  assert.equal(called, false);
});
