'use strict';
const cfg = require('../config');
const f = require('./formulas');
const v = require('./village');
const u = require('./units');
const combat = require('./combat');
const ranking = require('./ranking');
const knight = require('./knight');
const church = require('./church');
const relics = require('./relics');
const view = require('../view');
const { transaction } = require('../db');

const RES = cfg.physicalRes;
const now = () => Date.now() / 1000;
const MOVING = u.UNIT_IDS;
const MERCHANT_CAPACITY = 1000;
const MERCHANT_SPEED = 6; // minutes per field
const START_LOYALTY = 25; // loyalty of a freshly conquered village

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Seconds to cover the distance with the slowest unit; unit speed is minutes per field.
function travelSeconds(armyUnits, from, to) {
  const slowest = Math.max(...Object.entries(armyUnits).filter(([, n]) => n > 0).map(([id]) => cfg.units[id].speed.base));
  return (distance(from, to) * slowest * 60) / (cfg.SPEED * cfg.world.unitsSpeed);
}

const merchantSeconds = (from, to) => (distance(from, to) * MERCHANT_SPEED * 60) / cfg.SPEED;

const clean = (army) => Object.fromEntries(Object.entries(army).map(([k, n]) => [k, Math.floor(Number(n))]).filter(([k, n]) => MOVING.includes(k) && n > 0));
const protectedUntil = (user) => (user ? user.created_at + cfg.PROTECTION_SECONDS : 0);
const parse = (row) => row && { ...row, units: JSON.parse(row.units), loot: JSON.parse(row.loot) };

function getCommand(db, id) { return parse(db.prepare('SELECT * FROM command WHERE id = ?').get(id)); }

function listCommands(db, where, ...args) {
  return db.prepare(`SELECT * FROM command WHERE ${where} ORDER BY arrive_at`).all(...args).map(parse);
}

// ---- merchants ----
const merchantsAt = (level) => (level <= 10 ? level : (level - 10) ** 2 + 10);

function merchantsBusy(db, villageId) {
  let n = 0;
  for (const r of db.prepare("SELECT units FROM command WHERE (type = 'trade' AND from_village = ?) OR (type = 'trade_back' AND to_village = ?)").all(villageId, villageId)) n += JSON.parse(r.units).merchants || 0;
  return n;
}

function merchantsFree(db, villageId) {
  return Math.max(0, merchantsAt(v.getBuildings(db, villageId).market) - merchantsBusy(db, villageId));
}

// ---- sending troops ----
function send(db, { userId, fromId, toId, units: raw, type = 'attack' }) {
  return transaction(db, () => {
    const from = db.prepare('SELECT * FROM village WHERE id = ? AND user_id = ?').get(fromId, userId);
    const to = db.prepare('SELECT * FROM village WHERE id = ?').get(toId);
    if (!from) return { ok: false, error: 'noSource' };
    if (!to) return { ok: false, error: 'invalidTarget' };
    if (!['attack', 'support'].includes(type)) return { ok: false, error: 'unsupported' };
    if (to.id === from.id) return { ok: false, error: 'sameVillage' };
    const army = clean(raw);
    if (!Object.keys(army).length) return { ok: false, error: 'noTroops' };
    if (type === 'attack') {
      if (to.user_id === userId && !cfg.world.attackSelf) return { ok: false, error: 'ownVillage' };
      if (to.user_id && to.user_id !== userId) {
        const target = db.prepare('SELECT * FROM user WHERE id = ?').get(to.user_id);
        if (protectedUntil(target) > now()) return { ok: false, error: 'protected' };
      }
      if (army.snob && distance(from, to) > cfg.world.noblemanRange) return { ok: false, error: 'tooFar' };
    } else if (!to.user_id) return { ok: false, error: 'invalidTarget' };
    u.processTraining(db, fromId);
    const home = u.getUnits(db, fromId);
    for (const [id, n] of Object.entries(army)) if (home[id] < n) return { ok: false, error: 'notEnoughTroops' };
    for (const [id, n] of Object.entries(army)) db.prepare('UPDATE village_unit SET count = count - ? WHERE village_id = ? AND unit = ?').run(n, fromId, id);
    const depart = now();
    const arrive = depart + travelSeconds(army, from, to);
    const info = db.prepare('INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES (?,?,?,?,?,?)')
      .run(type, fromId, toId, JSON.stringify(army), depart, arrive);
    return { ok: true, id: Number(info.lastInsertRowid), arriveAt: arrive };
  });
}

