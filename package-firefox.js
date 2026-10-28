// Builds the Firefox (addons.mozilla.org) submission: the same runtime files as package.js,
// with manifest.firefox.json shipped as manifest.json. Output goes to dist-firefox/ and
// nivra-firefox-<version>.zip, so the Chrome/Edge dist/ and zip are never touched.
// Run via `npm run package:firefox` (after `npm run build`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist-firefox');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
const chromiumVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;

// The two manifests are edited by hand; refuse to ship mismatched versions.
if (manifest.version !== chromiumVersion) {
  throw new Error(`manifest.firefox.json version ${manifest.version} != manifest.json version ${chromiumVersion}`);
}

// Same list as package.js, minus manifest.json (written separately below).
const INCLUDE = [
  '_locales',
  'assets/Logo.png',
  'assets/icon16.png',
  'assets/icon48.png',
  'assets/icon128.png',
  'background',
  'popup',
  'settings',
  'transformations',
  'viewer',
  'pdfjs',
];

fs.rmSync(dist, { recursive: true, force: true });
for (const entry of INCLUDE) {
  const src = path.join(root, entry);
  if (!fs.existsSync(src)) throw new Error(`Missing: ${entry} (run "npm run build" first)`);
  fs.cpSync(src, path.join(dist, entry), {
    recursive: true,
    // Same exclusions as package.js.
    filter: p => !/[\\/]viewer[\\/]input\.css$/.test(p)
      && !/\.md$/i.test(p)
      && !/[\\/]fonts[\\/]inter[\\/].*(\.woff$|\.scss$|\.d\.css\.ts$|[\\/]metadata\.json$|[\\/]unicode\.json$|[\\/]package\.json$)/.test(p),
  });
}
fs.copyFileSync(path.join(root, 'manifest.firefox.json'), path.join(dist, 'manifest.json'));

fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'LICENSE'), path.join(dist, 'pdfjs', 'LICENSE'));

// Sanity checks AMO would otherwise find for us.
const refs = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  ...(manifest.background?.scripts || []),
  ...(manifest.web_accessible_resources || []).flatMap(r => r.resources),
].filter(Boolean);
const missing = refs.filter(r => !fs.existsSync(path.join(dist, r)));
if (missing.length) throw new Error('Manifest references missing files: ' + missing.join(', '));
if (!fs.existsSync(path.join(dist, '_locales', manifest.default_locale, 'messages.json'))) {
  throw new Error('default_locale has no messages.json');
}
if (!manifest.browser_specific_settings?.gecko?.id) throw new Error('Firefox manifest needs a gecko id');

const zip = path.join(root, `nivra-firefox-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
// See package.js: use the system bsdtar on Windows.
const tarBin = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';
execFileSync(tarBin, ['-a', '-c', '-f', zip, '-C', dist, ...fs.readdirSync(dist)], { stdio: 'inherit' });

console.log(`dist-firefox/ ready, packaged ${path.basename(zip)}`);
