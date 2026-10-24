'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config');

const DIR = process.env.BACKUP_DIR || path.join(ROOT, 'data', 'backups');
const NAME_RE = /^twlan-\d{8}-\d{6}\.db$/;

const stamp = (d = new Date()) => {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// A consistent copy made by SQLite itself (safe while the game is running).
function run(db, { dir = DIR, keep = 7, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `twlan-${stamp(now)}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // Oldest copies go first; the file name sorts by time.
  const all = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

function list(dir = DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse()
    .map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size, time: fs.statSync(path.join(dir, name)).mtimeMs / 1000 }));
}

const resolve = (name, dir = DIR) => (NAME_RE.test(name) ? path.join(dir, name) : null);

// Backs up when the last copy is older than the configured interval.
function maybeRun(db, settings, { dir = DIR, now = Date.now() } = {}) {
  if (settings.backupEnabled !== '1') return null;
  const hours = Math.max(1, Number(settings.backupHours) || 24);
  const last = list(dir)[0];
  if (last && now / 1000 - last.time < hours * 3600) return null;
  return run(db, { dir, keep: Number(settings.backupKeep) || 7, now: new Date(now) });
}

module.exports = { DIR, run, list, resolve, maybeRun };