function addReport(db, userId, { type, title, color, time, data }) {
  if (!userId) return;
  // Players can switch whole kinds of reports off in their report filter.
  const row = db.prepare('SELECT report_filter FROM user WHERE id = ?').get(userId);
  try { if (row && JSON.parse(row.report_filter).includes(type)) return; } catch { /* no filter */ }
  db.prepare('INSERT INTO report (user_id, type, title, color, time, data) VALUES (?,?,?,?,?,?)')
    .run(userId, type, title, color, time, JSON.stringify(data));
}

function setHome(db, villageId, army) {
  for (const id of MOVING) {
    if (army[id] === undefined) continue;
    db.prepare('INSERT INTO village_unit (village_id, unit, count) VALUES (?,?,?) ON CONFLICT(village_id, unit) DO UPDATE SET count = excluded.count').run(villageId, id, army[id]);
  }
}

const addUnits = (a, b) => { const out = { ...a }; for (const [k, n] of Object.entries(b)) out[k] = (out[k] || 0) + n; return out; };
const sumUnits = (list) => list.reduce((acc, a) => addUnits(acc, a), {});
const showVillage = (row, owner) => (owner ? row.name : 'Barbarendorf');
const villageLabel = (row, owner) => `${showVillage(row, owner)} (${row.x}|${row.y})`;

// ---- stationed support ----
const stationedAt = (db, hostId) => db.prepare('SELECT * FROM stationed WHERE host_village = ?').all(hostId).map((r) => ({ ...r, units: JSON.parse(r.units) }));

function station(db, ownerId, hostId, army) {
  const row = db.prepare('SELECT units FROM stationed WHERE owner_village = ? AND host_village = ?').get(ownerId, hostId);
  const merged = addUnits(row ? JSON.parse(row.units) : {}, army);
  db.prepare('INSERT INTO stationed (owner_village, host_village, units) VALUES (?,?,?) ON CONFLICT(owner_village, host_village) DO UPDATE SET units = excluded.units')
    .run(ownerId, hostId, JSON.stringify(merged));
}

function setStationed(db, ownerId, hostId, army) {
  const left = clean(army);
  if (Object.keys(left).length) db.prepare('UPDATE stationed SET units = ? WHERE owner_village = ? AND host_village = ?').run(JSON.stringify(left), ownerId, hostId);
  else db.prepare('DELETE FROM stationed WHERE owner_village = ? AND host_village = ?').run(ownerId, hostId);
}

// Sends stationed troops home. The owner withdraws them; the host may send them back.
function recall(db, userId, stationedId, requested, asHost) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM stationed WHERE id = ?').get(stationedId);
    if (!row) return { ok: false, error: 'noCommand' };
    const owner = db.prepare('SELECT * FROM village WHERE id = ?').get(row.owner_village);
    const host = db.prepare('SELECT * FROM village WHERE id = ?').get(row.host_village);
    if ((asHost ? host.user_id : owner.user_id) !== userId) return { ok: false, error: 'denied' };
    const have = JSON.parse(row.units);
    const army = requested ? clean(requested) : have;
    for (const [id, n] of Object.entries(army)) if ((have[id] || 0) < n) return { ok: false, error: 'notEnoughTroops' };
    if (!Object.keys(army).length) return { ok: false, error: 'noTroops' };
    const left = Object.fromEntries(Object.entries(have).map(([k, n]) => [k, n - (army[k] || 0)]));
    setStationed(db, owner.id, host.id, left);
    const t = now();
    db.prepare('INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES (?,?,?,?,?,?)')
      .run('return', host.id, owner.id, JSON.stringify(army), t, t + travelSeconds(army, host, owner));
    return { ok: true };
  });
}

