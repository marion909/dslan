'use strict';
// Compares public/ with the list of files the game expects (config/assets-manifest.txt).
// `node scripts/check-assets.js --write` regenerates the list; without a flag it reports what is missing.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'config', 'assets-manifest.txt');

function walk(dir, base = '') {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).filter((e) => e.name !== '.DS_Store').flatMap((e) => {
    const rel = path.posix.join(base, e.name);
    return e.isDirectory() ? walk(dir, rel) : [rel];
  });
}

function missing() {
  if (!fs.existsSync(MANIFEST)) return [];
  const expected = fs.readFileSync(MANIFEST, 'utf8').split('\n').filter((f) => f && !f.endsWith('.DS_Store'));
  return expected.filter((f) => !fs.existsSync(path.join(ROOT, 'public', f)));
}

if (require.main === module) {
  if (process.argv.includes('--write')) {
    const files = walk(path.join(ROOT, 'public')).sort();
    fs.writeFileSync(MANIFEST, `${files.join('\n')}\n`);
    console.log(`${files.length} files written to config/assets-manifest.txt`);
  } else {
    const lost = missing();
    if (lost.length) { console.log(`${lost.length} files missing in public/:`); lost.slice(0, 40).forEach((f) => console.log(`  ${f}`)); process.exit(1); }
    console.log('public/ is complete.');
  }
}

module.exports = { missing };
