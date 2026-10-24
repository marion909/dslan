'use strict';
const cfg = require('../config');
const f = require('./formulas');
const { transaction } = require('../db');
const relics = require('./relics');

const RES = cfg.physicalRes;
const now = () => Date.now() / 1000;

function getBuildings(db, villageId) {
  const levels = Object.fromEntries(f.BUILDING_IDS.map((id) => [id, cfg.buildings[id].minLevel]));
  for (const r of db.prepare('SELECT building, level FROM village_building WHERE village_id = ?').all(villageId)) {
    levels[r.building] = r.level;
  }
  return levels;
}

// Levels as they will be once the whole queue is done, for validating new orders.
function queuedLevels(db, villageId) {
  const levels = getBuildings(db, villageId);
  for (const q of getQueue(db, villageId)) levels[q.building] = q.level;
  return levels;
}

function getQueue(db, villageId) {
  return db.prepare('SELECT * FROM build_queue WHERE village_id = ? ORDER BY finish_at, id').all(villageId);
}

function storageMax(levels) {
  return f.capacity('storage', 'wood', levels.storage);
}

function popMax(levels) {
  return f.capacity('farm', 'population', levels.farm);
}

// Population taken by the village's units: home, in training, marching and stationed abroad.
function unitPop(db, villageId) {
  const per = (u) => cfg.units[u].recruitCosts.population;
  const armyPop = (json) => Object.entries(JSON.parse(json)).reduce((s, [u, n]) => s + (cfg.units[u] ? n * per(u) : 0), 0);
  let sum = 0;
  for (const r of db.prepare('SELECT unit, count FROM village_unit WHERE village_id = ?').all(villageId)) sum += r.count * per(r.unit);
  for (const r of db.prepare('SELECT unit, amount FROM train_queue WHERE village_id = ?').all(villageId)) sum += r.amount * per(r.unit);
  // Outgoing orders and units on their way home still eat the owner's food; merchants do not.
  for (const r of db.prepare("SELECT units FROM command WHERE (from_village = ? AND type IN ('attack', 'support')) OR (to_village = ? AND type = 'return')").all(villageId, villageId)) sum += armyPop(r.units);
  for (const r of db.prepare('SELECT units FROM stationed WHERE owner_village = ?').all(villageId)) sum += armyPop(r.units);
  return sum;
}

// Loyalty regrows with world speed; it is stored as a value plus the time it was set.
function loyaltyAt(row, t = now()) {
  const regrown = ((t - row.loyalty_at) / 3600) * cfg.world.loyaltyIncrease * cfg.SPEED;
  return Math.min(100, Math.max(0, row.loyalty + Math.max(0, regrown)));
}

function setLoyalty(db, villageId, value, t = now()) {
  db.prepare('UPDATE village SET loyalty = ?, loyalty_at = ? WHERE id = ?').run(Math.min(100, Math.max(0, value)), t, villageId);
}

// Orders after the first cost extra on worlds with a build-queue surcharge.
const queueFactor = (queueLength) => (queueLength >= 1 ? cfg.world.buildqueueMultiply : 1);
const scaled = (n, factor) => Math.round(n * factor);

function popUsed(levels, queue = [], extra = 0) {
  const lv = { ...levels };
  for (const q of queue) lv[q.building] = q.level;
  return extra + f.BUILDING_IDS.reduce((sum, id) => sum + (lv[id] > 0 ? f.buildCost(id, 'population', lv[id]) : 0), 0);
}

function hourlyProduction(levels, res, boost = 1) {
  return boost * f.BUILDING_IDS.reduce((sum, id) => sum + (cfg.buildings[id].res.prod[res] ? f.production(id, res, levels[id]) : 0), 0);
}

// The rate a village really has: buildings plus the relic assigned to it.
function rate(db, villageId, levels, res) {
  return hourlyProduction(levels, res, relics.boostFor(db, villageId)[res] || 1);
}

