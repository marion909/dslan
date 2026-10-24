'use strict';
const cfg = require('../config');
const ally = require('./ally');
const { transaction } = require('../db');

const MAX_PER_PLAYER = 30;
const now = () => Math.floor(Date.now() / 1000);
// A claim lasts three days (shorter on fast worlds) so forgotten ones do not block a village for ever.
const ttl = () => (3 * 86400) / cfg.SPEED_MULT;

function sweep(db) {
  db.prepare('DELETE FROM reservation WHERE time < ?').run(now() - ttl());
}

const forVillage = (db, villageId) => {
  sweep(db);
  return db.prepare('SELECT r.*, u.name AS owner FROM reservation r JOIN user u ON u.id = r.user_id WHERE r.village_id = ?').get(villageId) || null;
};

// Tribe mates see each other's claims; the map marks own claims differently.
function forTribe(db, allyId) {
  sweep(db);
  return allyId ? db.prepare('SELECT r.*, u.name AS owner, v.name AS village, v.x, v.y FROM reservation r JOIN user u ON u.id = r.user_id JOIN village v ON v.id = r.village_id WHERE r.ally_id = ? ORDER BY r.time DESC').all(allyId) : [];
}

function mapMarks(db, user) {
  const out = {};
  for (const r of forTribe(db, user.ally_id)) out[r.village_id] = r.user_id === user.id ? 'player' : 'team';
  return out;
}

function toggle(db, user, villageId) {
  return transaction(db, () => {
    if (!user.ally_id) return { ok: false, error: 'noAlly' };
    const village = db.prepare('SELECT * FROM village WHERE id = ?').get(villageId);
    if (!village) return { ok: false, error: 'noVillage' };
    if (village.user_id === user.id) return { ok: false, error: 'ownVillage' };
    const existing = forVillage(db, villageId);
    if (existing) {
      if (existing.ally_id !== user.ally_id) return { ok: false, error: 'reservedElsewhere' };
      if (existing.user_id !== user.id && !ally.can(db, user, 'members')) return { ok: false, error: 'reserved', owner: existing.owner };
      db.prepare('DELETE FROM reservation WHERE village_id = ?').run(villageId);
      return { ok: true, type: 'delete' };
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM reservation WHERE user_id = ?').get(user.id).n >= MAX_PER_PLAYER) return { ok: false, error: 'tooMany' };
    db.prepare('INSERT INTO reservation (village_id, user_id, ally_id, time) VALUES (?,?,?,?)').run(villageId, user.id, user.ally_id, now());
    return { ok: true, type: 'add' };
  });
}

module.exports = { forVillage, forTribe, mapMarks, toggle, MAX_PER_PLAYER };
