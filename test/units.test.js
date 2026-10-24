'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const v = require('../src/game/village');
const u = require('../src/game/units');

function setup() {
  const db = open(':memory:');
  db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('a','x',0)").run();
  const id = v.createVillage(db, { userId: 1, name: 'D', x: 500, y: 500 });
  db.prepare('UPDATE village SET wood=50000, stone=50000, iron=50000 WHERE id=?').run(id);
  db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'barracks', 3) ON CONFLICT(village_id, building) DO UPDATE SET level=3").run(id);
  return { db, id };
}

test('spear is recruitable from the start, axe needs smithy and research', () => {
  const { db, id } = setup();
  const lv = v.getBuildings(db, id);
  assert.ok(u.isRecruitable(db, id, lv, 'spear'));
  assert.ok(!u.isRecruitable(db, id, lv, 'axe'));
  assert.equal(u.canResearch(db, id, lv, 'axe'), 'requirements'); // smith level 2 needed
});

test('training deducts cost and units arrive one by one', () => {
  const { db, id } = setup();
  assert.ok(u.enqueueTraining(db, id, { spear: 10 }).ok);
  const q = u.getTrainQueue(db, id)[0];
  assert.equal(q.amount, 10);
  u.processTraining(db, id, q.start_at + q.per_unit * 4.5);
  assert.equal(u.getUnits(db, id).spear, 4);
  assert.equal(u.getTrainQueue(db, id)[0].amount, 6);
  u.processTraining(db, id, q.finish_at + 1);
  assert.equal(u.getUnits(db, id).spear, 10);
  assert.equal(u.getTrainQueue(db, id).length, 0);
});

test('units and queued units count against population; orders are all-or-nothing', () => {
  const { db, id } = setup();
  const before = v.popUsed(v.getBuildings(db, id), [], v.unitPop(db, id));
  u.enqueueTraining(db, id, { spear: 5 });
  assert.equal(v.popUsed(v.getBuildings(db, id), [], v.unitPop(db, id)), before + 5);
  const r = u.enqueueTraining(db, id, { spear: 1, axe: 1 });
  assert.equal(r.error, 'requirements');
  assert.equal(u.getTrainQueue(db, id).length, 1);
});

test('cancel refunds 90% of the unfinished part', () => {
  const { db, id } = setup();
  u.enqueueTraining(db, id, { spear: 10 });
  const q = u.getTrainQueue(db, id)[0];
  assert.ok(u.cancelTraining(db, id, q.id).ok);
  assert.equal(Math.round(db.prepare('SELECT wood FROM village WHERE id=?').get(id).wood), 50000 - 50 * 10 + 450);
  assert.equal(u.getTrainQueue(db, id).length, 0);
});

test('research unlocks a unit once the smithy requirement is met', () => {
  const { db, id } = setup();
  db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'smith', 2) ON CONFLICT(village_id, building) DO UPDATE SET level=2").run(id);
  assert.ok(u.enqueueResearch(db, id, 'axe').ok);
  const q = u.getResearchQueue(db, id)[0];
  u.processResearch(db, id, q.finish_at + 1);
  assert.equal(u.researchLevel(db, id, 'axe'), 1);
  assert.ok(u.isRecruitable(db, id, v.getBuildings(db, id), 'axe'));
});
