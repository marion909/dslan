'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const v = require('../src/game/village');
const u = require('../src/game/units');
const c = require('../src/game/commands');
const noble = require('../src/game/noble');

function world() {
  const db = open(':memory:');
  for (const n of ['a', 'b']) db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES (?, 'x', 0)").run(n);
  const A = v.createVillage(db, { userId: 1, name: 'A', x: 500, y: 500 });
  const B = v.createVillage(db, { userId: 2, name: 'B', x: 503, y: 504 });
  const units = (id, army) => { for (const [k, n] of Object.entries(army)) db.prepare('INSERT INTO village_unit VALUES (?,?,?) ON CONFLICT(village_id, unit) DO UPDATE SET count = excluded.count').run(id, k, n); };
  const rich = (id) => db.prepare('UPDATE village SET wood=90000, stone=90000, iron=90000 WHERE id=?').run(id);
  return { db, A, B, units, rich };
}

test('support is stationed, counts for population, defends and can be withdrawn', () => {
  const { db, A, B, units } = world();
  units(A, { spear: 100 }); units(B, { spear: 5 });
  const before = v.unitPop(db, A);
  const r = c.send(db, { userId: 1, fromId: A, toId: B, units: { spear: 100 }, type: 'support' });
  assert.ok(r.ok);
  assert.equal(v.unitPop(db, A), before, 'units on the road still need food');
  c.processDue(db, r.arriveAt + 1);
  assert.equal(c.stationedAt(db, B)[0].units.spear, 100);
  assert.equal(v.unitPop(db, A), before, 'stationed units still need food');
  assert.equal(c.getReports(db, 2, 'support').length, 1);

  // a third party attacks B: the supporters fight too and share the losses
  db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('c', 'x', 0)").run();
  const C = v.createVillage(db, { userId: 3, name: 'C', x: 505, y: 505 });
  units(C, { axe: 30 });
  const atk = c.send(db, { userId: 3, fromId: C, toId: B, units: { axe: 30 } });
  c.processDue(db, atk.arriveAt + 1, () => 0.5);
  const left = c.stationedAt(db, B)[0].units.spear;
  assert.ok(left < 100 && left > 0, `some supporters survive (${left})`);
  assert.ok(c.getReports(db, 1, 'defense').length === 1, 'the supporter gets a report too');

  const rec = c.recall(db, 1, c.stationedAt(db, B)[0].id, null, false);
  assert.ok(rec.ok);
  assert.equal(c.stationedAt(db, B).length, 0);
  const back = c.listCommands(db, "type = 'return' AND to_village = ?", A)[0];
  c.processDue(db, back.arrive_at + 1);
  assert.equal(u.getUnits(db, A).spear, left);
});

test('spy mission reports resources and buildings, and spies can be caught', () => {
  const { db, A, B, units } = world();
  units(A, { spy: 5 });
  const r = c.send(db, { userId: 1, fromId: A, toId: B, units: { spy: 5 } });
  c.processDue(db, r.arriveAt + 1);
  const rep = c.getReports(db, 1, 'attack')[0];
  assert.equal(rep.data.kind, 'spy');
  assert.ok(rep.data.success && rep.data.intel.buildings.main);
  // defender with many spies catches everything
  units(B, { spy: 50 });
  units(A, { spy: 5 });
  const r2 = c.send(db, { userId: 1, fromId: A, toId: B, units: { spy: 5 } });
  c.processDue(db, r2.arriveAt + 1);
  const rep2 = c.getReports(db, 1, 'attack')[0];
  assert.ok(!rep2.data.success);
  assert.equal(c.getReports(db, 2, 'other').length, 1);
});

test('nobles: coins are limited, loyalty drops, the village changes hands', () => {
  const { db, A, B, units, rich } = world();
  rich(A);
  db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'snob', 1) ON CONFLICT(village_id, building) DO UPDATE SET level = 1").run(A);
  assert.equal(noble.summary(db, 1).limit, 1);
  assert.ok(noble.mint(db, A, 1).ok);
  assert.equal(noble.mint(db, A, 1).error, 'limit');
  db.prepare("UPDATE village_building SET level = 25 WHERE building = 'farm' AND village_id = ?").run(A);
  assert.ok(u.enqueueTraining(db, A, { snob: 1 }).ok);
  assert.equal(db.prepare('SELECT coins FROM village WHERE id=?').get(A).coins, 0);
  const q = u.getTrainQueue(db, A)[0];
  u.processTraining(db, A, q.finish_at + 1);
  assert.equal(u.getUnits(db, A).snob, 1);

  units(A, { axe: 400 }); units(A, { snob: 1 });
  // three waves: each noble knocks 20-35 points off, so one noble per wave is not enough; send several waves
  let conquered = false;
  for (let wave = 0; wave < 6 && !conquered; wave++) {
    units(A, { axe: 400, snob: 1 });
    const r = c.send(db, { userId: 1, fromId: A, toId: B, units: { axe: 400, snob: 1 } });
    assert.ok(r.ok, JSON.stringify(r));
    c.processDue(db, r.arriveAt + 1, () => 0.5);
    conquered = db.prepare('SELECT user_id FROM village WHERE id=?').get(B).user_id === 1;
  }
  assert.ok(conquered, 'village B now belongs to player 1');
  assert.equal(db.prepare('SELECT conquered FROM user WHERE id=1').get().conquered, 1);
  assert.equal(noble.summary(db, 1).limit, 2);
  assert.ok(Math.abs(db.prepare('SELECT loyalty FROM village WHERE id=?').get(B).loyalty - c.START_LOYALTY) < 1);
  assert.ok(c.getReports(db, 2, 'defense').length > 0);
});