// ---- arrivals ----
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

// Spies are caught in proportion to the defender's spies; one survivor is enough to learn something.
function spyOutcome(sent, defending) {
  const lost = defending > 0 ? Math.ceil(sent * Math.min(1, defending / (2 * sent))) : 0;
  return { lost, survivors: sent - lost, success: sent - lost > 0 };
}

function intel(db, village, levels, units) {
  return {
    resources: Object.fromEntries(RES.map((r) => [r, Math.floor(village[r])])),
    buildings: Object.fromEntries(f.BUILDING_IDS.filter((b) => levels[b] > 0).map((b) => [b, levels[b]])),
    units,
  };
}

// Tribes at war keep a score of the kill points each side has earned against the other.
function recordWar(db, attackerUser, defenderUser, byAttacker, byDefender) {
  if (!attackerUser || !defenderUser) return;
  const ally = (id) => (db.prepare('SELECT ally_id FROM user WHERE id = ?').get(id) || {}).ally_id;
  const a = ally(attackerUser); const d = ally(defenderUser);
  if (!a || !d || a === d) return;
  if (!db.prepare("SELECT 1 FROM ally_contract WHERE ally_id = ? AND other_id = ? AND type = 'enemy'").get(a, d)) return;
  const add = db.prepare('INSERT INTO war_stat (ally_id, other_id, kills) VALUES (?,?,?) ON CONFLICT(ally_id, other_id) DO UPDATE SET kills = kills + excluded.kills');
  add.run(a, d, byAttacker); add.run(d, a, byDefender);
}

