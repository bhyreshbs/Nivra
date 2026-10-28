// Builds the Opera Add-ons submission. Opera uses the Chromium package (package.js), but its
// store rejects some binary file types PDF.js ships (it reported pdfjs/web/standard_fonts/*.pfb;
// .bcmap, .ttf and .icc are the same kind of data). So this copies dist/ to dist-opera/ and:
//   - stores each standard font and CMap as base64 text next to its name (<file>.txt),
//   - drops the CMYK ICC profile (PDF.js falls back to its built-in CMYK conversion),
//   - sets ENCODED_BINARY_DATA in viewer/build-flags.js so the viewer loads that layout
//     (see viewer/binary-data.js).
// Output: dist-opera/ and nivra-opera-<version>.zip. dist/ and the Chromium zip are untouched.
// Run via `npm run package:opera` (after `npm run build`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
const out = path.join(root, 'dist-opera');

// Start from a fresh Chromium package.
execFileSync(process.execPath, [path.join(root, 'package.js')], { cwd: root, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(dist, out, { recursive: true });

const ENCODE = [
  { dir: 'pdfjs/web/standard_fonts', ext: /\.(pfb|ttf)$/i },
  { dir: 'pdfjs/web/cmaps',          ext: /\.bcmap$/i },
];
let encoded = 0;
for (const { dir, ext } of ENCODE) {
  for (const name of fs.readdirSync(path.join(out, dir))) {
    if (!ext.test(name)) continue;
    const file = path.join(out, dir, name);
    fs.writeFileSync(`${file}.txt`, fs.readFileSync(file).toString('base64'));
    fs.rmSync(file);
    encoded++;
  }
}

// The ICC profile is fetched synchronously by the PDF.js worker, with no hook to decode it.
fs.rmSync(path.join(out, 'pdfjs', 'web', 'iccs'), { recursive: true, force: true });

const flags = path.join(out, 'viewer', 'build-flags.js');
const flagSrc = fs.readFileSync(flags, 'utf8');
const flagged = flagSrc.replace('export const ENCODED_BINARY_DATA = false;', 'export const ENCODED_BINARY_DATA = true;');
if (flagged === flagSrc) throw new Error('ENCODED_BINARY_DATA flag not found in viewer/build-flags.js');
fs.writeFileSync(flags, flagged);

// Nothing of the rejected kinds may remain.
const listFiles = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? listFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
const leftovers = listFiles(out).filter(f => /\.(pfb|ttf|bcmap|icc)$/i.test(f));
if (leftovers.length) throw new Error('Opera package still contains: ' + leftovers.map(f => path.relative(out, f)).join(', '));

const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const zip = path.join(root, `nivra-opera-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
// See package.js: use the system bsdtar on Windows.
const tarBin = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';
execFileSync(tarBin, ['-a', '-c', '-f', zip, '-C', out, ...fs.readdirSync(out)], { stdio: 'inherit' });

console.log(`dist-opera/ ready (${encoded} font/CMap files encoded, ICC profile dropped), packaged ${path.basename(zip)}`);
