import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Welcome, What's new and Privacy share one navbar: same three links, the current page marked.
const PAGES = { 'welcome.html': 'Welcome', 'update.html': "What's new", 'privacy.html': 'Privacy' };
const links = file => {
  const html = readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');
  const nav = html.match(/<div class="nav-links">([\s\S]*?)<\/div>/)[1];
  return [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)]
    .map(m => ({ href: m[1], current: !!m[2], text: m[3] }));
};

for (const [file, label] of Object.entries(PAGES)) {
  test(`${file} navbar has all three links with itself marked current`, () => {
    const l = links(file);
    assert.deepEqual(l.map(x => x.href), Object.keys(PAGES));
    assert.deepEqual(l.map(x => x.text), Object.values(PAGES));
    assert.deepEqual(l.filter(x => x.current).map(x => x.text), [label]);
  });
}