test('merchants carry 1000 each and trade delivers resources', () => {
  const { db, A, B } = world();
  db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'market', 3) ON CONFLICT(village_id, building) DO UPDATE SET level = 3").run(A);
  db.prepare('UPDATE village SET wood=5000 WHERE id=?').run(A);
  assert.equal(c.sendResources(db, { userId: 1, fromId: A, toId: B, res: { wood: 4000 } }).error, 'merchants');
  const r = c.sendResources(db, { userId: 1, fromId: A, toId: B, res: { wood: 2500 } });
  assert.ok(r.ok);
  assert.equal(r.merchants, 3);
  assert.equal(c.merchantsFree(db, A), 0);
  const cmd = c.listCommands(db, "type = 'trade'")[0];
  c.processDue(db, cmd.arrive_at + 1);
  assert.ok(db.prepare('SELECT wood FROM village WHERE id=?').get(B).wood >= 2285, 'delivered, limited by the warehouse');
  assert.equal(c.merchantsFree(db, A), 0, 'merchants are still travelling back');
  const back = c.listCommands(db, "type = 'trade_back'")[0];
  c.processDue(db, back.arrive_at + 1);
  assert.equal(c.merchantsFree(db, A), 3);
});

test('build queue: surcharge from the second order, demolition, reordering', () => {
  const { db, A, rich } = world();
  rich(A);
  const first = v.enqueueBuild(db, A, 'wood');
  const wood0 = db.prepare('SELECT wood FROM village WHERE id=?').get(A).wood;
  assert.ok(first.ok);
  assert.ok(v.enqueueBuild(db, A, 'stone').ok);
  const spent = wood0 - db.prepare('SELECT wood FROM village WHERE id=?').get(A).wood;
  const base = require('../src/game/formulas').buildCost('stone', 'wood', 6);
  assert.ok(spent > base, 'second order costs extra');
  assert.ok(v.enqueueBuild(db, A, 'iron').ok);
  const waiting = v.getQueue(db, A).slice(1).map((q) => q.building);
  assert.ok(v.reorderBuild(db, A, [1, 0]).ok);
  assert.deepEqual(v.getQueue(db, A).slice(1).map((q) => q.building), [waiting[1], waiting[0]]);
  assert.equal(v.reorderBuild(db, A, [0, 0]).error, 'badOrder');

  const { db: db2, A: A2 } = world();
  assert.equal(v.enqueueDestroy(db2, A2, 'wood').error, 'noDestroy');
  db2.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'main', 15) ON CONFLICT(village_id, building) DO UPDATE SET level = 15").run(A2);
  const d = v.enqueueDestroy(db2, A2, 'wood');
  assert.ok(d.ok);
  v.processQueue(db2, A2, d.finishAt + 1);
  assert.equal(v.getBuildings(db2, A2).wood, 4);
});

test('market offers: escrow, acceptance, cancel refund', () => {
  const m = require('../src/game/market');
  const { db, A, B } = world();
  for (const id of [A, B]) db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'market', 5) ON CONFLICT(village_id, building) DO UPDATE SET level = 5").run(id);
  db.prepare('UPDATE village SET wood=2000, stone=2000, iron=2000 WHERE id IN (?, ?)').run(A, B);
  assert.equal(m.createOffer(db, { userId: 1, villageId: A, sellRes: 'wood', sellAmount: 500, buyRes: 'wood', buyAmount: 500 }).error, 'badResources');
  assert.equal(m.createOffer(db, { userId: 1, villageId: A, sellRes: 'wood', sellAmount: 100, buyRes: 'stone', buyAmount: 900 }).error, 'badRatio');
  const o = m.createOffer(db, { userId: 1, villageId: A, sellRes: 'wood', sellAmount: 500, buyRes: 'stone', buyAmount: 400, multi: 2 });
  assert.ok(o.ok);
  assert.ok(db.prepare('SELECT wood FROM village WHERE id=?').get(A).wood < 1100, 'goods held back');
  assert.equal(m.openOffers(db, B).length, 1);
  assert.equal(m.acceptOffer(db, { userId: 2, villageId: B, offerId: o.id, count: 5 }).error, 'badAmount');
  assert.ok(m.acceptOffer(db, { userId: 2, villageId: B, offerId: o.id, count: 1 }).ok);
  assert.equal(db.prepare('SELECT multi FROM market_offer WHERE id=?').get(o.id).multi, 1);
  assert.equal(c.listCommands(db, "type = 'trade'").length, 2);
  const stone = db.prepare('SELECT stone FROM village WHERE id=?').get(B).stone;
  assert.ok(stone < 1700);
  assert.ok(m.cancelOffer(db, 1, o.id).ok);
  assert.equal(m.ownOffers(db, A).length, 0);
});

