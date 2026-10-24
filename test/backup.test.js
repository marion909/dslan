'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/db');
const backup = require('../src/backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'twlan-bk-'));

test('a backup is a readable copy and old ones are pruned', () => {
  const dir = tmp();
  const db = open(':memory:');
  db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('alice', 'x', 0)").run();
  const files = [];
  for (let i = 0; i < 5; i++) files.push(backup.run(db, { dir, keep: 3, now: new Date(2026, 0, 1, 10, i) }));
  assert.deepEqual(backup.list(dir).map((b) => b.name).sort(), files.slice(2).map((f) => path.basename(f)));
  const copy = new (require('node:sqlite').DatabaseSync)(files[4]);
  assert.equal(copy.prepare("SELECT name FROM user").get().name, 'alice');
  copy.close();
  assert.equal(backup.resolve('../../etc/passwd', dir), null, 'no path tricks');
  assert.ok(backup.resolve(path.basename(files[4]), dir));
  fs.rmSync(dir, { recursive: true });
});

test('the timer only backs up when the last copy is old enough and the setting is on', () => {
  const dir = tmp();
  const db = open(':memory:');
  const on = { backupEnabled: '1', backupHours: '24', backupKeep: '5' };
  assert.equal(backup.maybeRun(db, { ...on, backupEnabled: '0' }, { dir }), null, 'disabled');
  const first = backup.maybeRun(db, on, { dir, now: Date.now() });
  assert.ok(first);
  assert.equal(backup.maybeRun(db, on, { dir, now: Date.now() + 3600e3 }), null, 'one hour later: too early');
  assert.ok(backup.maybeRun(db, on, { dir, now: Date.now() + 25 * 3600e3 }), 'a day later');
  fs.rmSync(dir, { recursive: true });
});
