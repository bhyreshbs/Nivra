// Guards the Chrome/Edge package against unintended changes while other browsers are added.
// Hashes every file in dist/ (the exact contents of the store zip) and compares the result
// with tests/baseline.json. The zip itself is not hashed: it stores timestamps, so it differs
// on every build even when no file has changed.
//
//   node tests/baseline-check.js            rebuild dist/ (npm run package), then compare
//   node tests/baseline-check.js --no-build compare the dist/ already on disk
//   node tests/baseline-check.js --update   rebuild, then save the result as the new baseline
//
// Exits 1 when files were added, removed or changed. Run `npm run build` first if
// node_modules or the Tailwind output have changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const baselineFile = path.join(__dirname, 'baseline.json');
const args = new Set(process.argv.slice(2));

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function hashDist() {
  const files = {};
  for (const file of listFiles(dist)) {
    const rel = path.relative(dist, file).split(path.sep).join('/');
    files[rel] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  // Sorted keys keep baseline.json diffs readable.
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

if (!args.has('--no-build')) {
  execFileSync(process.execPath, [path.join(root, 'package.js')], { cwd: root, stdio: 'inherit' });
}
if (!fs.existsSync(dist)) {
  console.error('dist/ not found: run "npm run package" first.');
  process.exit(1);
}

const current = hashDist();
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;

if (args.has('--update') || !fs.existsSync(baselineFile)) {
  fs.writeFileSync(baselineFile, JSON.stringify({ version, files: current }, null, 2) + '\n');
  console.log(`Baseline saved: ${Object.keys(current).length} files (v${version}) -> tests/baseline.json`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).files;
const added = Object.keys(current).filter(f => !(f in baseline));
const removed = Object.keys(baseline).filter(f => !(f in current));
const changed = Object.keys(current).filter(f => f in baseline && baseline[f] !== current[f]);

for (const [label, list] of [['Added', added], ['Removed', removed], ['Changed', changed]]) {
  if (list.length) console.log(`${label} (${list.length}):\n` + list.map(f => `  ${f}`).join('\n'));
}
if (added.length + removed.length + changed.length === 0) {
  console.log(`Package unchanged: ${Object.keys(current).length} files match tests/baseline.json`);
} else {
  process.exitCode = 1;
}