function resolveAttack(db, cmd, rng) {
  const t = cmd.arrive_at;
  const att = db.prepare('SELECT * FROM village WHERE id = ?').get(cmd.from_village);
  const defVillage = v.processQueue(db, cmd.to_village, t);
  u.processTraining(db, cmd.to_village, t);
  const attOwner = att.user_id && db.prepare('SELECT * FROM user WHERE id = ?').get(att.user_id);
  const defOwnerId = defVillage.user_id;
  const defOwner = defOwnerId && db.prepare('SELECT * FROM user WHERE id = ?').get(defOwnerId);

  const defLevels = v.getBuildings(db, defVillage.id);
  const home = u.getUnits(db, defVillage.id);
  const groups = stationedAt(db, defVillage.id);
  const defenders = sumUnits([home, ...groups.map((g) => g.units)]);
  const spiesSent = cmd.units.spy || 0;
  const spyOnly = spiesSent > 0 && Object.keys(cmd.units).every((k) => k === 'spy');
  const spy = spiesSent > 0 ? spyOutcome(spiesSent, defenders.spy || 0) : null;

  const attackerName = attOwner ? attOwner.name : '-';
  const side = (row, owner, units, losses) => ({ user: owner ? owner.name : null, userId: owner ? owner.id : null, village: showVillage(row, owner), villageId: row.id, x: row.x, y: row.y, units, losses });
  const title = (key) => cfg.translate(view.currentLang(), key, { fromUser: attackerName, fromVillage: att.name, toVillage: villageLabel(defVillage, defOwner) });

  // A pure spying mission: nobody fights, spies come home with news or not at all.
  if (spyOnly) {
    const back = spy.survivors > 0 ? { spy: spy.survivors } : {};
    if (spy.survivors > 0) {
      db.prepare('INSERT INTO command (type, from_village, to_village, units, loot, depart_at, arrive_at) VALUES (?,?,?,?,?,?,?)')
        .run('return', defVillage.id, att.id, JSON.stringify(back), '{}', t, t + travelSeconds(back, att, defVillage));
    }
    const data = {
      kind: 'spy', time: t, success: spy.success,
      attacker: side(att, attOwner, cmd.units, { spy: spy.lost }), defender: side(defVillage, defOwner, {}, {}),
      intel: spy.success ? intel(db, defVillage, defLevels, home) : null,
    };
    addReport(db, att.user_id, { type: 'attack', title: title('game.report.attack'), color: spy.success ? (spy.lost ? 'yellow' : 'green') : 'red', time: t, data });
    if (defOwnerId && defOwnerId !== att.user_id && (spy.lost > 0 || !spy.success)) {
      addReport(db, defOwnerId, { type: 'other', title: `Spähversuch von ${att.name} (${att.x}|${att.y}) abgewehrt`, color: 'yellow', time: t, data: { ...data, intel: null } });
    }
    return;
  }

  const luck = (rng() * 2 - 1) * 0.25;
  const result = combat.resolve({
    attacker: cmd.units, defender: defenders, wallLevel: defLevels.wall,
    attackerPoints: v.villagePoints(v.getBuildings(db, att.id)), defenderPoints: v.villagePoints(defLevels), luck,
    defenseBonus: (view.isNight(new Date(t * 1000)) ? cfg.world.nightBonus : 1) * (relics.boostFor(db, defVillage.id).defense || 1) * church.faithFactor(db, defVillage),
    attackBonus: (relics.boostFor(db, att.id).attack || 1) * church.faithFactor(db, att),
    // Items only work for troops that are accompanied by a knight.
    attackerBoost: (cmd.units.knight || 0) > 0 ? knight.boostFor(db, att.user_id) : {},
    defenderBoost: (defenders.knight || 0) > 0 ? knight.boostFor(db, defOwnerId) : {},
  });
  if (spy && !spy.success) result.attackerSurvivors.spy = 0;
  else if (spy) result.attackerSurvivors.spy = Math.min(result.attackerSurvivors.spy || 0, spy.survivors);

  // Buildings: surviving rams hit the wall, catapults a random building.
  const damage = {};
  if (result.win && cfg.world.destroyBuildings) {
    const wallNow = combat.wallAfter(defLevels.wall, result.attackerSurvivors.ram || 0);
    if (wallNow !== defLevels.wall) damage.wall = { before: defLevels.wall, after: wallNow };
    const targets = f.BUILDING_IDS.filter((b) => b !== 'wall' && defLevels[b] > 0);
    if ((result.attackerSurvivors.catapult || 0) > 0 && targets.length) {
      const target = targets[Math.floor(rng() * targets.length)];
      const after = combat.buildingAfter(defLevels[target], result.attackerSurvivors.catapult);
      if (after !== defLevels[target]) damage[target] = { before: defLevels[target], after };
    }
    for (const [b, d] of Object.entries(damage)) {
      db.prepare('INSERT INTO village_building (village_id, building, level) VALUES (?,?,?) ON CONFLICT(village_id, building) DO UPDATE SET level = excluded.level').run(defVillage.id, b, d.after);
    }
  }

  // Everyone defending takes the same share of losses.
  const keep = 1 - result.defenderLossRatio;
  const shrink = (army) => Object.fromEntries(Object.entries(army).map(([k, n]) => [k, Math.floor(n * keep + 1e-9)]));
  setHome(db, defVillage.id, shrink(home));
  const supporterReports = [];
  for (const g of groups) {
    const survivors = shrink(g.units);
    setStationed(db, g.owner_village, defVillage.id, survivors);
    const lossesOf = Object.fromEntries(Object.entries(g.units).map(([k, n]) => [k, n - (survivors[k] || 0)]));
    const ownerVillage = db.prepare('SELECT * FROM village WHERE id = ?').get(g.owner_village);
    supporterReports.push({ ownerVillage, units: g.units, losses: lossesOf });
  }

  let booty = Object.fromEntries(RES.map((r) => [r, 0])); let capacity = 0;
  if (result.win) {
    const taken = combat.loot(result.attackerSurvivors, defVillage, f.hideCapacity(defLevels.hide));
    booty = taken.loot; capacity = taken.capacity;
    for (const r of RES) defVillage[r] -= booty[r];
    db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(defVillage.wood, defVillage.stone, defVillage.iron, defVillage.id);
  }

  // Nobles lower loyalty after a won battle; at zero the village changes hands.
  const survivors = { ...result.attackerSurvivors };
  const loyaltyBefore = v.loyaltyAt(defVillage, t);
  let loyaltyAfter = loyaltyBefore; let conquered = false;
  if (result.win && (survivors.snob || 0) > 0 && att.user_id && defOwnerId !== att.user_id) {
    let drop = 0;
    for (let i = 0; i < survivors.snob; i++) drop += randInt(rng, cfg.world.noblemanMinDecrease, cfg.world.noblemanMaxDecrease);
    loyaltyAfter = Math.max(0, loyaltyBefore - drop);
    if (loyaltyAfter <= 0) {
      conquered = true;
      survivors.snob -= 1; // the noble who claims the village stays behind
    } else v.setLoyalty(db, defVillage.id, loyaltyAfter, t);
  }
  if (conquered) {
    const id = defVillage.id;
    db.prepare('UPDATE village SET user_id = ?, loyalty = ?, loyalty_at = ? WHERE id = ?').run(att.user_id, START_LOYALTY, t, id);
    db.prepare('UPDATE user SET conquered = conquered + 1 WHERE id = ?').run(att.user_id);
    // Troops of the old owner (marching, stationed abroad) are lost with the village.
    db.prepare('DELETE FROM command WHERE from_village = ? OR to_village = ?').run(id, id);
    db.prepare('DELETE FROM stationed WHERE host_village = ? OR owner_village = ?').run(id, id);
    db.prepare('DELETE FROM village_group_member WHERE village_id = ?').run(id);
    db.prepare('DELETE FROM favorite WHERE village_id = ?').run(id);
    db.prepare('DELETE FROM market_offer WHERE village_id = ?').run(id);
    db.prepare('DELETE FROM reservation WHERE village_id = ?').run(id);
    relics.villageLost(db, id);
    ranking.invalidate();
  }

  const back = clean(survivors);
  if (Object.keys(back).length) {
    db.prepare('INSERT INTO command (type, from_village, to_village, units, loot, depart_at, arrive_at) VALUES (?,?,?,?,?,?,?)')
      .run('return', defVillage.id, att.id, JSON.stringify(back), JSON.stringify(booty), t, t + travelSeconds(back, att, defVillage));
  }

  // Kill points: what each side destroyed, valued by the unit's point worth.
  const worth = (losses, kind) => Object.entries(losses).reduce((sum, [unit, n]) => sum + n * cfg.units[unit].points[kind], 0);
  if (att.user_id) db.prepare('UPDATE user SET kills_att = kills_att + ? WHERE id = ?').run(worth(result.defenderLosses, 'defend'), att.user_id);
  if (defOwnerId) db.prepare('UPDATE user SET kills_def = kills_def + ? WHERE id = ?').run(worth(result.attackerLosses, 'attack'), defOwnerId);
  recordWar(db, att.user_id, defOwnerId, worth(result.defenderLosses, 'defend'), worth(result.attackerLosses, 'attack'));
  ranking.invalidate();
  // Knights that took part earn their owners progress towards new items.
  const knightFinds = {};
  if ((cmd.units.knight || 0) > 0) knightFinds.attacker = knight.gainProgress(db, att.user_id);
  if ((home.knight || 0) > 0 && defOwnerId) knightFinds.defender = knight.gainProgress(db, defOwnerId);

  const lostAny = Object.values(result.attackerLosses).some((n) => n > 0);
  const attColor = !result.win ? 'red' : lostAny ? 'yellow' : 'green';
  const defLost = Object.values(result.defenderLosses).some((n) => n > 0);
  const defColor = result.win ? 'red' : defLost ? 'yellow' : 'green';
  const data = {
    kind: 'battle', time: t, win: result.win, luck, morale: result.morale, night: view.isNight(new Date(t * 1000)),
    attacker: side(att, attOwner, cmd.units, result.attackerLosses), defender: side(defVillage, defOwner, defenders, result.defenderLosses),
    loot: booty, capacity, damage, conquered,
    loyalty: loyaltyAfter < loyaltyBefore || conquered ? { from: Math.round(loyaltyBefore), to: conquered ? START_LOYALTY : Math.round(loyaltyAfter) } : null,
    supporters: supporterReports.map((s2) => ({ user: s2.ownerVillage.user_id ? (db.prepare('SELECT name FROM user WHERE id = ?').get(s2.ownerVillage.user_id) || {}).name : null, village: s2.ownerVillage.name, x: s2.ownerVillage.x, y: s2.ownerVillage.y, units: s2.units, losses: s2.losses })),
    intel: spy && spy.success ? intel(db, defVillage, defLevels, home) : null, spyLost: spy ? spy.lost : 0, knightFinds,
  };
  const t1 = title('game.report.attack');
  addReport(db, att.user_id, { type: 'attack', title: conquered ? `${t1} – erobert!` : t1, color: attColor, time: t, data });
  const informed = new Set([att.user_id]);
  if (defOwnerId && !informed.has(defOwnerId)) { addReport(db, defOwnerId, { type: 'defense', title: conquered ? `${villageLabel(defVillage, defOwner)} wurde erobert` : t1, color: defColor, time: t, data }); informed.add(defOwnerId); }
  for (const s2 of supporterReports) {
    const uid = s2.ownerVillage.user_id;
    if (uid && !informed.has(uid)) { addReport(db, uid, { type: 'defense', title: t1, color: defColor, time: t, data }); informed.add(uid); }
  }
}