// Brings stored resources up to `t`, honouring the warehouse limit. Production
// rates only change when a building completes, so call this before applying one.
function settleResources(db, village, levels, t = now()) {
  const dt = Math.max(0, t - village.res_updated_at);
  const max = storageMax(levels);
  for (const r of RES) {
    const gained = (rate(db, village.id, levels, r) * dt) / 3600;
    village[r] = Math.min(Math.max(village[r], village[r] + gained), Math.max(max, village[r]));
  }
  village.res_updated_at = t;
  db.prepare('UPDATE village SET wood=?, stone=?, iron=?, res_updated_at=? WHERE id=?')
    .run(village.wood, village.stone, village.iron, t, village.id);
}

// Applies every finished queue entry in order, settling resources at each
// completion time so production before and after a level-up is accounted for.
function processQueue(db, villageId, t = now()) {
  return transaction(db, () => {
    const village = db.prepare('SELECT * FROM village WHERE id = ?').get(villageId);
    const done = db.prepare('SELECT * FROM build_queue WHERE village_id = ? AND finish_at <= ? ORDER BY finish_at, id')
      .all(villageId, t);
    for (const q of done) {
      settleResources(db, village, getBuildings(db, villageId), q.finish_at);
      db.prepare('INSERT INTO village_building (village_id, building, level) VALUES (?,?,?) '
        + 'ON CONFLICT(village_id, building) DO UPDATE SET level = excluded.level').run(villageId, q.building, q.level);
      db.prepare('DELETE FROM build_queue WHERE id = ?').run(q.id);
    }
    settleResources(db, village, getBuildings(db, villageId), t);
    return village;
  });
}

function missingRequirements(levels, id) {
  const req = cfg.buildings[id].requirements || {};
  return Object.entries(req).filter(([b, lvl]) => levels[b] < lvl).map(([b, lvl]) => ({ building: b, level: lvl }));
}

// Returns true when the next level of `id` can be queued, otherwise an error code.
function canBuild(db, village, id) {
  const queue = getQueue(db, village.id);
  const levels = queuedLevels(db, village.id);
  const b = cfg.buildings[id];
  if (!b) return 'noBuilding';
  if (queue.length >= cfg.world.buildqueueStart) return 'queueFull';
  const next = levels[id] + 1;
  if (next > b.maxLevel) return 'maxLevel';
  if (missingRequirements(levels, id).length) return 'requirements';
  const factor = queueFactor(queue.length);
  for (const r of RES) if (village[r] < scaled(f.buildCost(id, r, next), factor)) return 'resources';
  const real = getBuildings(db, village.id);
  if (popUsed(real, queue, unitPop(db, village.id)) + f.buildPopulation(id, next) > popMax(real)) return 'population';
  return true;
}

function enqueueBuild(db, villageId, id) {
  return transaction(db, () => {
    const village = processQueue(db, villageId);
    const state = canBuild(db, village, id);
    if (state !== true) return { ok: false, error: state };
    const queue = getQueue(db, villageId);
    const levels = getBuildings(db, villageId);
    const next = queuedLevels(db, villageId)[id] + 1;
    const factor = queueFactor(queue.length);
    for (const r of RES) village[r] -= scaled(f.buildCost(id, r, next), factor);
    db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(village.wood, village.stone, village.iron, villageId);
    const start = queue.length ? queue[queue.length - 1].finish_at : now();
    const finish = start + f.buildTime(id, next, levels.main);
    db.prepare('INSERT INTO build_queue (village_id, building, level, start_at, finish_at) VALUES (?,?,?,?,?)')
      .run(villageId, id, next, start, finish);
    return { ok: true, level: next, finishAt: finish };
  });
}

// Cancelling refunds the base cost (not the queue surcharge); later entries move forward to fill the gap.
function cancelBuild(db, villageId, queueId) {
  return transaction(db, () => {
    const village = processQueue(db, villageId);
    const queue = getQueue(db, villageId);
    const idx = queue.findIndex((q) => q.id === queueId);
    if (idx < 0) return { ok: false, error: 'noQueueEntry' };
    // Entries of the same building stack on each other, so only the last one may go.
    if (queue.some((q, i) => i > idx && q.building === queue[idx].building)) return { ok: false, error: 'dependent' };
    const target = queue[idx];
    if (target.kind !== 'destroy') for (const r of RES) village[r] += f.buildCost(target.building, r, target.level);
    db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(village.wood, village.stone, village.iron, villageId);
    db.prepare('DELETE FROM build_queue WHERE id = ?').run(target.id);
    const mainLevel = getBuildings(db, villageId).main;
    let cursor = idx === 0 ? now() : queue[idx - 1].finish_at;
    for (const q of queue.slice(idx + 1)) {
      const finish = cursor + f.buildTime(q.building, q.level, mainLevel);
      db.prepare('UPDATE build_queue SET start_at=?, finish_at=? WHERE id=?').run(cursor, finish, q.id);
      cursor = finish;
    }
    return { ok: true };
  });
}

