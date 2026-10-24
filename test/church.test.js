'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const cfg = require('../src/config');
const church = require('../src/game/church');

test('faith: villages outside a church area fight weaker, only on worlds with churches', () => {
  const db = open(':memory:');
  db.prepare("INSERT INTO user (id, name, password_hash, created_at) VALUES (1, 'a', 'x', 0)").run();
  const village = (id, x, y) => db.prepare("INSERT INTO village (id, user_id, name, x, y, wood, stone, iron, res_updated_at, created_at) VALUES (?, 1, 'v', ?, ?, 0, 0, 0, 0, 0)").run(id, x, y);
  village(1, 500, 500); village(2, 503, 500); village(3, 520, 500);
  const row = (id) => db.prepare('SELECT * FROM village WHERE id = ?').get(id);
  const was = cfg.world.church;
  try {
    cfg.world.church = false;
    assert.equal(church.faithFactor(db, row(3)), 1, 'no churches on this world');
    cfg.world.church = true;
    assert.equal(church.faithFactor(db, row(1)), church.NO_FAITH, 'no church built yet');
    db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (1, 'church', 1)").run();
    assert.equal(church.faithFactor(db, row(1)), 1, 'inside the area');
    assert.equal(church.faithFactor(db, row(2)), 1, 'neighbour within radius 4');
    assert.equal(church.faithFactor(db, row(3)), church.NO_FAITH, 'too far away');
    assert.equal(church.radiusOf(3), 8);
  } finally { cfg.world.church = was; }
});