function resolveSupport(db, cmd) {
  const t = cmd.arrive_at;
  const owner = db.prepare('SELECT * FROM village WHERE id = ?').get(cmd.from_village);
  const host = db.prepare('SELECT * FROM village WHERE id = ?').get(cmd.to_village);
  if (!host.user_id) { // support for a village that has become abandoned: the troops turn around
    db.prepare('INSERT INTO command (type, from_village, to_village, units, loot, depart_at, arrive_at) VALUES (?,?,?,?,?,?,?)')
      .run('return', host.id, owner.id, JSON.stringify(cmd.units), '{}', t, t + travelSeconds(cmd.units, owner, host));
    return;
  }
  station(db, owner.id, host.id, cmd.units);
  const ownerUser = owner.user_id && db.prepare('SELECT name FROM user WHERE id = ?').get(owner.user_id);
  const hostUser = db.prepare('SELECT name FROM user WHERE id = ?').get(host.user_id);
  const title = cfg.translate(view.currentLang(), 'game.report.support', { fromUser: ownerUser ? ownerUser.name : '-', fromVillage: owner.name, toVillage: villageLabel(host, hostUser) });
  const data = { kind: 'support', time: t, from: { user: ownerUser && ownerUser.name, village: owner.name, x: owner.x, y: owner.y }, to: { user: hostUser.name, village: host.name, x: host.x, y: host.y }, units: cmd.units };
  addReport(db, owner.user_id, { type: 'support', title, color: 'blue', time: t, data });
  if (host.user_id !== owner.user_id) addReport(db, host.user_id, { type: 'support', title, color: 'blue', time: t, data });
}