// Demolition needs a developed headquarters and frees population once finished.
function enqueueDestroy(db, villageId, id) {
  return transaction(db, () => {
    processQueue(db, villageId);
    const real = getBuildings(db, villageId);
    const queued = queuedLevels(db, villageId);
    const queue = getQueue(db, villageId);
    const b = cfg.buildings[id];
    if (!b) return { ok: false, error: 'noBuilding' };
    if (real.main < 15) return { ok: false, error: 'noDestroy' };
    if (queue.length >= cfg.world.buildqueueStart) return { ok: false, error: 'queueFull' };
    if (queued[id] <= b.minLevel) return { ok: false, error: 'fullyDestroyed' };
    const target = queued[id] - 1;
    const start = queue.length ? queue[queue.length - 1].finish_at : now();
    const finish = start + f.buildTime(id, queued[id], real.main) / 2;
    db.prepare("INSERT INTO build_queue (village_id, building, level, start_at, finish_at, kind) VALUES (?,?,?,?,?,'destroy')").run(villageId, id, target, start, finish);
    return { ok: true, level: target, finishAt: finish };
  });
}

// `order` lists the waiting entries (everything after the running one) in their new sequence.
function reorderBuild(db, villageId, order) {
  return transaction(db, () => {
    processQueue(db, villageId);
    const queue = getQueue(db, villageId);
    if (queue.length < 3) return { ok: false, error: 'nothingToSort' };
    const [active, ...waiting] = queue;
    if (order.length !== waiting.length || new Set(order).size !== order.length || order.some((i) => !Number.isInteger(i) || i < 0 || i >= waiting.length)) return { ok: false, error: 'badOrder' };
    const sorted = order.map((i) => waiting[i]);
    // Several orders for one building must stay in level order, or the levels would not add up.
    const seen = new Map([[active.building, active.level]]);
    for (const q of sorted) {
      if (seen.has(q.building) && (q.kind === 'destroy' ? q.level >= seen.get(q.building) : q.level <= seen.get(q.building))) return { ok: false, error: 'dependent' };
      seen.set(q.building, q.level);
    }
    const mainLevel = getBuildings(db, villageId).main;
    let cursor = active.finish_at;
    for (const q of sorted) {
      const dur = f.buildTime(q.building, q.kind === 'destroy' ? q.level + 1 : q.level, mainLevel) / (q.kind === 'destroy' ? 2 : 1);
      db.prepare('UPDATE build_queue SET start_at = ?, finish_at = ? WHERE id = ?').run(cursor, cursor + dur, q.id);
      cursor += dur;
    }
    return { ok: true };
  });
}

function villagePoints(levels) {
  return f.BUILDING_IDS.reduce((s, id) => s + f.buildPoints(id, levels[id]), 0);
}

function createVillage(db, { userId, name, x, y }) {
  return transaction(db, () => {
    const t = now();
    const info = db.prepare('INSERT INTO village (user_id, name, x, y, wood, stone, iron, res_updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId, name, x, y, 500, 500, 500, t, Math.floor(t));
    // (loyalty defaults to 100 in the schema)
    const id = Number(info.lastInsertRowid);
    for (const bid of f.BUILDING_IDS) {
      const b = cfg.buildings[bid];
      if (b.startLevel > 0) {
        db.prepare('INSERT INTO village_building (village_id, building, level) VALUES (?,?,?)').run(id, bid, b.startLevel);
      }
    }
    return id;
  });
}

module.exports = {
  RES, getBuildings, getQueue, queuedLevels, processQueue, canBuild, enqueueBuild, cancelBuild, enqueueDestroy, reorderBuild,
  queueFactor, scaled, loyaltyAt, setLoyalty,
  storageMax, popMax, popUsed, unitPop, hourlyProduction, rate, missingRequirements, villagePoints, createVillage,
};