test('premium points finish running orders and are never overspent', () => {
  const premium = require('../src/game/premium');
  const { db, A, rich } = world();
  rich(A);
  const b = v.enqueueBuild(db, A, 'wood');
  assert.ok(b.ok);
  assert.equal(premium.finish(db, 1, A, 'build').error, 'noPoints', 'no points, no finishing');
  assert.ok(premium.grant(db, 1, 5, 'Test').ok);
  assert.equal(premium.grant(db, 1, -99, 'zu viel').error, 'noPoints');
  const before = v.getBuildings(db, A).wood;
  const r = premium.finish(db, 1, A, 'build');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(v.getBuildings(db, A).wood, before + 1);
  assert.equal(v.getQueue(db, A).length, 0);
  assert.equal(premium.balance(db, 1), 5 - r.cost);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pp_log').get().n, 2);

  // two orders: finishing the first pulls the second forward
  v.enqueueBuild(db, A, 'stone'); v.enqueueBuild(db, A, 'iron');
  const second = v.getQueue(db, A)[1];
  premium.grant(db, 1, 10, 'Test');
  assert.ok(premium.finish(db, 1, A, 'build').ok);
  const after = v.getQueue(db, A);
  assert.equal(after.length, 1);
  assert.ok(after[0].finish_at < second.finish_at, 'the next order started earlier');

  // training and research
  db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'barracks', 3) ON CONFLICT(village_id, building) DO UPDATE SET level = 3").run(A);
  u.enqueueTraining(db, A, { spear: 5 });
  assert.ok(premium.finishFor(db, 1, A, 'barracks').ok);
  assert.equal(u.getUnits(db, A).spear, 5);
  assert.equal(premium.finishFor(db, 1, A, 'nonsense').error, 'nothing');
  assert.equal(premium.finish(db, 2, A, 'build').error, 'noSource', 'only the owner');
});

test('relics: only the site owner assigns, range and ownership limit the effect, production and defence profit', () => {
  const relics = require('../src/game/relics');
  const { db, A, B, units } = world();
  const far = v.createVillage(db, { userId: 1, name: 'Weit', x: 560, y: 560 });
  const near = v.createVillage(db, { userId: 1, name: 'Nah', x: 510, y: 510 });
  const site = v.createVillage(db, { userId: 1, name: 'Fundort', x: 500, y: 520 });
  db.prepare("INSERT INTO relic (name, effect, bonus, site_village) VALUES ('Test', 'wood', 25, ?)").run(site);
  db.prepare("INSERT INTO relic (name, effect, bonus, site_village) VALUES ('Schild', 'defense', 50, ?)").run(B);

  assert.equal(relics.assign(db, 2, 1, near).error, 'notYours');
  assert.equal(relics.assign(db, 1, 1, far).error, 'tooFar');
  assert.equal(relics.assign(db, 1, 1, B).error, 'noVillage');
  assert.ok(relics.assign(db, 1, 1, near).ok);
  const lv = v.getBuildings(db, near);
  assert.ok(Math.abs(v.rate(db, near, lv, 'wood') - 1.25 * v.hourlyProduction(lv, 'wood')) < 1e-6);
  assert.equal(v.rate(db, near, lv, 'stone'), v.hourlyProduction(lv, 'stone'), 'other resources unchanged');

  // the relic stops working when the site changes hands
  db.prepare('UPDATE village SET user_id = 2 WHERE id = ?').run(site);
  assert.deepEqual(relics.boostFor(db, near), {});
  db.prepare('UPDATE village SET user_id = 1 WHERE id = ?').run(site);
  assert.equal(relics.boostFor(db, near).wood, 1.25, 'and resumes when it is back');
  relics.villageLost(db, near);
  assert.deepEqual(relics.boostFor(db, near), {});

  // defence relic in the village the attack hits
  assert.ok(relics.assign(db, 2, 2, B).ok);
  units(B, { spear: 40 }); units(A, { axe: 60 });
  const c = require('../src/game/commands');
  const run = () => { const r = c.send(db, { userId: 1, fromId: A, toId: B, units: { axe: 60 } }); c.processDue(db, r.arriveAt + 1, () => 0.5); return c.getReports(db, 1, 'attack')[0]; };
  const strong = run();
  relics.assign(db, 2, 2, null);
  db.prepare("INSERT OR REPLACE INTO village_unit VALUES (?, 'spear', 40)").run(B);
  db.prepare("INSERT OR REPLACE INTO village_unit VALUES (?, 'axe', 60)").run(A);
  const plain = run();
  assert.ok(strong.data.defender.losses.spear <= plain.data.defender.losses.spear, 'the relic helps the defender');
});