function resolveReturn(db, cmd) {
  const village = v.processQueue(db, cmd.to_village, cmd.arrive_at);
  const home = u.getUnits(db, cmd.to_village);
  setHome(db, cmd.to_village, Object.fromEntries(Object.entries(cmd.units).map(([k, n]) => [k, (home[k] || 0) + n])));
  const cap = v.storageMax(v.getBuildings(db, cmd.to_village));
  for (const r of RES) village[r] = Math.min(Math.max(cap, village[r]), village[r] + (cmd.loot[r] || 0));
  db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(village.wood, village.stone, village.iron, village.id);
}

// ---- trade ----
function sendResources(db, { userId, fromId, toId, res: raw }) {
  return transaction(db, () => {
    const from = v.processQueue(db, fromId);
    const to = db.prepare('SELECT * FROM village WHERE id = ?').get(toId);
    if (!from || from.user_id !== userId) return { ok: false, error: 'noSource' };
    if (!to || !to.user_id) return { ok: false, error: 'invalidTarget' };
    if (to.id === from.id) return { ok: false, error: 'sameVillage' };
    const res = Object.fromEntries(RES.map((r) => [r, Math.max(0, Math.floor(Number(raw[r]) || 0))]));
    const total = RES.reduce((s, r) => s + res[r], 0);
    if (total <= 0) return { ok: false, error: 'nothing' };
    if (RES.some((r) => from[r] < res[r])) return { ok: false, error: 'resources' };
    const needed = Math.ceil(total / MERCHANT_CAPACITY);
    if (merchantsFree(db, fromId) < needed) return { ok: false, error: 'merchants' };
    for (const r of RES) from[r] -= res[r];
    db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(from.wood, from.stone, from.iron, fromId);
    const t = now();
    db.prepare('INSERT INTO command (type, from_village, to_village, units, loot, depart_at, arrive_at) VALUES (?,?,?,?,?,?,?)')
      .run('trade', fromId, toId, JSON.stringify({ merchants: needed }), JSON.stringify(res), t, t + merchantSeconds(from, to));
    return { ok: true, merchants: needed };
  });
}

