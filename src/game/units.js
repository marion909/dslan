'use strict';
const cfg = require('../config');
const v = require('./village');
const { transaction } = require('../db');

const RES = cfg.physicalRes;
const now = () => Date.now() / 1000;
const UNIT_IDS = Object.keys(cfg.units).filter((id) => cfg.units[id].recruitBuilding && (id !== 'knight' || cfg.world.knightActive));

// Training gets 6% faster per level of the recruiting building (assumed; the
// original formula lives in the closed extension).
const TRAIN_SPEEDUP = 0.94;
const REFUND = 0.9;

function recruitTime(unit, buildingLevel) {
  return Math.max(1, (cfg.units[unit].recruitCosts.time * Math.pow(TRAIN_SPEEDUP, buildingLevel)) / cfg.SPEED);
}

// Units without a research entry (nobles, knights) are always available once their building stands.
const researchMin = (unit) => (cfg.units[unit].research ? cfg.units[unit].research.min : 1);

function researchLevel(db, villageId, unit) {
  const row = db.prepare('SELECT level FROM village_research WHERE village_id = ? AND unit = ?').get(villageId, unit);
  return Math.max(researchMin(unit), row ? row.level : 0);
}

const needsResearch = (unit) => researchMin(unit) < 1;

function requirementsMet(levels, unit) {
  const req = cfg.units[unit].requirements || {};
  return Object.entries(req).every(([b, l]) => (levels[b] || 0) >= l);
}

function isRecruitable(db, villageId, levels, unit) {
  return requirementsMet(levels, unit) && researchLevel(db, villageId, unit) >= 1
    && levels[cfg.units[unit].recruitBuilding] > 0;
}

// Units of one kind owned by a player: home, training, marching and stationed abroad.
function ownedCount(db, userId, unit) {
  const villages = db.prepare('SELECT id FROM village WHERE user_id = ?').all(userId).map((r) => r.id);
  if (!villages.length) return 0;
  const marks = villages.map(() => '?').join(',');
  let n = 0;
  n += db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM village_unit WHERE unit = ? AND village_id IN (${marks})`).get(unit, ...villages).n;
  n += db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM train_queue WHERE unit = ? AND village_id IN (${marks})`).get(unit, ...villages).n;
  for (const r of db.prepare(`SELECT units FROM command WHERE type IN ('attack', 'support') AND from_village IN (${marks}) OR (type = 'return' AND to_village IN (${marks}))`).all(...villages, ...villages)) n += JSON.parse(r.units)[unit] || 0;
  for (const r of db.prepare(`SELECT units FROM stationed WHERE owner_village IN (${marks})`).all(...villages)) n += JSON.parse(r.units)[unit] || 0;
  return n;
}
const knightCount = (db, userId) => ownedCount(db, userId, 'knight');

function getUnits(db, villageId) {
  const out = Object.fromEntries(UNIT_IDS.map((u) => [u, 0]));
  for (const r of db.prepare('SELECT unit, count FROM village_unit WHERE village_id = ?').all(villageId)) out[r.unit] = r.count;
  return out;
}

function getTrainQueue(db, villageId, building) {
  const sql = `SELECT * FROM train_queue WHERE village_id = ? ${building ? 'AND building = ?' : ''} ORDER BY finish_at, id`;
  return building ? db.prepare(sql).all(villageId, building) : db.prepare(sql).all(villageId);
}

// Units appear one by one: whatever has finished by `t` moves home, the rest of the batch keeps waiting.
function processTraining(db, villageId, t = now()) {
  transaction(db, () => {
    for (const q of getTrainQueue(db, villageId)) {
      if (q.start_at > t) continue;
      const done = Math.min(q.amount, Math.floor((t - q.start_at) / q.per_unit + 1e-9));
      if (done <= 0) continue;
      db.prepare('INSERT INTO village_unit (village_id, unit, count) VALUES (?,?,?) ON CONFLICT(village_id, unit) DO UPDATE SET count = count + excluded.count')
        .run(villageId, q.unit, done);
      if (done >= q.amount) db.prepare('DELETE FROM train_queue WHERE id = ?').run(q.id);
      else db.prepare('UPDATE train_queue SET amount = ?, start_at = ? WHERE id = ?').run(q.amount - done, q.start_at + done * q.per_unit, q.id);
    }
  });
}

function maxRecruitable(db, village, levels, unit) {
  const c = cfg.units[unit].recruitCosts;
  const popFree = v.popMax(levels) - v.popUsed(levels, [], v.unitPop(db, village.id));
  return Math.max(0, Math.floor(Math.min(...RES.map((r) => village[r] / c[r]), popFree / c.population)));
}

