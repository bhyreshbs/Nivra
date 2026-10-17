// Builds the store submission: copies only the runtime files into dist/ and zips them
// to nivra-<version>.zip (upload this to Microsoft Partner Center / Edge Add-ons).
// Run via `npm run package`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const INCLUDE = [
  'manifest.json',
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
    // Source-only files that the extension never loads.
    filter: p => !/[\\/]viewer[\\/]input\.css$/.test(p)
      && !/\.md$/i.test(p)
      // Inter font package extras the viewer never loads (woff2 is used; legacy woff / scss / typings are not)
      && !/[\\/]fonts[\\/]inter[\\/].*(\.woff$|\.scss$|\.d\.css\.ts$|[\\/]metadata\.json$|[\\/]unicode\.json$|[\\/]package\.json$)/.test(p),
  });
}

// Licences that must ship with the package (Apache-2.0 requires PDF.js's to travel with it).
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'LICENSE'), path.join(dist, 'pdfjs', 'LICENSE'));

// Sanity checks the store would otherwise find for us.
const distManifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const refs = [
  ...Object.values(distManifest.icons || {}),
  ...Object.values(distManifest.action?.default_icon || {}),
  distManifest.action?.default_popup,
  distManifest.background?.service_worker,
  ...(distManifest.web_accessible_resources || []).flatMap(r => r.resources),
].filter(Boolean);
const missing = refs.filter(r => !fs.existsSync(path.join(dist, r)));
if (missing.length) throw new Error('Manifest references missing files: ' + missing.join(', '));
if (!fs.existsSync(path.join(dist, '_locales', distManifest.default_locale, 'messages.json'))) {
  throw new Error('default_locale has no messages.json');
}

const zip = path.join(root, `nivra-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
// bsdtar (Windows 10+, macOS) writes a zip with -a; entries use forward slashes.
// On Windows use the system bsdtar explicitly: under Git Bash, "tar" is GNU tar, which can
// neither write zips nor accept "C:\..." paths.
const tarBin = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';
execFileSync(tarBin, ['-a', '-c', '-f', zip, '-C', dist, ...fs.readdirSync(dist)], { stdio: 'inherit' });

console.log(`dist/ ready, packaged ${path.basename(zip)}`);
