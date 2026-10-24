'use strict';
const village = require('./village');
const ranking = require('./ranking');
const premium = require('./premium');
const knight = require('./knight');
const { transaction } = require('../db');

// Small tutorial goals; each pays a few resources once.
const QUESTS = [
  { id: 'wood10', title: 'Holzfäller ausbauen', text: 'Baue den Holzfäller auf Stufe 10 aus.', reward: { wood: 400, stone: 400, iron: 400 }, pp: 1,
    done: (s) => s.maxLevels.wood >= 10 },
  { id: 'main10', title: 'Hauptgebäude ausbauen', text: 'Baue das Hauptgebäude auf Stufe 10 aus.', reward: { wood: 500, stone: 500, iron: 500 }, done: (s) => s.maxLevels.main >= 10 },
  { id: 'barracks', title: 'Erste Truppen', text: 'Errichte eine Kaserne.', reward: { wood: 300, stone: 300, iron: 300 }, done: (s) => s.maxLevels.barracks >= 1 },
  { id: 'army', title: 'Eine kleine Armee', text: 'Besitze mindestens 50 Truppen.', reward: { wood: 600, stone: 600, iron: 600 }, done: (s) => s.troops >= 50 },
  { id: 'attack', title: 'Der erste Angriff', text: 'Greife ein Dorf an.', reward: { wood: 800, stone: 800, iron: 800 }, pp: 2, done: (s) => s.attacks >= 1 },
  { id: 'tribe', title: 'Gemeinsam stärker', text: 'Tritt einem Stamm bei oder gründe einen.', reward: { wood: 500, stone: 500, iron: 500 }, done: (s) => s.tribe },
  { id: 'points500', title: 'Aufstrebend', text: 'Erreiche 500 Punkte.', reward: { wood: 1000, stone: 1000, iron: 1000 }, done: (s) => s.points >= 500 },
  { id: 'conquer', title: 'Eroberer', text: 'Erobere ein Dorf mit einem Adelsgeschlecht.', reward: { wood: 3000, stone: 3000, iron: 3000 }, pp: 5, done: (s) => s.conquered >= 1 },
];

// Everything the goals are measured against.
function stats(db, user) {
  const ids = db.prepare('SELECT id FROM village WHERE user_id = ?').all(user.id).map((r) => r.id);
  const maxLevels = {};
  for (const id of ids) for (const [b, l] of Object.entries(village.getBuildings(db, id))) maxLevels[b] = Math.max(maxLevels[b] || 0, l);
  const troops = ids.reduce((s, id) => s + (db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM village_unit WHERE village_id = ?').get(id).n), 0);
  const rk = ranking.playerRank(db, user.id);
  return {
    maxLevels, troops, points: rk.points, villages: ids.length, conquered: user.conquered, kills: user.kills_att + user.kills_def,
    attacks: db.prepare("SELECT COUNT(*) AS n FROM report WHERE user_id = ? AND type = 'attack'").get(user.id).n,
    tribe: !!user.ally_id, items: knight.found(db, user.id).length,
  };
}

const claimed = (db, userId) => new Set(db.prepare('SELECT quest FROM quest_claim WHERE user_id = ?').all(userId).map((r) => r.quest));

// Pays the reward into `villageId` (capped by the warehouse) and books the premium points.
function claim(db, user, villageId, questId) {
  return transaction(db, () => {
    const q = QUESTS.find((x) => x.id === questId);
    if (!q || claimed(db, user.id).has(q.id) || !q.done(stats(db, user))) return { ok: false, error: 'notReady' };
    const v = village.processQueue(db, villageId);
    if (!v || v.user_id !== user.id) return { ok: false, error: 'noSource' };
    const cap = village.storageMax(village.getBuildings(db, villageId));
    const next = Object.fromEntries(village.RES.map((r) => [r, Math.min(Math.max(cap, v[r]), v[r] + q.reward[r])]));
    db.prepare('UPDATE village SET wood = ?, stone = ?, iron = ? WHERE id = ?').run(next.wood, next.stone, next.iron, villageId);
    db.prepare('INSERT INTO quest_claim (user_id, quest, time) VALUES (?,?,?)').run(user.id, q.id, Math.floor(Date.now() / 1000));
    if (q.pp) premium.grant(db, user.id, q.pp, `Aufgabe: ${q.title}`);
    return { ok: true, quest: q };
  });
}

module.exports = { QUESTS, stats, claimed, claim };