function resolveTrade(db, cmd) {
  const t = cmd.arrive_at;
  const from = db.prepare('SELECT * FROM village WHERE id = ?').get(cmd.from_village);
  const to = v.processQueue(db, cmd.to_village, t);
  const cap = v.storageMax(v.getBuildings(db, to.id));
  for (const r of RES) to[r] = Math.min(Math.max(cap, to[r]), to[r] + (cmd.loot[r] || 0));
  db.prepare('UPDATE village SET wood=?, stone=?, iron=? WHERE id=?').run(to.wood, to.stone, to.iron, to.id);
  db.prepare('INSERT INTO command (type, from_village, to_village, units, loot, depart_at, arrive_at) VALUES (?,?,?,?,?,?,?)')
    .run('trade_back', to.id, from.id, JSON.stringify(cmd.units), '{}', t, t + merchantSeconds(from, to));
  const fromUser = from.user_id && db.prepare('SELECT name FROM user WHERE id = ?').get(from.user_id);
  const toUser = to.user_id && db.prepare('SELECT name FROM user WHERE id = ?').get(to.user_id);
  const data = { kind: 'trade', time: t, from: { user: fromUser && fromUser.name, village: from.name, x: from.x, y: from.y }, to: { user: toUser && toUser.name, village: to.name, x: to.x, y: to.y }, res: cmd.loot };
  const title = `Lieferung von ${from.name} (${from.x}|${from.y}) nach ${to.name} (${to.x}|${to.y})`;
  addReport(db, from.user_id, { type: 'trade', title, color: 'green', time: t, data });
  if (to.user_id !== from.user_id) addReport(db, to.user_id, { type: 'trade', title, color: 'green', time: t, data });
}

// Resolves everything that has arrived by `t`, oldest first, so chains (attack -> return) happen in order.
function processDue(db, t = now(), rng = Math.random) {
  let handled = 0;
  for (;;) {
    const cmd = db.prepare('SELECT * FROM command WHERE arrive_at <= ? ORDER BY arrive_at, id LIMIT 1').get(t);
    if (!cmd) return handled;
    const parsed = parse(cmd);
    transaction(db, () => {
      db.prepare('DELETE FROM command WHERE id = ?').run(cmd.id);
      switch (parsed.type) {
        case 'attack': resolveAttack(db, parsed, rng); break;
        case 'support': resolveSupport(db, parsed); break;
        case 'return': resolveReturn(db, parsed); break;
        case 'trade': resolveTrade(db, parsed); break;
        default: break; // trade_back only frees the merchants
      }
    });
    handled++;
  }
}

