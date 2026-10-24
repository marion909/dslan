'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const v = require('../src/game/village');
const u = require('../src/game/units');
const c = require('../src/game/commands');

function setup() {
  const db = open(':memory:');
  db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('a','x',0)").run();
  const mine = v.createVillage(db, { userId: 1, name: 'Mine', x: 500, y: 500 });
  const barb = v.createVillage(db, { userId: null, name: 'Barb', x: 503, y: 504 });
  db.prepare("INSERT INTO village_unit VALUES (?, 'axe', 100), (?, 'spear', 50)").run(mine, mine);
  db.prepare("INSERT INTO village_unit VALUES (?, 'spear', 5)").run(barb);
  db.prepare('UPDATE village SET wood=3000, stone=3000, iron=3000 WHERE id=?').run(barb);
  return { db, mine, barb };
}

test('send removes units, validates them and travel time follows distance', () => {
  const { db, mine, barb } = setup();
  assert.equal(c.send(db, { userId: 1, fromId: mine, toId: barb, units: { axe: 500 } }).error, 'notEnoughTroops');
  assert.equal(c.send(db, { userId: 1, fromId: mine, toId: mine, units: { axe: 1 } }).error, 'sameVillage');
  const r = c.send(db, { userId: 1, fromId: mine, toId: barb, units: { axe: 60, spear: 10 } });
  assert.ok(r.ok);
  assert.equal(u.getUnits(db, mine).axe, 40);
  const cmd = c.getCommand(db, r.id);
  assert.ok(Math.abs((cmd.arrive_at - cmd.depart_at) - c.travelSeconds({ axe: 1, spear: 1 }, { x: 500, y: 500 }, { x: 503, y: 504 })) < 1e-6);
});

test('arrival fights, loots, reports and sends survivors home with the loot', () => {
  const { db, mine, barb } = setup();
  const r = c.send(db, { userId: 1, fromId: mine, toId: barb, units: { axe: 60 } });
  c.processDue(db, r.arriveAt + 1, () => 0.5);
  assert.equal(u.getUnits(db, barb).spear, 0);
  const reports = c.getReports(db, 1);
  assert.equal(reports.length, 1);
  assert.ok(reports[0].data.win);
  const back = c.listCommands(db, "type = 'return'")[0];
  assert.ok(back && back.loot.wood > 0);
  const before = db.prepare('SELECT wood FROM village WHERE id=?').get(mine).wood;
  c.processDue(db, back.arrive_at + 1);
  assert.ok(u.getUnits(db, mine).axe >= 40 + 55);
  assert.ok(db.prepare('SELECT wood FROM village WHERE id=?').get(mine).wood > before);
});

test('protected players cannot be attacked, cancelling brings units back', () => {
  const { db, mine } = setup();
  db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('b','x',?)").run(Math.floor(Date.now() / 1000));
  const other = v.createVillage(db, { userId: 2, name: 'Other', x: 510, y: 510 });
  assert.equal(c.send(db, { userId: 1, fromId: mine, toId: other, units: { axe: 5 } }).error, 'protected');
  const { barb } = { barb: v.createVillage(db, { userId: null, name: 'B2', x: 520, y: 520 }) };
  const r = c.send(db, { userId: 1, fromId: mine, toId: barb, units: { axe: 5 } });
  assert.ok(c.cancel(db, 1, r.id).ok);
  assert.equal(c.getCommand(db, r.id).type, 'return');
});
