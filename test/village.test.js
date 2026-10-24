'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const v = require('../src/game/village');
const f = require('../src/game/formulas');
const cfg = require('../src/config');

function setup() {
  const db = open(':memory:');
  db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('a','x',0)").run();
  const id = v.createVillage(db, { userId: 1, name: 'Dorf', x: 500, y: 500 });
  return { db, id };
}

test('new village gets start levels and 500 of each resource', () => {
  const { db, id } = setup();
  const lv = v.getBuildings(db, id);
  assert.equal(lv.main, cfg.buildings.main.startLevel);
  assert.equal(lv.barracks, 0);
  const row = db.prepare('SELECT * FROM village WHERE id=?').get(id);
  assert.equal(row.wood, 500);
});

test('building costs grow geometrically and build time shrinks with HQ level', () => {
  assert.equal(f.buildCost('main', 'wood', 1), 90);
  assert.ok(f.buildCost('main', 'wood', 2) > 90);
  assert.ok(f.buildTime('barracks', 1, 10) < f.buildTime('barracks', 1, 1));
});

test('enqueue deducts cost, completes after finish time and raises the level', () => {
  const { db, id } = setup();
  db.prepare('UPDATE village SET wood=5000, stone=5000, iron=5000 WHERE id=?').run(id);
  const before = v.getBuildings(db, id).wood;
  const r = v.enqueueBuild(db, id, 'wood');
  assert.ok(r.ok);
  assert.equal(r.level, before + 1);
  assert.equal(v.getQueue(db, id).length, 1);
  v.processQueue(db, id, r.finishAt + 1);
  assert.equal(v.getBuildings(db, id).wood, before + 1);
  assert.equal(v.getQueue(db, id).length, 0);
});

test('requirements and resources are enforced', () => {
  const { db, id } = setup();
  db.prepare('UPDATE village SET wood=0, stone=0, iron=0 WHERE id=?').run(id);
  assert.equal(v.enqueueBuild(db, id, 'wood').error, 'resources');
  db.prepare('UPDATE village SET wood=99999, stone=99999, iron=99999 WHERE id=?').run(id);
  v.processQueue(db, id);
  assert.equal(v.enqueueBuild(db, id, 'wall').error, 'requirements');
});

test('cancel refunds and removes the order', () => {
  const { db, id } = setup();
  db.prepare('UPDATE village SET wood=5000, stone=5000, iron=5000 WHERE id=?').run(id);
  v.enqueueBuild(db, id, 'wood');
  const q = v.getQueue(db, id)[0];
  assert.ok(v.cancelBuild(db, id, q.id).ok);
  assert.equal(db.prepare('SELECT wood FROM village WHERE id=?').get(id).wood, 5000);
  assert.equal(v.getQueue(db, id).length, 0);
});

test('resources accrue per hour and cap at warehouse size', () => {
  const { db, id } = setup();
  const lv = v.getBuildings(db, id);
  const perHour = v.hourlyProduction(lv, 'wood');
  assert.ok(perHour > 0);
  const t = Date.now() / 1000 + 3600;
  const village = v.processQueue(db, id, t);
  assert.ok(Math.abs(village.wood - Math.min(500 + perHour, v.storageMax(lv))) < 1);
  const far = v.processQueue(db, id, t + 1e7);
  assert.equal(far.wood, v.storageMax(lv));
});
