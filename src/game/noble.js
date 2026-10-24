'use strict';
const cfg = require('../config');
const u = require('./units');
const v = require('./village');
const { transaction } = require('../db');

const RES = cfg.physicalRes;

// "noblemanRes" is stored as a JSON string in world.json.
const coinCost = () => (typeof cfg.world.noblemanRes === 'string' ? JSON.parse(cfg.world.noblemanRes) : cfg.world.noblemanRes);

// Each village a player has conquered allows one more noble (plus one to start with).
const limitFor = (db, userId) => 1 + (db.prepare('SELECT conquered FROM user WHERE id = ?').get(userId) || { conquered: 0 }).conquered;

function coinsOf(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(coins), 0) AS n FROM village WHERE user_id = ?').get(userId).n;
}

function summary(db, userId) {
  const nobles = u.ownedCount(db, userId, 'snob');
  const coins = coinsOf(db, userId);
  const limit = limitFor(db, userId);
  return { nobles, coins, limit, conquered: limit - 1, mintable: Math.max(0, limit - nobles - coins) };
}

function mint(db, villageId, n = 1) {
  return transaction(db, () => {
    n = Math.floor(n);
    if (!(n > 0)) return { ok: false, error: 'nothing' };
    const village = v.processQueue(db, villageId);
    if (!village.user_id) return { ok: false, error: 'noSource' };
    if (v.getBuildings(db, villageId).snob < 1) return { ok: false, error: 'requirements' };
    if (summary(db, village.user_id).mintable < n) return { ok: false, error: 'limit' };
    const cost = coinCost();
    if (RES.some((r) => village[r] < cost[r] * n)) return { ok: false, error: 'resources' };
    for (const r of RES) village[r] -= cost[r] * n;
    db.prepare('UPDATE village SET wood=?, stone=?, iron=?, coins = coins + ? WHERE id=?').run(village.wood, village.stone, village.iron, n, villageId);
    return { ok: true };
  });
}

module.exports = { coinCost, limitFor, coinsOf, summary, mint };