// The paladin walks to another of the player's villages that has a statue; it arrives like returning troops.
function moveKnight(db, userId, fromId, toId) {
  return transaction(db, () => {
    const from = db.prepare('SELECT * FROM village WHERE id = ? AND user_id = ?').get(fromId, userId);
    const to = db.prepare('SELECT * FROM village WHERE id = ? AND user_id = ?').get(toId, userId);
    if (!from || !to || from.id === to.id) return { ok: false, error: 'invalidTarget' };
    if (!(v.getBuildings(db, to.id).statue >= 1)) return { ok: false, error: 'noStatue' };
    if (!(u.getUnits(db, from.id).knight >= 1)) return { ok: false, error: 'noTroops' };
    setHome(db, from.id, { knight: 0 });
    const t = now();
    db.prepare('INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES (?,?,?,?,?,?)')
      .run('return', from.id, to.id, JSON.stringify({ knight: 1 }), t, t + travelSeconds({ knight: 1 }, from, to));
    return { ok: true };
  });
}

// Calling units back: only possible for attacks and support still on their way out.
function cancel(db, userId, commandId) {
  return transaction(db, () => {
    const cmd = getCommand(db, commandId);
    if (!cmd || !['attack', 'support'].includes(cmd.type)) return { ok: false, error: 'noCommand' };
    const from = db.prepare('SELECT * FROM village WHERE id = ? AND user_id = ?').get(cmd.from_village, userId);
    if (!from) return { ok: false, error: 'noCommand' };
    const t = now();
    if (cmd.arrive_at <= t) return { ok: false, error: 'tooLate' };
    const back = t + (t - cmd.depart_at);
    db.prepare('UPDATE command SET type = ?, from_village = ?, to_village = ?, depart_at = ?, arrive_at = ?, loot = ? WHERE id = ?')
      .run('return', cmd.to_village, cmd.from_village, t, back, '{}', cmd.id);
    return { ok: true };
  });
}

// Copies one of the player's reports into another player's inbox.
function forwardReport(db, userId, reportId, toName) {
  const report = db.prepare('SELECT r.*, u.name AS sender FROM report r JOIN user u ON u.id = r.user_id WHERE r.id = ? AND r.user_id = ?').get(reportId, userId);
  if (!report) return { ok: false, error: 'noReport' };
  const to = db.prepare('SELECT id FROM user WHERE name = ?').get(String(toName || '').trim());
  if (!to || to.id === userId) return { ok: false, error: 'noUser' };
  if (db.prepare('SELECT 1 FROM blocked WHERE user_id = ? AND other_id = ?').get(to.id, userId)) return { ok: false, error: 'blocked' };
  db.prepare('INSERT INTO report (user_id, type, title, color, time, data, forwarded_by) VALUES (?,?,?,?,?,?,?)').run(to.id, report.type, report.title, report.color, report.time, report.data, report.sender);
  return { ok: true };
}

// `type`: all | attack | defense | support | trade | other | forwarded | public; `folder` lists one folder.
function getReports(db, userId, type, folder = null) {
  const parsed = (rows) => rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  const order = 'ORDER BY time DESC, id DESC LIMIT 200';
  if (folder) return parsed(db.prepare(`SELECT * FROM report WHERE user_id = ? AND folder_id = ? ${order}`).all(userId, folder));
  if (type === 'forwarded') return parsed(db.prepare(`SELECT * FROM report WHERE user_id = ? AND forwarded_by IS NOT NULL ${order}`).all(userId));
  if (type === 'public') return parsed(db.prepare(`SELECT * FROM report WHERE user_id = ? AND public_token IS NOT NULL ${order}`).all(userId));
  // Reports in folders stay out of the normal lists.
  const filter = ['attack', 'defense', 'support', 'trade', 'other'].includes(type) ? 'AND type = ?' : '';
  const sql = `SELECT * FROM report WHERE user_id = ? AND folder_id IS NULL ${filter} ${order}`;
  const rows = filter ? db.prepare(sql).all(userId, type) : db.prepare(sql).all(userId);
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

module.exports = {
  addReport,
  send, processDue, cancel, moveKnight, listCommands, getCommand, getReports, travelSeconds, merchantSeconds, protectedUntil, distance,
  stationedAt, recall, forwardReport, sendResources, merchantsAt, merchantsBusy, merchantsFree, MERCHANT_CAPACITY, START_LOYALTY,
};