// `orders` is { unit: amount }; either everything is queued or nothing is.
function enqueueTraining(db, villageId, orders) {
  return transaction(db, () => {
    const village = v.processQueue(db, villageId);
    processTraining(db, villageId);
    const levels = v.getBuildings(db, villageId);
    const entries = Object.entries(orders).map(([u, a]) => [u, Math.floor(Number(a))]).filter(([, a]) => a > 0);
    if (!entries.length) return { ok: false, error: 'nothing' };
    const total = Object.fromEntries(RES.map((r) => [r, 0])); let pop = 0; let coins = 0;
    for (const [u, a] of entries) {
      if (!UNIT_IDS.includes(u)) return { ok: false, error: 'unknownUnit' };
      if (a > 99999) return { ok: false, error: 'tooMany' };
      if (!isRecruitable(db, villageId, levels, u)) return { ok: false, error: 'requirements' };
      const c = cfg.units[u].recruitCosts;
      if (u === 'knight') {
        if (a !== 1 || knightCount(db, village.user_id) > 0) return { ok: false, error: 'knightExists' };
      }
      if (u === 'snob') coins += a; // nobles are paid with coins, not raw resources
      else for (const r of RES) total[r] += c[r] * a;
      pop += c.population * a;
    }
    if (coins > 0 && (village.coins || 0) < coins) return { ok: false, error: 'noCoins' };
    if (RES.some((r) => village[r] < total[r])) return { ok: false, error: 'resources' };
    if (v.popUsed(levels, [], v.unitPop(db, villageId)) + pop > v.popMax(levels)) return { ok: false, error: 'population' };
    for (const r of RES) village[r] -= total[r];
    db.prepare('UPDATE village SET wood=?, stone=?, iron=?, coins = coins - ? WHERE id=?').run(village.wood, village.stone, village.iron, coins, villageId);
    for (const [u, a] of entries) {
      const b = cfg.units[u].recruitBuilding;
      const per = recruitTime(u, levels[b]);
      const last = getTrainQueue(db, villageId, b).at(-1);
      const start = last ? last.finish_at : now();
      db.prepare('INSERT INTO train_queue (village_id, building, unit, amount, per_unit, start_at, finish_at) VALUES (?,?,?,?,?,?,?)')
        .run(villageId, b, u, a, per, start, start + per * a);
    }
    return { ok: true };
  });
}

// Refunds the units that have not finished yet and pulls the following orders forward.
function cancelTraining(db, villageId, queueId) {
  return transaction(db, () => {
    const village = v.processQueue(db, villageId);
    processTraining(db, villageId);
    const q = db.prepare('SELECT * FROM train_queue WHERE id = ? AND village_id = ?').get(queueId, villageId);
    if (!q) return { ok: false, error: 'noQueueEntry' };
    const c = cfg.units[q.unit].recruitCosts;
    // The queue screen promises 90% back; a noble's coin comes back in full.
    if (q.unit !== 'snob') for (const r of RES) village[r] += Math.floor(c[r] * q.amount * REFUND);
    db.prepare('UPDATE village SET wood=?, stone=?, iron=?, coins = coins + ? WHERE id=?').run(village.wood, village.stone, village.iron, q.unit === 'snob' ? q.amount : 0, villageId);
    db.prepare('DELETE FROM train_queue WHERE id = ?').run(q.id);
    let cursor = Math.max(now(), q.start_at);
    const rest = getTrainQueue(db, villageId, q.building).filter((o) => o.finish_at > q.start_at);
    for (const o of rest) {
      const finish = cursor + o.per_unit * o.amount;
      db.prepare('UPDATE train_queue SET start_at = ?, finish_at = ? WHERE id = ?').run(cursor, finish, o.id);
      cursor = finish;
    }
    return { ok: true };
  });
}

// ---- research (smithy) ----
function getResearchQueue(db, villageId) {
  return db.prepare('SELECT * FROM research_queue WHERE village_id = ? ORDER BY finish_at, id').all(villageId);
}

function processResearch(db, villageId, t = now()) {
  transaction(db, () => {
    for (const q of getResearchQueue(db, villageId).filter((r) => r.finish_at <= t)) {
      db.prepare('INSERT INTO village_research (village_id, unit, level) VALUES (?,?,1) ON CONFLICT(village_id, unit) DO UPDATE SET level = 1').run(villageId, q.unit);
      db.prepare('DELETE FROM research_queue WHERE id = ?').run(q.id);
    }
  });
}

function researchCost(unit) {
  const r = cfg.units[unit].research['1'] || {};
  return { wood: r.wood || 0, stone: r.stone || 0, iron: r.iron || 0, time: Math.max(1, (r.time || 0) / cfg.SPEED) };
}

function canResearch(db, villageId, levels, unit) {
  if (!needsResearch(unit)) return 'noResearch';
  if (!requirementsMet(levels, unit)) return 'requirements';
  if (researchLevel(db, villageId, unit) >= 1) return 'done';
  if (getResearchQueue(db, villageId).some((q) => q.unit === unit)) return 'queued';
  return true;
}

function enqueueResearch(db, villageId, unit) {
  return transaction(db, () => {
    const village = v.processQueue(db, villageId);
    processResearch(db, villageId);
    if (!UNIT_IDS.includes(unit)) return { ok: false, error: 'unknownUnit' };
    const levels = v.getBuildings(db, villageId);
    const state = canResearch(db, villageId, levels, unit);
    if (state !== true) return { ok: false, error: state };
    const cost = researchCost(unit);
    if (RES.some((r) => village[r] < cost[r])) return { ok: false, error: 'resources' };
    for (const r of RES) village[r] -= cost[r];
    db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(village.wood, village.stone, village.iron, villageId);
    const last = getResearchQueue(db, villageId).at(-1);
    const start = last ? last.finish_at : now();
    db.prepare('INSERT INTO research_queue (village_id, unit, start_at, finish_at) VALUES (?,?,?,?)').run(villageId, unit, start, start + cost.time);
    return { ok: true };
  });
}

module.exports = {
  ownedCount, knightCount, UNIT_IDS, recruitTime, researchLevel, needsResearch, requirementsMet, isRecruitable, getUnits, getTrainQueue,
  processTraining, maxRecruitable, enqueueTraining, cancelTraining, getResearchQueue, processResearch, researchCost,
  canResearch, enqueueResearch,
};
