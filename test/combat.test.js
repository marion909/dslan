'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/game/combat');

test('overwhelming attackers win and lose only a fraction', () => {
  const r = c.resolve({ attacker: { axe: 200 }, defender: { spear: 10 } });
  assert.ok(r.win);
  assert.equal(r.defenderSurvivors.spear, 0);
  assert.ok(r.attackerSurvivors.axe > 190);
});

test('defenders beat a small attack and the attackers are wiped out', () => {
  const r = c.resolve({ attacker: { axe: 5 }, defender: { spear: 100 } });
  assert.ok(!r.win);
  assert.equal(r.attackerSurvivors.axe, 0);
  assert.ok(r.defenderSurvivors.spear >= 94);
});

test('wall raises defence, luck changes attack, morale shields small villages', () => {
  const base = { attacker: { axe: 100 }, defender: { spear: 100 } };
  assert.ok(c.resolve({ ...base, wallLevel: 10 }).defense > c.resolve(base).defense);
  assert.ok(c.resolve({ ...base, luck: 0.25 }).attack > c.resolve({ ...base, luck: -0.25 }).attack);
  assert.ok(c.morale(1000, 100) < 1);
  assert.equal(c.morale(100, 1000), 1);
  assert.ok(c.morale(1000, 1) >= 0.3);
});

test('rams lower the wall, loot respects hide and carry capacity', () => {
  assert.ok(c.wallAfter(10, 30) < 10);
  assert.equal(c.wallAfter(10, 0), 10);
  const { loot, capacity } = c.loot({ spear: 100 }, { wood: 5000, stone: 5000, iron: 5000 }, 150);
  assert.equal(capacity, 100 * 25);
  assert.equal(loot.wood + loot.stone + loot.iron, 2500);
  const small = c.loot({ spear: 1000 }, { wood: 100, stone: 100, iron: 100 }, 100);
  assert.equal(small.loot.wood, 0);
});
