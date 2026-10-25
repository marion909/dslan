'use strict';
const { transaction } = require('../db');
const relics = require('./relics');
const ranking = require('./ranking');
const commands = require('./commands');

const now = () => Date.now() / 1000;
const DAY = 86400;

function log(db, text) {
  db.prepare('INSERT INTO admin_log (time, text) VALUES (?, ?)').run(Math.floor(now()), text);
  db.prepare('DELETE FROM admin_log WHERE id NOT IN (SELECT id FROM admin_log ORDER BY id DESC LIMIT 200)').run();
}

// Takes a player out of the world. Their villages turn into barbarian villages; nothing is left dangling:
// troops of others that were on their way (or stationed) go home, the player's own orders and offers are dropped.
function removePlayer(db, userId) {
  transaction(db, () => {
    const own = db.prepare('SELECT id FROM village WHERE user_id = ?').all(userId).map((r) => r.id);
    const t = now();
    for (const id of own) {
      for (const c of db.prepare("SELECT id, from_village FROM command WHERE to_village = ? AND type IN ('attack', 'support')").all(id)) {
        if (own.includes(c.from_village)) { db.prepare('DELETE FROM command WHERE id = ?').run(c.id); continue; }
        db.prepare("UPDATE command SET type = 'return', to_village = from_village, depart_at = ?, arrive_at = ? WHERE id = ?").run(t, t, c.id);
      }
      db.prepare("DELETE FROM command WHERE from_village = ? AND type IN ('attack', 'support', 'trade')").run(id);
      const host = db.prepare('SELECT * FROM village WHERE id = ?').get(id);
      for (const s of db.prepare('SELECT * FROM stationed WHERE host_village = ?').all(id)) {
        if (own.includes(s.owner_village)) continue;
        const home = db.prepare('SELECT * FROM village WHERE id = ?').get(s.owner_village);
        const units = JSON.parse(s.units);
        db.prepare("INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES ('return', ?, ?, ?, ?, ?)")
          .run(id, s.owner_village, s.units, t, t + commands.travelSeconds(units, host, home));
      }
      db.prepare('DELETE FROM stationed WHERE host_village = ? OR owner_village = ?').run(id, id);
      db.prepare('DELETE FROM market_offer WHERE village_id = ?').run(id);
      db.prepare('DELETE FROM reservation WHERE village_id = ?').run(id);
      db.prepare('DELETE FROM village_group_member WHERE village_id = ?').run(id);
      db.prepare("UPDATE village SET name = 'Barbarendorf' WHERE id = ?").run(id);
      relics.villageLost(db, id);
    }
    const me = db.prepare('SELECT ally_id FROM user WHERE id = ?').get(userId);
    if (me && me.ally_id) {
      const ally = db.prepare('SELECT * FROM ally WHERE id = ?').get(me.ally_id);
      if (ally && ally.leader_id === userId) {
        const next = db.prepare('SELECT id FROM user WHERE ally_id = ? AND id != ? ORDER BY id LIMIT 1').get(ally.id, userId);
        if (next) db.prepare('UPDATE ally SET leader_id = ? WHERE id = ?').run(next.id, ally.id);
        else db.prepare('DELETE FROM ally WHERE id = ?').run(ally.id);
      }
    }
    db.prepare('DELETE FROM user WHERE id = ?').run(userId);
  });
  ranking.invalidate();
}

const lastActive = (u) => u.last_seen || u.created_at;

// Players who have been away for `days` days (and are not on vacation) lose their account; their villages become barbarians.
function sweepInactive(db, days, t = now()) {
  if (!(days > 0)) return [];
  const gone = [];
  const rows = db.prepare('SELECT * FROM user WHERE is_admin = 0 AND is_bot = 0 AND vacation_until <= ?').all(Math.floor(t));
  for (const u of rows) {
    if (lastActive(u) >= t - days * DAY) continue;
    removePlayer(db, u.id);
    log(db, `Inaktives Konto entfernt: ${u.name} (${Math.floor((t - lastActive(u)) / DAY)} Tage nicht online)`);
    gone.push(u.name);
  }
  return gone;
}

// Players who are close to being removed, for the admin overview.
function inactiveCandidates(db, days, t = now()) {
  if (!(days > 0)) return [];
  return db.prepare('SELECT * FROM user WHERE is_admin = 0 AND is_bot = 0 AND vacation_until <= ?').all(Math.floor(t))
    .map((u) => ({ id: u.id, name: u.name, away: (t - lastActive(u)) / DAY }))
    .filter((u) => u.away >= days * 0.6).sort((a, b) => b.away - a.away);
}

const MAX_VACATION_DAYS = 14;

// Vacation only pauses the inactivity removal; it does not protect villages.
function setVacation(db, userId, days) {
  const d = Math.min(MAX_VACATION_DAYS, Math.max(0, Math.floor(Number(days)) || 0));
  db.prepare('UPDATE user SET vacation_until = ? WHERE id = ?').run(d ? Math.floor(now() + d * DAY) : 0, userId);
  return d;
}

module.exports = { removePlayer, sweepInactive, inactiveCandidates, setVacation, log, MAX_VACATION_DAYS };
